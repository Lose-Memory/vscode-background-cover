/*
 * @Description: 
 * @Author: czw
 * @Date: 2023-08-25 10:00:03
 * @FilePath: \vscode-background-cover\src\extension.ts
 */
'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
	commands,
	window,
	Extension,
	extensions,
	ExtensionContext,
	StatusBarAlignment,
	version as vscodeVersion,
	workspace, // 获取 VSCode 版本
} from 'vscode';
import * as fs from 'fs';
import { PickList } from './PickList';
import { setContext } from './global';
import { CUSTOM_JS_FILE_PATH, collectStaleWindowCssFiles, detectPatchState, readRenderedImagePath } from './FileDom';
import { dataDir, migrateData } from './dataDir';
import { reloadImagePositions } from './imagePositions';
import { reloadPersistedStats } from './imageStats';
import { StudioViewProvider } from './StudioViewProvider';
import { hasCurrentImageRecord, hasCurrentSessionRecord, resolveCurrentImagePath, setCurrentBlur, setCurrentImagePath, setCurrentOpacity } from './windowBackground';
import { migrateLegacyFolder } from './playlists';


// 上一次生效的数据目录，用于在设置变化时把旧目录的数据搬过来
let lastDataDir: string | undefined;

export function activate(context: ExtensionContext) {
	setContext(context);
	lastDataDir = dataDir();
	// 创建底部按钮 - 背景图片配置
	let backImgBtn = window.createStatusBarItem(StatusBarAlignment.Right, -999);
	backImgBtn.text = '$(file-media)';
	backImgBtn.command = 'extension.backgroundCover.showMenu';
	backImgBtn.tooltip = '切换背景图';
	backImgBtn.show();
	context.subscriptions.push(backImgBtn);

	// 旧版单目录设置迁移成播放列表 1（有旧值时才写一次），完成后再走启动逻辑
	migrateLegacyFolder()
		.catch(err => { console.error('[BackgroundCover] playlist migration failed:', err); return false; })
		// 窗口刚打开时本窗口还没有记录，而首帧渲染用的是共享 CSS 里上一次应用的图：
		// 先把它记到本窗口，Studio 面板才不会一直显示"未设置"。
		.then(() => seedCurrentImageFromRenderedCss())
		.then(() => checkVSCodeVersionChanged(context))
		.then(async isChanged => {
		if (!isChanged) {
			const config = workspace.getConfiguration('backgroundCover');
			const resolved = resolveCurrentImagePath(config.imagePath || '');
			const hasImage = !!resolved || hasCurrentImageRecord();

			// A1: 以实际内核文件的内容标记判定补丁状态（none/legacy/latest）。
			// 覆盖"同一版本重装 VS Code / 用户手动还原 workbench 文件 / 打过旧版补丁"
			// 这些仅凭版本号或文件存在性检测不到的丢失场景。
			const patchState = await detectPatchState();
			const patchOutdated = patchState !== 'latest' || !fs.existsSync(CUSTOM_JS_FILE_PATH);

			if (hasImage && patchOutdated) {
				const ex: Extension<any> | undefined = extensions.getExtension('manasxx.background-cover');
				const extensionVersion: string = ex ? ex.packageJSON['version'] : '';
				window.showInformationMessage(
					`BackgroundCover ${extensionVersion || ''}：检测到背景补丁缺失或版本过旧，需要重新应用。是否立即执行？`,
					'应用',
					'稍后'
				).then(async result => {
					if (result === '应用') {
						const requiresReload = await PickList.applyCurrentBackground();
						if (requiresReload) {
							await promptRestartWindow();
						}
					}
				});
			} else {
				// 启动随机换图自己会写一份最终壁纸：先应用一次持久记录只会让窗口多闪
				// 一张（共享首帧 → 记录图 → 随机图）。随机没换成图时才回退到下面的
				// 持久记录逻辑，避免残留 CSS 指向已删除的图片。
				const randomized = await PickList.startupRandomUpdate();
				if (!randomized) {
					// 没有记录时也要走一次：清掉指向已删除图片的残留 CSS（包括首帧用的
					// 共享文件），避免重启后先黑屏、点刷新也不生效。
					await PickList.applyCurrentBackground();
				}
			}
		}
	}).catch(err => {
		console.error('[BackgroundCover] startup apply failed:', err);
	});

	// 启动自动更换任务
	PickList.startAutoRandomTask();

	// 回收历史窗口会话遗留的 CSS 文件，不阻塞启动
	void collectStaleWindowCssFiles();

	// 监听配置变化
	context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('backgroundCover.dataDir')) {
			// 换数据目录：先把旧目录里的数据搬过去（复制，不删源文件），
			// 再丢掉按旧路径读出来的内存缓存，否则面板仍显示旧扫描结果。
			const before = lastDataDir;
			const after = dataDir();
			lastDataDir = after;
			if (after && after !== before) {
				const copied = migrateData(before, after);
				if (copied) { console.log(`[BackgroundCover] migrated ${copied} data file(s) to`, after); }
			}
			reloadImagePositions();
			reloadPersistedStats();
		}
		if (e.affectsConfiguration('backgroundCover.autoStatus') || e.affectsConfiguration('backgroundCover.autoInterval')) {
			PickList.startAutoRandomTask();
		}
		if (e.affectsConfiguration('backgroundCover.perWindowBackground')) {
			// 切换独立/共用模式：重新应用一次，让本窗口写到新的目标 CSS 文件，
			// 并把注入端的地址复位。其余窗口各自收到同一事件后自行处理。
			void PickList.applyCurrentBackground();
		}
		if (e.affectsConfiguration('backgroundCover.activePlaylist')) {
			// 切换播放列表：立刻从新列表随机换一张，让用户马上看到变化。
			void PickList.applyActivePlaylist();
		}
	}));

	let randomCommand = commands.registerCommand('extension.backgroundCover.refresh', () => { PickList.randomUpdateBackground(); });
	let startCommand = commands.registerCommand('extension.backgroundCover.start', () => { 
		commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');
		commands.executeCommand('workbench.view.extension.backgroundCover-explorer');
	});
	let showMenuCommand = commands.registerCommand('extension.backgroundCover.showMenu', () => {
		commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');
		commands.executeCommand('workbench.view.extension.backgroundCover-explorer');
	});
	context.subscriptions.push(startCommand);
	context.subscriptions.push(randomCommand);
	context.subscriptions.push(showMenuCommand);

	// 数据目录：选一个自己的文件夹，卸载扩展时就不会被一起删掉
	context.subscriptions.push(commands.registerCommand('backgroundCover.pickDataDir', async () => {
		const picked = await window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: '用作数据目录'
		});
		if (!picked || !picked.length) { return; }
		await workspace.getConfiguration('backgroundCover').update('dataDir', picked[0].fsPath, true);
	}));
	context.subscriptions.push(commands.registerCommand('backgroundCover.resetDataDir', async () => {
		await workspace.getConfiguration('backgroundCover').update('dataDir', '', true);
	}));

	// webview
	// New Vue-powered Studio webview (primary configuration UI)
	const studioViewProvider = new StudioViewProvider(context);
	context.subscriptions.push(window.registerWebviewViewProvider(
		StudioViewProvider.viewType,
		studioViewProvider,
		{ webviewOptions: { retainContextWhenHidden: true } }
	));

	context.subscriptions.push(
		commands.registerCommand('backgroundCover.refreshEntry', () => {
			commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');
			studioViewProvider.refresh();
		}),
		commands.registerCommand('backgroundCover.switchMode', () => {
			commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');
			studioViewProvider.navigate('home');
		})
	);

	// Register Command for Tree Item Click
	context.subscriptions.push(commands.registerCommand('backgroundCover.runAction', async (type: number, path?: string) => {
		const config = workspace.getConfiguration('backgroundCover');
		// No QuickPick: webview-originated actions must not flash a native popup
		// or open the legacy "Reloading takes effect?" prompt. The Studio panel
		// is the user-facing UI now.
		const pickList = new PickList(config);
		await pickList.handleAction(type, path);
	}));


	context.subscriptions.push(commands.registerCommand('backgroundCover.setConfig', async (key: string, value: any) => {
		if (key === 'backgroundCover.imagePath') {
			// 全局兜底由 windowBackground 的 globalState 承担，不再回写 settings.json
			// （旧实现只在首次为空时写入，之后永久冻结在第一张图上）。
			await setCurrentImagePath(typeof value === 'string' ? value : '');
			await PickList.applyCurrentBackground();
			return;
		}
		const config = workspace.getConfiguration('backgroundCover');
		if (key === 'backgroundCover.opacity' || key === 'backgroundCover.blur') {
			// 独立模式下透明度/模糊度按窗口+工作区记录在 globalState 里，让每个
			// 窗口的 webview 显示各自的值；共用模式下才回写全局 settings.json。
			const num = typeof value === 'number' ? value : parseFloat(value);
			if (Number.isNaN(num)) { return; }
			if (key === 'backgroundCover.opacity') {
				await setCurrentOpacity(num, config);
			} else {
				await setCurrentBlur(num, config);
			}
			// 配置对象是快照，保存后重新读取，避免共享模式应用上一次的值。
			PickList.needAutoUpdate(workspace.getConfiguration('backgroundCover'));
			return;
		}
		await config.update(key.replace(/^backgroundCover\./, ''), value, true);
		if (key === 'backgroundCover.perWindowBackground' || key === 'backgroundCover.activePlaylist') {
			// 重新应用 / 随机换图交给 onDidChangeConfiguration 统一处理，避免重复触发。
			return;
		}
		PickList.needAutoUpdate(workspace.getConfiguration('backgroundCover'));
	}));

	// Initialize context
	commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');

	// A4: 主题感知混合模式已改为注入 CSS 的变量 + :has() 即时适配（见 backgroundCss.ts），
	// 不再需要监听主题变化并弹窗确认 / 重打补丁 / 重载窗口。

	// 安装/升级后不再弹「更新内容」提示：用户明确不希望重装后被弹窗打断。
}

