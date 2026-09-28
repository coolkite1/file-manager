// 主进程：创建窗口，提供文件整理与项目打包相关的系统能力
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
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

// 递归列出文件夹里的所有文件，保留相对路径（rel 用 "/" 分隔）；
// 跳过符号链接 / 快捷方式，防止循环和误跟到外部目录
async function listFiles(root) {
  const out = [];
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        out.push({ name: e.name, rel });
      }
    }
  }
  await walk(root, '');
  return out;
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

function emptyResults() {
  return { copied: [], errors: [] };
}

// 自定义图标：把图标放到 build/icon.png（≥256×256）或 build/icon.ico，
// 打包与开发运行都会自动使用；没有该文件时用 Electron 默认图标
const customIcon = path.join(__dirname, '..', 'build', 'icon.png');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    title: '文件整理助手',
    autoHideMenuBar: true,
    icon: fs.existsSync(customIcon) ? customIcon : undefined,
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

// 预览整理结果：只读，不做任何修改；子文件夹文件保留原目录结构
ipcMain.handle('organize:preview', async (event, sourceDir, targetDir) => {
  const files = await listFiles(sourceDir);
  const byCategory = {};
  const preview = files.map(({ name, rel }) => {
    const category = categoryOf(name);
    byCategory[category] = (byCategory[category] || 0) + 1;
    return {
      name,
      rel,
      category,
      targetRelative: path.posix.join(category, rel || '', name),
      conflict: fs.existsSync(path.join(targetDir, category, rel || '', name)),
    };
  });
  return { files: preview, total: files.length, byCategory };
});

// 执行整理：只处理界面勾选的文件列表（files: [{name, rel}]）；
// 复制到新位置，原文件保留；同名自动加序号；子文件夹保留结构
ipcMain.handle('organize:execute', async (event, { sourceDir, targetDir, files }) => {
  currentJob = { cancelled: false };
  if (!Array.isArray(files) || files.length === 0) {
    return { ...emptyResults(), cancelled: false, message: '没有需要整理的文件' };
  }
  const results = { copied: [], errors: [] };
  for (let i = 0; i < files.length; i += 1) {
    if (currentJob.cancelled) return { ...results, cancelled: true };
    const { name, rel } = files[i];
    try {
      const category = categoryOf(name);
      const catDir = path.join(targetDir, category, rel || '');
      await fsp.mkdir(catDir, { recursive: true });
      const dest = await uniquePath(catDir, name);
      await fsp.copyFile(path.join(sourceDir, rel || '', name), dest);
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

// ---------- 打包项目（页面二） ----------

let buildJob = null; // 正在进行的打包子进程

// 子进程环境：清除本机的 ELECTRON_RUN_AS_NODE，避免影响构建工具
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// 极简解析 electron-builder.yml 的 files: 列表（行级 "- xxx"）
function readFilesConfig(projectDir) {
  const ymlPath = path.join(projectDir, 'electron-builder.yml');
  if (!fs.existsSync(ymlPath)) return null;
  const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
  let inFiles = false;
  const patterns = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    if (!inFiles) continue;
    if (/^-\s+/.test(line)) {
      const p = line.replace(/^-\s+/, '').replace(/\s*#.*$/, '').trim();
      if (p) patterns.push(p);
    } else if (line !== '' && !line.startsWith('-')) {
      break; // files 块结束
    }
  }
  return patterns.length ? patterns : null;
}

// 展开打包文件范围：支持 `dir/**/*` 与具体文件名；未配置 files 时默认全部（不含常见排除项）
function expandPatterns(projectDir, patterns) {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'release', 'dist'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(projectDir, p).replace(/\\/g, '/'));
    }
  };
  if (!patterns) {
    walk(projectDir);
    return files;
  }
  for (const pat of patterns) {
    const m = pat.match(/^(.+?)\/\*\*\/\*$/);
    if (m) {
      const base = path.join(projectDir, m[1]);
      if (fs.existsSync(base)) walk(base);
    } else if (fs.existsSync(path.join(projectDir, pat))) {
      files.push(pat);
    }
  }
  return files;
}

// 构建产物扫描
function findArtifacts(projectDir) {
  const out = [];
  for (const d of ['release', 'dist']) {
    const dir = path.join(projectDir, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.exe')) continue;
      const full = path.join(dir, f);
      out.push({ name: f, path: full, size: fs.statSync(full).size });
    }
  }
  return out;
}

// 检查项目能否打包：环境、依赖、构建命令、文件筛选清单
ipcMain.handle('build:check', async (event, projectDir) => {
  const issues = [];
  const info = { projectDir };

  const node = spawnSync('node', ['--version'], { shell: true, encoding: 'utf8' });
  const npm = spawnSync('npm', ['--version'], { shell: true, encoding: 'utf8' });
  if (node.status !== 0) issues.push('未检测到 Node.js（打包需要本机安装 Node.js）');
  else info.nodeVersion = (node.stdout || '').trim();
  if (npm.status !== 0) issues.push('未检测到 npm');
  else info.npmVersion = (npm.stdout || '').trim();

  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    issues.push('找不到 package.json —— 这不是一个 Node 项目');
  } else {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
    catch { issues.push('package.json 内容无法解析'); pkg = {}; }
    const dev = pkg.devDependencies || {};
    if (!dev.electron) issues.push('devDependencies 缺少 electron —— 不是 Electron 项目');
    if (!dev['electron-builder']) issues.push('devDependencies 缺少 electron-builder');
    info.hasBuilderYml = fs.existsSync(path.join(projectDir, 'electron-builder.yml'));
    info.buildCmd = pkg.scripts && pkg.scripts.dist
      ? 'npm run dist'
      : 'npx electron-builder --win';
    info.needsInstall = !fs.existsSync(path.join(projectDir, 'node_modules', 'electron-builder'));
    info.appVersion = pkg.version || '未知';
    info.appName = pkg.name || '未知';
  }

  info.filesConfig = readFilesConfig(projectDir);
  info.matched = expandPatterns(projectDir, info.filesConfig);
  info.excluded = ['node_modules/', 'release/', '.git/', 'dist/',
    'docs/、README.md（文档，不进 exe）', 'test-data/、screenshots/（测试与截图）',
    'scripts/（打包脚本，不进 exe）'];

  return { ok: issues.length === 0, issues, info };
});

