/*
 * @Description: 单张图片单独设置的纵向取景位置（优先于全局「竖图位置」）
 * 存放在 globalStorage/image-positions.json：路径数量可能很多，不塞进 globalState。
 */
import * as fs from 'fs';
import * as path from 'path';
import { getContext } from './global';

const FILE_NAME = 'image-positions.json';
const MAX_ENTRIES = 5000;

let cache: Record<string, number> | undefined;

function normalize(imagePath: string): string {
    return imagePath.replace(/\\/g, '/').toLowerCase();
}

function positionsFilePath(): string | undefined {
    try {
        return path.join(getContext().globalStorageUri.fsPath, FILE_NAME);
    } catch {
        return undefined;
    }
}

function load(): Record<string, number> {
    if (cache) { return cache; }
    cache = {};
    const file = positionsFilePath();
    if (!file) { return cache; }
    try {
        if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, number>;
            if (raw && typeof raw === 'object') { cache = raw; }
        }
    } catch (e) {
        console.warn('[BackgroundCover] Failed to read image positions file:', e);
    }
    return cache;
}

function save(): void {
    const file = positionsFilePath();
    if (!file) { return; }
    try {
        fs.writeFileSync(file, JSON.stringify(cache ?? {}), 'utf-8');
    } catch (e) {
        console.warn('[BackgroundCover] Failed to write image positions file:', e);
    }
}

/** 单张图片单独设置的纵向位置（0-100）；没有单独设置时返回 undefined。 */
export function getImagePosition(imagePath: string): number | undefined {
    if (!imagePath) { return undefined; }
    const value = load()[normalize(imagePath)];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 写入（value 为数字）或清除（value 为 null/undefined）单张图片的纵向位置。 */
export function setImagePosition(imagePath: string, value: number | null | undefined): void {
    if (!imagePath) { return; }
    const key = normalize(imagePath);
    const store = load();
    if (value === null || value === undefined || !Number.isFinite(value)) {
        if (!(key in store)) { return; }
        delete store[key];
        save();
        return;
    }
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (store[key] === clamped) { return; }
    if (!(key in store) && Object.keys(store).length >= MAX_ENTRIES) {
        // 简单退避：超上限时丢掉最早写入的一条。
        const oldest = Object.keys(store)[0];
        delete store[oldest];
    }
    store[key] = clamped;
    save();
}
