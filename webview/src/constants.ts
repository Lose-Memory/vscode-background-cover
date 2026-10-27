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
    AutoRandomSettings:  20
} as const;

export const SIZE_MODES = [
    'cover', 'repeat', 'contain', 'center',
    'not_center', 'not_right_bottom', 'not_right_top',
    'not_left', 'not_right', 'not_top', 'not_bottom'
];

export const BLEND_MODES = ['auto', 'multiply', 'lighten'];

/** 关于区入口（仓库 / Issues / Star）。 */
export const GITHUB_REPO_URL = 'https://github.com/AShujiao/vscode-background-cover';
export const GITHUB_ISSUES_URL = 'https://github.com/AShujiao/vscode-background-cover/issues';