// 启动打包：npm install（可选）→ 构建命令；日志通过 build:log 事件推送
ipcMain.handle('build:start', async (event, { projectDir, buildCmd, needsInstall, autoInstall }) => {
  const wc = event.sender;
  if (buildJob) return { started: false, message: '已有打包任务在进行' };
  const sendLog = (line) => { if (!wc.isDestroyed()) wc.send('build:log', line); };
  const run = (cmd) => new Promise((resolve) => {
    const child = spawn(cmd, { cwd: projectDir, env: cleanEnv(), shell: true, windowsHide: true });
    buildJob = child;
    const pump = (buf) => String(buf).replace(/\r?\n$/, '').split(/\r?\n/).forEach(sendLog);
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('close', (code) => { buildJob = null; resolve(code ?? -1); });
    child.on('error', (err) => { buildJob = null; sendLog('启动失败: ' + err.message); resolve(-1); });
  });

  let code;
  if (autoInstall && needsInstall) {
    sendLog('> 自动安装依赖: npm install');
    code = await run('npm install');
    if (code !== 0) {
      wc.send('build:done', { code, artifacts: [], message: '依赖安装失败，请查看上方日志' });
      return;
    }
  }
  sendLog(`> 开始构建: ${buildCmd}`);
  code = await run(buildCmd);
  const artifacts = findArtifacts(projectDir);
  wc.send('build:done', {
    code,
    artifacts,
    message: code === 0
      ? `构建成功，生成 ${artifacts.length} 个 exe 产物`
      : '构建失败，请查看上方日志',
  });
});

// 取消打包
ipcMain.on('build:cancel', () => {
  if (buildJob) buildJob.kill();
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
