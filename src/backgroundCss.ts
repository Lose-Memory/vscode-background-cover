/**
 * 背景 CSS 片段生成（借鉴 shalldie/vscode-background 的 ChecksumsPatchGenerator /
 * ThemePatchGenerator）：
 * - getCorruptionWarningCss：用 CSS `:has()` 屏蔽 VS Code 的"安装损坏"校验和提示
 *   （16 种语言全覆盖，用户完全无感）；
 * - resolveBlendModeDeclaration / resolveThemeBlendRules：auto 混合模式改为 CSS 变量 +
 *   `:has()` 主题感知，主题切换由 CSS 即时生效，不再需要扩展侧监听/重打补丁；
 * - getTransitionCss：背景切换的淡入淡出过渡（尊重系统的"减少动态效果"设置）。
 *
 * 纯逻辑模块，不依赖 vscode API，方便单元测试。
 */

// ---- 校验和"安装损坏"提示 -----------------------------------------------------
// 文案来自 VS Code integrityService 的多语言翻译，与参考项目 shalldie/vscode-background
// 的 ChecksumsPatchGenerator 保持一致。除完整句外，保留两条短匹配兜底
// （aria-label 子串匹配，长句能覆盖短句，多保留两条无害）。
export const CORRUPTION_TRANSLATIONS: string[] = [
    // en, default
    'installation appears to be corrupt. Please reinstall.',
    // cs
    'je pravděpodobně poškozená. Proveďte prosím přeinstalaci.',
    // de
    'Installation ist offenbar beschädigt. Führen Sie eine Neuinstallation durch.',
    // es
    'parece estar dañada. Vuelva a instalar.',
    // fr
    'semble être endommagée. Effectuez une réinstallation.',
    // it
    'sembra danneggiata. Reinstallare.',
    // ja
    'インストールが壊れている可能性があります。再インストールしてください。',
    // ko
    '설치가 손상된 것 같습니다. 다시 설치하세요.',
    // pl
    'prawdopodobnie jest uszkodzona. Spróbuj zainstalować ponownie.',
    // pt-BR
    'parece estar corrompida. Reinstale-o.',
    // qps-ploc
    'ïñstællætïøñ æppëærs tø þë çørrµpt. Plëæsë rëïñstæll.',
    // ru
    'повреждена. Повторите установку.',
    // tr
    'yüklemeniz bozuk gibi görünüyor. Lütfen yeniden yükleyin.',
    // zh-hans
    '安装似乎损坏。请重新安装。',
    // zh-hant
    '安裝似乎已損毀。請重新安裝。',
    // 短匹配兜底（兼容只包含片段的通知文本）
    'installation appears to be corrupt',
    '安装似乎损坏'
];

/**
 * 生成屏蔽"安装损坏"通知的 CSS。选择器中的单引号会转义，避免破坏属性选择器。
 */
