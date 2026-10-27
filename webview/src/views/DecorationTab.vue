<template>
    <div class="decoration-tab">
        <!-- Reload to apply — kept on top so users see the restart requirement
             before they start changing settings below. -->
        <el-card class="card apply-card" shadow="never">
            <div class="apply-hint">{{ t('applyChangesHint') }}</div>
            <el-button type="primary" class="apply-btn" @click="onApply">
                <el-icon><RefreshRight /></el-icon>
                {{ t('applyChanges') }}
            </el-button>
        </el-card>

        <!-- Pet -->
        <el-card class="card" shadow="never">
            <template #header>
                <div class="card-header">
                    <span class="card-title">
                        <el-icon><Sunny /></el-icon>
                        {{ t('petAssistant') }}
                    </span>
                    <el-switch
                        :model-value="!!state.petEnabled"
                        @change="togglePet"
                    />
                </div>
            </template>

            <div class="pet-sync-note">{{ t('petCodexSyncHint') }}</div>

            <div class="pet-grid">
                <button
                    v-for="pet in state.pets"
                    :key="pet.value"
                    class="pet-tile"
                    :class="{ 'is-active': pet.value === state.petType }"
                    :title="`${pet.label} · ${pet.desc}`"
                    @click="selectPet(pet.value)"
                >
                    <div class="pet-thumb">
                        <img v-if="pet.thumb" :src="pet.thumb" :alt="pet.label" loading="lazy" />
                        <el-icon v-else><Picture /></el-icon>
                    </div>
                    <div class="pet-name">{{ pet.label }}</div>
                    <div v-if="pet.value === state.petType" class="pet-badge">
                        <el-icon><Check /></el-icon>
                    </div>
                </button>
            </div>

            <div class="message-section">
                <div class="message-head">
                    <span class="slider-label">{{ t('petMessages') }}</span>
                    <span class="message-hint">{{ t('petMessagesHint') }}</span>
                </div>
                <el-input
                    type="textarea"
                    :model-value="state.petMessages"
                    :placeholder="t('petMessagesPlaceholder')"
                    :rows="4"
                    resize="vertical"
                    @input="onPetMessagesInput"
                />
            </div>
        </el-card>

    </div>
</template>

<script setup lang="ts">
import { Sunny, Picture, Check, RefreshRight } from '@element-plus/icons-vue';
import { useI18n } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';
import { useDebouncedPost } from '../composables/useDebouncedPost';
import { state } from '../composables/useStore';
import { ActionType } from '../constants';

const { t } = useI18n();
const bridge = useBridge();

function togglePet()      { bridge.post({ type: 'runAction', action: ActionType.TogglePet }); }

function selectPet(value: string) {
    state.petType = value;
    bridge.post({ type: 'setGlobalState', key: 'backgroundCoverPetType', value });
}

const messagesPost = useDebouncedPost('setGlobalState', 'backgroundCoverPetMessages',     { delay: 250, storeKey: 'petMessages' });

function onPetMessagesInput(value: string) {
    state.petMessages = value;
    messagesPost.post(value);
}

function onApply() {
    // applyDecorations 会携带完整状态，挂起的单项更新无需再发送
    messagesPost.cancel();
    bridge.post({
        type: 'applyDecorations',
        state: {
            backgroundCoverPetEnabled: !!state.petEnabled,
            backgroundCoverPetType: state.petType,
            backgroundCoverPetMessages: state.petMessages
        }
    });
}
</script>

<style lang="scss" scoped>
.decoration-tab { display: flex; flex-direction: column; gap: 12px; }

.card :deep(.el-card__header) { padding: 8px 12px; }
.card :deep(.el-card__body)   { padding: 10px 12px; }

.card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.card-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    .el-icon { color: var(--studio-accent); }
}

/* ===== Pet grid ===== */
.pet-sync-note {
    margin-bottom: 8px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--vscode-descriptionForeground);
}

.pet-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
    gap: 8px;
}

.pet-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 4px 4px;
    border-radius: 8px;
    background: var(--studio-btn-soft, rgba(46, 54, 88, 0.85));
    border: 1px solid var(--studio-btn-soft-border, rgba(120, 140, 200, 0.35));
    color: var(--vscode-foreground);
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
    &:hover {
        transform: translateY(-1px);
        border-color: rgba(140, 165, 230, 0.55);
        box-shadow: 0 6px 14px rgba(108, 140, 255, 0.25);
    }
    &.is-active {
        border-color: var(--studio-accent);
        box-shadow:
            0 0 0 2px var(--studio-accent),
            0 6px 14px rgba(108, 140, 255, 0.35);
    }
}

.pet-thumb {
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.25);
    overflow: hidden;
    img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        image-rendering: pixelated;
    }
    .el-icon {
        font-size: 22px;
        color: var(--vscode-descriptionForeground);
    }
}

.pet-name {
    font-size: 10px;
    line-height: 1.2;
    text-align: center;
    color: var(--vscode-foreground);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pet-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--studio-btn-grad, var(--studio-accent));
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    box-shadow: 0 2px 6px rgba(108, 140, 255, 0.55);
}

.message-section {
    margin-top: 10px;
    padding-top: 10px;
    border-top: var(--studio-divider);
}

.message-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
}

.message-hint {
    flex: 1 1 auto;
    text-align: right;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
}

/* ===== Sliders ===== */
.slider-row {
    display: grid;
    grid-template-columns: 60px 1fr 36px;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    & + .slider-row { border-top: var(--studio-divider); }
}

.slider-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.slider-input {
    --el-slider-height: 6px;
    --el-slider-button-size: 14px;
}

.slider-value {
    text-align: right;
    font-size: 11px;
    color: var(--vscode-foreground);
    font-variant-numeric: tabular-nums;
}

.slider-hint {
    font-size: 10px;
    line-height: 1.45;
    color: var(--vscode-descriptionForeground);
    padding: 2px 0 6px;
}

/* ===== Color section ===== */
.color-section {
    margin-top: 8px;
    padding-top: 8px;
    border-top: var(--studio-divider);
}

.color-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}

.custom-color {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.swatch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(22px, 1fr));
    gap: 6px;
}

.swatch {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.15);
    cursor: pointer;
    transition: transform 0.12s ease, box-shadow 0.12s ease;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    .el-icon {
        font-size: 11px;
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
    }
    &:hover {
        transform: scale(1.12);
        box-shadow: 0 0 0 2px rgba(108, 140, 255, 0.4), 0 2px 6px rgba(0, 0, 0, 0.4);
    }
    &.is-active {
        box-shadow:
            0 0 0 2px var(--studio-accent),
            0 0 8px rgba(108, 140, 255, 0.6);
    }
}

/* ===== Apply card ===== */
.apply-card :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px;
}

.apply-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
}

.apply-btn {
    width: 100%;
    justify-content: center;
}
</style>
