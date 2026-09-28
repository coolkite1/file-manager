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
const env = { ...process.env, FO_TEST_DIRS: `${SOURCE};${TARGET}` };
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
  if (f !== '同名.docx') fs.rmSync(path.join(docDir, f), { force: true });
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
check('预览表格行数 = 10', rowCount === 10, `实际 ${rowCount}`);
console.log('   摘要:', summary);
await page.screenshot({ path: path.join(SHOT_DIR, '02-预览.png') });

console.log('5) 确认整理 ...');
await page.evaluate(() => document.getElementById('btn-execute').click());
await page.waitForSelector('#result-title', { state: 'visible', timeout: 15000 });
const resultTitle = await page.evaluate(() => document.getElementById('result-title').textContent);
const resultList = await page.evaluate(() => document.getElementById('result-list').innerText);
console.log('   ', resultTitle);
console.log(resultList.split('\n').map((l) => '    ' + l).join('\n'));
await page.screenshot({ path: path.join(SHOT_DIR, '03-结果.png') });

console.log('6) 核对文件系统 ...');
const expected = [
  ['图片/风景.jpg'], ['视频/假期.mp4'], ['音频/音乐.mp3'], ['文档/报告.docx'],
  ['文档/数据.csv'], ['文档/笔记.txt'], ['压缩包/备份.zip'], ['程序/安装程序.exe'],
  ['其他/未知文件.xyz'],
];
for (const [rel] of expected) check(`已复制 ${rel}`, fs.existsSync(path.join(TARGET, rel)));
check('同名文件自动加序号', fs.existsSync(path.join(TARGET, '文档', '同名 (2).docx')));
check('原同名文件未被覆盖', fs.readFileSync(path.join(TARGET, '文档', '同名.docx'), 'utf8') === 'old');
check('源文件全部保留（10 个）', fs.readdirSync(SOURCE).length === 10);

console.log('7) 关闭应用');
await app.close();

console.log(failures.length === 0 ? '\n全部通过' : `\n失败 ${failures.length} 项: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
