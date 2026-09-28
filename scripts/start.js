// 开发启动脚本：npm start 用这个启动应用
// 本机环境里有 ELECTRON_RUN_AS_NODE=1（某些软件设置），会让 Electron 以纯 Node
// 模式运行导致窗口打不开；这里先清除该变量再启动，保证 npm start 始终正常。
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('child_process');
const electronPath = require('electron'); // 纯 Node 下返回 electron.exe 的路径
const child = spawn(electronPath, ['.'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
