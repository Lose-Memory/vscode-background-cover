<template>
    <div class="advanced-tab">
        <!-- Auto random -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Refresh /></el-icon>
                    {{ t('autoRandom') }}
                </span>
            </template>

            <div class="row">
                <span class="row-label">{{ t('enabled') }}</span>
                <el-switch
                    :model-value="!!config.autoStatus"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'autoStatus', value: v })"
                />
            </div>

            <div class="row">
                <span class="row-label">{{ t('intervalSeconds') }}</span>
                <el-input-number
                    :model-value="Number(config.autoInterval ?? 10)"
                    :min="3"
                    :max="3600"
                    :step="1"
                    size="small"
                    controls-position="right"
                    class="interval-input"
                    @change="onIntervalChange"
                />
            </div>

            <div class="row">
                <span class="row-label">{{ t('sourceFolder') }}</span>
                <el-button link type="primary" class="folder-btn" :title="config.randomImageFolder" @click="onSourceFolder">
                    <span class="folder-text">{{ shortFolder || t('notSet') }}</span>
                    <el-icon><ArrowRight /></el-icon>
                </el-button>
            </div>

            <div class="row">
                <span class="row-label">{{ t('autoRandomOnStartup') }}</span>
                <el-switch
                    :model-value="config.autoRandomOnStartup !== false"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'autoRandomOnStartup', value: v })"
                />
            </div>
            <div class="row-hint">{{ t('autoRandomOnStartupHint') }}</div>
        </el-card>

        <!-- Window scope -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Monitor /></el-icon>
                    {{ t('windowScope') }}
                </span>
            </template>

            <div class="row">
                <span class="row-label">{{ t('perWindowBackground') }}</span>
                <el-switch
                    :model-value="config.perWindowBackground !== false"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'perWindowBackground', value: v })"
                />
            </div>
            <div class="row-hint">{{ t('perWindowBackgroundHint') }}</div>
        </el-card>

        <!-- Size mode -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><FullScreen /></el-icon>
                    {{ t('sizeMode') }}
                </span>
            </template>
            <el-select
                :model-value="config.sizeModel"
                size="small"
                class="block-select"
                @change="(v: any) => bridge.post({ type: 'setConfig', key: 'sizeModel', value: v })"
            >
                <el-option v-for="opt in sizeModeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
        </el-card>

        <!-- Aspect ratio：比例筛选 + 竖图纵向取景 -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Crop /></el-icon>
                    {{ t('aspectSection') }}
                </span>
            </template>

            <div class="row">
                <span class="row-label">{{ t('aspectFilterEnabled') }}</span>
                <el-switch
                    :model-value="!!config.aspectFilterEnabled"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'aspectFilterEnabled', value: v })"
                />
            </div>

            <div class="row">
                <span class="row-label">{{ t('aspectThreshold') }}</span>
                <el-input-number
                    :model-value="Number(config.aspectThreshold ?? 1.3)"
                    :min="0.1"
                    :max="10"
                    :step="0.05"
                    :precision="2"
                    size="small"
                    controls-position="right"
                    class="interval-input"
                    @change="onThresholdChange"
                />
            </div>
            <div class="row-hint">{{ t('aspectThresholdHint') }}</div>

            <div class="row row-col">
                <span class="row-label">
                    {{ t('portraitPosition') }}
                    <span class="pos-value">{{ positionValue }}%</span>
                </span>
                <el-slider
                    :model-value="positionValue"
                    :min="0"
                    :max="100"
                    :step="1"
                    :show-tooltip="false"
                    @input="onPositionChange"
                />
            </div>
            <div class="row-hint">{{ t('portraitPositionHint') }}</div>
        </el-card>

        <!-- Blend mode -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Brush /></el-icon>
                    {{ t('blendMode') }}
                </span>
            </template>
            <el-select
                :model-value="config.blendModel"
                size="small"
                class="block-select"
                @change="(v: any) => bridge.post({ type: 'setConfig', key: 'blendModel', value: v })"
            >
                <el-option v-for="opt in blendModeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
            <div class="row-hint">{{ t('blendModeHint') }}</div>
        </el-card>

        <!-- Misc -->
        <el-card class="card" shadow="never">
            <div class="row-hint hint-top">{{ t('applyChangesHint') }}</div>
            <div class="quick-actions">
                <el-button class="block-btn" type="primary" @click="onApplyChanges">
                    <el-icon><RefreshRight /></el-icon>
                    {{ t('applyChanges') }}
                </el-button>
                <el-button class="block-btn" type="danger" plain @click="onSupport">
                    <el-icon><Star /></el-icon>
                    {{ t('supportAuthor') }}
                </el-button>
            </div>
        </el-card>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Refresh, ArrowRight, FullScreen, Brush, Star, Monitor, RefreshRight, Crop } from '@element-plus/icons-vue';