export function getCorruptionWarningCss(): string {
    return CORRUPTION_TRANSLATIONS.map((trans) => {
        const escaped = trans.replace(/'/g, "\\'");
        return `
        .notification-toast-container:has([aria-label*='${escaped}']) {
            display: none;
        }
        `;
    }).join('');
}

// ---- 混合模式 ----------------------------------------------------------------
/**
 * 主题感知混合模式的 CSS 变量名。auto 模式下背景层使用该变量，
 * 深浅主题的取值由下面的 :has() 规则即时切换。
 */
export const BLEND_CSS_VAR = '--background-cover-blend';

/**
 * 解析混合模式的声明片段：
 * - auto（或空）：`mix-blend-mode: var(--background-cover-blend);`
 * - multiply / lighten：直接写死。
 */
export function resolveBlendModeDeclaration(mode: string): string {
    const normalized = (mode || '').toLowerCase();
    if (normalized === 'multiply' || normalized === 'lighten') {
        return `mix-blend-mode: ${normalized};`;
    }
    return `mix-blend-mode: var(${BLEND_CSS_VAR});`;
}

/** auto 模式下背景层应使用的 mix-blend-mode 值（注入视频 config 用）。 */
export function resolveBlendModeValue(mode: string): string {
    const normalized = (mode || '').toLowerCase();
    if (normalized === 'multiply' || normalized === 'lighten') {
        return normalized;
    }
    return `var(${BLEND_CSS_VAR})`;
}

/**
 * auto 模式的主题感知规则。语义与旧 BlendHelper.autoBlendModel() 完全一致：
 * 浅色 → multiply；深色（vs-dark）→ lighten；高对比黑（hc-black）→ lighten；
 * 高对比白（hc-light）→ multiply（走默认值）。
 * 非 auto 模式返回空串。
 */
export function resolveThemeBlendRules(mode: string): string {
    const normalized = (mode || '').toLowerCase();
    if (normalized !== 'auto' && normalized !== '') {
        return '';
    }
    return `
        body { ${BLEND_CSS_VAR}: multiply; }
        body:has(> .monaco-workbench.vs-dark) { ${BLEND_CSS_VAR}: lighten; }
        body:has(> .monaco-workbench.hc-black) { ${BLEND_CSS_VAR}: lighten; }
    `;
}

// ---- 壁纸垫底：面板打透 + 浮层毛玻璃 ------------------------------------------
/**
 * 壁纸层垫到 `.monaco-workbench` 之下（壁纸 z-index 0，工作台自身 z-index 1），
 * 文字与图像不再有任何合成的机会 —— 这是「文字就是文字」的唯一做法。
 *
 * 代价：主题给面板上的底色不会再被混合顶掉，必须真正打透，否则壁纸被黑底盖死。
 * 打透走变量这一层，而不是逐元素刷 `background-color: transparent`：
 * - 把 `--vscode-*-background` 这些「面」变量改成 transparent，凡是读它的组件
 *   （包括带 !important 的 modern-ui 规则、内联 style）一起变透明，不会漏一个留一个黑块；
 * - 列表选中 / 悬停这类「高亮」变量不动，交互反馈保留。
 *
 * 浮层（菜单、命令面板、补全、hover、对话框）不能只是透明：那样下面的文字会透上来
 * 和浮层文字叠在一起。它们用毛玻璃 —— 半透明深底 + `backdrop-filter` 把下面的内容糊掉，
 * 壁纸的色块还在，底下的字看不出来。
 */

/** 浮层毛玻璃的底色变量（深浅主题各一份）。 */
export const OVERLAY_CSS_VAR = '--background-cover-overlay';

/**
 * 打透/毛玻璃所需的特异性前缀。modern-ui 的面板底色规则是 0,4,0 且带 !important，
 * 兜底选择器要压过它就得抬到 0,4,x 以上；`body::before` 的打透兜底再抬一级到 0,6,x，
 * 浮层规则与它同特异性并排在后面，靠顺序胜出。
 */
const WB = 'html body .monaco-workbench';
const WB4 = `${WB}.monaco-workbench.monaco-workbench.monaco-workbench`;
const WB5 = `${WB4}.monaco-workbench`;

/** 需要打透的「面」主题色（点号转连字符后加 `--vscode-` 前缀）。 */
const TRANSPARENT_COLOR_IDS: string[] = [
    'editor.background',
    'editorGutter.background',
    'editorGroup.background',
    'editorGroupHeader.tabsBackground',
    'editorGroupHeader.noTabsBackground',
    'editorGroup.emptyBackground',
    'editorPane.background',
    'sideBar.background',
    'sideBarSectionHeader.background',
    'activityBar.background',
    'activityBar.inactiveBackground',
    'titleBar.activeBackground',
    'titleBar.inactiveBackground',
    'statusBar.background',
    'statusBar.noFolderBackground',
    'panel.background',
    'panelSectionHeader.background',
    'tab.activeBackground',
    'tab.inactiveBackground',
    'tab.unfocusedActiveBackground',
    'tab.unfocusedInactiveBackground',
    'breadcrumb.background',
    'terminal.background',
    'debugToolBar.background',
    'input.background',
    'inputValidation.background',
    'checkbox.background',
    'dropdown.background',
    'badge.background',
    // 粘滞滚动标题（Markdown 等文件的粘性标题条）与代码块底色，同样不能留深底。
    'editorStickyScroll.background',
    'editorStickyScrollGutter.background',
    'editorStickyScroll.shadow',
    'textCodeBlock.background',
    'textPreformat.background',
    // 资源管理器/列表的「粘性祖先行」：滚动时钉在顶部的那几行，底色默认是
    // var(--vscode-sideBarStickyScroll-background)（高对比主题下是纯黑）。
    'sideBarStickyScroll.background',
    // 菜单内部的 .monaco-scrollable-element 会刷 var(--vscode-menu-background)。
    // 菜单本身已经改成「透明 + ::before 毛玻璃」，这里再叠一层半透明黑，
    // 二级菜单就会比一级菜单多出一层 0.42 的深底，看起来更暗。
    'menu.background',
    // 滚动条容器的底色。现代 UI 主题会把它设成黑色，透明化后整条滚动条
    // 就是一条黑带；滑块颜色（scrollbarSlider.*）保持不动。
    'scrollbar.background'
];

/** 需要换成毛玻璃的浮层主题色（下拉/菜单/hover/补全/对话框/通知）。 */
const OVERLAY_COLOR_IDS: string[] = [
    'quickInput.background',
    'widget.background',
    'editorWidget.background',
    'editorSuggestWidget.background',
    'editorHoverWidget.background',
    'peekViewEditor.background',
    'peekViewResult.background',
    'peekViewTitle.background',
    'notifications.background',
    'notificationCenterHeader.background',
    'editorMarkerNavigation.background'
];

const toCssVar = (colorId: string) => `--vscode-${colorId.replace(/\./g, '-')}`;

/** 浮层选择器：这些容器本体加毛玻璃。
 *  菜单（.monaco-menu / .monaco-submenu）刻意不在这里：backdrop-filter 会让它成为
 *  fixed 子元素的包含块，二级菜单的位置随之算错，还会被菜单的滚动容器裁掉。
 *  菜单改用下面的 ::before 伪元素单独兜毛玻璃。 */
const OVERLAY_SELECTORS = [
    '.quick-input-widget',
    '.monaco-dialog-box',
    '.notification-toast',
    '.monaco-editor .editor-widget',
    '.monaco-hover',
    '.monaco-editor .suggest-widget',
    '.monaco-editor .find-widget',
    '.monaco-editor .parameter-hints-widget',
    '.monaco-editor .peekview-widget'
];

export function getWallpaperBehindCss(): string {
    const transparentVars = TRANSPARENT_COLOR_IDS
        .map((id) => `            ${toCssVar(id)}: transparent !important;`)
        .join('\n');
    const overlayVars = OVERLAY_COLOR_IDS
        .map((id) => `            ${toCssVar(id)}: var(${OVERLAY_CSS_VAR}) !important;`)
        .join('\n');
    const overlaySelectors = OVERLAY_SELECTORS
        .map((sel) => `${WB5} ${sel}`)
        .join(',\n');

    return `
        /* 壁纸已经垫在工作台下面，任何混合都会让壁纸和文字颜色互相污染。 */
        body::before { z-index: 0; mix-blend-mode: normal !important; }
        body {
            ${OVERLAY_CSS_VAR}: rgba(0, 0, 0, .42);
        }
        body:has(> .monaco-workbench.vs),
        body:has(> .monaco-workbench.hc-light) {
            ${OVERLAY_CSS_VAR}: rgba(255, 255, 255, .5);
        }

        /* 1) 变量层打透：面 → 透明，浮层 → 毛玻璃底。 */
        .monaco-workbench {
            --modern-ui-shell-background: transparent !important;
            --vscode-modernUI-shellBackground: transparent !important;
${transparentVars}
${overlayVars}
        }

        /* 工作台根容器自己：modern-ui 的壳底色、以及主题给这一层写死的不透明底色，
           都挂在根上。它不透明，下面面板打得再透也白搭——整张壁纸直接看不见。 */
        ${WB4} {
            background-color: transparent !important;
        }

        /* 2) 兜底：直接写死底色、不读变量的容器，再点一次名。 */
        ${WB} .part.sidebar,
        ${WB} .part.auxiliarybar,
        ${WB} .part.panel,
        ${WB} .part.editor,
        ${WB} .part.activitybar,
        ${WB} .part.statusbar,
        ${WB} .part.titlebar,
        ${WB} .part > .content,
        ${WB} .part > .title,
        ${WB} .monaco-pane-view .pane,
        ${WB} .monaco-pane-view .pane > .pane-header,
        ${WB} .monaco-editor .monaco-editor-background,
        ${WB} .monaco-editor .margin,
        ${WB} .monaco-breadcrumbs,
        ${WB} .monaco-grid-view,
        ${WB} .editor-container,
        ${WB} .editor-group-container > .title .tabs-and-actions-container,
        ${WB}.monaco-workbench .part.sidebar,
        ${WB}.monaco-workbench .part.auxiliarybar,
        ${WB}.monaco-workbench .part.panel,
        ${WB}.monaco-workbench .part.editor,
        ${WB}.monaco-workbench .part.activitybar,
        ${WB}.monaco-workbench .part.statusbar,
        ${WB}.monaco-workbench .part.titlebar,
        /* 菜单、hover 整棵子树排除在外：这条兜底的选择器特异性很高（四个 :not 也算），
           它们自己的底色/毛玻璃规则压不过它，留着就永远透明或永远没有模糊。 */
        ${WB4} *:not(.monaco-editor):not(.monaco-editor *):not(.monaco-list-row):not(.monaco-list-row *):not(.monaco-menu):not(.monaco-menu *):not(.uri-icon):not(.monaco-hover):not(.monaco-hover *) {
            background-color: transparent !important;
        }

        /* 右侧缩略图（minimap）是 canvas，底色由 Monaco 按主题的编辑器底色直接画进
           画布，不读 CSS 变量，所以没法完全透明；半透明才能让壁纸透出来。 */
        ${WB} .minimap {
            opacity: .55 !important;
        }

        /* 编辑器右侧的滚动条与概览标尺：editor.scrollbar.vertical 设为 hidden 只隐藏
           滑块，Monaco 仍会保留一条与 verticalScrollbarSize 等宽的列（概览标尺 canvas
           负责画 git 标记，底色由滚动条容器按主题绘制），在透明主题下就是一条黑带。
           这里把整列一起隐藏。 */
        ${WB} .monaco-editor .monaco-scrollable-element > .scrollbar.vertical,
        ${WB} .monaco-editor .decorationsOverviewRuler {
            display: none !important;
        }

        /* 列表的粘性祖先行是 .monaco-list-row，被上面那条兜底刻意放过，
           于是它还留着主题的纯黑底，滚动时在顶部糊出几条黑带。
           只打透还不够：下面滚上来的行会和它叠成「字压字」，所以整块做一次毛玻璃。 */
        ${WB4} .monaco-tree-sticky-container,
        ${WB4} .monaco-tree-sticky-row {
            background-color: transparent !important;
        }

        ${WB4} .monaco-tree-sticky-container {
            backdrop-filter: blur(14px) saturate(1.1);
            -webkit-backdrop-filter: blur(14px) saturate(1.1);
        }

        /* 上面那条兜底会把滚动条滑块一起打透，这里补回来。 */
        ${WB}.monaco-workbench .monaco-scrollable-element > .scrollbar > .slider {
            background-color: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, .4)) !important;
        }

        /* 3) 浮层毛玻璃：壁纸色块透出来，下面的内容被糊掉，不会文字叠文字。 */
        ${overlaySelectors} {
            background-color: var(${OVERLAY_CSS_VAR}) !important;
            backdrop-filter: blur(26px) saturate(1.1);
            -webkit-backdrop-filter: blur(26px) saturate(1.1);
        }

        /* 浮层内部的列表容器同样要透，否则毛玻璃上会盖一层实心底。
           只点列表容器，不点行 —— 行的选中/悬停高亮要留着。 */
        ${WB} .monaco-editor .editor-widget,
        ${WB} .monaco-editor .editor-widget .monaco-list,
        ${WB} .monaco-editor .editor-widget .monaco-list-rows,
        ${WB} .monaco-editor .monaco-hover-content,
        ${WB} .monaco-editor .find-widget > .find-part,
        ${WB} .monaco-editor .find-widget > .replace-part {
            background-color: transparent !important;
        }

        /* 菜单（含二级菜单）、设置里的下拉列表与 ActionWidget 弹层：完全透明 + 毛玻璃。
           backdrop-filter 不能加在菜单本体上 —— 那会让它成为 fixed 子元素的包含块，
           二级菜单位置算错、再被滚动容器裁掉。模糊交给 ::before 伪元素：它是菜单的
           子节点，不影响定位。
           .action-widget 是聊天/模型选择等新式下拉（Agent、Ask、Plan、权限弹层）的
           容器，底色读的是 --vscode-menu-background；不点名它就会只剩透明、没有模糊，
           弹层文字和下面的内容叠在一起。 */
        ${WB5} .monaco-menu,
        ${WB5} .monaco-submenu,
        ${WB5} .monaco-select-box-dropdown-container,
        ${WB5} .action-widget {
            background-color: transparent !important;
            /* 创建独立的层叠上下文，::before 的 z-index:-1 才会留在弹层内部、
               压在菜单内容下面；否则它会掉到工作台后面，模糊完全看不见
               （设置页齿轮菜单就是这样完全透明的）。 */
            isolation: isolate;
            /* will-change: opacity 会让元素成为 backdrop root，弹层内部的
               backdrop-filter 只能采样到空内容，模糊同样失效。VS Code 的
               菜单/下拉动画恰好在祖先上留了 will-change: opacity。 */
            will-change: auto !important;
        }

        /* 上下文菜单的滚动容器（动画规则里带 will-change: opacity）在菜单
           和背景之间，必须一并关掉，否则上面那条菜单模糊仍然采不到壁纸。 */
        ${WB5} .context-view > .monaco-scrollable-element {
            will-change: auto !important;
        }

        ${WB5} .monaco-menu::before,
        ${WB5} .monaco-submenu::before,
        ${WB5} .monaco-select-box-dropdown-container::before,
        ${WB5} .action-widget::before {
            content: '';
            position: absolute;
            inset: 0;
            z-index: -1;
            border-radius: inherit;
            backdrop-filter: blur(26px) saturate(1.1);
            -webkit-backdrop-filter: blur(26px) saturate(1.1);
        }

        /* 二级菜单是 .monaco-submenu 里再套一层 .monaco-menu，两层都命中上面的规则，
           于是同一块背景被连续模糊两次、sat(1.1) 也叠两次，看起来比一级菜单更"沉"。
           内层的::before 去掉，只留外层的模糊。 */
        ${WB5} .monaco-submenu .monaco-menu::before {
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
        }

        /* 设置页本身是一个 Monaco 编辑器，兜底规则刻意跳过 .monaco-editor 子树，
           于是它既没有底色也没有模糊，设置项的正文直接和底下的画面叠在一起。
           模糊必须加在 .settings-editor 这一层：编辑器内部的 .monaco-editor-background
           是巨型滚动层，Chromium 不给它做 backdrop 采样，加了也看不出效果。 */
        ${WB5} .settings-editor {
            backdrop-filter: blur(26px) saturate(1.1);
            -webkit-backdrop-filter: blur(26px) saturate(1.1);
        }

        /* 设置页里的输入框/下拉框/复选框：底色是内联样式 var(--vscode-settings-*)，
           而那个变量在高对比主题下是纯黑，只能靠 !important 压掉。 */
        ${WB5} .settings-editor .monaco-inputbox,
        ${WB5} .settings-editor .monaco-select-box,
        ${WB5} .settings-editor .monaco-custom-toggle {
            background-color: transparent !important;
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18);
        }

        ${WB5} .settings-editor .monaco-inputbox > .ibwrapper > .input,
        ${WB5} .settings-editor .monaco-select-box > option {
            background-color: transparent !important;
        }

        /* 粘滞滚动标题：底色打透后补一层轻模糊，滚到标题底下的代码不会和标题糊在一起。 */
        ${WB} .monaco-editor .sticky-widget {
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            box-shadow: none !important;
        }

        /* 按钮：高对比主题的 button.background 是纯黑，整个按钮就是一块黑板。
           改成透明 + 轻模糊，用一圈细描边保住「这是个按钮」的观感。 */
        ${WB5} .monaco-button,
        ${WB5} .monaco-text-button {
            background-color: transparent !important;
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .22);
        }

        ${WB5} .monaco-button:hover,
        ${WB5} .monaco-text-button:hover {
            background-color: rgba(255, 255, 255, .16) !important;
        }

        /* 活动栏里的插件图标是 mask + background-color 画的，
           上面那条兜底会把它一起打成透明（只剩悬停时的按钮底色）。 */
        ${WB} .activitybar .action-label.uri-icon {
            background-color: currentColor !important;
        }
    `;
}

// ---- 过渡动画 ----------------------------------------------------------------
/**
 * 背景层过渡动画声明（放在 body::before 规则内部）。开关关闭时不输出。
 */
export function getTransitionDeclaration(enabled: boolean): string {
    return enabled ? 'transition: opacity .25s ease, filter .25s ease;' : '';
}

/**
 * 过渡动画的"减少动态效果"兜底规则（顶层 @media，尊重系统减少动效偏好）。
 */
export function getTransitionReducedMotionCss(enabled: boolean): string {
    if (!enabled) {
        return '';
    }
    return `
        @media (prefers-reduced-motion: reduce) {
            body::before { transition: none; }
        }
    `;
}
