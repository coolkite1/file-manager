// 主进程：创建窗口，提供文件整理相关的系统能力
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// 按扩展名把文件归入分类（想调整规则改这里）
const CATEGORY_RULES = [
  { name: '图片', exts: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tif', '.tiff', '.heic'] },
  { name: '视频', exts: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.rmvb'] },
  { name: '音频', exts: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'] },
  { name: '文档', exts: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.txt', '.md', '.csv', '.rtf', '.odt'] },
  { name: '压缩包', exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso'] },
  { name: '程序', exts: ['.exe', '.msi', '.bat', '.cmd', '.ps1', '.apk', '.dmg', '.deb', '.rpm'] },
];

function categoryOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  const rule = CATEGORY_RULES.find((r) => r.exts.includes(ext));
  return rule ? rule.name : '其他';
}

async function listFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

// 目标位置已有同名文件时自动加序号，绝不覆盖
async function uniquePath(targetDir, filename) {
  const direct = path.join(targetDir, filename);
  if (!fs.existsSync(direct)) return direct;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let i = 2; ; i += 1) {
    const candidate = path.join(targetDir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

// 当前整理任务状态（供“取消整理”使用）
let currentJob = { cancelled: false };

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    title: '文件整理助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

// 选择文件夹
// 自动化测试入口：设置 FO_TEST_DIRS 环境变量（如 "源目录;目标目录"）后，
// 选择对话框按顺序返回预设路径而不再弹出原生窗口（scripts/drive.mjs 使用）；
// 未设置时行为与正常使用完全一致。
const testDirs = process.env.FO_TEST_DIRS ? process.env.FO_TEST_DIRS.split(';') : null;
let testDirIndex = 0;
ipcMain.handle('dialog:selectFolder', async (event, title) => {
  if (testDirs) return testDirs[testDirIndex++ % testDirs.length] || null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title,
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// 预览整理结果：只读，不做任何修改
ipcMain.handle('organize:preview', async (event, sourceDir, targetDir) => {
  const files = await listFiles(sourceDir);
  const byCategory = {};
  const preview = files.map((name) => {
    const category = categoryOf(name);
    byCategory[category] = (byCategory[category] || 0) + 1;
    return {
      name,
      category,
      targetRelative: path.posix.join(category, name),
      conflict: fs.existsSync(path.join(targetDir, category, name)),
    };
  });
  return { files: preview, total: files.length, byCategory };
});

// 执行整理：复制到新位置，原文件保留；同名自动加序号
ipcMain.handle('organize:execute', async (event, { sourceDir, targetDir }) => {
  currentJob = { cancelled: false };
  const files = await listFiles(sourceDir);
  const results = { copied: [], errors: [] };
  for (let i = 0; i < files.length; i += 1) {
    if (currentJob.cancelled) return { ...results, cancelled: true };
    const name = files[i];
    try {
      const category = categoryOf(name);
      const catDir = path.join(targetDir, category);
      await fsp.mkdir(catDir, { recursive: true });
      const dest = await uniquePath(catDir, name);
      await fsp.copyFile(path.join(sourceDir, name), dest);
      results.copied.push({
        name,
        category,
        destination: path.relative(targetDir, dest),
        renamed: path.basename(dest) !== name,
      });
    } catch (err) {
      results.errors.push({ name, message: err.message });
    }
  }
  return { ...results, cancelled: currentJob.cancelled };
});

// 取消整理
ipcMain.on('organize:cancel', () => {
  currentJob.cancelled = true;
});

// 在资源管理器中打开文件夹
ipcMain.handle('organize:openTarget', async (event, dir) => {
  const err = await shell.openPath(dir);
  return err ? { ok: false, message: err } : { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
