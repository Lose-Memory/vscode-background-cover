import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    WebviewView,
    WebviewViewProvider,
    WebviewViewResolveContext,
    CancellationToken,
    ExtensionContext,
    Uri,
    Webview,
    commands,
    env,
    workspace,
    Disposable
} from 'vscode';
import { PickList } from './PickList';
import { onDidChangeGlobalState } from './global';
import { resolveCurrentBlur, resolveCurrentImagePath, resolveCurrentOpacity } from './windowBackground';
import { expandPathVariables, FOLDER_SCAN_MAX_FILES } from './pathUtil';
import { getThumbnail } from './thumbnails';
import { getCachedImageSize, getLatestScan, scanFolderSizes } from './imageStats';

const PUSH_DEBOUNCE_MS = 120;

/** globalState keys the webview may write directly via `setGlobalState`. */
const WEBVIEW_WRITABLE_STATE_KEYS = new Set<string>(['backgroundCoverLocale']);

/**
 * Vue-powered single-pane configuration webview.
 *
 * Loads the inlined Vite build at `webview-dist/index.html`, injects a CSP
 * + nonce, and brokers messages between the extension host and the SPA.
 *
 * Inbound message shapes:
 *   { type: 'ready' }
 *   { type: 'runAction', action: number, path?: string }
 *   { type: 'setConfig', key: string, value: any }
 *   { type: 'setGlobalState', key: string, value: any }
 *   { type: 'thumbnailsRequest', paths: string[] }
 *   { type: 'scanFolder' }
 *   { type: 'applyDecorations' }
 *   { type: 'openExternal', url: string }
 *
 * Outbound:
 *   { type: 'state', data: { locale, config, state } }
 *   { type: 'scanProgress', data: { done, total } }
 *   { type: 'scanResult', data: FolderScanResult | { error } }
 *   { type: 'navigate', tab: 'home'|'advanced' }
 */
export class StudioViewProvider implements WebviewViewProvider {

    public static readonly viewType = 'backgroundCover.studio';

    private view?: WebviewView;
    private disposables: Disposable[] = [];
    /** Set of allowed local-resource root directories (fs paths). */
    private allowedRoots = new Set<string>();
    private pushTimer?: ReturnType<typeof setTimeout>;
    /** Folder listing cache keyed by folder path + mtime; avoids readdir on every push. */
    private folderCache?: { folder: string; mtimeMs: number; depth: number; names: string[] };
    /** 目录扫描进行中：避免连点按钮并发扫两遍。 */
    private scanning = false;

    constructor(private readonly ctx: ExtensionContext) {}

    public resolveWebviewView(
        view: WebviewView,
        _context: WebviewViewResolveContext,
        _token: CancellationToken
    ): void {
        this.view = view;
        this.seedAllowedRoots();
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: this.computeRootUris()
        };
        view.webview.html = this.getHtml(view.webview);

        view.webview.onDidReceiveMessage((msg: any) => this.handleMessage(msg), undefined, this.disposables);


