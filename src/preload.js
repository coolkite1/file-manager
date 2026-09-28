// 预加载脚本：向界面暴露安全、有限的能力（界面代码不能直接接触系统）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: (title) => ipcRenderer.invoke('dialog:selectFolder', title),
  preview: (sourceDir, targetDir) => ipcRenderer.invoke('organize:preview', sourceDir, targetDir),
  execute: (sourceDir, targetDir, files) => ipcRenderer.invoke('organize:execute', { sourceDir, targetDir, files }),
  cancel: () => ipcRenderer.send('organize:cancel'),
  openFolder: (dir) => ipcRenderer.invoke('organize:openTarget', dir),
  // 打包项目页
  checkProject: (dir) => ipcRenderer.invoke('build:check', dir),
  startBuild: (opts) => ipcRenderer.invoke('build:start', opts),
  cancelBuild: () => ipcRenderer.send('build:cancel'),
  onBuildLog: (cb) => ipcRenderer.on('build:log', (e, line) => cb(line)),
  onBuildDone: (cb) => ipcRenderer.on('build:done', (e, data) => cb(data)),
});