// 检查 VSCode 版本是否变化
async function checkVSCodeVersionChanged(context: ExtensionContext): Promise<boolean> {
	// 获取配置
	let config = workspace.getConfiguration('backgroundCover');
	const resolved = resolveCurrentImagePath(config.imagePath || '');
	if (!resolved && !hasCurrentImageRecord()) {
		return false;
	}

	// 从全局状态中获取上次记录的 VSCode 版本
	let lastVSCodeVersion = context.globalState.get('vscode_version');
	// 如果版本不同，说明 VSCode 更新了
	if (lastVSCodeVersion && lastVSCodeVersion !== vscodeVersion) {
		// 弹出提示框确认是否更新背景
		const value = await window.showInformationMessage(
			`检测到 VS Code 已从 ${lastVSCodeVersion} 更新到 ${vscodeVersion}，背景补丁可能已被重置。是否重新应用并重载窗口？`,
			'应用并重载',
			'稍后'
		);

		if (value === '应用并重载') {
			// Update the stored version BEFORE any operation that might reload/close the window
			await context.globalState.update('vscode_version', vscodeVersion);

			// Apply the background patch
			const requiresReload = await PickList.applyCurrentBackground();
			if (requiresReload) {
				// VSCode updates replace workbench files; the Electron main process has
				// already cached the compiled bytecode of the old (unpatched) workbench.
				// A soft reload (workbench.action.reloadWindow) only rebuilds the renderer
				// process and still pulls from the stale cache. A full restart is required
				// to clear the main process cache and recompile the patched file.
				await promptRestartWindow();
			} else {
				window.setStatusBarMessage('背景已应用。', 5000);
			}
		} else {
			// User chose "Later / 稍后" — still update the version so we don't prompt again
			await context.globalState.update('vscode_version', vscodeVersion);
		}

		return true;
	}

	// 修复：首次运行或版本未记录时，也需要更新版本号，防止下次误判
	if (!lastVSCodeVersion) {
		await context.globalState.update('vscode_version', vscodeVersion);
	}

	return false;
}

/**
 * 启动时把渲染层首帧实际在用的背景（共享 CSS 里那张图）记到本窗口。
 * per-window 模式下本窗口记录只有在真正应用过一次之后才存在，而窗口刚打开时
 * 屏幕上显示的其实是共享 CSS 的图 —— 少了这一步，Studio 面板会一直显示
 * "未设置"，直到启动随机换图完成或用户手动刷新才同步。
 */
async function seedCurrentImageFromRenderedCss(): Promise<void> {
	if (hasCurrentSessionRecord()) { return; }
	const rendered = await readRenderedImagePath();
	if (rendered) {
		await setCurrentImagePath(rendered);
	}
}

async function promptRestartWindow(): Promise<void> {
	const value = await window.showInformationMessage(
		'背景补丁已应用，但需要完全关闭并重新打开 VS Code 才能生效（软重载不会清除编译缓存）。是否现在退出？',
		'退出',
		'稍后'
	);
	if (value === '退出') {
		await commands.executeCommand('workbench.action.quit');
	}
}

// this method is called when your extension is deactivated
export function deactivate() {
	PickList.stopAutoRandomTask();
}
