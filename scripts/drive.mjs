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
const env = { ...process.env, FO_TEST_DIRS: `${SOURCE};${TARGET};${APP_DIR}` };
delete env.ELECTRON_RUN_AS_NODE;

const failures = [];
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
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [APP_DIR],
  env,
  timeout: 30000,
});
const page = await app.firstWindow();
await page.waitForSelector('#btn-source', { timeout: 15000 });
await page.screenshot({ path: path.join(SHOT_DIR, '01-启动.png') });
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
await page.screenshot({ path: path.join(SHOT_DIR, '02-预览.png') });

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
await page.screenshot({ path: path.join(SHOT_DIR, '03-筛选.png') });

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
await page.screenshot({ path: path.join(SHOT_DIR, '04-结果.png') });

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
await page.screenshot({ path: path.join(SHOT_DIR, '05-打包检查.png') });

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
check('产物版本为 0.4.0', artifactNames.some((n) => n.includes('0.4.0')), artifactNames.join(', '));
await page.screenshot({ path: path.join(SHOT_DIR, '06-打包完成.png') });

console.log('10) 关闭应用');
await app.close();

console.log(failures.length === 0 ? '\n全部通过' : `\n失败 ${failures.length} 项: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
