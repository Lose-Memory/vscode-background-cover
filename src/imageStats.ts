/**
 * 图片尺寸统计 / 长宽比筛选。
 *
 * - getImageSize：用 sharp 读单张图的长宽（按 EXIF 方向校正），按 mtime 缓存；
 *   视频与读不到尺寸的条目返回 undefined，一律视为「未知」。
 * - filterByMinAspect：随机换图时抽样筛掉长宽比不达标的图片（视频直接放行），
 *   不需要事先扫描，也就不会因为目录变化而拿到过期结果。
 * - scanFolderSizes：图库「扫描目录」按钮用的一次性全量统计（只存在当前会话）。
 *
 * sharp 是可选依赖，加载失败时整个模块降级为「未知」，不影响壁纸本身。
 */
import * as fs from 'fs';
import { isVideoFile } from './pathUtil';

export interface ImageSize {
    width: number;
    height: number;
}

type SharpMetadata = { width?: number; height?: number; orientation?: number };
type SharpFactory = (input: string, options?: Record<string, unknown>) => {
    metadata(): Promise<SharpMetadata>;
};

let sharpFactory: SharpFactory | null | undefined;

function loadSharp(): SharpFactory | null {
    if (sharpFactory === undefined) {
        try {
            sharpFactory = require('sharp') as SharpFactory;
        } catch (e) {
            console.warn('[BackgroundCover] sharp unavailable, image size stats disabled:', e);
            sharpFactory = null;
        }
    }
    return sharpFactory;
}

const sizeCache = new Map<string, { mtimeMs: number; size?: ImageSize }>();
const SIZE_CACHE_MAX = 60_000;

/** 读取图片的显示尺寸（已按 EXIF 方向校正）；视频 / 不存在 / 读不到返回 undefined。 */
export async function getImageSize(filePath: string): Promise<ImageSize | undefined> {
    if (!filePath || isVideoFile(filePath)) { return undefined; }
    const sharp = loadSharp();
    if (!sharp) { return undefined; }

    let mtimeMs: number;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) { return undefined; }
        mtimeMs = stat.mtimeMs;
    } catch {
        return undefined;
    }

    const cached = sizeCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) { return cached.size; }

    let size: ImageSize | undefined;
    try {
        const meta = await sharp(filePath, { failOn: 'none' }).metadata();
        const width = typeof meta.width === 'number' ? meta.width : 0;
        const height = typeof meta.height === 'number' ? meta.height : 0;
        if (width > 0 && height > 0) {
            // EXIF 5~8 表示 90°/270° 旋转，展示时长宽要互换
            const rotated = typeof meta.orientation === 'number' && meta.orientation >= 5 && meta.orientation <= 8;
            size = rotated ? { width: height, height: width } : { width, height };
        }
    } catch {
        size = undefined;
    }

    if (sizeCache.size >= SIZE_CACHE_MAX) { sizeCache.clear(); }
    sizeCache.set(filePath, { mtimeMs, size });
    return size;
}

/** 同步读缓存（没统计过就返回 undefined），供 webview 状态推送使用。 */
export function getCachedImageSize(filePath: string): ImageSize | undefined {
    return sizeCache.get(filePath)?.size;
}

/** 长宽比 = 宽 / 高；读不到尺寸返回 undefined。 */
export async function getImageAspect(filePath: string): Promise<number | undefined> {
    const size = await getImageSize(filePath);
    return size ? size.width / size.height : undefined;
}

/**
 * 从候选里抽样挑出长宽比 >= minRatio 的图片，最多 want 张、最多查 maxChecks 张。
 * minRatio <= 0 表示不筛选，直接等概率返回全部候选。
 * 视频 / 读不到尺寸的条目直接放行（用户明确要求忽略视频比例）。
 */
export async function filterByMinAspect(
    files: string[],
    minRatio: number,
    want: number = 5,
    maxChecks: number = 40
): Promise<string[]> {
    if (!files.length) { return []; }
    if (!(minRatio > 0)) { return files.slice(); }

    const picked: string[] = [];
    const tried = new Set<number>();
    const checks = Math.min(maxChecks, files.length);
    for (let i = 0; i < checks && picked.length < want; i++) {
        let idx = Math.floor(Math.random() * files.length);
        while (tried.has(idx)) { idx = (idx + 1) % files.length; }
        tried.add(idx);
        const size = await getImageSize(files[idx]);
        if (!size || size.width / size.height >= minRatio) { picked.push(files[idx]); }
    }
    return picked;
}

