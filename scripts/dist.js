// 打包脚本：npm run dist 一条命令生成 Windows 安装包与便携版 exe
// 先设置国内镜像，再调用 electron-builder（配置在 electron-builder.yml）
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const { build } = require('electron-builder');

build({ win: ['nsis', 'portable'] }).catch((err) => {
  console.error(err);
  process.exit(1);
});