import { useI18n, type MessageKey } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';
import { useDebouncedPost } from '../composables/useDebouncedPost';
import { config } from '../composables/useStore';
import { ActionType, SIZE_MODES, BLEND_MODES } from '../constants';

const { t } = useI18n();
const bridge = useBridge();

// 下拉框显示翻译后的名称，发送给扩展的值保持原枚举值不变
const SIZE_MODE_LABEL_KEYS: Record<string, MessageKey> = {
    cover:            'sizeModeCover',
    repeat:           'sizeModeRepeat',
    contain:          'sizeModeContain',
    center:           'sizeModeCenter',
    not_center:       'sizeModeNotCenter',
    not_right_bottom: 'sizeModeNotRightBottom',
    not_right_top:    'sizeModeNotRightTop',
    not_left:         'sizeModeNotLeft',
    not_right:        'sizeModeNotRight',
    not_top:          'sizeModeNotTop',
    not_bottom:       'sizeModeNotBottom'
};
const BLEND_MODE_LABEL_KEYS: Record<string, MessageKey> = {
    auto:     'blendModeAuto',
    multiply: 'blendModeMultiply',
    lighten:  'blendModeLighten'
};

const shortFolder = computed(() => {
    const p = config.randomImageFolder || '';
    if (!p) { return ''; }
    return p.length > 26 ? '…' + p.slice(-25) : p;
});

const intervalPost = useDebouncedPost('setConfig', 'autoInterval', { delay: 300 });
function onIntervalChange(v: number | undefined) {
    const value = Number(v ?? 10);
    config.autoInterval = value;
    intervalPost.post(value);
}

// 竖图阈值：同时决定「比例筛选」的下限和「竖图」的判定
const thresholdPost = useDebouncedPost('setConfig', 'aspectThreshold', { delay: 250 });
function onThresholdChange(v: number | undefined) {
    const value = Number(v ?? 1.3);
    config.aspectThreshold = Number.isFinite(value) && value > 0 ? value : 1.3;
    thresholdPost.post(config.aspectThreshold);
}

// 竖图纵向取景：0 = 顶部，50 = 居中，100 = 底部
const positionValue = computed(() => {
    const v = Number(config.portraitVerticalPosition ?? 50);
    if (!Number.isFinite(v)) { return 50; }
    return Math.max(0, Math.min(100, Math.round(v)));
});

const positionPost = useDebouncedPost('setConfig', 'portraitVerticalPosition', { delay: 200 });
function onPositionChange(v: any) {
    const raw = Array.isArray(v) ? v[0] : v;
    const value = Math.max(0, Math.min(100, Math.round(Number(raw ?? 50))));
    config.portraitVerticalPosition = value;
    positionPost.post(value);
}

const sizeModeOptions = computed(() => SIZE_MODES.map((value) => ({
    value,
    label: t(SIZE_MODE_LABEL_KEYS[value] ?? 'sizeModeCover')
})));
const blendModeOptions = computed(() => BLEND_MODES.map((value) => ({
    value,
    label: t(BLEND_MODE_LABEL_KEYS[value] ?? 'blendModeAuto')
})));

function onSourceFolder() { bridge.post({ type: 'runAction', action: ActionType.AddDirectory }); }
function onSupport()      { bridge.post({ type: 'runAction', action: ActionType.OpenFilePath, path: '//resources//support.jpg' }); }
function onApplyChanges() { bridge.post({ type: 'applyDecorations' }); }
</script>

<style lang="scss" scoped>
.advanced-tab { display: flex; flex-direction: column; gap: 12px; }

.card :deep(.el-card__header) { padding: 8px 12px; }
.card :deep(.el-card__body)   { padding: 10px 12px; }

.card-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    .el-icon { color: var(--studio-accent); }
}

.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    & + .row { border-top: var(--studio-divider); }
}

.row-label {
    font-size: 12px;
    color: var(--vscode-foreground);
}

.row-hint {
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    opacity: .85;
    padding-top: 6px;
    border-top: var(--studio-divider);
}

.hint-top {
    padding-top: 0;
    padding-bottom: 8px;
    border-top: none;
}

.folder-btn {
    max-width: 70%;
    overflow: hidden;
    .folder-text {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
    }
}

.block-select { width: 100%; }

/* 竖图纵向取景：标签一行、滑块占满一行 */
.row-col {
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    .row-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    :deep(.el-slider) { padding: 0 4px; }
}

.pos-value {
    font-family: 'Consolas', 'SFMono-Regular', Menlo, monospace;
    font-size: 11px;
    color: var(--studio-accent, var(--vscode-textLink-foreground));
}

.interval-input { width: 120px; }

.quick-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
}

.block-btn.block-btn {
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    text-align: center;
    margin: 0 !important;
}

.block-btn :deep(> span) {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}
</style>