export interface RatioBucket {
    /** 展示用标签，如 `1.0-1.3`、`>=2.0`。 */
    key: string;
    count: number;
}

export interface FolderScanResult {
    folder: string;
    depth: number;
    scannedAt: number;
    /** 目录内媒体总数（含视频）。 */
    total: number;
    /** 成功读到尺寸的图片数。 */
    measured: number;
    /** 视频 / 读不到尺寸的数量。 */
    unknown: number;
    /** 长宽比 >= threshold 的数量。 */
    horizontal: number;
    /** 长宽比 < threshold 的数量。 */
    portrait: number;
    threshold: number;
    minRatio: number;
    maxRatio: number;
    medianRatio: number;
    buckets: RatioBucket[];
}

const BUCKET_EDGES = [0.8, 1.0, 1.3, 1.5, 1.78, 2.0];

function bucketLabel(index: number): string {
    if (index === 0) { return `<${BUCKET_EDGES[0]}`; }
    if (index === BUCKET_EDGES.length) { return `>=${BUCKET_EDGES[BUCKET_EDGES.length - 1]}`; }
    return `${BUCKET_EDGES[index - 1]}-${BUCKET_EDGES[index]}`;
}

function bucketIndex(ratio: number): number {
    for (let i = 0; i < BUCKET_EDGES.length; i++) {
        if (ratio < BUCKET_EDGES[i]) { return i; }
    }
    return BUCKET_EDGES.length;
}

export interface ScanProgress {
    done: number;
    total: number;
}

const SCAN_CONCURRENCY = 8;

let latestScan: FolderScanResult | undefined;

/** 当前会话最近一次扫描结果；folder 不匹配时视为没有结果。 */
export function getLatestScan(folder?: string): FolderScanResult | undefined {
    if (latestScan && folder && latestScan.folder !== folder) { return undefined; }
    return latestScan;
}

/**
 * 统计一批图片的尺寸与长宽比分布。files 由调用方给出（已按扫描深度/上限枚举好）。
 * onProgress 每 ~120ms 回调一次，用于图库里的进度显示。
 */
export async function scanFolderSizes(
    folder: string,
    depth: number,
    files: string[],
    threshold: number,
    onProgress?: (p: ScanProgress) => void
): Promise<FolderScanResult> {
    const total = files.length;
    const ratios: number[] = [];
    let measured = 0;
    let unknown = 0;
    let done = 0;
    let cursor = 0;
    let lastReport = 0;

    const worker = async () => {
        for (;;) {
            const index = cursor++;
            if (index >= total) { return; }
            const size = await getImageSize(files[index]);
            if (size) {
                measured += 1;
                ratios.push(size.width / size.height);
            } else {
                unknown += 1;
            }
            done += 1;
            const now = Date.now();
            if (onProgress && (done === total || now - lastReport > 120)) {
                lastReport = now;
                onProgress({ done, total });
            }
        }
    };

    const workers = Math.max(1, Math.min(SCAN_CONCURRENCY, total));
    await Promise.all(Array.from({ length: workers }, worker));
    if (onProgress && total === 0) { onProgress({ done: 0, total: 0 }); }

    ratios.sort((a, b) => a - b);
    const buckets: RatioBucket[] = BUCKET_EDGES.map((_, i) => ({ key: bucketLabel(i), count: 0 }))
        .concat({ key: bucketLabel(BUCKET_EDGES.length), count: 0 });
    let horizontal = 0;
    for (const ratio of ratios) {
        buckets[bucketIndex(ratio)].count += 1;
        if (ratio >= threshold) { horizontal += 1; }
    }

    const result: FolderScanResult = {
        folder,
        depth,
        scannedAt: Date.now(),
        total,
        measured,
        unknown,
        horizontal,
        portrait: measured - horizontal,
        threshold,
        minRatio: ratios.length ? ratios[0] : 0,
        maxRatio: ratios.length ? ratios[ratios.length - 1] : 0,
        medianRatio: ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0,
        buckets
    };
    latestScan = result;
    return result;
}
