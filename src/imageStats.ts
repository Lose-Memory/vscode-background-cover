/**
 * 图片尺寸统计 / 长宽比筛选。
 *
 * - getImageSize：用 sharp 读单张图的长宽（按 EXIF 方向校正），按 mtime 缓存；
 *   视频与读不到尺寸的条目返回 undefined，一律视为「未知」。
 * - filterByMinAspect：随机换图时抽样筛掉长宽比不达标的图片（视频直接放行），
 *   不需要事先扫描，也就不会因为目录变化而拿到过期结果。
 * - scanFolderSizes：图库「扫描目录」按钮用的统计（落盘到 globalStorage）。扫描是
 *   增量的：落盘记录里存了每张图的 mtime，mtime 没变的图直接复用上次的宽高，
 *   只有新增/改动过的图才真正用 sharp 解码。
 *
 * sharp 是可选依赖，加载失败时整个模块降级为「未知」，不影响壁纸本身。
 */
import * as fs from 'fs';
import { dataFile } from './dataDir';
import { isVideoFile } from './pathUtil';
import { getThumbnail } from './thumbnails';

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

// --- 扫描结果落盘 ---------------------------------------------------------
// 只存「目录一次扫描的结论 + 相对路径的宽高」，重启后直接复用：统计卡片、缩略图
// 角标、随机换图筛选都还能用，不需要用户再扫一遍。
const STATS_FILE_NAME = 'image-stats.json';
const MAX_STATS_FOLDERS = 3;
const MAX_STATS_ENTRIES = 30_000;

interface PersistedFolderStats {
    depth: number;
    scannedAt: number;
    summary: FolderScanResult;
    /** 相对目录的小写路径 → [宽, 高, 文件 mtimeMs]（老版本落盘只有前两项） */
    sizes: Record<string, [number, number, number]>;
}

let persistedStats: Record<string, PersistedFolderStats> | undefined;

function normalizePathKey(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function statsFilePath(): string | undefined {
    return dataFile(STATS_FILE_NAME);
}

/** 数据目录变化后丢弃内存缓存，下次读取直接用新目录里的文件。 */
export function reloadPersistedStats(): void {
    persistedStats = undefined;
}

function loadPersistedStats(): Record<string, PersistedFolderStats> {
    if (persistedStats) { return persistedStats; }
    persistedStats = {};
    const file = statsFilePath();
    if (!file) { return persistedStats; }
    try {
        if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, PersistedFolderStats>;
            if (raw && typeof raw === 'object') { persistedStats = raw; }
        }
    } catch (e) {
        console.warn('[BackgroundCover] Failed to read image stats file:', e);
    }
    return persistedStats;
}

function savePersistedStats(): void {
    const file = statsFilePath();
    if (!file) { return; }
    try {
        fs.writeFileSync(file, JSON.stringify(persistedStats ?? {}), 'utf-8');
    } catch (e) {
        console.warn('[BackgroundCover] Failed to write image stats file:', e);
    }
}

/** 把绝对路径转成「相对扫描目录」的小写键；不在目录内返回 undefined。 */
function relativePathKey(folder: string, filePath: string): string | undefined {
    const base = normalizePathKey(folder);
    const target = normalizePathKey(filePath);
    if (!target.startsWith(`${base}/`)) { return undefined; }
    return target.slice(base.length + 1);
}

/**
 * 查落盘记录里这张图的宽度与 mtime。
 * 老版本落盘没有 mtime，mtimeMs 为 undefined —— 只能用于展示，不能证明文件没被改过。
 */
function lookupPersistedEntry(filePath: string): { mtimeMs?: number; size: ImageSize } | undefined {
    const target = normalizePathKey(filePath);
    const store = loadPersistedStats();
    for (const folder of Object.keys(store)) {
        const prefix = `${folder}/`;
        if (!target.startsWith(prefix)) { continue; }
        const hit = store[folder].sizes?.[target.slice(prefix.length)];
        if (!hit) { return undefined; }
        const mtimeMs = typeof hit[2] === 'number' && Number.isFinite(hit[2]) ? hit[2] : undefined;
        return { mtimeMs, size: { width: hit[0], height: hit[1] } };
    }
    return undefined;
}

function cacheSize(filePath: string, mtimeMs: number, size: ImageSize | undefined): void {
    if (sizeCache.size >= SIZE_CACHE_MAX) { sizeCache.clear(); }
    sizeCache.set(filePath, { mtimeMs, size });
}

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

    // 上次扫描落盘的尺寸：文件没动过就不用再解码
    const persisted = lookupPersistedEntry(filePath);
    if (persisted && persisted.mtimeMs === mtimeMs) {
        cacheSize(filePath, mtimeMs, persisted.size);
        return persisted.size;
    }

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

    cacheSize(filePath, mtimeMs, size);
    return size;
}

