import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { commands, env, Uri, window, WorkspaceConfiguration, UIKind } from 'vscode';
import * as lockfile from 'proper-lockfile';
import version from './version';
import { SudoPromptHelper } from './SudoPromptHelper';
import * as fse from 'fs-extra';
import { getContext } from './global';
import { getSessionHash, getWindowCssFileName, isPerWindowEnabled } from './windowBackground';
import { detectPatchStateFromFile, PatchState, BOOTSTRAP_VERSION } from './patchState';
import { expandPathVariables, hasFileExtension, isVideoFile, pickRandomFromFolder } from './pathUtil';
import {
    getCorruptionWarningCss,
    getTransitionDeclaration,
    getTransitionReducedMotionCss,
    resolveBlendModeDeclaration,
    resolveBlendModeValue,
    resolveThemeBlendRules
} from './backgroundCss';
import { IMAGE_FADE_JS, PRELOAD_IMAGE_JS } from './loaderFragments';
import {
    clearPatchBlock,
    hasPatchBlock,
    patchMediaCsp,
    restoreMediaCsp,
    patchCodeServerWorkbenchHtml,
    clearCodeServerWorkbenchHtmlPatch
} from './patchCleanup';
import {
    BackgroundApplyCancelledError,
    BackgroundPatchError
} from './downloadError';

export {
    BackgroundApplyCancelledError,
    BackgroundPatchError
} from './downloadError';

interface AdditionalBundle {
    // Path relative to env.appRoot/out, e.g. 'vs/sessions/sessions.desktop.main.js'.
    relativePath: string;
}

interface WorkbenchTarget {
    name: string;
    root: string;
    js: string;
    css: string;
    bak: string;
    html?: string;
    // Additional renderer bundles that should receive the same loader IIFE so
    // VSCode auxiliary windows (AgentView / Open Agents Window) also pick up
    // the background. CSS is still authored once in the main workbench dir;
    // each bundle just self-injects a <style> referencing it.
    additionalBundles?: AdditionalBundle[];
}
/**
 * 文件路径配置，支持服务器模式
 */
const WORKBENCH_TARGETS: WorkbenchTarget[] = [
    {
        name: 'desktop', // vscode目录
        root: path.join(env.appRoot, "out", "vs", "workbench"), // 需要hook的文件目录
        js: 'workbench.desktop.main.js', // 需要hook的css文件名
        css: 'workbench.desktop.main.css', // 需要hook的js文件名
        bak: 'workbench.desktop.main.js.bak', // 备份文件名
        // AgentView (Agent Sessions) auxiliary window — separate Electron BrowserWindow
        // loaded from sessions.html → sessions.desktop.main.js. Patching it lets the
        // background show up there too. Optional: the file is only present in VSCode
        // builds that ship the AgentView; older builds will be skipped at runtime.
        additionalBundles: [
            { relativePath: path.join('vs', 'sessions', 'sessions.desktop.main.js') },
            // Cursor Agent Window (codename "Glass") — same workbench dir but a
            // separate renderer bundle picked when the window config has glass=true.
            { relativePath: path.join('vs', 'workbench', 'workbench.glass.main.js') }
        ]
    },
    {
        name: 'code-server',
        root: path.join(env.appRoot, "out", "vs", "code", "browser", "workbench"),
        js: 'workbench.js',
        css: 'workbench.css',
        bak: 'workbench.js.bak',
        html: 'workbench.html'
    }
];

// 选择当前运行环境对应的文件路径
function getWorkbenchTarget(): WorkbenchTarget {
    const preferredHost = determineHostPreference();

    const pickByName = (name: string): WorkbenchTarget | undefined => {
        return WORKBENCH_TARGETS.find((target) => target.name === name && fs.existsSync(path.join(target.root, target.js)));
    };

    if (preferredHost === 'desktop') {
        const desktopTarget = pickByName('desktop');
        if (desktopTarget) {
            return desktopTarget;
        }
    }

    if (preferredHost === 'code-server') {
        const webTarget = pickByName('code-server');
        if (webTarget) {
            return webTarget;
        }
    }

    return pickByName('desktop') || pickByName('code-server') || WORKBENCH_TARGETS[0];
}

function determineHostPreference(): 'desktop' | 'code-server' | undefined {
    const appHost = typeof env.appHost === 'string' ? env.appHost.toLowerCase() : undefined;
    if (appHost === 'desktop') {
        return 'desktop';
    }
    if (appHost === 'web') {
        return 'code-server';
    }

    if (env.uiKind === UIKind.Desktop) {
        return 'desktop';
    }
    if (env.uiKind === UIKind.Web) {
        return 'code-server';
    }

    const appName = (env.appName || '').toLowerCase();
    if (appName.includes('code-server') || appName.includes('vscode server')) {
        return 'code-server';
    }

    return undefined;
}

// 各路径静态变量
const selectedWorkbench = getWorkbenchTarget();
const JS_FILE_PATH = path.join(selectedWorkbench.root, selectedWorkbench.js);
const CSS_FILE_PATH = path.join(selectedWorkbench.root, selectedWorkbench.css);
const BAK_FILE_PATH = path.join(selectedWorkbench.root, selectedWorkbench.bak);
const HTML_FILE_PATH = selectedWorkbench.html ? path.join(selectedWorkbench.root, selectedWorkbench.html) : undefined;
const CUSTOM_CSS_FILE_NAME = 'css-background-cover.css';
const CUSTOM_JS_FILE_NAME = 'js-background-cover.js';
// 共用模式下随 reload trigger 一起下发的固定 token，注入端见到它就回到共享 CSS。
const SHARED_CSS_TOKEN = 'shared';
export const CUSTOM_CSS_FILE_PATH = path.join(selectedWorkbench.root, CUSTOM_CSS_FILE_NAME);
export const WORKBENCH_DIR = selectedWorkbench.root;
export const CUSTOM_JS_FILE_PATH = path.join(selectedWorkbench.root, CUSTOM_JS_FILE_NAME);
const APP_OUT_PATH = path.join(env.appRoot, 'out');
// Each entry is an additional bundle that needs the same loader IIFE injected
// (e.g. sessions.desktop.main.js for the AgentView window). Bak path mirrors
// the original with a .bak suffix so the file can be restored later.
const ADDITIONAL_BUNDLE_PATHS: { jsPath: string; bakPath: string }[] = (selectedWorkbench.additionalBundles ?? []).map((b) => ({
    jsPath: path.join(APP_OUT_PATH, b.relativePath),
    bakPath: path.join(APP_OUT_PATH, b.relativePath + '.bak')
}));
// Exported so the standalone vscode:uninstall script can use the same set
// when restoring files at extension removal time.
export const ADDITIONAL_BUNDLE_RELATIVE_PATHS: string[] = (selectedWorkbench.additionalBundles ?? []).map((b) => b.relativePath);
const IS_CODE_SERVER_TARGET = selectedWorkbench.name === 'code-server';
const WEB_RELATIVE_CSS_PATH = IS_CODE_SERVER_TARGET ? getWebRelativePath(CUSTOM_CSS_FILE_PATH) : undefined;
const WEB_RELATIVE_JS_PATH = IS_CODE_SERVER_TARGET ? getWebRelativePath(CUSTOM_JS_FILE_PATH) : undefined;
const CUSTOM_ASSET_DIR = path.join(selectedWorkbench.root, 'background-cover-assets');
const RELATIVE_URL_PLACEHOLDER = '__BACKGROUND_COVER_BASE__';
// 桌面端 workbench 的 CSP 只允许 media-src 'self'，本地视频经 vscode-file:// 由
// main.js 的 net.fetch(file://) 代理返回时缺少 Accept-Ranges（Electron 43 起不再
// 为 file:// 补 Range 头），Chromium 150 的 <video> 因此报 "no supported sources"。
// 修复方案：渲染层把 vscode-file 的视频 fetch 成 blob 再播放，并放行 CSP 的
// media-src blob:/data:。这里记录需要同步放开 media-src 的 HTML 入口文件
// （主 workbench + sessions 辅助窗口共用同一份 CSP 规则）。
const DESKTOP_HTML_ENTRIES = [
    path.join(APP_OUT_PATH, 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
    path.join(APP_OUT_PATH, 'vs', 'sessions', 'electron-browser', 'sessions.html')
];

// 本进程内已确认「补丁块 == 期望内容」的 bundle：路径 → 补丁 hash + 文件 mtime/size。
// bootstrap 在同一扩展版本内是固定的，换图只改外部 CSS/JS，没必要每次都把十几 MB 的
// workbench bundle 读进来做正则比对；文件被 VS Code 更新或被别处改写时 mtime/size 会变，
// 自然落回完整校验。
const verifiedBundles = new Map<string, { hash: string; mtimeMs: number; size: number }>();

async function statSignature(filePath: string): Promise<{ mtimeMs: number; size: number } | undefined> {
    try {
        const st = await fse.stat(filePath);
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
        return undefined;
    }
}

async function markBundleVerified(filePath: string, hash: string): Promise<void> {
    const sig = await statSignature(filePath);
    if (sig) {
        verifiedBundles.set(filePath, { hash, ...sig });
    } else {
        verifiedBundles.delete(filePath);
    }
}

function getWebRelativePath(filePath: string): string | undefined {
    try {
        const relativePath = path.relative(APP_OUT_PATH, filePath);
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return undefined;
        }
        return relativePath.split(path.sep).join('/');
    } catch (error) {
        console.warn(`[FileDom] Failed to compute web path for ${filePath}:`, error);
        return undefined;
    }
}

