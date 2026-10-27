<template>
    <div class="local-gallery">
        <!-- Quick actions header -->
        <div class="actions-bar">
            <el-button type="primary" size="small" @click="onPick">
                <el-icon><Plus /></el-icon>
                {{ t('selectImage') }}
            </el-button>
            <el-button size="small" @click="onAddDir">
                <el-icon><FolderAdd /></el-icon>
                {{ t('addDirectory') }}
            </el-button>
        </div>

        <!-- Folder library (in-panel replacement for the native QuickPick after "Add Folder") -->
        <el-card v-if="config.randomImageFolder" class="grid-card" shadow="never">
            <template #header>
                <div class="folder-header">
                    <span class="card-title">
                        <el-icon><FolderOpened /></el-icon>
                        {{ t('folderLibrary') }}
                        <el-tag size="small" round>{{ state.folderImagesTruncated ? '≥' : '' }}{{ state.folderImagesTotal }}</el-tag>
                    </span>
                    <span class="folder-path" :title="config.randomImageFolder">
                        {{ shortFolder }}
                    </span>
                </div>
            </template>

            <div class="scan-bar">
                <el-button size="small" :loading="scanning" :disabled="scanning" @click="onScan">
                    <el-icon v-if="!scanning"><DataAnalysis /></el-icon>
                    {{ scanning ? t('scanning') : t('scanFolder') }}
                </el-button>
                <span class="scan-status" :title="scanStatus">{{ scanStatus }}</span>
            </div>

            <div v-if="state.folderScan" class="scan-stats">
                <div class="stat-row">
                    <span>{{ t('scanTotal', { n: state.folderScan.total }) }}</span>
                    <span>{{ t('scanMeasured', { n: state.folderScan.measured }) }}</span>
                    <span v-if="state.folderScan.unknown">{{ t('scanUnknown', { n: state.folderScan.unknown }) }}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-h">{{ t('scanHorizontal', { n: state.folderScan.horizontal }) }}</span>
                    <span class="stat-p">{{ t('scanPortrait', { n: state.folderScan.portrait }) }}</span>
                </div>
                <div class="stat-row stat-range">
                    {{ t('scanRatioRange', {
                        median: formatRatio(state.folderScan.medianRatio),
                        min: formatRatio(state.folderScan.minRatio),
                        max: formatRatio(state.folderScan.maxRatio)
                    }) }}
                </div>
                <div class="bucket-list">
                    <div v-for="b in state.folderScan.buckets" :key="b.key" class="bucket">
                        <span class="bucket-key">{{ b.key }}</span>
                        <span class="bucket-track"><i :style="{ width: bucketWidth(b.count) }"></i></span>
                        <span class="bucket-count">{{ b.count }}</span>
                    </div>
                </div>
            </div>

            <el-empty
                v-if="state.folderImages.length === 0"
                :description="t('folderLibraryEmpty')"
                :image-size="60"
            />
            <div v-else>
                <div class="thumb-grid">
                    <button
                        v-for="img in pagedFolderImages"
                        :key="img.path"
                        type="button"
                        class="thumb"
                        :class="{ 'is-active': img.path === config.imagePath, 'is-filtered': isFilteredOut(img) }"
                        :title="thumbTitle(img)"
                        :aria-label="t('thumbSelectLabel', { name: img.name })"
                        :aria-pressed="img.path === config.imagePath"
                        @click="onApplyFolderImage(img.path)"
                    >
                        <video
                            v-if="img.display && isVideoPath(img.path)"
                            :src="img.display"
                            :aria-label="t('videoThumbLabel', { name: img.name })"
                            muted
                            loop
                            playsinline
                            preload="none"
                            @mouseenter="onHover($event, true)"
                            @mouseleave="onHover($event, false)"
                        />
                        <img v-else-if="thumbSrc(img)" :src="thumbSrc(img)" :alt="img.name" loading="lazy" />
                        <div v-else class="thumb-fallback">
                            <el-icon><Picture /></el-icon>
                        </div>
                        <div v-if="isVideoPath(img.path)" class="thumb-kind">
                            <el-icon><VideoCamera /></el-icon>
                        </div>
                        <div v-else-if="img.ratio" class="thumb-ratio">{{ formatRatio(img.ratio) }}</div>
                        <div class="thumb-name">{{ img.name }}</div>
                        <div v-if="img.path === config.imagePath" class="thumb-badge">
                            <el-icon><Check /></el-icon>
                        </div>
                    </button>
                </div>
                <div v-if="folderTotalPages > 1" class="folder-pager">
                    <el-pagination
                        :current-page="folderPage"
                        :page-size="folderPageSize"
                        :total="state.folderImages.length"
                        layout="prev, pager, next"
                        :pager-count="5"
                        small
                        background
                        @current-change="onFolderPageChange"
                    />
                </div>
                <div
                    v-if="state.folderImagesTotal > state.folderImages.length"
                    class="folder-more"
                >
                    <template v-if="state.folderImagesTruncated">
                        {{ t('folderLibraryMoreTruncated', { n: state.folderImages.length }) }}
                    </template>
                    <template v-else>
                        {{ t('folderLibraryMore', { n: state.folderImagesTotal, shown: state.folderImages.length }) }}
                    </template>
                </div>
            </div>
        </el-card>

    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Plus, FolderAdd, FolderOpened, Picture, Check, VideoCamera, DataAnalysis } from '@element-plus/icons-vue';
