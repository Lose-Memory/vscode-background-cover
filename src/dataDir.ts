/*
 * @Description: 插件自己的数据（缩略图、单图取景位置、目录扫描结果）存放在哪。
 * 默认放在扩展的 globalStorage 里，而 VS Code 卸载扩展时会递归删除该目录；
 * 配置 backgroundCover.dataDir 后改存到用户指定目录，卸载扩展不再影响这些数据。
 * 只涉及本插件自己的文件，不碰 VS Code 或其它扩展的配置。
 */
import * as fs from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';
import { getContext } from './global';

export const DATA_DIR_KEY = 'dataDir';
export const THUMBNAILS_SUBDIR = 'thumbnails';

/** 落盘的文件名（与各自模块里的常量保持一致） */
const DATA_FILES = ['image-positions.json', 'image-stats.json'];

let cached: { raw: string; dir: string | undefined } | undefined;

/** 默认目录：扩展 globalStorage（取不到时返回 undefined，调用方整体降级）。 */
function defaultDir(): string | undefined {
    try {
        const storage = getContext().globalStorageUri;
        return storage && storage.fsPath ? storage.fsPath : undefined;
    } catch {
        return undefined;
    }
}

/** 配置里的自定义目录；留空、不存在且建不出来时返回 undefined（回退默认目录）。 */
function customDir(): string | undefined {
    let raw: string;
    try {
        raw = (workspace.getConfiguration('backgroundCover').get<string>(DATA_DIR_KEY) || '').trim();
    } catch {
        return undefined;
    }
    if (!raw) { return undefined; }
    if (cached && cached.raw === raw) { return cached.dir; }
    let dir: string | undefined;
    try {
        const abs = path.resolve(raw);
        fs.mkdirSync(abs, { recursive: true });
        if (fs.statSync(abs).isDirectory()) { dir = abs; }
    } catch {
        dir = undefined;
    }
    cached = { raw, dir };
    return dir;
}

/** 数据根目录：自定义目录优先，否则 globalStorage。 */
export function dataDir(): string | undefined {
    return customDir() ?? defaultDir();
}

/** 数据文件的绝对路径；没有可用目录时返回 undefined。 */
export function dataFile(name: string): string | undefined {
    const dir = dataDir();
    return dir ? path.join(dir, name) : undefined;
}

/**
 * 把旧目录里的插件数据复制到新目录：不覆盖目标已有文件，也不删除源文件。
 * 返回实际复制的文件数，供日志使用。
 */
export function migrateData(from: string | undefined, to: string | undefined): number {
    if (!from || !to) { return 0; }
    if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) { return 0; }
    let copied = 0;
    const copyOne = (src: string, dest: string) => {
        try {
            if (!fs.existsSync(src) || fs.existsSync(dest)) { return; }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            copied += 1;
        } catch (e) {
            console.warn('[BackgroundCover] data migration skipped:', src, e);
        }
    };
    for (const name of DATA_FILES) {
        copyOne(path.join(from, name), path.join(to, name));
    }
    const thumbsFrom = path.join(from, THUMBNAILS_SUBDIR);
    try {
        for (const name of fs.readdirSync(thumbsFrom)) {
            if (name.endsWith('.webp')) {
                copyOne(path.join(thumbsFrom, name), path.join(to, THUMBNAILS_SUBDIR, name));
            }
        }
    } catch {
        // 旧目录没有缩略图，忽略
    }
    return copied;
}