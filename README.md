# 📁 文件整理助手

按 [Vibe Guide](https://rouicezar.github.io/Vibecoding-guide/zh-cn/)「桌面 App」示例制作的第一版：选择文件夹、预览整理结果、确认后复制到新位置，**原文件始终保留**。

## 三步开始

```bash
# 1. 安装依赖（首次）
npm install

# 2. 开发运行（可选）
npm start

# 3. 打包为 exe（自动生成安装包 + 便携版）
npm run dist
```

打包完成后，exe 在 `release/` 文件夹：

- `FileOrganizer-Setup-0.1.0-x64.exe` —— 安装包（装到电脑上，带桌面快捷方式）
- `FileOrganizer-Portable-0.1.0-x64.exe` —— 便携版（免安装，双击即用）

## 使用说明

1. 选择要整理的文件夹
2. 选择结果保存位置
3. 点「预览整理结果」，核对每个文件的分类与位置
4. 点「确认整理」，文件被复制到目标文件夹的分类子目录（图片/视频/音频/文档/压缩包/程序/其他）
5. 原文件始终保留；同名文件自动加序号，绝不覆盖

## 数据与恢复

- 本工具不保存任何数据；整理结果就是目标文件夹里的文件，卸载/删除本工具不影响它们。
- 原文件只被复制、从不移动或删除。

## 常见问题

- **其他电脑提示「Windows 已保护你的电脑」**：未做代码签名，选「更多信息 → 仍要运行」。正式分发前按官方要求做代码签名（见 docs/delivery.md）。
- **`npm start` 后窗口一闪而过 / 报 ipcMain 错误**：本机环境变量里有 `ELECTRON_RUN_AS_NODE=1`（某些软件设置），会让 Electron 以纯 Node 模式运行。本项目的 `npm start` 已自动清除该变量；直接双击 exe 不受影响。若其他 Electron 程序也打不开，检查并移除这个环境变量。
- **打包失败**：删除 `node_modules`，重新 `npm install`，再 `npm run dist`。
- **想调整分类规则**：编辑 `src/main.js` 里的 `CATEGORY_RULES`。

## 项目文档

| 文件 | 内容 |
|---|---|
| docs/requirements.md | 需求与第一版范围 |
| docs/design.md | 技术选择、理由与限制 |
| docs/delivery.md | 交付物与安装说明 |
| docs/release.md | 打包与试运行记录（每次打包后更新） |
