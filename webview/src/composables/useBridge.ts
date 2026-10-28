/**
 * Vue composable wrapping the VS Code Webview message bridge.
 *
 * Outbound messages use `vscode.postMessage`; inbound messages dispatch by
 * `data.type`. The acquireVsCodeApi() handle can only be obtained once per
 * webview, so it's memoised at module scope.
 */

export interface OutboundMessage {
    type: string;
    [k: string]: any;
}

type Listener = (data: any) => void;

const listeners = new Map<string, Set<Listener>>();
let vscodeApi: any = null;

/**
 * 这些消息会改写注入层的 CSS，发完立刻让父窗口（工作台页面）重新读取 CSS。
 * 否则只能等状态栏文字触发或 focus/pointerdown 兜底——而用户在面板里操作时
 * 焦点一直在 webview iframe 内，兜底事件不会冒泡到工作台文档。
 */
const RELOAD_SIGNAL_TYPES = new Set(['setConfig', 'setImagePosition', 'applyDecorations']);

function signalParentReload() {
    try {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ __backgroundCoverReload: true }, '*');
        }
    } catch {
        /* 父窗口不可达时忽略（独立预览场景） */
    }
}

function getApi() {
    if (vscodeApi) { return vscodeApi; }
    if (typeof (window as any).acquireVsCodeApi === 'function') {
        vscodeApi = (window as any).acquireVsCodeApi();
    } else {
        // Standalone preview (vite dev) — fall back to console logger
        vscodeApi = {
            postMessage: (msg: any) => console.log('[bridge:dev]', msg),
            getState: () => ({}),
            setState: () => undefined
        };
    }
    return vscodeApi;
}

if (typeof window !== 'undefined') {
    window.addEventListener('message', (ev: MessageEvent) => {
        const data = ev.data;
        if (!data || typeof data.type !== 'string') { return; }
        const set = listeners.get(data.type);
        if (set) { set.forEach(fn => fn(data)); }
    });
}

export function useBridge() {
    return {
        post(msg: OutboundMessage) {
            getApi().postMessage(msg);
            if (RELOAD_SIGNAL_TYPES.has(msg.type)) {
                signalParentReload();
            }
        },
        /** VS Code webview 持久化状态（acquireVsCodeApi().getState） */
        getState<T extends Record<string, any>>(): Partial<T> {
            try { return (getApi().getState() as Partial<T>) ?? {}; } catch { return {}; }
        },
        /** 合并写入 webview 持久化状态，保留其它字段 */
        patchState(patch: Record<string, any>) {
            try {
                const prev = getApi().getState() ?? {};
                getApi().setState({ ...prev, ...patch });
            } catch { /* noop */ }
        },
        on(type: string, fn: Listener) {
            if (!listeners.has(type)) { listeners.set(type, new Set()); }
            listeners.get(type)!.add(fn);
            return () => listeners.get(type)!.delete(fn);
        }
    };
}
