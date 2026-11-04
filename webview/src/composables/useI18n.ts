import zh from '../locales/zh';

export type MessageKey = keyof typeof zh;
export type MessageParams = Record<string, string | number>;

export function useI18n() {
    return {
        /** 界面只有中文：t('key', { n: 1 }) 会把文案中的 `{n}` 替换为 1；未提供的占位符原样保留。 */
        t(key: MessageKey, params?: MessageParams): string {
            const text: string = (zh as any)[key] ?? String(key);
            if (!params) { return text; }
            return text.replace(/\{(\w+)\}/g, (m, name: string) =>
                Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
            );
        }
    };
}