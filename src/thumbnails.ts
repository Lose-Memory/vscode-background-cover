/**
 * 图库缩略图：用 sharp 把本地图片压成 160px 的 webp，缓存到扩展 globalStorage。
 *
 * 缓存文件名 = 绝对路径的 sha1 + 原图 mtime，原图改动后自然重建；
 * 视频不生成缩略图（返回空，调用方回退到原文件）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getContext } from './global';
import { isVideoFile } from './pathUtil';

const THUMB_WIDTH = 160;
const THUMB_QUALITY = 72;
const MAX_CONCURRENCY = 3;
const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type SharpFactory = (input: string, options?: Record<string, unknown>) => any;

let sharpFactory: SharpFactory | null | undefined;

/** sharp 是可选依赖：加载失败时缩略图功能整体降级，不影响壁纸本身。 */
function loadSharp(): SharpFactory | null {
    if (sharpFactory === undefined) {
        try {
            sharpFactory = require('sharp') as SharpFactory;
        } catch (e) {
            console.warn('[BackgroundCover] sharp unavailable, thumbnails disabled:', e);
            sharpFactory = null;
        }
    }
    return sharpFactory;
}

/** 取不到 globalStorage（例如测试环境）时返回 undefined，缩略图整体降级。 */
export function thumbnailsDir(): string | undefined {
    try {
        const storage = getContext().globalStorageUri;
        return storage && storage.fsPath ? path.join(storage.fsPath, 'thumbnails') : undefined;
    } catch {
        return undefined;
    }
}

let running = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
    if (running < MAX_CONCURRENCY) {
        running += 1;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => waiters.push(resolve));
}

function release(): void {
    const next = waiters.shift();
    if (next) {
        next();
        return;
    }
    running -= 1;
}

function thumbFile(dir: string, filePath: string, mtimeMs: number): string {
    const key = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 16);
    return path.join(dir, `${key}-${Math.round(mtimeMs)}.webp`);
}

/**
 * 返回缩略图的绝对路径；不支持的文件（视频/不可读/生成失败）返回 undefined。
 */
export async function getThumbnail(filePath: string): Promise<string | undefined> {
    if (!filePath || isVideoFile(filePath)) { return undefined; }
    const dir = thumbnailsDir();
    if (!dir) { return undefined; }

    let mtimeMs = 0;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) { return undefined; }
        mtimeMs = stat.mtimeMs;
    } catch {
        return undefined;
    }

    const target = thumbFile(dir, filePath, mtimeMs);
    if (fs.existsSync(target)) { return target; }

    const sharp = loadSharp();
    if (!sharp) { return undefined; }

    await acquire();
    try {
        if (!fs.existsSync(target)) {
            fs.mkdirSync(dir, { recursive: true });
            const tmp = `${target}.tmp`;
            await sharp(filePath, { failOn: 'none' })
                .rotate()
                .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: THUMB_QUALITY })
                .toFile(tmp);
            fs.renameSync(tmp, target);
        }
    } catch (e) {
        try { fs.unlinkSync(`${target}.tmp`); } catch { /* noop */ }
        console.warn('[BackgroundCover] thumbnail failed:', filePath, e);
    } finally {
        release();
    }
    return fs.existsSync(target) ? target : undefined;
}

/** 清掉 30 天没被访问过的缩略图，避免缓存目录无限增长。 */
export async function pruneOldThumbnails(): Promise<void> {
    const dir = thumbnailsDir();
    if (!dir) { return; }
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return;
    }
    const deadline = Date.now() - PRUNE_MAX_AGE_MS;
    for (const name of names) {
        if (!name.endsWith('.webp')) { continue; }
        const full = path.join(dir, name);
        try {
            if (fs.statSync(full).mtimeMs < deadline) { fs.unlinkSync(full); }
        } catch {
            // 单个文件失败不影响其它条目
        }
    }
}
