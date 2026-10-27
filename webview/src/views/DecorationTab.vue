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
    </div>
</template>

<script setup lang="ts">
import { RefreshRight } from '@element-plus/icons-vue';
import { useI18n } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';

const { t } = useI18n();
const bridge = useBridge();

function onApply() {
    bridge.post({ type: 'applyDecorations' });
}
</script>

<style lang="scss" scoped>
.decoration-tab { display: flex; flex-direction: column; gap: 12px; }

.card :deep(.el-card__body)   { padding: 10px 12px; }

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
