/**
 * Mirror of src/PickList.ts ActionType enum.
 * Keep in sync when adding new actions extension-side.
 */
export const ActionType = {
    SelectPictures:      1,
    AddDirectory:        2,
    UpdateBackground:    4,
    BackgroundOpacity:   5,
    InputPath:           6,
    CloseBackground:     7,
    ReloadWindow:        8,
    OpenFilePath:        14,
    BackgroundBlur:      18,
    AutoRandomSettings:  20,
    SelectPet:           26,
    TogglePet:           27,
    ToggleParticle:      31,
    ParticleOpacity:     32,
    ParticleColor:       33,
    ParticleCount:       34
} as const;

export const SIZE_MODES = [
    'cover', 'repeat', 'contain', 'center',
    'not_center', 'not_right_bottom', 'not_right_top',
    'not_left', 'not_right', 'not_top', 'not_bottom'
];

export const BLEND_MODES = ['auto', 'multiply', 'lighten'];

/**
 * Mirror of DEFAULT/MIN/MAX_PARTICLE_FPS in src/ParticleEffect.ts（前端无法 import 扩展侧代码）。
 * 帧率上限用于修复高刷屏下粒子特效 GPU 占用随刷新率线性上升的问题（#230）。
 * scripts/test-particle-throttle.js 会校验与扩展侧常量是否漂移。
 */
export const DEFAULT_PARTICLE_FPS = 60;
export const MIN_PARTICLE_FPS = 10;
export const MAX_PARTICLE_FPS = 120;

/** 关于区入口（仓库 / Issues / Star）。 */
export const GITHUB_REPO_URL = 'https://github.com/AShujiao/vscode-background-cover';
export const GITHUB_ISSUES_URL = 'https://github.com/AShujiao/vscode-background-cover/issues';
