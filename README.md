
<h1 align="center">
    <img src="resources/background-cover.png" alt="logo" width="180"><br>
    VS Code - Background Cover
</h1>

<p align="center">
    <b>让你喜欢的图片或视频铺满 VS Code，只保留本地图像壁纸：热更新、视频背景、自动轮播、多窗口独立背景</b><br>
    <a href="https://github.com/Lose-Memory/vscode-background-cover">
        <img src="https://img.shields.io/github/stars/Lose-Memory/vscode-background-cover.svg?style=social" alt="stars">
    </a>
</p>

![Background Cover Studio preview](resources/readme-preview.jpg)


## 🚀 3.8.0 本地精简版

本分支只保留「用本地图像作壁纸」这一件事，其余功能已移除：

1. **❌ 移除在线图库**：在线图片 / 在线视频、社区图库入口、在线缓存与「打开缓存目录」一并删除，只认本地文件与文件夹。
2. **❌ 移除粒子动画**：鼠标跟随粒子特效、状态栏粒子按钮与相关设置全部删除。
3. **❌ 移除顶部小宠物**：小动物与 Codex 宠物同步、冒泡文案全部删除，装饰页也已移除。
4. **❌ 取消播放历史**：不再记录「最近使用」的图片，图库页不再有历史列表。
5. **✅ 新增递归检索**：`backgroundCover.folderScanDepth` 设置（默认 3 层，0 = 只看当前目录），随机换图与目录选图都会递归扫描子目录，最多 50000 张。
6. **✅ 图库改用缩略图**：侧边栏图库预览由 sharp 生成 160px WebP 缩略图（按路径 + 修改时间缓存在扩展目录），不再加载原图。
---

## 🌟 功能特性

- **Studio 配置面板**：首页、本地图库、高级设置集中管理。
- **界面主题**：支持默认主题和守望主题，可在面板右上角切换。
- **图片/视频背景**：支持本地图片与本地视频；本地路径支持 `~`、`${ENV}`、`$ENV` 变量和文件夹（自动随机取一张）。
- **递归检索子目录**：可设置扫描层数（`backgroundCover.folderScanDepth`，默认 3 层，0 = 只看当前目录），最多收集 50000 张。
- **热更新**：切换背景即刻生效，无需重启 VS Code。
- **多窗口独立背景**：每个窗口可显示各自的背景图，也可切回全部窗口共用。
- **AgentView 支持**：支持 VS Code AgentView / Agent Sessions 独立窗口背景显示。
- **自动轮播**：多张图片/视频可定时自动切换，换图前预加载 + 淡入淡出过渡，不再闪烁。
- **本地图库**：文件夹图片缩略图预览、分页浏览和点击设置背景。
- **可视化配置**：左侧 Studio 面板一键设置，支持中英双语。
- **透明度/模糊/填充模式**：自定义背景透明度、模糊度、填充方式；多窗口模式下每个工作区可各自独立设置透明度与模糊度。
- **过渡动画**：切换背景/调整参数时淡入淡出（可关闭），并尊重系统「减少动态效果」。
- **跨平台支持**：兼容 Windows、MacOS、Linux 及 Code-Server。
- **自动权限处理**：Windows 下自动获取写入权限，无需手动操作。


## ⚠️ 注意事项

> 本插件通过修改 VS Code 内部文件实现效果。

1. **首次使用/升级到 3.x**：需重新获取权限（Hook），并重启一次 VS Code。
2. **初次安装/更新**：如遇「安装损坏」提示，扩展已自动屏蔽，无需任何操作。
3. **背景重叠/异常**：升级后如遇背景重叠，请重启 VS Code。
4. **还原方法**：如 VS Code 无法打开，请手动还原：
   - 路径：`Microsoft VS Code\resources\app\out\vs\workbench\`
   - 将 `workbench.desktop.main.js.bak` 重命名为 `workbench.desktop.main.js`


## 🖼️ 效果展示

![](https://github.com/user-attachments/assets/7bd68f60-55af-42e8-980a-99bf1b3e078d)
![](https://github.com/user-attachments/assets/047617e6-7e09-441e-b9df-ae6a2bb940d9)
![](https://github.com/user-attachments/assets/3c0a214f-7563-43b9-9579-314647808ccf)


## ⚙️ 配置方式

> **推荐**：点击左侧活动栏的 `Background Cover` 图标，打开可视化配置面板，所有设置一目了然。

- **图片/视频源**：支持本地文件、本地文件夹（自动随机取一张，可递归子目录）。
- **外观**：调整透明度、模糊度、填充模式。
- **高级**：配置自动轮播间隔、混合模式，以及「应用更改 / 重启窗口」按钮。

*也可通过命令面板 `Ctrl + Shift + P` -> `backgroundCover - start` 进入设置*


## 📝 快捷键与使用

- **切换背景**：点击底部状态栏按钮
- **打开/配置**：`Ctrl + Shift + P` -> `backgroundCover - start`
- **重新应用**：VS Code 更新后如背景消失，请重新设置

> **首次升级到 3.x 必须重新授权并重启 VS Code 才能生效！**




## 🗑️ 卸载说明

1. 禁用/卸载插件
2. 重启 VS Code
3. 插件会自动清理残留背景


## ❓ 常见问题

**Q: 安装后无反应？**
A: 请确保有管理员权限（右键 VS Code 图标 -> 以管理员身份运行）。

**Q: Mac 如何授权？**
A: 插件会自动请求密码，或手动 `sudo chown` 相关文件。

---

## 📝 更新日志

[完整日志](./CHANGELOG.md)

#### ver 3.8.0 本地精简版

1. 只保留本地图像/视频壁纸：删除在线图库、在线图片下载与缓存、粒子动画、顶部小宠物、装饰页。
2. 取消记录最近使用的图片。
3. 新增 `backgroundCover.folderScanDepth`：随机换图与目录选图递归检索子目录（默认 3 层，最多 50000 张）。
4. 图库预览改用 sharp 生成的缩略图，不再加载原图。

## 📄 许可证
本项目采用 [MIT 许可证](LICENSE) 进行许可。

---

本项目基于 [AShujiao/vscode-background-cover](https://github.com/AShujiao/vscode-background-cover) 改写，感谢原作者与所有贡献者。