        // Push state on config / globalState changes

        
        // 配置/globalState 的变化往往是成串的（拖滑块、自动换图 tick），合并成一次推送。
        this.disposables.push(workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('backgroundCover')) { this.schedulePush(); }
        }));
        this.disposables.push(onDidChangeGlobalState.event(() => this.schedulePush()));

        view.onDidDispose(() => {
            if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = undefined; }
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
            this.view = undefined;
        });
    }

    private schedulePush(): void {
        if (!this.view) { return; }
        if (this.pushTimer) { clearTimeout(this.pushTimer); }
        this.pushTimer = setTimeout(() => {
            this.pushTimer = undefined;
            this.pushState();
        }, PUSH_DEBOUNCE_MS);
    }

    /** List folder media, reusing the previous listing while the directory mtime and scan depth are unchanged. */
    private listFolder(folder: string): string[] {
        const mtimeMs = fs.statSync(folder).mtimeMs;
        const depth = PickList.getScanDepth();
        const c = this.folderCache;
        if (c && c.folder === folder && c.mtimeMs === mtimeMs && c.depth === depth) {
            return c.names;
        }
        const names = PickList.listFolderImages(folder);
        this.folderCache = { folder, mtimeMs, depth, names };
        return names;
    }

    /** Re-send full state; used by external commands (refresh/home/support). */
    public pushState(): void {
        if (!this.view) { return; }
        if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = undefined; }
        const cfg = workspace.getConfiguration('backgroundCover');
        const gs = this.ctx.globalState;

        const imagePath = resolveCurrentImagePath(cfg.get<string>('imagePath') || '');
        const imagePathDisplay = this.toWebviewUri(imagePath);

        const folder = expandPathVariables(cfg.get<string>('randomImageFolder') || '');
        let folderImages: { path: string; display: string; name: string; width?: number; height?: number; ratio?: number }[] = [];
        let folderImagesTotal = 0;
        let folderImagesTruncated = false;
        try {
            if (folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
                const names = this.listFolder(folder);
                folderImagesTotal = names.length;
                // 扫描有数量上限：达到上限时结果只代表「至少这么多」，不能当成真实总数
                folderImagesTruncated = folderImagesTotal >= FOLDER_SCAN_MAX_FILES;
                folderImages = names.slice(0, 2000).map(full => {
                    const size = getCachedImageSize(full);
                    return {
                        path: full,
                        display: this.toWebviewUri(full),
                        name: this.basename(full),
                        width: size?.width,
                        height: size?.height,
                        ratio: size ? Math.round((size.width / size.height) * 100) / 100 : undefined
                    };
                });
            }
        } catch {
            folderImages = [];
            folderImagesTotal = 0;
            folderImagesTruncated = false;
        }
        const folderScan = getLatestScan(folder || undefined) ?? null;

        let brandLogo = '';
        try {
            const logoUri = Uri.joinPath(this.ctx.extensionUri, 'resources', 'background-cover.png');
            brandLogo = this.view.webview.asWebviewUri(logoUri).toString();
        } catch { brandLogo = ''; }
        const pkg = (this.ctx.extension && (this.ctx.extension as any).packageJSON) || {};
        const brandName: string = pkg.displayName || pkg.name || 'background-cover';

        this.view.webview.postMessage({
            type: 'state',
            data: {
                locale: (gs.get<string>('backgroundCoverLocale') as 'en' | 'zh' | undefined)
                    ?? (env.language.startsWith('zh') ? 'zh' : 'en'),
                brandLogo,
                brandName,
                config: {
                    // 透明度/模糊度按窗口+工作区独立存储，推送当前窗口实际生效的值，
                    // 不同工作区窗口的 webview 会显示各自不同的数值。
                    opacity: resolveCurrentOpacity(cfg.get('opacity') ?? 0.2),
                    blur: resolveCurrentBlur(cfg.get('blur') ?? 0),
                    imagePath,
                    imagePathDisplay,
                    autoStatus: cfg.get('autoStatus') ?? false,
                    autoInterval: cfg.get('autoInterval') ?? 10,
                    autoRandomOnStartup: cfg.get('autoRandomOnStartup') ?? true,
                    sizeModel: cfg.get('sizeModel') ?? 'cover',
                    blendModel: cfg.get('blendModel') ?? 'auto',
                    randomImageFolder: cfg.get('randomImageFolder') ?? '',
                    perWindowBackground: cfg.get('perWindowBackground') ?? true,
                    backgroundTransition: true,
                    aspectThreshold: cfg.get('aspectThreshold') ?? 1.3,
                    aspectFilterEnabled: cfg.get('aspectFilterEnabled') ?? false,
                    portraitVerticalPosition: cfg.get('portraitVerticalPosition') ?? 50,
                    folderScanDepth: PickList.getScanDepth(),
                    // 当前背景图的长宽比（未统计过为 0），首页预览据此决定是否偏移
                    imageAspect: (() => {
                        const size = getCachedImageSize(imagePath);
                        return size ? size.width / size.height : 0;
                    })()
                },
                state: {
                    folderImages,
                    folderImagesTotal,
                    folderImagesTruncated,
                    folderScan
                }
            }
        });
    }

    /** Programmatic navigation hook for `view/title` menu commands. */
    public navigate(tab: 'home' | 'advanced'): void {
        this.view?.webview.postMessage({ type: 'navigate', tab });
    }

    /** Refresh the current Studio data without switching to the legacy gallery view. */
    public refresh(): void {
        this.pushState();
    }

    private async handleMessage(msg: any): Promise<void> {
        if (!msg || typeof msg.type !== 'string') { return; }
        switch (msg.type) {
            case 'ready':
                this.pushState();
                return;

            case 'runAction':
                if (typeof msg.action === 'number') {
                    await commands.executeCommand('backgroundCover.runAction', msg.action, msg.path);
                    this.pushState();
                }
                return;

            case 'setConfig':
                if (typeof msg.key === 'string') {
                    await commands.executeCommand('backgroundCover.setConfig', `backgroundCover.${msg.key}`, msg.value);
                }
                return;

            case 'setGlobalState':
                if (typeof msg.key === 'string' && WEBVIEW_WRITABLE_STATE_KEYS.has(msg.key)) {
                    await this.ctx.globalState.update(msg.key, msg.value);
                    onDidChangeGlobalState.fire();
                }
                return;

            case 'thumbnailsRequest': {
                const paths: string[] = Array.isArray(msg.paths)
                    ? msg.paths.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
                    : [];
                const items: Array<{ path: string; display: string }> = [];
                for (const p of paths.slice(0, 60)) {
                    const thumb = await getThumbnail(p);
                    items.push({ path: p, display: thumb ? this.toWebviewUri(thumb) : '' });
                }
                if (items.length && this.view) {
                    await this.view.webview.postMessage({ type: 'thumbnails', items });
                }
                return;
            }

            case 'applyDecorations':
                await this.applyDecorations();
                return;

            case 'scanFolder':
                await this.scanFolder();
                return;

            case 'openExternal':
                if (typeof msg.url === 'string' && /^https:\/\//i.test(msg.url)) {
                    await env.openExternal(Uri.parse(msg.url));
                }
                return;
        }
    }

    private async applyDecorations(): Promise<void> {
        await PickList.applyCurrentBackground();
        await commands.executeCommand('workbench.action.reloadWindow');
    }

    /**
     * 统计来源目录内所有图片的尺寸与长宽比（一次性的全量扫描，结果只保留在当前会话）。
     * 扫描期间按 ~120ms 推送一次进度；结束时无论成功失败都推一次 scanResult。
     */
    private async scanFolder(): Promise<void> {
        const post = (msg: any) => { this.view?.webview.postMessage(msg); };
        if (this.scanning) { return; }

        const cfg = workspace.getConfiguration('backgroundCover');
        const folder = expandPathVariables(cfg.get<string>('randomImageFolder') || '');
        let names: string[] = [];
        try {
            if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
                throw new Error('请先选择来源目录 / Choose a source folder first.');
            }
            names = this.listFolder(folder);
        } catch (e: any) {
            post({ type: 'scanResult', data: { error: String(e?.message || e) } });
            return;
        }

        if (!names.length) {
            post({ type: 'scanResult', data: { error: '目录内没有图片或视频 / The folder has no media.' } });
            return;
        }

        this.scanning = true;
        try {
            const rawThreshold = Number(cfg.get('aspectThreshold', 1.3));
            const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 1.3;
            post({ type: 'scanProgress', data: { done: 0, total: names.length } });
            const result = await scanFolderSizes(
                folder,
                PickList.getScanDepth(),
                names,
                threshold,
                p => post({ type: 'scanProgress', data: p })
            );
            post({ type: 'scanResult', data: result });
        } catch (e: any) {
            post({ type: 'scanResult', data: { error: String(e?.message || e) } });
        } finally {
            this.scanning = false;
        }
        // 扫描后每个缩略图都有尺寸/比例了，重推一次让图库显示角标
        this.pushState();
    }

    /**
     * Convert a local file path to a webview-safe URI.
     */
    private toWebviewUri(p: string): string {
        if (!p) { return ''; }
        try {
            if (!fs.existsSync(p)) { return ''; }
            this.ensureRootForFile(p);
            return this.view!.webview.asWebviewUri(Uri.file(p)).toString();
        } catch {
            return '';
        }
    }

    private basename(p: string): string {
        return path.basename(p || '');
    }

    /** Seed initial allowed roots: extension dist, workspace folders, global/extension storage. */
    private seedAllowedRoots(): void {
        const add = (p: string | undefined) => {
            if (p) { this.allowedRoots.add(path.normalize(p)); }
        };
        add(Uri.joinPath(this.ctx.extensionUri, 'webview-dist').fsPath);
        add(Uri.joinPath(this.ctx.extensionUri, 'resources').fsPath);
        add(this.ctx.globalStorageUri?.fsPath);
        add(this.ctx.storageUri?.fsPath);
        (workspace.workspaceFolders || []).forEach(f => add(f.uri.fsPath));
    }

    /** Register the directory containing the given file path as a localResourceRoot. */
    private ensureRootForFile(filePath: string): void {
        const dir = path.normalize(path.dirname(filePath));
        if (!dir || this.isCovered(dir)) { return; }
        this.allowedRoots.add(dir);
        if (this.view) {
            this.view.webview.options = {
                enableScripts: true,
                localResourceRoots: this.computeRootUris()
            };
        }
    }

    /** Check whether `dir` is already inside any registered root. */
    private isCovered(dir: string): boolean {
        const target = dir.toLowerCase();
        for (const root of this.allowedRoots) {
            const r = root.toLowerCase();
            if (target === r || target.startsWith(r + path.sep)) { return true; }
        }
        return false;
    }

    private computeRootUris(): Uri[] {
        return Array.from(this.allowedRoots).map(p => Uri.file(p));
    }

    private getHtml(webview: Webview): string {
        const indexFile = path.join(this.ctx.extensionPath, 'webview-dist', 'index.html');
        let html = '';
        try {
            html = fs.readFileSync(indexFile, 'utf8');
        } catch {
            return this.fallbackHtml('webview-dist/index.html not found. Run `npm run build:webview`.');
        }

        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data: blob:`,
            `media-src ${webview.cspSource} data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        // Always use our own CSP so the nonce below matches; drop any CSP shipped in the build.
        html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        html = html.replace(/<head[^>]*>/i, m => `${m}\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);

        // Stamp nonce on every inline/external script
        html = html.replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);

        return html;
    }

    private fallbackHtml(msg: string): string {
        return `<!doctype html><html><body style="font-family:sans-serif;padding:16px;color:#ccc;background:#1e1e1e">
            <h3>Background Cover Studio</h3>
            <p>${msg}</p>
        </body></html>`;
    }
}