/** 同步读缓存（没统计过就返回 undefined），供 webview 状态推送使用。 */
export function getCachedImageSize(filePath: string): ImageSize | undefined {
    const cached = sizeCache.get(filePath);
    if (cached) { return cached.size; }
    const persisted = lookupPersistedEntry(filePath);
    if (!persisted) { return undefined; }
    if (persisted.mtimeMs !== undefined) {
        // 有 mtime 才进内存缓存，免得把「老格式、无 mtime」的尺寸当成已验证结果
        cacheSize(filePath, persisted.mtimeMs, persisted.size);
    }
    return persisted.size;
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
/** 图库最多展示 2000 张（StudioViewProvider 的 slice 上限），超出的不必预生成缩略图 */
const THUMB_SCAN_LIMIT = 2000;

let latestScan: FolderScanResult | undefined;

/** 当前会话最近一次扫描结果（会话内没有则回落到落盘数据）；folder 不匹配时视为没有结果。 */
export function getLatestScan(folder?: string): FolderScanResult | undefined {
    if (latestScan && (!folder || latestScan.folder === folder)) { return latestScan; }
    if (!folder) { return latestScan; }
    return loadPersistedStats()[normalizePathKey(folder)]?.summary;
}

/**
 * 统计一批图片的尺寸与长宽比分布。files 由调用方给出（已按扫描深度/上限枚举好）。
 * 增量：上次落盘里有的图、mtime 又没变，就直接复用宽高，不再解码；其余才走 sharp。
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
    const previous = loadPersistedStats()[normalizePathKey(folder)]?.sizes ?? {};
    const ratios: number[] = [];
    /** 本次扫到（或复用）的条目：相对路径 → [宽, 高, mtimeMs] */
    const fresh: Record<string, [number, number, number]> = {};
    /** 上次测到过、这次读不出来的条目，落盘时删掉 */
    const broken: string[] = [];
    let measured = 0;
    let unknown = 0;
    let done = 0;
    let cursor = 0;
    let lastReport = 0;

    const worker = async () => {
        for (;;) {
            const index = cursor++;
            if (index >= total) { return; }
            const file = files[index];

            let size: ImageSize | undefined;
            let key: string | undefined;
            let mtimeMs: number | undefined;
            if (!isVideoFile(file)) {
                key = relativePathKey(folder, file);
                try {
                    const stat = fs.statSync(file);
                    if (stat.isFile()) { mtimeMs = stat.mtimeMs; }
                } catch {
                    // 枚举后又被删掉：按未知处理
                }
                if (key !== undefined && mtimeMs !== undefined) {
                    const old = previous[key];
                    if (old && old[2] === mtimeMs && old[0] > 0 && old[1] > 0) {
                        size = { width: old[0], height: old[1] };
                        // 顺手填内存缓存，图库角标不用再读盘
                        cacheSize(file, mtimeMs, size);
                    }
                }
                if (!size) {
                    size = await getImageSize(file);
                }
            }

            if (size) {
                measured += 1;
                ratios.push(size.width / size.height);
                if (key !== undefined && mtimeMs !== undefined) {
                    fresh[key] = [size.width, size.height, mtimeMs];
                }
            } else {
                unknown += 1;
                if (key !== undefined && mtimeMs !== undefined) {
                    broken.push(key);
                }
            }
            done += 1;
            // 扫描时顺手把缩略图生成好：图库第一次打开就能直接看到，不用再逐张等。
            // 图库最多展示 THUMB_SCAN_LIMIT 张，超出的不必预先压。
            if (index < THUMB_SCAN_LIMIT && !isVideoFile(file)) {
                await getThumbnail(file);
            }
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
    persistScan(folder, result, fresh, broken);
    return result;
}

/**
 * 扫描结果落盘，并只保留最近使用的几个目录。
 * 尺寸表与旧记录合并：换个扫描层数、或者临时扫小范围，都不会把已测过的尺寸丢掉。
 */
function persistScan(
    folder: string,
    summary: FolderScanResult,
    fresh: Record<string, [number, number, number]>,
    broken: string[]
): void {
    const store = loadPersistedStats();
    const folderKey = normalizePathKey(folder);
    const sizes: Record<string, [number, number, number]> = { ...(store[folderKey]?.sizes ?? {}) };
    let count = Object.keys(sizes).length;
    for (const key of Object.keys(fresh)) {
        if (!(key in sizes)) {
            if (count >= MAX_STATS_ENTRIES) { continue; }
            count += 1;
        }
        sizes[key] = fresh[key];
    }
    for (const key of broken) { delete sizes[key]; }

    store[folderKey] = { depth: summary.depth, scannedAt: summary.scannedAt, summary, sizes };
    const keys = Object.keys(store);
    if (keys.length > MAX_STATS_FOLDERS) {
        keys.sort((a, b) => (store[a].scannedAt || 0) - (store[b].scannedAt || 0));
        for (const key of keys.slice(0, keys.length - MAX_STATS_FOLDERS)) {
            delete store[key];
        }
    }
    savePersistedStats();
}
