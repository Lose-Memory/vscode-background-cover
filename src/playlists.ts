/**
 * 播放列表：两个互相独立的图片目录，其余设置（透明度、模糊、比例筛选、轮播间隔
 * 等）全部共用。
 *
 * - `playlist1Folder` / `playlist2Folder` 各存一个目录，递归扫描沿用全局
 *   `folderScanDepth`；
 * - `activePlaylist` 决定随机换图、图库列表与目录扫描使用哪一个目录；
 * - 旧版的 `randomImageFolder` 启动时一次性迁移到 `playlist1Folder`。
 */
import { ConfigurationTarget, WorkspaceConfiguration, workspace } from 'vscode';

export type PlaylistIndex = 1 | 2;

/** 旧版单目录设置；只读出来迁移，界面上已弃用。 */
const LEGACY_FOLDER_KEY = 'randomImageFolder';

export function playlistFolderKey(index: PlaylistIndex): 'playlist1Folder' | 'playlist2Folder' {
    return index === 2 ? 'playlist2Folder' : 'playlist1Folder';
}

/** 当前生效的列表；取值非法时回落到列表 1。 */
export function getActivePlaylist(config: WorkspaceConfiguration): PlaylistIndex {
    return config.get<string>('activePlaylist') === '2' ? 2 : 1;
}

/** 某个列表的目录（未做 `~` / 环境变量展开，交给调用方处理）。 */
export function getPlaylistFolder(config: WorkspaceConfiguration, index: PlaylistIndex): string {
    const value = config.get<string>(playlistFolderKey(index));
    return typeof value === 'string' ? value.trim() : '';
}

export function getActivePlaylistFolder(config: WorkspaceConfiguration): string {
    return getPlaylistFolder(config, getActivePlaylist(config));
}

/**
 * 把旧版 `randomImageFolder` 迁移成播放列表 1 的目录。
 * 迁移完清掉旧键，避免两个键各存一份、互相打架。
 * @returns 是否发生了迁移
 */
export async function migrateLegacyFolder(
    config: WorkspaceConfiguration = workspace.getConfiguration('backgroundCover')
): Promise<boolean> {
    const inspect = config.inspect<string>(LEGACY_FOLDER_KEY);
    const legacyGlobal = (inspect?.globalValue ?? '').trim();
    const legacyWorkspace = (inspect?.workspaceValue ?? '').trim();
    const legacy = legacyGlobal || legacyWorkspace;
    if (!legacy) { return false; }

    if (!getPlaylistFolder(config, 1)) {
        await config.update(playlistFolderKey(1), legacy, ConfigurationTarget.Global);
    }
    if (legacyGlobal) {
        await config.update(LEGACY_FOLDER_KEY, undefined, ConfigurationTarget.Global);
    }
    if (legacyWorkspace) {
        await config.update(LEGACY_FOLDER_KEY, undefined, ConfigurationTarget.Workspace);
    }
    return true;
}