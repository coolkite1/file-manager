// scripts/drive.mjs — 自动化试运行驱动
// 启动应用，走完「选文件夹 → 预览 → 确认整理」全流程，截图并核对文件系统。
// 运行：node scripts/drive.mjs（截图输出到 screenshots/）
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');
const SOURCE = path.join(APP_DIR, 'test-data', 'source');
const TARGET = path.join(APP_DIR, 'test-data', 'target');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// 本机环境的 ELECTRON_RUN_AS_NODE=1 会让 Electron 以纯 Node 模式运行，先清除
// FO_TEST_DIRS 第三项：打包项目页测试用（选择本项目自身进行真实打包）
const DOCX_FIXTURE = path.join(APP_DIR, 'test-data', '文档示例.docx');
const PDF_FIXTURE = DOCX_FIXTURE.replace(/\.docx$/, '.pdf');
const ROUNDTRIP_DOCX = DOCX_FIXTURE.replace(/\.docx$/, ' (2).docx');
const ZIP_FIXTURE = path.join(APP_DIR, 'test-data', 'source.zip');
const ZIP_EXTRACT_DIR = path.join(APP_DIR, 'test-data', 'source (2)');
const env = {
  ...process.env,
  FO_TEST_DIRS: `${SOURCE};${TARGET};${APP_DIR}`,
  FO_TEST_FILES: `${DOCX_FIXTURE};${PDF_FIXTURE}`,
  FO_TEST_ZIP_SRC: SOURCE,
  FO_TEST_ZIP_FILE: ZIP_FIXTURE,
};
delete env.ELECTRON_RUN_AS_NODE;