enum SystemType {
    WINDOWS = 'Windows_NT',
    MACOS = 'Darwin',
    LINUX = 'Linux'
}

// One elevated grant per directory per process. New per-window CSS files keep
// appearing under workbench/, so unlocking the folder once avoids a UAC prompt
// on every new window.
const dirUnlockInFlight = new Map<string, Promise<void>>();

function quoteWinPath(filePath: string): string {
    return `"${filePath}"`;
}

/** POSIX shell 单引号转义：sudo 下路径里的 $ / 反引号 / 双引号都不会被解释。 */
function quotePosixPath(filePath: string): string {
    return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

function quoteShellPath(filePath: string): string {
    return os.type() === SystemType.WINDOWS ? quoteWinPath(filePath) : quotePosixPath(filePath);
}

async function unlockDir(dirPath: string): Promise<void> {
    window.setStatusBarMessage(
        '正在开放背景文件目录写入权限，请在弹出的授权窗口中确认一次。 / Granting write access to the background folder. Please confirm the permission prompt once.',
        15000
    );
    const systemType = os.type();
    if (systemType === SystemType.WINDOWS) {
        const quoted = quoteWinPath(dirPath);
        // (OI)(CI) = new files and subfolders inherit Users:F, so later windows
        // can create css-background-cover.<session>.css without another prompt.
        await SudoPromptHelper.exec(
            `takeown /f ${quoted} /a & icacls ${quoted} /grant "Users:(OI)(CI)F"`
        );
        return;
    }
    if (systemType === SystemType.MACOS || systemType === SystemType.LINUX) {
        await SudoPromptHelper.exec(`chmod a+rwx ${quotePosixPath(dirPath)}`);
    }
}

async function ensureDirWritable(dirPath: string): Promise<void> {
    const normalized = path.normalize(dirPath);
    const existing = dirUnlockInFlight.get(normalized);
    if (existing) {
        await existing;
        return;
    }
    const task = unlockDir(normalized).catch((error) => {
        dirUnlockInFlight.delete(normalized);
        throw error;
    });
    dirUnlockInFlight.set(normalized, task);
    await task;
}

function isElevationCancelled(error: unknown): boolean {
    return /did not grant permission|canceled|cancelled/i.test(String(error));
}

export async function removeBackgroundCoverCssFiles(): Promise<void> {
    if (!(await fse.pathExists(WORKBENCH_DIR))) {
        return;
    }
    let names: string[] = [];
    try {
        names = await fse.readdir(WORKBENCH_DIR);
    } catch (error) {
        console.warn('[FileDom] Failed to list workbench CSS files:', error);
        return;
    }
    const cssFiles = names.filter(name => name.startsWith('css-background-cover') && name.endsWith('.css'));
    const systemType = os.type();
    let dirUnlocked = false;
    for (const name of cssFiles) {
        const filePath = path.join(WORKBENCH_DIR, name);
        try {
            await fse.remove(filePath);
            continue;
        } catch {
            if (!dirUnlocked) {
                try {
                    await ensureDirWritable(WORKBENCH_DIR);
                    dirUnlocked = true;
                    await fse.remove(filePath);
                    continue;
                } catch (error) {
                    if (isElevationCancelled(error)) {
                        throw error;
                    }
                }
            }
        }
        try {
            if (systemType === SystemType.WINDOWS) {
                await SudoPromptHelper.exec(`del ${quoteWinPath(filePath)}`);
            } else {
                await SudoPromptHelper.exec(`rm ${quotePosixPath(filePath)}`);
            }
        } catch (error) {
            console.warn(`[FileDom] Failed to remove ${filePath}:`, error);
        }
    }
}

// 每个窗口会话都会新建一份 css-background-cover.<session>.css，而 session 在重载
// 后就会变，旧文件不会再有人读。这里做 best-effort 回收：绝不提权、绝不弹窗，删不掉
// 就留给下次启动。按 mtime 判定过期，误删一个长期开着又没换过图的窗口的文件时，
// 该窗口 loadCss 的 fetch 会失败并保留已在 DOM 里的样式，不会白屏。
const WINDOW_CSS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_CSS_FILE_RE = /^css-background-cover\..+\.css$/;

export async function collectStaleWindowCssFiles(): Promise<void> {
    try {
        if (!(await fse.pathExists(WORKBENCH_DIR))) {
            return;
        }
        const currentName = getWindowCssFileName();
        const names = await fse.readdir(WORKBENCH_DIR);
        const now = Date.now();
        for (const name of names) {
            if (name === CUSTOM_CSS_FILE_NAME || name === currentName) {
                continue;
            }
            if (!WINDOW_CSS_FILE_RE.test(name)) {
                continue;
            }
            const filePath = path.join(WORKBENCH_DIR, name);
            try {
                const stat = await fse.stat(filePath);
                if (now - stat.mtimeMs < WINDOW_CSS_MAX_AGE_MS) {
                    continue;
                }
                await fse.remove(filePath);
            } catch {
                // 被占用或无写权限：跳过，下次启动再试。
            }
        }
    } catch (error) {
        console.warn('[FileDom] Failed to collect stale window CSS files:', error);
    }
}

/**
 * 补丁状态机（A1）：按主 workbench bundle 的实际内容标记判定补丁状态。
 * - latest：已按当前 bootstrap 版本打过补丁；
 * - legacy：打过旧版补丁（需要升级）；
 * - none：文件被还原 / VS Code 更新替换 / 首次安装。
 * 主文件缺失时也返回 none，保持静默。
 */
export async function detectPatchState(): Promise<PatchState> {
    return detectPatchStateFromFile(JS_FILE_PATH);
}

export class FileDom {
    private readonly filePath: string;
    private readonly extName = "backgroundCover";
    private imagePath: string;
    private readonly imageOpacity: number;
    private readonly sizeModel: string;
    private readonly blur: number;
    private readonly blendModel: string;
    private readonly systemType: string;
    private readonly forceHttpsUpgrade: boolean;
    private readonly transitionEnabled: boolean;
    private readonly shouldApply: () => boolean;
    private readonly windowCssFilePath: string;
    public readonly windowCssToken: string;
    private readonly silent: boolean;
    private upCssContent: string = '';
    private bakStatus: boolean = false;
    private bakJsContent: string = '';
    private workConfig: WorkspaceConfiguration;
    private initializePromise?: Promise<void>;
    private isVideo: boolean = false;
    public didUpdateCss: boolean = false;
    public didUpdateDynamicJs: boolean = false;

    constructor(
        workConfig: WorkspaceConfiguration,
        imagePath: string,
        opacity: number,
        sizeModel: string = 'cover',
        blur: number = 0,
        blendModel: string = '',
        shouldApply: () => boolean = () => true,
        silent: boolean = false
    ) {
        this.workConfig = workConfig;
        this.filePath = JS_FILE_PATH;
        this.imagePath = imagePath;
        this.imageOpacity = Math.min(opacity, 0.8);
        this.sizeModel = sizeModel || "cover";
        this.blur = blur;
        this.blendModel = blendModel || this.workConfig.get('blendModel', '');
        this.systemType = os.type();
        this.forceHttpsUpgrade = this.workConfig.get('forceHttpsUpgrade', true);
        // 背景切换动画始终启用；仍尊重系统减少动态效果设置。
        this.transitionEnabled = true;
        this.shouldApply = shouldApply;
        // 共用模式(perWindowBackground=false)下直接写共享 CSS 文件，并用固定 token
        // 让注入端把 __backgroundCoverCssUrl 复位到共享地址。
        const perWindow = isPerWindowEnabled();
        this.windowCssToken = perWindow ? getSessionHash() : SHARED_CSS_TOKEN;
        this.windowCssFilePath = perWindow
            ? path.join(selectedWorkbench.root, getWindowCssFileName())
            : CUSTOM_CSS_FILE_PATH;
        this.silent = silent;
        
        this.initializePromise = this.initializeImage().catch((error: unknown) => {
            console.error('[FileDom] Failed to preprocess image:', error);
            throw error;
        });
    }

    // 检测是否为视频文件
    private checkIsVideo(filePath: string): boolean {
        return isVideoFile(filePath);
    }

    /**
     * 若 imagePath 指向一个本地文件夹（无扩展名且是目录），随机返回其中一张
     * 图片/视频的完整路径；URL、data:、单文件或不存在一律返回 undefined。
     */
    private async resolveFolderBackground(): Promise<string | undefined> {
        const lower = this.imagePath.toLowerCase();
        if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:')) {
            return undefined;
        }
        if (hasFileExtension(this.imagePath)) {
            return undefined;
        }
        return pickRandomFromFolder(this.imagePath);
    }

    // 本地图片转换为vscode可访问路径
    private async initializeImage(): Promise<void> {
        // A3：展开 ~ / ${ENV} / $ENV；无扩展名的本地路径按「文件夹」处理，随机取一张
        // 作为本次背景（支持直接把壁纸目录填进 imagePath）。
        // 注意只对本地路径展开：http/data URL 的查询串里可能含 $ 字面量，不能动。
        const lowerInput = this.imagePath.toLowerCase();
        if (!lowerInput.startsWith('http://') && !lowerInput.startsWith('https://') && !lowerInput.startsWith('data:')) {
            this.imagePath = expandPathVariables(this.imagePath);
        }
        const folderPicked = await this.resolveFolderBackground();
        if (folderPicked) {
            this.imagePath = folderPicked;
        }

        let lowerPath = this.imagePath.toLowerCase();

        this.isVideo = this.checkIsVideo(this.imagePath);

        if (
            !lowerPath.startsWith('http://') &&
            !lowerPath.startsWith('https://') &&
            !lowerPath.startsWith('data:')
        ) {
            try {
                if (IS_CODE_SERVER_TARGET) {
                    const assetUrl = await this.prepareCodeServerAsset(this.imagePath);
                    if (assetUrl) {
                        this.imagePath = assetUrl;
                    } else if (!this.isVideo) {
                        await this.imageToBase64();
                    } else {
                        this.localImgToVsc();
                    }
                } else {
                    this.localImgToVsc();
                }
            } catch (e) {
                if (!this.isVideo) {
                    await this.imageToBase64();
                } else {
                    this.localImgToVsc();
                }
            }
        }
    }

    //应用补丁安装
    public async install(): Promise<boolean> {
        if (!(await this.checkFileExists())) {
            if (this.silent) {
                throw new BackgroundPatchError('Workbench file is missing');
            }
            return false;
        }

        await this.handleLegacyCleanup();
        await this.ensureBackup();

        const patched = await this.applyPatch();
        if (patched) {
            // 视频背景依赖渲染层 fetch(vscode-file://).blob() 播放，须放行 CSP 的
            // media-src。主窗口 + 辅助窗口(sessions) 的 HTML 都要同步处理，
            // 缺文件（老版本 VSCode）时静默跳过。
            try {
                await this.patchMediaCspForEntries();
            } catch (e) {
                console.warn('[FileDom] Failed to patch media CSP:', e);
            }
        }
        return patched;
    }

    // 检查文件是否存在
    private async checkFileExists(): Promise<boolean> {
        const isExist = await fse.pathExists(this.filePath);
        if (!isExist) {
            if (!this.silent) {
                await window.showErrorMessage(`文件不存在，提醒开发者修复吧！`);
            }
            return false;
        }
        return true;
    }

    // 旧版本清理
    private async handleLegacyCleanup(): Promise<void> {
        const vsContext = getContext();
        const clearCssNum = Number(vsContext.globalState.get('ext_backgroundCover_clear_v2')) || 0;

        if (clearCssNum <= 5) {
            const cssContent = await this.getContent(CSS_FILE_PATH);
            if (this.getPatchContent(cssContent)) {
                this.upCssContent = this.clearCssContent(cssContent);
            } else {
                vsContext.globalState.update('ext_backgroundCover_clear_v2', clearCssNum + 1);
            }
        }
    }

    // 是否存在备份文件
    private async ensureBackup(): Promise<void> {
        const bakExist = await fse.pathExists(BAK_FILE_PATH);
        if (!bakExist) {
            this.bakStatus = true;
            window.setStatusBarMessage(`首次使用正在获取权限及备份文件，处理中... / First use is getting permission and backing up files, processing...`, 10000);
        }
    }

    // 应用补丁
    private async applyPatch(): Promise<boolean> {
        const lockPath = path.join(os.tmpdir(), 'vscode-background.lock');
        let release: (() => Promise<void>) | undefined;

        try {
            await this.ensureInitialized();

            if (!this.shouldApply()) {
                throw new BackgroundApplyCancelledError();
            }

            if (!(await fse.pathExists(lockPath))) {
                await fse.writeFile(lockPath, '', 'utf-8');
            }

            release = await lockfile.lock(lockPath, {
                retries: {
                    retries: 10,
                    minTimeout: 100,
                    maxTimeout: 1000,
                    randomize: true
                },
                stale: 20000
            });

            if (!this.shouldApply()) {
                throw new BackgroundApplyCancelledError();
            }

            // Save dynamic assets first. The patched workbench bundle only keeps a
            // stable bootstrap; feature code lives in cache-busted external files.
            try {
                this.didUpdateCss = await this.saveCssContent();
                this.didUpdateDynamicJs = await this.saveDynamicJsContent();
            } catch (e) {
                // 静默模式(定时自动换图)不能弹窗，直接抛给上层去挑下一张候选图。
                if (this.silent) {
                    throw new BackgroundPatchError(String(e));
                }
                window.showErrorMessage('Failed to write background assets: ' + e);
                return false;
            }

            const content = this.getJs().trim();
            if (!content) {
                if (this.silent) {
                    throw new BackgroundPatchError('Generated patch content is empty');
                }
                return false;
            }

            const patchHash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);

            // Patch main workbench bundle. captureBak: true means if no backup exists
            // yet we save the pre-patch content for safety.
            const mainResult = await this.patchOneJsFile(this.filePath, BAK_FILE_PATH, content, true);
            if (mainResult === 'failed') {
                if (this.silent) {
                    throw new BackgroundPatchError('Failed to patch workbench file');
                }
                return false;
            }

            // Patch any additional bundles (AgentView etc). Skipping ones that don't
            // exist keeps us forward/backward compatible across VSCode versions.
            let anyAdditionalChanged = false;
            for (const { jsPath, bakPath } of ADDITIONAL_BUNDLE_PATHS) {
                if (!(await fse.pathExists(jsPath))) continue;
                const r = await this.patchOneJsFile(jsPath, bakPath, content, false);
                if (r === 'patched') anyAdditionalChanged = true;
                if (r === 'failed') {
                    // Don't abort the whole install — the main window is already
                    // fine, the auxiliary one just won't have a background.
                    console.error(`[FileDom] Failed to patch additional bundle: ${jsPath}`);
                }
            }

            const htmlChanged = await this.saveCodeServerHtmlContent(`${version}-${patchHash}`);
            // Reload window if any JS bundle was rewritten or the HTML cache key
            // changed. The main reload covers main + sessions windows that are
            // currently open in this VSCode session.
            this.requiresReload = mainResult === 'patched' || anyAdditionalChanged || htmlChanged;
            return true;

        } catch (error: any) {
            if (error instanceof BackgroundApplyCancelledError) {
                throw error;
            }
            // 静默模式必须先于 handlePatchError 返回：后者是个 await 住的模态框，
            // 会把定时换图的调度器(isAutoRunning)一直卡住，而且 BackgroundPatchError
            // 本来就是上面几处静默分支自己抛的，不该再被当成未知错误弹一次窗。
            if (this.silent) {
                if (error instanceof BackgroundPatchError) {
                    throw error;
                }
                console.error('[FileDom] applyPatch error (silent):', error);
                throw new BackgroundPatchError((error && (error.message || error.toString())) || 'Failed to install background patch');
            }
            await this.handlePatchError(error);
            return false;
        } finally {
            if (release) {
                try {
                    await release();
                } catch (err) {
                    console.error(`Failed to unlock ${lockPath}:`, err);
                }
            }
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initializePromise) {
            return;
        }
        const pending = this.initializePromise;
        try {
            await pending;
            if (this.initializePromise === pending) {
                this.initializePromise = undefined;
            }
        } catch (error) {
            if (this.initializePromise === pending) {
                this.initializePromise = undefined;
            }
            throw error;
        }
    }

    /**
     * Categorize an installation error (permission, lock, missing file, unknown)
     * and offer the user contextual recovery actions instead of a flat message.
     */
    private async handlePatchError(error: any): Promise<void> {
        const rawMsg: string = (error && (error.message || error.toString())) || 'Unknown error';
        const code: string = (error && error.code) ? String(error.code) : '';
        const lower = (rawMsg + ' ' + code).toLowerCase();

        type Kind = 'permission' | 'locked' | 'missing' | 'unknown';
        let kind: Kind = 'unknown';
        if (/eacces|eperm|access\s*denied|operation\s*not\s*permitted|权限/.test(lower)) {
            kind = 'permission';
        } else if (/ebusy|lock\s*file|already\s*being\s*held|locked/.test(lower)) {
            kind = 'locked';
        } else if (/enoent|no\s*such\s*file|not\s*found/.test(lower)) {
            kind = 'missing';
        }

        const intro: Record<Kind, string> = {
            permission: '权限不足：写入 VSCode 核心文件失败。请尝试以管理员身份重新打开 VSCode，或关闭其他正在写入该文件的进程。 / Permission denied while patching VSCode core file.',
            locked:     '文件被占用：另一个 VSCode 实例可能正在写入相同文件。请关闭其他窗口后重试。 / The workbench file is locked by another process.',
            missing:    '未找到 VSCode 核心文件：可能在你升级 / 修复 VSCode 后路径已变化。 / Required VSCode core file is missing.',
            unknown:    '安装补丁失败 / Failed to install background patch.'
        };

        const buttons: string[] = ['Retry / 重试'];
        if (kind === 'permission' && this.systemType === SystemType.WINDOWS) {
            buttons.push('Reopen as Admin / 以管理员身份重开');
        }
        buttons.push('Open Log / 查看日志');

        const detail = `${intro[kind]}\n\n[${kind.toUpperCase()}] ${rawMsg}`;
        console.error('[FileDom] applyPatch error:', error);

        const choice = await window.showErrorMessage(detail, ...buttons);
        if (!choice) { return; }
        if (choice === 'Retry / 重试') {
            // Re-attempt without recursion blowing the stack; small delay so any
            // transient lock has a chance to clear. Restart image preprocessing
            // so a previous failed download is not reused.
            this.initializePromise = this.initializeImage().catch((error: unknown) => {
                console.error('[FileDom] Failed to preprocess image:', error);
                throw error;
            });
            setTimeout(() => { void this.applyPatch(); }, 300);
            return;
        }
        if (choice === 'Reopen as Admin / 以管理员身份重开') {
            await window.showInformationMessage(
                '请手动关闭当前 VSCode 窗口，然后右键 VSCode 图标 → "以管理员身份运行"。 / Close VSCode, then right-click its icon and choose "Run as administrator".',
                { modal: true },
                'OK'
            );
            return;
        }
        if (choice === 'Open Log / 查看日志') {
            try {
                await commands.executeCommand('workbench.action.toggleDevTools');
            } catch (e) {
                console.warn('[FileDom] toggleDevTools failed:', e);
            }
            return;
        }
    }

    // Patch one JS bundle: replace any existing background-cover marker block
    // with `content`, or append it if absent. Optionally captures a pre-patch
    // backup the first time it sees the file unpatched.
    //
    // Returns 'unchanged' if the file already matches, 'patched' if rewritten,
    // 'failed' if the write didn't go through.
    private async patchOneJsFile(
        jsPath: string,
        bakPath: string,
        content: string,
        captureBak: boolean
    ): Promise<'unchanged' | 'patched' | 'failed'> {
        const result = await this.patchOneJsFileInner(jsPath, bakPath, content, captureBak);
        const hash = crypto.createHash('md5').update(content.trim()).digest('hex');
        if (result === 'failed') {
            verifiedBundles.delete(jsPath);
        } else {
            await markBundleVerified(jsPath, hash);
        }
        return result;
    }

    private async patchOneJsFileInner(
        jsPath: string,
        bakPath: string,
        content: string,
        captureBak: boolean
    ): Promise<'unchanged' | 'patched' | 'failed'> {
        try {
            const cached = verifiedBundles.get(jsPath);
            if (cached && cached.hash === crypto.createHash('md5').update(content.trim()).digest('hex')) {
                const sig = await statSignature(jsPath);
                if (sig && sig.mtimeMs === cached.mtimeMs && sig.size === cached.size) {
                    return 'unchanged';
                }
            }

            const currentContent = await this.getContent(jsPath);
            const markerRe = new RegExp(`\\/\\*ext-${this.extName}-start\\*\\/([\\s\\S]*?)\\/\\*ext-${this.extName}-end\\*\\/`);
            const match = currentContent.match(markerRe);
            if (match && match[0].trim() === content.trim()) {
                return 'unchanged';
            }

            const stripped = this.clearCssContent(currentContent);

            // Capture the original (pre-patch) content as backup if requested
            // and we haven't backed up before. Two cases handled differently:
            // - Main bundle: relies on the bakStatus/bakJsContent flow that the
            //   constructor + ensureBackup() already prepared for `this.filePath`.
            // - Additional bundles: write directly here on first sight.
            if (captureBak) {
                if (jsPath === this.filePath) {
                    if (this.bakStatus) {
                        this.bakJsContent = stripped;
                    }
                } else {
                    if (!(await fse.pathExists(bakPath))) {
                        try {
                            await this.writeWithPermission(bakPath, stripped);
                        } catch (err) {
                            console.error(`[FileDom] Failed to write backup ${bakPath}:`, err);
                        }
                    }
                }
            } else if (!(await fse.pathExists(bakPath))) {
                // Even when not "first-time captureBak", make sure each additional
                // bundle gets a one-shot backup the first time we touch it. This
                // way uninstall has something to fall back to if the marker block
                // ever drifts.
                try {
                    await this.writeWithPermission(bakPath, stripped);
                } catch (err) {
                    console.error(`[FileDom] Failed to write backup ${bakPath}:`, err);
                }
            }

            const newContent = stripped + content;
            if (jsPath === this.filePath) {
                // Keep main-bundle path going through the existing saveContent()
                // so the legacy upCssContent + bakFile machinery still fires.
                return (await this.saveContent(newContent)) ? 'patched' : 'failed';
            }

            try {
                await this.writeWithPermission(jsPath, newContent);
                return 'patched';
            } catch (err) {
                console.error(`[FileDom] writeWithPermission failed for ${jsPath}:`, err);
                return 'failed';
            }
        } catch (err) {
            console.error(`[FileDom] patchOneJsFile error for ${jsPath}:`, err);
            return 'failed';
        }
    }

    // 获取单个文件权限（目录授权仍盖不住的已有受保护文件才走这里）
    public async getFilePermission(filePath: string): Promise<void> {
        try {
            const quoted = quoteShellPath(filePath);
            const exists = await fse.pathExists(filePath);
            if (this.systemType === SystemType.WINDOWS) {
                const create = exists ? '' : `echo. > ${quoted} & `;
                await SudoPromptHelper.exec(
                    `${create}takeown /f ${quoted} /a & icacls ${quoted} /grant Users:F`
                );
                return;
            }
            const chmodCmd = this.systemType === SystemType.MACOS ? 'chmod a+rwx' : 'chmod 666';
            if (exists) {
                await SudoPromptHelper.exec(`${chmodCmd} ${quoted}`);
            } else {
                await SudoPromptHelper.exec(`touch ${quoted} && ${chmodCmd} ${quoted}`);
            }
        } catch (error) {
            console.error(`Failed to get permission for ${filePath}:`, error);
            throw error;
        }
    }

    // 清理补丁内容
    public async uninstall(): Promise<boolean> {
        try {
            const content = this.clearCssContent(await this.getContent(this.filePath));
            await this.saveContent(content);

            // Strip our loader from any additional bundles (AgentView sessions
            // bundle on desktop). Missing files are tolerated — that just means
            // this VSCode build doesn't ship the auxiliary bundle.
            for (const { jsPath } of ADDITIONAL_BUNDLE_PATHS) {
                if (!(await fse.pathExists(jsPath))) continue;
                try {
                    const raw = await this.getContent(jsPath);
                    const cleaned = this.clearCssContent(raw);
                    if (cleaned !== raw) {
                        await this.writeWithPermission(jsPath, cleaned);
                    }
                } catch (err) {
                    console.error(`[FileDom] Failed to strip patch from ${jsPath}:`, err);
                }
            }

            // Remove CSS files (shared fallback + per-window copies)
            await removeBackgroundCoverCssFiles();

            if (await fse.pathExists(CUSTOM_JS_FILE_PATH)) {
                try {
                    await fse.remove(CUSTOM_JS_FILE_PATH);
                } catch {
                    if (this.systemType === SystemType.WINDOWS) {
                        await SudoPromptHelper.exec(`del "${CUSTOM_JS_FILE_PATH}"`);
                    } else {
                        await SudoPromptHelper.exec(`rm "${CUSTOM_JS_FILE_PATH}"`);
                    }
                }
            }

            await this.clearCodeServerHtmlContent();
            // 还原 CSP：卸载时把 media-src 里的 blob:/data: 放行撤掉。
            try {
                await this.restoreMediaCspForEntries();
            } catch (e) {
                console.warn('[FileDom] Failed to restore media CSP:', e);
            }

            return true;
        } catch (error) {
            await window.showErrorMessage(`卸载失败: ${error}`);
            return false;
        }
    }

    // 清除背景
    public async clearBackground(): Promise<boolean> {
        try {
            await this.writeWithPermission(this.windowCssFilePath, '');
            this.requiresReload = false;
            return true;
        } catch (error) {
            if (this.silent) {
                throw new BackgroundPatchError(`清除背景失败: ${error}`);
            }
            await window.showErrorMessage(`清除背景失败: ${error}`);
            return false;
        }
    }

    // 读取原文件内容
    private async getContent(filePath: string): Promise<string> {
        return await fse.readFile(filePath, 'utf-8');
    }

    /**
     * 视频背景修复（一）：放行 workbench CSP 的 media-src，允许渲染层用
     * blob:/data: 播放本地/在线视频。只改含 CSP meta 的 HTML 入口文件，
     * 幂等（重复安装不叠加）。入口列表桌面端覆盖主窗口 + sessions 辅助窗口，
     * code-server 复用 selectedWorkbench.html。
     */
    private getMediaCspEntries(): string[] {
        const entries: string[] = [];
        if (IS_CODE_SERVER_TARGET) {
            if (HTML_FILE_PATH) {
                entries.push(HTML_FILE_PATH);
            }
        } else {
            for (const htmlPath of DESKTOP_HTML_ENTRIES) {
                if (fse.pathExistsSync(htmlPath)) {
                    entries.push(htmlPath);
                }
            }
        }
        return entries;
    }

    private async patchMediaCspForEntries(): Promise<void> {
        for (const htmlPath of this.getMediaCspEntries()) {
            try {
                const raw = await this.getContent(htmlPath);
                const patched = patchMediaCsp(raw);
                if (patched !== raw) {
                    await this.writeWithPermission(htmlPath, patched);
                    if (htmlPath.indexOf('workbench.html') !== -1) {
                        console.log(`[FileDom] media CSP patched in ${htmlPath}`);
                    }
                }
            } catch (e) {
                console.warn(`[FileDom] Failed to patch media CSP in ${htmlPath}:`, e);
            }
        }
    }

    private async restoreMediaCspForEntries(): Promise<void> {
        for (const htmlPath of this.getMediaCspEntries()) {
            try {
                const raw = await this.getContent(htmlPath);
                const restored = restoreMediaCsp(raw);
                if (restored !== raw) {
                    await this.writeWithPermission(htmlPath, restored);
                }
            } catch (e) {
                console.warn(`[FileDom] Failed to restore media CSP in ${htmlPath}:`, e);
            }
        }
    }

    // 写入文件内容
    private async saveContent(content: string): Promise<boolean> {
        if (this.bakStatus) {
            await this.bakFile();
        }

        await this.writeWithPermission(this.filePath, content);

        if (this.upCssContent) {
            await this.writeWithPermission(CSS_FILE_PATH, this.upCssContent);
            this.upCssContent = '';
        }

        return true;
    }

    // 写入文件内容，带权限处理
    private async writeWithPermission(filePath: string, content: string): Promise<void> {
        try {
            await fse.writeFile(filePath, content, { encoding: 'utf-8' });
            return;
        } catch {
            // Install dir is protected; unlock the folder first.
        }
        try {
            await ensureDirWritable(path.dirname(filePath));
            await fse.writeFile(filePath, content, { encoding: 'utf-8' });
            return;
        } catch (error) {
            if (isElevationCancelled(error)) {
                throw error;
            }
            // Existing files (workbench js) can keep a restrictive ACL after the
            // directory grant. Unlock that one file and retry.
        }
        await this.getFilePermission(filePath);
        await fse.writeFile(filePath, content, { encoding: 'utf-8' });
    }

    // 写入备份文件
    private async bakFile(): Promise<void> {
        await this.writeWithPermission(BAK_FILE_PATH, this.bakJsContent);
    }

    public requiresReload: boolean = true;

    // 写入css内容
    private async saveCssContent(): Promise<boolean> {
        const css = this.getCss();
        let changed = true;
        try {
            if (await fse.pathExists(this.windowCssFilePath)) {
                const current = await fse.readFile(this.windowCssFilePath, 'utf-8');
                if (current === css) {
                    changed = false;
                }
            }
        } catch {
            // Fall through to write; permission handling below will surface real failures.
        }
        if (changed) {
            await this.writeWithPermission(this.windowCssFilePath, css);
        }
        // Shared file is only a pre-handshake fallback. Seed it when missing so a
        // brand-new window has something to show before this session's trigger.
        try {
            if (!(await fse.pathExists(CUSTOM_CSS_FILE_PATH))) {
                await this.writeWithPermission(CUSTOM_CSS_FILE_PATH, css);
            }
        } catch (error) {
            console.warn('[FileDom] Failed to seed shared CSS fallback:', error);
        }
        return changed;
    }

    private async saveDynamicJsContent(): Promise<boolean> {
        const js = this.getDynamicJs();
        try {
            if (await fse.pathExists(CUSTOM_JS_FILE_PATH)) {
                const current = await fse.readFile(CUSTOM_JS_FILE_PATH, 'utf-8');
                if (current === js) {
                    return false;
                }
            }
        } catch {
            // Fall through to write; permission handling below will surface real failures.
        }
        await this.writeWithPermission(CUSTOM_JS_FILE_PATH, js);
        return true;
    }

    // code-server 静态资源会被浏览器长缓存，给 workbench.js URL 增加版本参数以确保首次注入后能加载新文件。
    private async saveCodeServerHtmlContent(cacheKey: string): Promise<boolean> {
        if (!IS_CODE_SERVER_TARGET || !HTML_FILE_PATH || !(await fse.pathExists(HTML_FILE_PATH))) {
            return false;
        }

        const content = await this.getContent(HTML_FILE_PATH);
        const patchedContent = patchCodeServerWorkbenchHtml(content, cacheKey);

        if (patchedContent === content) {
            return false;
        }

        await this.writeWithPermission(HTML_FILE_PATH, patchedContent);
        return true;
    }

    private async clearCodeServerHtmlContent(): Promise<void> {
        if (!IS_CODE_SERVER_TARGET || !HTML_FILE_PATH || !(await fse.pathExists(HTML_FILE_PATH))) {
            return;
        }

        const content = await this.getContent(HTML_FILE_PATH);
        const patchedContent = clearCodeServerWorkbenchHtmlPatch(content);

        if (patchedContent !== content) {
            await this.writeWithPermission(HTML_FILE_PATH, patchedContent);
        }
    }

    // 获取要应用的js内容
    private getJs(): string {
        return `
        /*ext-${this.extName}-start*/
        /*ext.${this.extName}.bootstrap.${BOOTSTRAP_VERSION}*/
        ${this.getBootstrapJs()}
        /*ext-${this.extName}-end*/
        `;
    }

    private getDynamicJs(): string {
        return `
        /*ext.${this.extName}.ver.${version}*/
        ${this.getLoaderJs()}
        `;
    }

    private getBootstrapJs(): string {
        const jsDesktopUrl = Uri.file(CUSTOM_JS_FILE_PATH).with({ scheme: 'vscode-file', authority: 'vscode-app' }).toString();
        const escapedDesktopUrl = this.escapeTemplateLiteral(jsDesktopUrl);
        const webJsPath = WEB_RELATIVE_JS_PATH ? this.escapeTemplateLiteral(WEB_RELATIVE_JS_PATH) : '';
        const jsFileName = this.escapeTemplateLiteral(CUSTOM_JS_FILE_NAME);
        const workbenchJsName = this.escapeTemplateLiteral(selectedWorkbench.js);

        return `
        (function() {
            const dynamicDesktopUrl = '${escapedDesktopUrl}';
            const relativeDynamicPath = '${webJsPath}';
            const dynamicFileName = '${jsFileName}';
            const workbenchJsName = '${workbenchJsName}';
            const GLOBAL_KEY = '__backgroundCoverDynamicLoader';

            function withCacheBust(url) {
                const sep = url.indexOf('?') === -1 ? '?' : '&';
                return url + sep + 't=' + Date.now();
            }

            function deriveFromScript() {
                if (typeof document === 'undefined') {
                    return undefined;
                }

                const buildFromSrc = (src) => {
                    try {
                        return new URL(dynamicFileName, src).toString();
                    } catch (error) {
                        console.error('[BackgroundCover] Dynamic script URL resolve error:', error);
                        return undefined;
                    }
                };

                const current = document.currentScript;
                if (current && current.src) {
                    const candidate = buildFromSrc(current.src);
                    if (candidate) {
                        return candidate;
                    }
                }

                const scripts = document.getElementsByTagName ? document.getElementsByTagName('script') : [];
                for (let i = scripts.length - 1; i >= 0; i--) {
                    const tag = scripts[i];
                    if (tag && tag.src && tag.src.indexOf(workbenchJsName) !== -1) {
                        const candidate = buildFromSrc(tag.src);
                        if (candidate) {
                            return candidate;
                        }
                    }
                }

                return undefined;
            }

            function resolveDynamicUrl() {
                const scriptResolved = deriveFromScript();
                if (scriptResolved) {
                    return scriptResolved;
                }

                if (relativeDynamicPath) {
                    const bases = [];
                    const monacoEnv = typeof globalThis !== 'undefined' ? globalThis.MonacoEnvironment || {} : {};
                    if (monacoEnv.baseUrl) {
                        bases.push(monacoEnv.baseUrl);
                    }
                    if (monacoEnv.appOrigin) {
                        bases.push(monacoEnv.appOrigin);
                    }
                    if (typeof document !== 'undefined' && document.baseURI) {
                        bases.push(document.baseURI);
                    }
                    if (typeof window !== 'undefined' && window.location) {
                        const { origin, href } = window.location;
                        if (origin) {
                            bases.push(origin + '/');
                        }
                        if (href) {
                            const slashIndex = href.lastIndexOf('/');
                            if (slashIndex !== -1) {
                                bases.push(href.substring(0, slashIndex + 1));
                            }
                        }
                    }

                    for (const base of bases) {
                        try {
                            return new URL(relativeDynamicPath, base).toString();
                        } catch (error) {
                            console.error('[BackgroundCover] Dynamic base URL failed:', error);
                        }
                    }

                    if (!relativeDynamicPath.startsWith('http')) {
                        try {
                            return new URL(relativeDynamicPath, '/').toString();
                        } catch (error) {
                            console.error('[BackgroundCover] Dynamic relative URL failed:', error);
                        }
                    }
                }

                return dynamicDesktopUrl;
            }

            function disposePreviousDynamicJs() {
                try {
                    const previous = window[GLOBAL_KEY];
                    if (previous && typeof previous.dispose === 'function') {
                        previous.dispose();
                    }
                } catch (error) {
                    console.error('[BackgroundCover] Dynamic dispose failed:', error);
                }
            }

            const dynamicUrl = resolveDynamicUrl();
            // Workbench CSP enforces require-trusted-types-for 'script' with no
            // 'default' policy, so assigning a string to script.src throws.
            // Dynamic import() is not a Trusted Types sink and script-src 'self'
            // permits loading the sibling file, so load the module instead.
            let loadGeneration = 0;
            const maxLoadAttempts = 3;
            function loadDynamicJs() {
                const generation = ++loadGeneration;
                disposePreviousDynamicJs();

                const attemptLoad = (attempt) => {
                    if (generation !== loadGeneration) {
                        return;
                    }
                    try {
                        import(withCacheBust(dynamicUrl)).catch((error) => {
                            console.error('[BackgroundCover] Dynamic load error:', error);
                            if (generation === loadGeneration && attempt < maxLoadAttempts) {
                                setTimeout(() => attemptLoad(attempt + 1), (attempt + 1) * 1000);
                            }
                        });
                    } catch (error) {
                        console.error('[BackgroundCover] Dynamic import failed:', error);
                    }
                };
                attemptLoad(0);
            }

            window.__backgroundCoverBootstrap = { reload: loadDynamicJs };
            loadDynamicJs();
        })();
        `;
    }


    // 获取css内容
    private getCss(): string {
        const opacity = Math.min(this.imageOpacity, 0.8);
        const { sizeModelVal, repeatVal, positionVal } = this.getCssStyles();

        let rawPath = this.imagePath;
        const globalWindow = typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined;
        
        if (this.forceHttpsUpgrade && rawPath.toLowerCase().startsWith('http://')) {
            if (globalWindow?.location?.protocol === 'https:') {
                rawPath = rawPath.replace(/^http:\/\//i, 'https://');
            }
        }

        let cssPath = this.escapeTemplateLiteral(rawPath);

        if (this.isVideo) {
            const config = {
                url: rawPath,
                opacity: opacity,
                blur: this.blur,
                // A4: auto 模式注入 CSS 变量，主题切换由 :has() 即时适配
                blendMode: resolveBlendModeValue(this.blendModel),
                // A6: 视频元素同样支持淡入淡出（loader 的 applyVideo 读取该字段）
                transition: this.transitionEnabled
            };
            // Escape backticks and ${} for template literal safety, but keep backslashes as is (JSON stringified)
            const jsonConfig = JSON.stringify(config)
                .replace(/`/g, '\\`')
                .replace(/\$\{/g, '\\${');

            return `
            /*background-cover-video-start*/
            ${jsonConfig}
            /*background-cover-video-end*/
            ${resolveThemeBlendRules(this.blendModel)}
            ${getCorruptionWarningCss()}
            `;
        }

        return `
        body::before{
            content: "";
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            position: absolute;
            background-size: ${sizeModelVal};
            background-repeat: ${repeatVal};
            background-position: ${positionVal};
            opacity:${opacity};
            background-image:url('${cssPath}');
            z-index: 2;
            pointer-events: none;
            filter: blur(${this.blur}px);
            ${resolveBlendModeDeclaration(this.blendModel)}
            ${getTransitionDeclaration(this.transitionEnabled)}
        }
        ${resolveThemeBlendRules(this.blendModel)}
        ${getTransitionReducedMotionCss(this.transitionEnabled)}
        ${getCorruptionWarningCss()}
        `;
    }

    // 获取js内容
    private getLoaderJs(): string {
        const cssDesktopUrl = Uri.file(CUSTOM_CSS_FILE_PATH).with({ scheme: 'vscode-file', authority: 'vscode-app' }).toString();
        const escapedDesktopUrl = this.escapeTemplateLiteral(cssDesktopUrl);
        const webCssPath = WEB_RELATIVE_CSS_PATH ? this.escapeTemplateLiteral(WEB_RELATIVE_CSS_PATH) : '';
        const cssFileName = this.escapeTemplateLiteral(CUSTOM_CSS_FILE_NAME);
        const workbenchJsName = this.escapeTemplateLiteral(selectedWorkbench.js);
        const relativePlaceholder = this.escapeTemplateLiteral(RELATIVE_URL_PLACEHOLDER);

        const videoSetup = `
            function applyVideo(targetWindow, config) {
                try {
                    const doc = targetWindow && targetWindow.document;
                    if (!doc || !doc.body) return;
                    let video = doc.getElementById('background-cover-video');
                    if (!config) {
                        if (video) {
                            if (video.__bgcObjectUrl) {
                                try { URL.revokeObjectURL(video.__bgcObjectUrl); } catch (e) {}
                            }
                            video.remove();
                        }
                        return;
                    }
                    if (!video) {
                        video = doc.createElement('video');
                        video.id = 'background-cover-video';
                        video.autoplay = true;
                        video.loop = true;
                        video.muted = true;
                        video.style.position = 'absolute';
                        video.style.top = '0';
                        video.style.left = '0';
                        video.style.width = '100%';
                        video.style.height = '100%';
                        video.style.objectFit = 'cover';
                        video.style.zIndex = '2';
                        video.style.pointerEvents = 'none';
                        doc.body.prepend(video);
                    }

                    let url = config.url;
                    const loc = targetWindow.location;
                    if (loc && url.toLowerCase().startsWith('http://') && loc.protocol === 'https:') {
                        url = url.replace(/^http:\\/\\//i, 'https://');
                    }

                    if (!video.loop) video.loop = true;
                    if (!video.muted) video.muted = true;

                    video.style.opacity = config.opacity + '';
                    video.style.filter = 'blur(' + config.blur + 'px)';
                    video.style.mixBlendMode = config.blendMode;

                    // A6: 视频切换同样支持淡入淡出（尊重系统"减少动态效果"）
                    if (config.transition) {
                        var reducedMotion = (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
                        video.style.transition = reducedMotion ? 'none' : 'opacity .25s ease, filter .25s ease';
                    }

                    // B1: vscode-file 协议由 main.js 的 net.fetch(file://) 代理，Electron 43
                    // 起不再补 Accept-Ranges/206，Chromium 150 的 <video> 直接报
                    // "no supported sources"。把 vscode-file 的视频 fetch 成完整 blob
                    // 再用 object URL 播放，绕开协议层对 Range 的依赖。
                    if (url.toLowerCase().startsWith('vscode-file:')) {
                        var currentObj = video.__bgcObjectUrl;
                        if (currentObj && video.__bgcSourceUrl === url) {
                            // 同一文件已加载过，无需重新 fetch。
                            if (video.paused) {
                                video.play().catch(function(e) {
                                    if (e.name !== 'AbortError') {
                                        console.error('BackgroundCover video play error:', e);
                                    }
                                });
                            }
                            return;
                        }
                        fetch(url).then(function(r) {
                            if (!r.ok) throw new Error('vscode-file fetch failed: ' + r.status);
                            return r.blob();
                        }).then(function(blob) {
                            var nextUrl = URL.createObjectURL(blob);
                            var prevObj = video.__bgcObjectUrl;
                            video.__bgcObjectUrl = nextUrl;
                            video.__bgcSourceUrl = url;
                            video.src = nextUrl;
                            if (prevObj) {
                                try { URL.revokeObjectURL(prevObj); } catch (e) {}
                            }
                            return video.play();
                        }).catch(function(e) {
                            console.error('BackgroundCover video blob load error:', e);
                            // 降级：直接挂 vscode-file 地址（老版本 Electron 仍可播放）。
                            if (video.src !== url) {
                                video.src = url;
                            }
                            if (video.paused) {
                                video.play().catch(function(e2) {
                                    if (e2.name !== 'AbortError') {
                                        console.error('BackgroundCover video play error:', e2);
                                    }
                                });
                            }
                        });
                        return;
                    }

                    let currentSrc = video.src;
                    let newSrc = url;
                    try {
                        if (currentSrc !== newSrc && decodeURIComponent(currentSrc) !== decodeURIComponent(newSrc)) {
                            // 从 blob 切回直链时，回收旧的 object URL。
                            if (video.__bgcObjectUrl) {
                                try { URL.revokeObjectURL(video.__bgcObjectUrl); } catch (e) {}
                                video.__bgcObjectUrl = null;
                                video.__bgcSourceUrl = null;
                            }
                            video.src = newSrc;
                        }
                    } catch (e) {
                        if (currentSrc !== newSrc) {
                            if (video.__bgcObjectUrl) {
                                try { URL.revokeObjectURL(video.__bgcObjectUrl); } catch (e) {}
                                video.__bgcObjectUrl = null;
                                video.__bgcSourceUrl = null;
                            }
                            video.src = newSrc;
                        }
                    }

                    if (video.paused) {
                        video.play().catch(e => {
                            if (e.name !== 'AbortError') {
                                console.error('BackgroundCover video play error:', e);
                            }
                        });
                    }
                } catch (e) {
                    console.error('[BackgroundCover] applyVideo error:', e);
                }
            }
        `;

        return `
        (function() {
            const runtime = {
                timers: [],
                listeners: [],
                observers: [],
                originalOpen: null,
                dispose: function() {
                    this.timers.forEach(id => clearTimeout(id));
                    this.timers = [];
                    this.listeners.forEach(item => {
                        try {
                            item.target.removeEventListener(item.type, item.handler, item.options);
                        } catch (e) {
                            // ignore teardown failures
                        }
                    });
                    this.listeners = [];
                    this.observers.forEach(observer => {
                        try {
                            observer.disconnect();
                        } catch (e) {
                            // ignore teardown failures
                        }
                    });
                    this.observers = [];
                    if (this.originalOpen && window.open !== this.originalOpen) {
                        window.open = this.originalOpen;
                    }
                    this.originalOpen = null;
                }
            };
            window.__backgroundCoverDynamicLoader = runtime;

            function registerTimer(id) {
                runtime.timers.push(id);
                return id;
            }

            function registerInterval(id) {
                runtime.timers.push(id);
                return id;
            }

            function registerListener(target, type, handler, options) {
                target.addEventListener(type, handler, options);
                runtime.listeners.push({ target, type, handler, options });
            }

            function registerObserver(observer) {
                runtime.observers.push(observer);
                return observer;
            }

            const cssDesktopUrl = '${escapedDesktopUrl}';
            const relativeCssPath = '${webCssPath}';
            const cssFileName = '${cssFileName}';
            const workbenchJsName = '${workbenchJsName}';
            const relativePlaceholder = '${relativePlaceholder}';
            const perWindowEnabled = ${isPerWindowEnabled()};

            function ensureTrailingSlash(value) {
                if (!value) {
                    return '';
                }
                return value.endsWith('/') ? value : value + '/';
            }

            function getCssBaseHref(url) {
                if (!url) {
                    return '';
                }
                let clean = url;
                const hashIndex = clean.indexOf('#');
                if (hashIndex !== -1) {
                    clean = clean.substring(0, hashIndex);
                }
                const queryIndex = clean.indexOf('?');
                if (queryIndex !== -1) {
                    clean = clean.substring(0, queryIndex);
                }
                const slashIndex = clean.lastIndexOf('/');
                if (slashIndex === -1) {
                    return ensureTrailingSlash(clean);
                }
                return ensureTrailingSlash(clean.substring(0, slashIndex + 1));
            }

            function replaceRelativeTokens(value, baseHref) {
                if (!value || value.indexOf(relativePlaceholder) === -1) {
                    return value;
                }
                return value.split(relativePlaceholder).join(baseHref);
            }

            function deriveFromScript() {
                if (typeof document === 'undefined') {
                    return undefined;
                }

                const buildFromSrc = (src) => {
                    try {
                        return new URL(cssFileName, src).toString();
                    } catch (error) {
                        console.error('[BackgroundCover] Script URL resolve error:', error);
                        return undefined;
                    }
                };

                const current = document.currentScript;
                if (current && current.src) {
                    const candidate = buildFromSrc(current.src);
                    if (candidate) {
                        return candidate;
                    }
                }

                const scripts = document.getElementsByTagName ? document.getElementsByTagName('script') : [];
                for (let i = scripts.length - 1; i >= 0; i--) {
                    const tag = scripts[i];
                    if (tag && tag.src && tag.src.indexOf(workbenchJsName) !== -1) {
                        const candidate = buildFromSrc(tag.src);
                        if (candidate) {
                            return candidate;
                        }
                    }
                }

                return undefined;
            }

            const resolveCssUrl = () => {
                const scriptResolved = deriveFromScript();
                if (scriptResolved) {
                    return scriptResolved;
                }

                const relativePath = relativeCssPath;
                if (relativePath) {
                    const bases = [];
                    const monacoEnv = typeof globalThis !== 'undefined' ? globalThis.MonacoEnvironment || {} : {};
                    if (monacoEnv.baseUrl) {
                        bases.push(monacoEnv.baseUrl);
                    }
                    if (monacoEnv.appOrigin) {
                        bases.push(monacoEnv.appOrigin);
                    }
                    if (typeof document !== 'undefined' && document.baseURI) {
                        bases.push(document.baseURI);
                    }
                    if (typeof window !== 'undefined' && window.location) {
                        const { origin, href } = window.location;
                        if (origin) {
                            bases.push(origin + '/');
                        }
                        if (href) {
                            const slashIndex = href.lastIndexOf('/');
                            if (slashIndex !== -1) {
                                bases.push(href.substring(0, slashIndex + 1));
                            }
                        }
                    }

                    for (const base of bases) {
                        try {
                            return new URL(relativePath, base).toString();
                        } catch (error) {
                            console.error('[BackgroundCover] Base URL failed:', error);
                        }
                    }

                    if (!relativePath.startsWith('http')) {
                        try {
                            return new URL(relativePath, '/').toString();
                        } catch (error) {
                            console.error('[BackgroundCover] Relative URL failed:', error);
                        }
                    }
                }

                return cssDesktopUrl;
            };
            const cssUrl = resolveCssUrl();
            const cssBaseHref = getCssBaseHref(cssUrl);

            function cssUrlForToken(token) {
                // 'shared' = 共用模式：回到不带 session 后缀的共享 CSS。
                if (!token || token === '${SHARED_CSS_TOKEN}') return cssUrl;
                const windowFile = cssFileName.replace(/\\.css$/, '.' + token + '.css');
                if (cssUrl.indexOf(cssFileName) !== -1) {
                    return cssUrl.split(cssFileName).join(windowFile);
                }
                return cssUrl;
            }

            // 从"每窗口独立"切到"共用"时，window 上可能还留着上一模式指向 per-window
            // 文件的地址，而那个文件已经不再更新了。动态脚本每次重载都按当前模式复位。
            if (!perWindowEnabled) {
                try {
                    window.__backgroundCoverCssUrl = undefined;
                } catch (e) {
                    console.error('[BackgroundCover] Reset css url failed:', e);
                }
            }

            function activeCssUrl() {
                return window.__backgroundCoverCssUrl || cssUrl;
            }
            
            ${videoSetup}

            // A6: 换图淡入淡出片段（background-image 不可过渡，用 opacity 模拟交叉淡化）
            ${IMAGE_FADE_JS}

            function applyStyle(targetWindow, css) {
                try {
                    const doc = targetWindow && targetWindow.document;
                    if (!doc || !doc.head) return;
                    let style = doc.getElementById('background-cover-style');
                    if (!style) {
                        style = doc.createElement('style');
                        style.id = 'background-cover-style';
                        doc.head.appendChild(style);
                    }
                    // A6: 换图交叉淡化（cross-fade 图片级混合，body::before 规则全程不变）
                    bgcApplyStyleWithFade(targetWindow, style, css);
                } catch (e) {
                    console.error('[BackgroundCover] applyStyle error:', e);
                }
            }

            // Track auxiliary windows opened by VSCode (e.g. the new AgentView "Open Agents Window",
            // floating editor windows, etc.). Each auxiliary window is a separate Electron BrowserWindow
            // with its own document/body, so we must mirror the <style> and <video> into each.
            // The set lives on window so it survives dynamic-script reloads; otherwise windows
            // captured by a previous generation would stop receiving background updates.
            if (!window.__backgroundCoverAuxWindows) {
                window.__backgroundCoverAuxWindows = new Set();
            }
            const auxWindows = window.__backgroundCoverAuxWindows;
            let lastCss = '';
            let lastVideoConfig = null;

            function isWindowAlive(w) {
                try {
                    return !!(w && !w.closed && w.document);
                } catch (e) {
                    return false;
                }
            }

            function applyToWindow(w) {
                if (!isWindowAlive(w)) return;
                try {
                    if (window.__backgroundCoverCssUrl) {
                        w.__backgroundCoverCssUrl = window.__backgroundCoverCssUrl;
                    }
                } catch (e) {
                    // Auxiliary windows may not allow property writes during init.
                }
                applyStyle(w, lastCss);
                applyVideo(w, lastVideoConfig);
            }

            function applyToAll() {
                applyToWindow(window);
                auxWindows.forEach(w => {
                    if (isWindowAlive(w)) {
                        applyToWindow(w);
                    } else {
                        auxWindows.delete(w);
                    }
                });
            }

            function registerAuxWindow(newWindow) {
                if (!newWindow || newWindow === window) return;
                if (auxWindows.has(newWindow)) return;
                auxWindows.add(newWindow);

                // VSCode opens auxiliary windows with about:blank then rewrites the document.
                // Apply on a short retry schedule so we catch the post-rewrite head/body.
                let attempts = 0;
                const maxAttempts = 40; // ~20s total
                const tick = () => {
                    attempts++;
                    if (!isWindowAlive(newWindow)) {
                        auxWindows.delete(newWindow);
                        return;
                    }
                    try {
                        applyToWindow(newWindow);
                    } catch (e) {
                        // ignore transient errors during window init
                    }
                    if (attempts < maxAttempts) {
                        registerTimer(setTimeout(tick, 500));
                    }
                };
                tick();

                try {
                    registerListener(newWindow, 'unload', () => {
                        auxWindows.delete(newWindow);
                    }, { once: true });
                } catch (e) {
                    // ignore
                }
            }

            // Hook window.open so we capture every auxiliary window VSCode opens.
            try {
                const originalOpen = window.open || null;
                if (originalOpen) {
                    runtime.originalOpen = originalOpen;
                    window.open = function() {
                        const result = originalOpen.apply(window, arguments);
                        try {
                            if (result && result !== window) {
                                registerAuxWindow(result);
                            }
                        } catch (e) {
                            console.error('[BackgroundCover] window.open hook error:', e);
                        }
                        return result;
                    };
                }
            } catch (e) {
                console.error('[BackgroundCover] window.open patch error:', e);
            }

            // A5: 图片预加载片段（换图前预热，消除首帧闪烁）
            ${PRELOAD_IMAGE_JS}

            let cssLoadInFlight = false;
            let lastCssLoadAt = 0;

            function withCacheBust(url) {
                const sep = url.indexOf('?') === -1 ? '?' : '&';
                return url + sep + 't=' + Date.now();
            }

            function loadCss() {
                if (cssLoadInFlight) return;
                cssLoadInFlight = true;
                lastCssLoadAt = Date.now();
                const currentCssUrl = activeCssUrl();
                const url = withCacheBust(currentCssUrl);
                fetch(url).then(r => r.text()).then(css => {
                    const resolvedCss = replaceRelativeTokens(css, getCssBaseHref(currentCssUrl) || cssBaseHref);
                    lastCss = resolvedCss;

                    const match = resolvedCss.match(/\\/\\*background-cover-video-start\\*\\/([\\s\\S]*?)\\/\\*background-cover-video-end\\*\\//);
                    if (match) {
                        try {
                            const config = JSON.parse(match[1]);
                            config.url = replaceRelativeTokens(config.url, cssBaseHref);
                            lastVideoConfig = config;
                        } catch(e) {
                            console.error('[BackgroundCover] Video config parse error:', e);
                            lastVideoConfig = null;
                        }
                    } else {
                        lastVideoConfig = null;
                    }

                    // A5: 换图前先预加载目标图片，避免首帧闪烁（最长等待 2s）
                    return preloadBackgroundImage(resolvedCss);
                }).then(() => {
                    applyToAll();
                }).catch(e => console.error('[BackgroundCover] Load error:', e))
                .finally(() => {
                    cssLoadInFlight = false;
                });
            }

            function scheduleLoadCss(reason, delay) {
                registerTimer(setTimeout(() => {
                    try {
                        loadCss();
                    } catch (e) {
                        console.error('[BackgroundCover] Scheduled load error (' + reason + '):', e);
                    }
                }, delay || 0));
            }

            // Initial load
            scheduleLoadCss('initial', 0);

            // 1. Event Hook: Listen for status bar message
            try {
                const observer = registerObserver(new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        const target = mutation.target;
                        // Check text content of the mutated node
                        if (target.textContent && target.textContent.includes('background-cover-reload-trigger')) {
                            // ':js:' means the dynamic bundle itself changed and must be
                            // re-imported; a CSS-only change just refreshes the stylesheet
                            // so the background runtime keeps its state.
                            const triggerMatch = target.textContent.match(/background-cover-reload-trigger:(css|js):\\d+:([0-9a-z]+)/i);
                            if (triggerMatch && triggerMatch[2]) {
                                window.__backgroundCoverCssUrl = cssUrlForToken(triggerMatch[2]);
                            }
                            const wantsJsReload = target.textContent.includes('background-cover-reload-trigger:js:');
                            const bootstrap = window.__backgroundCoverBootstrap;
                            if (wantsJsReload && bootstrap && typeof bootstrap.reload === 'function') {
                                bootstrap.reload();
                            } else {
                                scheduleLoadCss('statusbar', 0);
                                scheduleLoadCss('statusbar-followup', 600);
                            }
                            return;
                        }
                    }
                }));
                
                const findStatusBar = () => {
                    // Try to find the status bar container
                    const statusBar = document.querySelector('.statusbar') || document.getElementById('workbench.parts.statusbar') || document.querySelector('footer');
                    if (statusBar) {
                        observer.observe(statusBar, { 
                            subtree: true, 
                            characterData: true, 
                            childList: true 
                        });
                        console.log('[BackgroundCover] Observer attached to:', statusBar);
                    } else {
                        // Retry if not found yet
                        registerTimer(setTimeout(findStatusBar, 2000));
                    }
                };

                if (document.readyState === 'loading') {
                    registerListener(document, 'DOMContentLoaded', findStatusBar);
                } else {
                    findStatusBar();
                }
            } catch (e) {
                console.error('[BackgroundCover] Observer error:', e);
            }

            // 2. Backup Hook: Check on window focus
            // This ensures that if the status bar trigger is missed, the background updates when the user interacts with the window
            registerListener(window, 'focus', () => {
                if (Date.now() - lastCssLoadAt > 800) {
                    scheduleLoadCss('focus', 0);
                }
            });
            registerListener(document, 'visibilitychange', () => {
                if (!document.hidden) {
                    scheduleLoadCss('visibility', 0);
                }
            });
            registerListener(document, 'pointerdown', () => {
                if (Date.now() - lastCssLoadAt > 1500) {
                    scheduleLoadCss('pointer', 0);
                }
            }, { passive: true });

            let startupPolls = 0;
            const startupPoll = registerInterval(setInterval(() => {
                startupPolls++;
                scheduleLoadCss('startup-poll', 0);
                if (startupPolls >= 6) {
                    clearInterval(startupPoll);
                }
            }, 2000));
        })();
        `;
    }

    // 获取css样式值
    private getCssStyles(): { sizeModelVal: string; repeatVal: string; positionVal: string } {
        let sizeModelVal = this.sizeModel;
        let repeatVal = "no-repeat";
        let positionVal = "center";

        switch (this.sizeModel) {
            case "cover":
                sizeModelVal = "cover";
                break;
            case "contain":
                sizeModelVal = "100% 100%";
                break;
            case "center":
                sizeModelVal = "contain";
                break;
            case "repeat":
                sizeModelVal = "auto";
                repeatVal = "repeat";
                break;
            case "not_center":
                sizeModelVal = "auto";
                break;
            case "not_right_bottom":
                sizeModelVal = "auto";
                positionVal = "right 96%";
                break;
            case "not_right_top":
                sizeModelVal = "auto";
                positionVal = "right 30px";
                break;
            case "not_left":
                sizeModelVal = "auto";
                positionVal = "left";
                break;
            case "not_right":
                sizeModelVal = "auto";
                positionVal = "right";
                break;
            case "not_top":
                sizeModelVal = "auto";
                positionVal = "top";
                break;
            case "not_bottom":
                sizeModelVal = "auto";
                positionVal = "bottom";
                break;
        }

        return { sizeModelVal, repeatVal, positionVal };
    }

    // 转义模板字符串
    private escapeTemplateLiteral(value: string): string {
        if (!value) return value;
        return value
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
    }

    // 图片转为Base64
    private async imageToBase64(): Promise<boolean> {
        try {
            const extname = path.extname(this.imagePath).substr(1);
            const imageBuffer = await fs.promises.readFile(path.resolve(this.imagePath));
            this.imagePath = `data:image/${extname};base64,${imageBuffer.toString('base64')}`;
            return true;
        } catch {
            return false;
        }
    }

    private async prepareCodeServerAsset(sourcePath: string): Promise<string | undefined> {
        try {
            await fse.ensureDir(CUSTOM_ASSET_DIR);
            const buffer = await fse.readFile(path.resolve(sourcePath));
            const hash = crypto.createHash('md5').update(buffer).digest('hex');
            const ext = path.extname(sourcePath) || '.img';
            const fileName = `${hash}${ext}`;
            const destPath = path.join(CUSTOM_ASSET_DIR, fileName);

            if (!(await fse.pathExists(destPath))) {
                await fse.writeFile(destPath, buffer);
            }

            const relativeUrl = this.getRelativeAssetUrl(destPath);
            if (!relativeUrl) {
                return undefined;
            }

            const normalized = relativeUrl.replace(/^\/+/, '');
            return `${RELATIVE_URL_PLACEHOLDER}/${normalized}`;
        } catch (error) {
            console.error('[FileDom] Failed to prepare code-server asset:', error);
            return undefined;
        }
    }

    private getRelativeAssetUrl(targetPath: string): string | undefined {
        try {
            const relative = path.relative(selectedWorkbench.root, targetPath);
            if (!relative || relative.startsWith('..')) {
                return undefined;
            }
            return relative.split(path.sep).join('/');
        } catch (error) {
            console.error('[FileDom] Failed to resolve asset url:', error);
            return undefined;
        }
    }

    private localImgToVsc(): void {
        // 使用 Uri.file 自动处理路径分隔符和编码，避免手动拼接导致的路径错误（如 macOS 下的双斜杠问题）
        this.imagePath = Uri.file(this.imagePath).with({ scheme: 'vscode-file', authority: 'vscode-app' }).toString();
    }

    private clearCssContent(content: string): string {
        return clearPatchBlock(content);
    }

    public getPatchContent(content: string): boolean {
        return hasPatchBlock(content);
    }
}