import { useI18n } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';
import { config, state, thumbs, thumbMisses } from '../composables/useStore';
import { ActionType } from '../constants';
import { isVideoPath } from '../utils/media';

const { t } = useI18n();
const bridge = useBridge();

const shortFolder = computed(() => {
    const p = config.randomImageFolder || '';
    if (!p) { return ''; }
    return p.length > 28 ? '…' + p.slice(-27) : p;
});

const folderPageSize = 40;
const folderPage = ref(1);
const folderTotalPages = computed(() => Math.max(1, Math.ceil(state.folderImages.length / folderPageSize)));
const pagedFolderImages = computed(() => {
    const start = (folderPage.value - 1) * folderPageSize;
    return state.folderImages.slice(start, start + folderPageSize);
});
function onFolderPageChange(p: number) { folderPage.value = p; }

// Reset to page 1 whenever the folder source or list size changes.
watch(() => config.randomImageFolder, () => { folderPage.value = 1; });
watch(() => state.folderImages.length, () => {
    if (folderPage.value > folderTotalPages.value) { folderPage.value = 1; }
});

/**
 * 网格里展示缩略图而不是原图：视频与生成失败的条目回退到原文件。
 */
function thumbSrc(img: { path: string; display: string }): string {
    if (isVideoPath(img.path)) { return ''; }
    return thumbs[img.path] || (thumbMisses[img.path] ? img.display : '');
}

const requestedThumbs = new Set<string>();
const pendingThumbPaths = computed(() => {
    const out: string[] = [];
    const push = (p: string) => {
        if (!p || isVideoPath(p) || thumbs[p] || thumbMisses[p] || requestedThumbs.has(p)) { return; }
        out.push(p);
    };
    pagedFolderImages.value.forEach(i => push(i.path));
    return out;
});

watch(pendingThumbPaths, (paths) => {
    const batch = paths.slice(0, 40);
    if (!batch.length) { return; }
    batch.forEach(p => requestedThumbs.add(p));
    bridge.post({ type: 'thumbnailsRequest', paths: batch });
}, { immediate: true, flush: 'post' });

/* ---------- 目录扫描：统计目录内每张图的长宽比 ---------- */
const scanning = ref(false);
const scanProgress = ref<{ done: number; total: number } | null>(null);
const scanError = ref('');

const scanStatus = computed(() => {
    if (scanning.value && scanProgress.value) {
        return t('scanProgress', { done: scanProgress.value.done, total: scanProgress.value.total });
    }
    if (scanError.value) { return scanError.value; }
    const s = state.folderScan;
    return s ? t('scanDone', { n: s.measured }) : t('scanStatusIdle');
});

function onScan() {
    scanError.value = '';
    scanProgress.value = null;
    scanning.value = true;
    bridge.post({ type: 'scanFolder' });
}

bridge.on('scanProgress', (msg: any) => { scanProgress.value = msg?.data ?? null; });
bridge.on('scanResult', (msg: any) => {
    scanning.value = false;
    scanProgress.value = null;
    const payload = msg?.data;
    scanError.value = payload?.error ? String(payload.error) : '';
});

function formatRatio(v?: number): string {
    return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
}

const maxBucketCount = computed(() => {
    const buckets = state.folderScan?.buckets ?? [];
    return Math.max(1, ...buckets.map(b => b.count));
});
function bucketWidth(count: number): string {
    return `${Math.max(2, Math.round((count / maxBucketCount.value) * 100))}%`;
}

/* ---------- 长宽比角标与「会被筛选掉」的提示 ---------- */
const filterThreshold = computed(() => {
    const v = Number(config.aspectThreshold);
    return Number.isFinite(v) && v > 0 ? v : 1.3;
});

function thumbTitle(img: { name: string; width?: number; height?: number; ratio?: number }): string {
    if (!img.width || !img.height) { return img.name; }
    return `${img.name}\n` + t('scanDims', {
        w: img.width,
        h: img.height,
        r: formatRatio(img.ratio ?? img.width / img.height)
    });
}

function isFilteredOut(img: { ratio?: number }): boolean {
    if (!config.aspectFilterEnabled || !img.ratio) { return false; }
    return img.ratio < filterThreshold.value;
}

function onPick()      { bridge.post({ type: 'runAction', action: ActionType.SelectPictures }); }
function onAddDir()    { bridge.post({ type: 'runAction', action: ActionType.AddDirectory }); }
function onApplyFolderImage(path: string) {
    bridge.post({ type: 'setConfig', key: 'imagePath', value: path });
}