// 清理上次测试的产物
for (const f of [PDF_FIXTURE, ROUNDTRIP_DOCX, ZIP_FIXTURE]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
if (fs.existsSync(ZIP_EXTRACT_DIR)) fs.rmSync(ZIP_EXTRACT_DIR, { recursive: true, force: true });

const failures = [];
const shot = async (name) => {
  try {
    await page.screenshot({ path: path.join(SHOT_DIR, name), timeout: 20000 });
  } catch (e) {
    console.log('WARN  截图失败 ' + name + ': ' + e.message.split('\n')[0]);
  }
};
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '   [' + extra + ']' : ''}`);
  if (!cond) failures.push(label);
};

// 重置目标目录：只保留预置的「已有同名文件」，用于验证自动加序号
for (const entry of fs.readdirSync(TARGET)) {
  if (entry !== '文档') fs.rmSync(path.join(TARGET, entry), { recursive: true, force: true });
}
const docDir = path.join(TARGET, '文档');
for (const f of fs.readdirSync(docDir)) {
  if (f !== '同名.docx') fs.rmSync(path.join(docDir, f), { recursive: true, force: true });
}
if (!fs.existsSync(path.join(docDir, '同名.docx'))) fs.writeFileSync(path.join(docDir, '同名.docx'), 'old');

console.log('1) 启动应用 ...');
// DRIVE_EXECUTABLE 指向打包后的 exe 时，可验证打包版（DRIVE_SKIP_PACK=1 跳过打包页步骤）
const DEV_EXECUTABLE = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const EXECUTABLE = process.env.DRIVE_EXECUTABLE || DEV_EXECUTABLE;
const SKIP_PACK = process.env.DRIVE_SKIP_PACK === '1';
const app = await electron.launch({
  executablePath: EXECUTABLE,
  args: EXECUTABLE === DEV_EXECUTABLE ? [APP_DIR] : [],
  env,
  timeout: 30000,
});
const page = await app.firstWindow();
await page.waitForSelector('#btn-source', { timeout: 15000 });
await shot('01-启动.png');
console.log('   窗口已渲染');

console.log('2) 选择源文件夹 ...');
await page.evaluate(() => document.getElementById('btn-source').click());
await page.waitForFunction(() => document.getElementById('source-dir').value !== '');
const srcVal = await page.evaluate(() => document.getElementById('source-dir').value);
check('源文件夹已填入', srcVal === SOURCE, srcVal);

console.log('3) 选择目标文件夹 ...');
await page.evaluate(() => document.getElementById('btn-target').click());
await page.waitForFunction(() => document.getElementById('target-dir').value !== '');
const tgtVal = await page.evaluate(() => document.getElementById('target-dir').value);
check('目标文件夹已填入', tgtVal === TARGET, tgtVal);

console.log('4) 预览整理结果 ...');
await page.evaluate(() => document.getElementById('btn-preview').click());
await page.waitForSelector('#preview-body tr', { timeout: 10000 });
const rowCount = await page.evaluate(() => document.querySelectorAll('#preview-body tr').length);
const summary = await page.evaluate(() => document.getElementById('summary').textContent);
check('预览表格行数 = 12（含子文件夹）', rowCount === 12, `实际 ${rowCount}`);
check('分类筛选按钮已生成', (await page.evaluate(() => document.querySelectorAll('#category-filters .chip').length)) === 7);
console.log('   摘要:', summary);
await shot('02-预览.png');

console.log('5) 筛选测试 ...');
// 按分类筛选：关掉「音频」，再重新打开
const chipOff = () => page.evaluate(() => {
  const chip = [...document.querySelectorAll('#category-filters .chip')].find((c) => c.textContent === '音频');
  chip.click();
});
await chipOff();
const visibleAfterFilter = await page.evaluate(() => document.querySelectorAll('#preview-body tr:not([hidden])').length);
check('关闭「音频」分类后可见 11 行', visibleAfterFilter === 11, `实际 ${visibleAfterFilter}`);
await chipOff();
const visibleRestored = await page.evaluate(() => document.querySelectorAll('#preview-body tr:not([hidden])').length);
check('重新打开「音频」后恢复 12 行', visibleRestored === 12, `实际 ${visibleRestored}`);
await shot('03-筛选.png');

// 单文件排除：取消勾选「未知文件.xyz」
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#preview-body tr')].find(
    (tr) => tr.querySelector('td.name').textContent.includes('未知文件.xyz')
  );
  const cb = row.querySelector('input[type="checkbox"]');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
const selInfo = await page.evaluate(() => document.getElementById('selection-info').textContent);
check('排除单个文件后显示 已选 11 / 共 12', selInfo.includes('已选 11 / 共 12'), selInfo);

console.log('6) 确认整理 ...');
await page.evaluate(() => document.getElementById('btn-execute').click());
await page.waitForSelector('#result-title', { state: 'visible', timeout: 15000 });
const resultTitle = await page.evaluate(() => document.getElementById('result-title').textContent);
const resultList = await page.evaluate(() => document.getElementById('result-list').innerText);
console.log('   ', resultTitle);
console.log(resultList.split('\n').map((l) => '    ' + l).join('\n'));
check('复制数量 = 11（排除了 1 个）', resultTitle.includes('11 个文件'), resultTitle);
await shot('04-结果.png');

console.log('7) 核对文件系统 ...');
const expected = [
  ['图片/风景.jpg'], ['视频/假期.mp4'], ['音频/音乐.mp3'], ['文档/报告.docx'],
  ['文档/数据.csv'], ['文档/笔记.txt'], ['压缩包/备份.zip'], ['程序/安装程序.exe'],
  ['图片/旅游/海边.jpg'], ['文档/旅游/攻略.txt'],
];
for (const [rel] of expected) check(`已复制 ${rel}`, fs.existsSync(path.join(TARGET, rel)));
check('被排除的文件未被复制', !fs.existsSync(path.join(TARGET, '其他', '未知文件.xyz')));
check('同名文件自动加序号', fs.existsSync(path.join(TARGET, '文档', '同名 (2).docx')));
check('原同名文件未被覆盖', fs.readFileSync(path.join(TARGET, '文档', '同名.docx'), 'utf8') === 'old');
check('源文件全部保留（12 个）', countFiles(SOURCE) === 12);
check('源子文件夹结构未动', fs.existsSync(path.join(SOURCE, '旅游', '海边.jpg')));

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

if (!SKIP_PACK) {
console.log('8) 打包项目页（真实打包本项目）...');
await page.evaluate(() => document.getElementById('tab-pack').click());
await page.evaluate(() => document.getElementById('btn-pack-select').click());
await page.waitForFunction(() => document.getElementById('pack-project-dir').value !== '');
const packDir = await page.evaluate(() => document.getElementById('pack-project-dir').value);
check('项目文件夹已填入', packDir === APP_DIR, packDir);
await page.evaluate(() => document.getElementById('btn-pack-check').click());
await page.waitForSelector('#pack-check-panel', { state: 'visible', timeout: 15000 });
const chkSummary = await page.evaluate(() => document.getElementById('pack-check-summary').textContent);
check('项目检查通过', chkSummary.includes('检查通过'), chkSummary.slice(0, 80));
const matchedCount = await page.evaluate(() => Number(document.getElementById('pack-matched-count').textContent));
check('筛选出打包文件', matchedCount > 3, `${matchedCount} 个`);
await shot('05-打包检查.png');

console.log('9) 开始打包（通过应用界面）...');
await page.evaluate(() => {
  document.getElementById('pack-auto-install').checked = false; // 依赖已就绪
  document.getElementById('btn-pack-build').click();
});
await page.waitForSelector('#pack-result', { state: 'visible', timeout: 600000 });
const resultMsg = await page.evaluate(() => document.getElementById('pack-result-title').textContent);
const artifactNames = await page.evaluate(() =>
  [...document.querySelectorAll('#pack-artifacts li')].map((li) => li.textContent));
console.log('   ', resultMsg);
artifactNames.forEach((n) => console.log('    ', n));
check('生成 exe 产物', artifactNames.length >= 2, `${artifactNames.length} 个`);
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
check(`产物版本为 ${PKG_VERSION}`, artifactNames.some((n) => n.includes(PKG_VERSION)), artifactNames.join(', '));
await shot('06-打包完成.png');
}

console.log('10) 文档转换页（Word → PDF → Word 往返）...');
await page.evaluate(() => document.getElementById('tab-conv').click());
await page.evaluate(() => document.getElementById('btn-conv-select').click());
await page.waitForFunction(() => document.getElementById('conv-file').value !== '');
const convFile = await page.evaluate(() => document.getElementById('conv-file').value);
check('文档已选择', convFile === DOCX_FIXTURE, convFile);
await page.waitForFunction(
  () => document.getElementById('conv-status').textContent.includes('预览就绪'),
  null,
  { timeout: 30000 }
);
const docxPreview = await page.evaluate(() => document.getElementById('conv-preview').innerText);
check('Word 预览包含内容', docxPreview.includes('项目周报'), docxPreview.slice(0, 30));
await shot('07-Word预览.png');

// Word → PDF
await page.evaluate(() => document.getElementById('btn-conv-go').click());
await page.waitForFunction(
  () => document.getElementById('conv-status').textContent.includes('转换完成'),
  null,
  { timeout: 60000 }
);
check('生成 PDF 文件', fs.existsSync(PDF_FIXTURE));

// 预览生成的 PDF
await page.evaluate(() => document.getElementById('btn-conv-preview').click());
await page.waitForFunction(
  () => document.querySelectorAll('#conv-preview canvas').length > 0,
  null,
  { timeout: 60000 }
);
const pdfPages = await page.evaluate(() => document.querySelectorAll('#conv-preview canvas').length);
check('PDF 预览渲染页面', pdfPages >= 1, `${pdfPages} 页`);
await shot('08-PDF预览.png');

// PDF → Word（同名自动加序号）
await page.evaluate(() => document.getElementById('btn-conv-go').click());
await page.waitForFunction(
  () => document.getElementById('conv-status').textContent.includes('转换完成'),
  null,
  { timeout: 60000 }
);
check('PDF→Word 生成（自动加序号）', fs.existsSync(ROUNDTRIP_DOCX));

console.log('11) 压缩解压页 ...');
await page.evaluate(() => document.getElementById('tab-zip').click());
// 压缩 test-data/source
await page.evaluate(() => document.getElementById('btn-zip-pick').click());
await page.waitForFunction(() => document.querySelectorAll('#zip-picked-list li').length > 0);
check('已选择压缩内容', (await page.evaluate(() => document.querySelectorAll('#zip-picked-list li').length)) === 1);
await page.evaluate(() => document.getElementById('btn-zip-go').click());
await page.waitForFunction(
  () => document.getElementById('zip-status').textContent.includes('压缩完成'),
  null,
  { timeout: 60000 }
);
check('生成 zip 文件', fs.existsSync(ZIP_FIXTURE));
await shot('09-压缩完成.png');

// 解压
await page.evaluate(() => document.getElementById('zip-mode-extract').click());
await page.evaluate(() => document.getElementById('btn-zip-pick-file').click());
await page.waitForFunction(() => document.getElementById('zip-file').value !== '');
await page.waitForFunction(
  () => document.getElementById('zip-list-summary').textContent.includes('共'),
  null,
  { timeout: 30000 }
);
const zipSummary = await page.evaluate(() => document.getElementById('zip-list-summary').textContent);
check('压缩包内容预览', zipSummary.includes('条目'), zipSummary.slice(0, 60));
await page.evaluate(() => document.getElementById('btn-zip-extract').click());
await page.waitForFunction(
  () => document.getElementById('zip-status').textContent.includes('解压完成'),
  null,
  { timeout: 60000 }
);
const zipResult = await page.evaluate(() => document.getElementById('zip-result-text').textContent);
check('解压完成并返回目录', zipResult.includes('解压完成'), zipResult.slice(0, 60));
check('解压目录存在（同名自动加序号）', fs.existsSync(ZIP_EXTRACT_DIR));
check('解压内容完整（含子文件夹）', fs.existsSync(path.join(ZIP_EXTRACT_DIR, 'source', '旅游', '海边.jpg')));
await shot('10-解压完成.png');

console.log('12) 关闭应用');
await app.close();

console.log(failures.length === 0 ? '\n全部通过' : `\n失败 ${failures.length} 项: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
