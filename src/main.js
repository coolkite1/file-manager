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
    // 用 exit 而非 close：Windows 下孙进程可能一直持有管道，close 永不触发
    child.on('exit', (code) => { buildJob = null; resolve(code ?? -1); });
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

// ---------- 文档转换（页面三：PDF ⇄ Word） ----------

const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const os = require('os');

// 选择文档文件（pdf / docx）
let convTestIndex = 0; // 自动化测试入口 FO_TEST_FILES 的取用游标
ipcMain.handle('conv:selectFile', async (event) => {
  // 自动化测试入口：设置 FO_TEST_FILES（"a.docx;b.pdf"）后按顺序返回预设文件
  const testFiles = process.env.FO_TEST_FILES ? process.env.FO_TEST_FILES.split(';') : null;
  if (testFiles) {
    const f = testFiles[convTestIndex++ % testFiles.length];
    return f || null;
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择 PDF 或 Word 文档',
    properties: ['openFile'],
    filters: [{ name: '文档', extensions: ['pdf', 'docx'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 文件基本信息
ipcMain.handle('conv:info', async (event, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return {
    name: path.basename(filePath),
    dir: path.dirname(filePath),
    kind: ext === '.pdf' ? 'pdf' : ext === '.docx' ? 'docx' : 'unknown',
    size: fs.statSync(filePath).size,
  };
});

// 文件内容（base64，供界面预览 PDF 用）
ipcMain.handle('conv:fileData', async (event, filePath) => {
  return fs.readFileSync(filePath).toString('base64');
});

// pdf.js worker 源码（界面用 Blob URL 方式加载 worker）
ipcMain.handle('conv:workerText', async () => {
  const workerPath = path.join(__dirname, 'renderer', 'vendor', 'pdf.worker.mjs');
  return fs.readFileSync(workerPath, 'utf8');
});

// Word 预览：docx → HTML（图片内联为 data URI）
ipcMain.handle('conv:docxToHtml', async (event, filePath) => {
  const { value } = await mammoth.convertToHtml(
    { path: filePath },
    {
      convertImage: mammoth.images.imgElement((image) =>
        image.read('base64').then((b64) => ({ src: `data:${image.contentType};base64,${b64}` }))
      ),
    }
  );
  return value;
});

// 提取 PDF 文字：逐页按行输出（供 PDF→Word 转换与检查使用）
async function extractPdfLines(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const it of content.items) {
      const s = (it.str || '').trim();
      if (!s) continue;
      const y = Math.round(it.transform[5] / 5) * 5; // 按纵向坐标分组为行
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(s);
    }
    const lines = [...rows.keys()]
      .sort((a, b) => b - a)
      .map((y) => rows.get(y).join(' ').trim())
      .filter(Boolean);
    pages.push({ number: i, lines });
  }
  // 兼容 pdf.js 新旧 API：新版 destroy()，legacy 构建 cleanup()
  if (typeof doc.destroy === 'function') await doc.destroy();
  else if (typeof doc.cleanup === 'function') await doc.cleanup();
  return pages;
}

// PDF → Word：文字版转换（图片与复杂排版不保留，界面已注明）
// 输出到源文件同目录，同名时自动加序号，绝不覆盖
ipcMain.handle('conv:pdfToDocx', async (event, { pdfPath }) => {
  const outPath = await uniquePath(path.dirname(pdfPath), `${path.basename(pdfPath, '.pdf')}.docx`);
  const pages = await extractPdfLines(pdfPath);
  const children = [];
  for (const pg of pages) {
    children.push(new Paragraph({ text: `第 ${pg.number} 页`, heading: HeadingLevel.HEADING_2 }));
    for (const line of pg.lines) {
      children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
  return { ok: true, outPath, pages: pages.length, lines: pages.reduce((n, p) => n + p.lines.length, 0) };
});

// Word → PDF：docx → HTML（mammoth）→ 隐藏窗口 printToPDF；同名自动加序号
ipcMain.handle('conv:docxToPdf', async (event, { docxPath }) => {
  const outPath = await uniquePath(path.dirname(docxPath), `${path.basename(docxPath, '.docx')}.pdf`);
  const { value: html } = await mammoth.convertToHtml(
    { path: docxPath },
    {
      convertImage: mammoth.images.imgElement((image) =>
        image.read('base64').then((b64) => ({ src: `data:${image.contentType};base64,${b64}` }))
      ),
    }
  );
  const wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 12pt; margin: 2cm; line-height: 1.6; }
    img { max-width: 100%; }
    table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 4px 8px; }
  </style></head><body>${html}</body></html>`;
  const tmpHtml = path.join(os.tmpdir(), `fo-conv-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, wrapped, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadFile(tmpHtml);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(outPath, pdf);
    return { ok: true, outPath };
  } finally {
    win.destroy();
    try { fs.unlinkSync(tmpHtml); } catch { /* 临时文件清理失败不影响结果 */ }
  }
});

// ---------- 压缩解压（页面四：zip） ----------

const { ZipArchive } = require('archiver'); // archiver 8：工厂函数改为 ZipArchive 类
const yauzl = require('yauzl');
const iconv = require('iconv-lite');

let zipJob = { cancelled: false }; // 当前压缩/解压任务状态（供取消）

// 按 zip 规范解码条目名：UTF-8 标志位优先；老工具生成的 GBK 压缩包按 GBK 解码
function decodeZipName(entry) {
  const raw = Buffer.isBuffer(entry.fileName) ? entry.fileName : Buffer.from(entry.fileName);
  const isUtf8 = (entry.generalPurposeBitFlag & 0x800) !== 0;
  return isUtf8 ? raw.toString('utf8') : iconv.decode(raw, 'gbk');
}

// 是否为目录条目（decodeStrings:false 时 fileName 是 Buffer，不能直接调 endsWith）
function isDirEntry(entry) {
  const raw = Buffer.isBuffer(entry.fileName) ? entry.fileName : Buffer.from(entry.fileName);
  return raw.length > 0 && raw[raw.length - 1] === 0x2f; // 0x2f = '/'
}

// 选择要压缩的文件/文件夹（可多选）
let zipTestIndex = 0; // 自动化测试入口 FO_TEST_ZIP_SRC 的取用游标
ipcMain.handle('zip:selectFiles', async (event) => {
  const test = process.env.FO_TEST_ZIP_SRC ? process.env.FO_TEST_ZIP_SRC.split(';') : null;
  if (test) {
    const batch = test[zipTestIndex++ % test.length];
    return batch ? batch.split('|') : [];
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择要压缩的文件或文件夹（可多选）',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

// 选择要解压的 zip 文件
let zipFileTestIndex = 0; // 自动化测试入口 FO_TEST_ZIP_FILE 的取用游标
ipcMain.handle('zip:selectZip', async (event) => {
  const test = process.env.FO_TEST_ZIP_FILE ? process.env.FO_TEST_ZIP_FILE.split(';') : null;
  if (test) return test[zipFileTestIndex++ % test.length] || null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择要解压的 zip 文件',
    properties: ['openFile'],
    filters: [{ name: 'zip 压缩包', extensions: ['zip'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 预览压缩包内容（只读）
ipcMain.handle('zip:list', async (event, zipPath) => {
  const entries = await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (err, zf) => {
      if (err) return reject(err);
      const list = [];
      zf.on('entry', (entry) => {
        const name = decodeZipName(entry);
        list.push({
          name: name.replace(/\\/g, '/'),
          size: entry.uncompressedSize,
          isDir: isDirEntry(entry),
        });
        zf.readEntry();
      });
      zf.on('end', () => resolve(list));
      zf.on('error', reject);
      zf.readEntry();
    });
  });
  return {
    entries,
    count: entries.length,
    totalSize: entries.reduce((n, e) => n + e.size, 0),
  };
});

// 压缩：支持多选；输出到第一项同目录，同名自动加序号；进度经 zip:progress 事件推送
ipcMain.handle('zip:compress', async (event, { items }) => {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, message: '没有选择要压缩的内容' };
  const base = items.length === 1 ? path.basename(items[0]) : '压缩包';
  const outZip = await uniquePath(path.dirname(items[0]), `${base}.zip`);
  const wc = event.sender;
  zipJob = { cancelled: false };
  const send = (data) => { if (!wc.isDestroyed()) wc.send('zip:progress', { kind: 'compress', ...data }); };
  try {
    const result = await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outZip);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      zipJob.archive = archive;
      output.on('close', () => resolve({ ok: true, outZip, size: archive.pointer() }));
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('progress', (p) => send({
        processed: p.fs.processedBytes,
        total: p.fs.totalBytes,
        ratio: p.fs.totalBytes ? p.fs.processedBytes / p.fs.totalBytes : 0,
      }));
      archive.on('entry', (e) => send({ entry: e.name.replace(/\\/g, '/') }));
      archive.pipe(output);
      for (const item of items) {
        const st = fs.statSync(item);
        if (st.isDirectory()) archive.directory(item, path.basename(item));
        else archive.file(item, { name: path.basename(item) });
      }
      archive.finalize();
    });
    return result;
  } catch (err) {
    if (zipJob.cancelled) return { ok: false, cancelled: true, outZip, message: '已取消压缩' };
    return { ok: false, outZip, message: err.message };
  }
});

// 解压：输出到压缩包同目录的同名文件夹，同名自动加序号；
// 逐条写入、路径穿越防护、可取消；进度经 zip:progress 事件推送。
// yauzl 惰性模式要求：openReadStream 必须在 entry 回调内调用、流结束后再 readEntry()
ipcMain.handle('zip:extract', async (event, { zipPath }) => {
  const base = path.basename(zipPath, '.zip');
  const outDir = await uniquePath(path.dirname(zipPath), base);
  const wc = event.sender;
  zipJob = { cancelled: false };
  const send = (data) => { if (!wc.isDestroyed()) wc.send('zip:progress', { kind: 'extract', ...data }); };
  try {
    // 先读一遍中央目录拿总数（供进度显示）
    const list = await new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (err, zf) => {
        if (err) return reject(err);
        const entries = [];
        zf.on('entry', (entry) => { entries.push(entry); zf.readEntry(); });
        zf.on('error', reject);
        zf.on('end', () => resolve(entries));
        zf.readEntry();
      });
    });
    const total = list.filter((e) => !isDirEntry(e)).length;
    const result = await new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (err, zf) => {
        if (err) return reject(err);
        const outRoot = path.resolve(outDir);
        let done = 0;
        const processEntry = async (entry) => {
          try {
            if (zipJob.cancelled) return resolve({ cancelled: true, done, total, outDir });
            const name = decodeZipName(entry).replace(/\\/g, '/');
            const target = path.resolve(outRoot, name);
            // 防护：目标路径必须位于解压目录之内（防 ../ 穿越与绝对路径），越界条目跳过
            if (target !== outRoot && !target.startsWith(outRoot + path.sep)) {
              zf.readEntry();
              return;
            }
            if (isDirEntry(entry)) {
              await fsp.mkdir(target, { recursive: true });
              zf.readEntry();
              return;
            }
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await new Promise((res, rej) => {
              zf.openReadStream(entry, (e2, rs) => {
                if (e2) return rej(e2);
                const ws = fs.createWriteStream(target);
                rs.pipe(ws);
                ws.on('close', res);
                ws.on('error', rej);
              });
            });
            done += 1;
            send({ done, total, name });
            zf.readEntry();
          } catch (e) { reject(e); }
        };
        zf.on('entry', processEntry);
        zf.on('error', reject);
        zf.on('end', () => resolve({ cancelled: false, done, total, outDir }));
        zf.readEntry();
      });
    });
    return result;
  } catch (err) {
    return { cancelled: false, ok: false, message: err.message };
  }
});

// 取消压缩/解压
ipcMain.on('zip:cancel', () => {
  zipJob.cancelled = true;
  if (zipJob.archive) {
    try { zipJob.archive.abort(); } catch { /* 忽略中止异常 */ }
  }
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