function onHover(ev: Event, entering: boolean) {
    const el = ev.currentTarget as HTMLVideoElement | null;
    if (!el) { return; }
    if (entering) {
        // preload="none"：网格里的视频默认不拉取任何数据，悬停时才开始加载并播放
        if (el.preload !== 'auto') { el.preload = 'auto'; }
        el.play().catch(() => { /* autoplay blocked */ });
    } else {
        el.pause();
        try { el.currentTime = 0; } catch { /* noop */ }
    }
}
</script>

<style lang="scss" scoped>
.local-gallery { display: flex; flex-direction: column; gap: 12px; }

.actions-bar {
    display: flex;
    gap: 8px;
    .el-button { flex: 1 1 0; }
}

.grid-card :deep(.el-card__header) { padding: 8px 12px; }
.grid-card :deep(.el-card__body)   { padding: 10px 12px; }

.card-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    .el-icon { color: var(--studio-accent); }
}

.thumb-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
    gap: 10px;
}

.thumb {
    // <button> 重置：保持与原 <div> 一致的外观
    appearance: none;
    display: block;
    width: 100%;
    margin: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: inherit;
    position: relative;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    background: var(--studio-input-bg);
    border: 1px solid rgba(120, 140, 200, 0.18);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    &:hover {
        transform: translateY(-2px);
        border-color: rgba(108, 140, 255, 0.45);
        box-shadow:
            0 10px 24px rgba(108, 140, 255, 0.25),
            0 0 0 1px rgba(108, 140, 255, 0.25);
    }
    &.is-active {
        border-color: var(--studio-accent);
        box-shadow:
            0 0 0 2px var(--studio-accent),
            0 10px 24px rgba(108, 140, 255, 0.35);
    }
    &:focus-visible {
        outline: 2px solid var(--vscode-focusBorder, var(--studio-accent));
        outline-offset: 2px;
    }
    img, video {
        width: 100%;
        aspect-ratio: 16 / 10;
        object-fit: cover;
        display: block;
        background: #000;
    }
}

.thumb-kind {
    position: absolute;
    top: 6px;
    left: 6px;
    padding: 2px 6px;
    background: rgba(15, 18, 32, 0.7);
    color: #fff;
    border-radius: 999px;
    font-size: 10px;
    display: flex;
    align-items: center;
    gap: 2px;
    backdrop-filter: blur(4px);
    box-shadow: 0 2px 6px rgba(0,0,0,0.35);
}

.thumb-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 16 / 10;
    color: var(--vscode-descriptionForeground);
    font-size: 20px;
}

.thumb-name {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 16px 6px 4px;
    font-size: 10px;
    color: #fff;
    background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
}

.thumb-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 18px;
    height: 18px;
    background: var(--studio-btn-grad);
    color: #fff;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    box-shadow: 0 2px 8px rgba(108, 140, 255, 0.55);
}

.thumb-ratio {
    position: absolute;
    top: 6px;
    left: 6px;
    padding: 1px 5px;
    background: rgba(15, 18, 32, 0.72);
    color: #fff;
    border-radius: 4px;
    font-size: 10px;
    line-height: 14px;
    font-family: 'Consolas', 'SFMono-Regular', Menlo, monospace;
    backdrop-filter: blur(4px);
    pointer-events: none;
}

/* 会被比例筛选排除的图片：角标变橙，图库本身仍完整显示 */
.thumb.is-filtered .thumb-ratio {
    background: rgba(196, 124, 22, 0.85);
}

.thumb.is-filtered img,
.thumb.is-filtered video {
    opacity: 0.62;
}

/* ---------- 扫描按钮与统计 ---------- */
.scan-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
}

.scan-status {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.scan-stats {
    margin-bottom: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--studio-input-bg);
    border: 1px solid rgba(120, 140, 200, 0.18);
    font-size: 11px;
    color: var(--vscode-foreground);
}

.stat-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    line-height: 18px;
    color: var(--vscode-descriptionForeground);
}

.stat-h { color: var(--vscode-charts-blue, #6c8cff); }
.stat-p { color: var(--vscode-charts-orange, #d98a2b); }
.stat-range { font-family: 'Consolas', 'SFMono-Regular', Menlo, monospace; }

.bucket-list {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.bucket {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
}

.bucket-key {
    flex: 0 0 74px;
    font-family: 'Consolas', 'SFMono-Regular', Menlo, monospace;
    color: var(--vscode-descriptionForeground);
}

.bucket-track {
    flex: 1 1 auto;
    height: 6px;
    border-radius: 3px;
    background: rgba(120, 140, 200, 0.16);
    overflow: hidden;
    i {
        display: block;
        height: 100%;
        border-radius: 3px;
        background: var(--studio-btn-grad);
    }
}

.bucket-count {
    flex: 0 0 44px;
    text-align: right;
    font-family: 'Consolas', 'SFMono-Regular', Menlo, monospace;
    color: var(--vscode-foreground);
}

.block-btn { width: 100%; }

.folder-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
}

.folder-path {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-family: 'Consolas', 'SFMono-Regular', Menlo, monospace;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
}

.folder-more {
    margin-top: 10px;
    padding: 6px 4px;
    border-top: var(--studio-divider);
    font-size: 11px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
}

.folder-pager {
    display: flex;
    justify-content: center;
    margin-top: 10px;
}
</style>
