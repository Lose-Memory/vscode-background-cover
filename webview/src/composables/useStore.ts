import { reactive } from 'vue';

/**
 * Reactive snapshot of extension-side configuration mirrored into the webview.
 * The extension pushes a 'state' message; the bridge listener writes here.
 */
export interface StudioConfig {
    opacity: number;
    blur: number;
    imagePath: string;
    imagePathDisplay: string;     // webview URI for <img src>
    autoStatus: boolean;
    autoInterval: number;
    /** 启动窗口时随机换一张新图（与定时自动换图互不影响） */
    autoRandomOnStartup: boolean;
    sizeModel: string;
    blendModel: string;
    randomImageFolder: string;
    /** false = 所有窗口共用一张背景图（旧版行为） */
    perWindowBackground: boolean;
    /** 竖图阈值：宽/高 小于它视为竖图；比例筛选与纵向取景共用 */
    aspectThreshold: number;
    /** 随机换图时是否只挑宽高比 >= 阈值的图片 */
    aspectFilterEnabled: boolean;
    /** 竖图纵向取景位置：0 = 顶部，50 = 居中，100 = 底部 */
    portraitVerticalPosition: number;
    /** 子目录扫描层数（只读回显，实际值在扩展侧） */
    folderScanDepth: number;
    /** 当前背景图的长宽比；0 = 未知 */
    imageAspect: number;
}

export interface FolderImage {
    path: string;
    display: string;
    name: string;
    width?: number;
    height?: number;
    /** 宽/高，保留两位小数；扫描过后才有 */
    ratio?: number;
}

export interface RatioBucket {
    key: string;
    count: number;
}

/** 一次目录扫描的汇总（完整逐图尺寸留在扩展侧的缓存里）。 */
export interface FolderScanSummary {
    scannedAt: number;
    total: number;
    measured: number;
    unknown: number;
    horizontal: number;
    portrait: number;
    threshold: number;
    minRatio: number;
    maxRatio: number;
    medianRatio: number;
    buckets: RatioBucket[];
}

export interface StudioState {
    folderImages: FolderImage[];
    folderImagesTotal: number;
    /** 目录文件数达到扫描上限，total 只是「至少这么多」 */
    folderImagesTruncated: boolean;
    folderScan: FolderScanSummary | null;
}

export const config = reactive<StudioConfig>({
    opacity: 0.2,
    blur: 0,
    imagePath: '',
    imagePathDisplay: '',
    autoStatus: false,
    autoInterval: 10,
    autoRandomOnStartup: true,
    sizeModel: 'cover',
    blendModel: 'auto',
    randomImageFolder: '',
    perWindowBackground: true,
    aspectThreshold: 1.3,
    aspectFilterEnabled: false,
    portraitVerticalPosition: 50,
    folderScanDepth: 3,
    imageAspect: 0,
});

export const state = reactive<StudioState>({
    folderImages: [],
    folderImagesTotal: 0,
    folderImagesTruncated: false,
    folderScan: null
});

/**
 * 图库缩略图：path → webview 可用的缩略图地址（扩展侧 sharp 生成）。
 * thumbMisses 记录已请求过但没有缩略图的路径（视频/生成失败），此时回退原图。
 */
export const thumbs = reactive<Record<string, string>>({});
export const thumbMisses = reactive<Record<string, true>>({});

export interface StudioBrand {
    logo: string;
    name: string;
}

export const brand = reactive<StudioBrand>({
    logo: '',
    name: ''
});

/**
 * 本地正在编辑（防抖发送中/刚发送）的字段 → 失效时间戳。
 * 扩展回推的完整 state 会跳过这些字段，避免覆盖用户正在拖动的值。
 */
type DirtyScope = 'config' | 'state';
const dirtyUntil: Record<DirtyScope, Map<string, number>> = {
    config: new Map(),
    state: new Map()
};

export function markDirty(scope: DirtyScope, key: string, ms: number) {
    const until = Date.now() + ms;
    const map = dirtyUntil[scope];
    if ((map.get(key) ?? 0) < until) { map.set(key, until); }
}

function isDirty(scope: DirtyScope, key: string): boolean {
    const map = dirtyUntil[scope];
    const until = map.get(key);
    if (until === undefined) { return false; }
    if (Date.now() < until) { return true; }
    map.delete(key);
    return false;
}

function assignClean(scope: DirtyScope, target: Record<string, any>, src: Record<string, any>) {
    for (const k of Object.keys(src)) {
        if (!isDirty(scope, k)) { target[k] = src[k]; }
    }
}

export function applyState(data: any) {
    if (!data) { return; }
    if (data.config) { assignClean('config', config, data.config); }
    if (data.state)  { assignClean('state', state, data.state); }
    if (typeof data.brandLogo === 'string') { brand.logo = data.brandLogo; }
    if (typeof data.brandName === 'string') { brand.name = data.brandName; }
}
