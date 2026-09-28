// 界面逻辑：选择文件夹 → 预览与筛选 → 确认整理 → 查看结果
const $ = (id) => document.getElementById(id);

const state = {
  sourceDir: null,
  targetDir: null,
  preview: null,
  hiddenCategories: new Set(), // 被筛选掉的分类
  excluded: new Set(), // 被单独排除的文件（键为 相对路径）
};

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status show ' + (kind || 'info');
}

function show(stepId) {
  ['step-select', 'step-preview', 'step-result'].forEach((id) => {
    $(id).hidden = id !== stepId;
  });
}

function updatePreviewButton() {
  $('btn-preview').disabled = !(state.sourceDir && state.targetDir);
}

// 选择源文件夹
$('btn-source').addEventListener('click', async () => {
  const dir = await window.api.selectFolder('选择要整理的文件夹');
  if (dir) {
    state.sourceDir = dir;
    $('source-dir').value = dir;
    setStatus('');
    updatePreviewButton();
  }
});

// 选择目标文件夹
$('btn-target').addEventListener('click', async () => {
  const dir = await window.api.selectFolder('选择整理结果的保存位置');
  if (dir) {
    state.targetDir = dir;
    $('target-dir').value = dir;
    setStatus('');
    updatePreviewButton();
  }
});

// ---------- 预览与筛选 ----------

const fileKey = (f) => (f.rel ? `${f.rel}/${f.name}` : f.name);

// 统计当前会被整理的文件数
function selectedCount() {
  if (!state.preview) return 0;
  return state.preview.files.filter(
    (f) => !state.hiddenCategories.has(f.category) && !state.excluded.has(fileKey(f))
  ).length;
}

function updateSelectionInfo() {
  const n = selectedCount();
  const total = state.preview ? state.preview.total : 0;
  $('selection-info').textContent = `已选 ${n} / 共 ${total} 个文件`;
  $('btn-execute').disabled = n === 0;
}

// 分类筛选按钮
function renderFilters() {
  const wrap = $('category-filters');
  wrap.textContent = '';
  Object.keys(state.preview.byCategory).forEach((cat) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = cat;
    chip.addEventListener('click', () => {
      if (state.hiddenCategories.has(cat)) state.hiddenCategories.delete(cat);
      else state.hiddenCategories.add(cat);
      chip.classList.toggle('off', state.hiddenCategories.has(cat));
      applyFilters();
      updateSelectionInfo();
    });
    wrap.append(chip);
  });
}

// 按分类筛选显示/隐藏行
function applyFilters() {
  document.querySelectorAll('#preview-body tr[data-cat]').forEach((tr) => {
    tr.hidden = state.hiddenCategories.has(tr.dataset.cat);
  });
}

// 预览表格
function renderPreviewRows() {
  const tbody = $('preview-body');
  tbody.textContent = '';
  state.preview.files.forEach((f) => {
    const tr = document.createElement('tr');
    tr.dataset.cat = f.category;

    const tdCheck = document.createElement('td');
    tdCheck.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.title = '取消勾选则不整理这个文件';
    cb.addEventListener('change', () => {
      cb.checked ? state.excluded.delete(fileKey(f)) : state.excluded.add(fileKey(f));
      tr.classList.toggle('excluded', !cb.checked);
      updateSelectionInfo();
    });
    tdCheck.append(cb);

    const tdName = document.createElement('td');
    tdName.className = 'name';
    tdName.textContent = f.rel ? `${f.rel}/${f.name}` : f.name;

    const tdCat = document.createElement('td');
    tdCat.className = 'tag';
    tdCat.textContent = f.category;

    const tdDest = document.createElement('td');
    tdDest.className = 'name';
    tdDest.textContent = f.targetRelative;

    const tdNote = document.createElement('td');
    if (f.conflict) {
      tdNote.className = 'warn';
      tdNote.textContent = '已有同名，自动加序号';
    }

    tr.append(tdCheck, tdName, tdCat, tdDest, tdNote);
    tbody.append(tr);
  });
}

// 预览
$('btn-preview').addEventListener('click', async () => {
  if (state.sourceDir === state.targetDir) {
    setStatus('结果文件夹不能和要整理的文件夹相同，请换一个位置。', 'error');
    return;
  }
  try {
    const result = await window.api.preview(state.sourceDir, state.targetDir);
    state.preview = result;
    state.hiddenCategories.clear();
    state.excluded.clear();
    if (result.total === 0) {
      setStatus('这个文件夹里没有文件，请换一个文件夹。', 'error');
      return;
    }
    const byCat = Object.entries(result.byCategory)
      .map(([cat, n]) => `${cat} ${n} 个`)
      .join(' · ');
    $('summary').textContent = `共 ${result.total} 个文件，将复制到：${byCat || '无'}（原文件保留，同名自动加序号）`;
    renderFilters();
    renderPreviewRows();
    updateSelectionInfo();
    show('step-preview');
    $('btn-cancel').hidden = true;
    setStatus('预览只显示结果，还没有复制任何文件。可取消勾选排除文件。');
  } catch (err) {
    setStatus('预览失败：' + err.message, 'error');
  }
});

// 全选 / 全不选
$('btn-select-all').addEventListener('click', () => {
  state.excluded.clear();
  document.querySelectorAll('#preview-body input[type="checkbox"]').forEach((cb) => {
    cb.checked = true;
    cb.closest('tr').classList.remove('excluded');
  });
  updateSelectionInfo();
});
$('btn-select-none').addEventListener('click', () => {
  state.preview.files.forEach((f) => state.excluded.add(fileKey(f)));
  document.querySelectorAll('#preview-body input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
    cb.closest('tr').classList.add('excluded');
  });
  updateSelectionInfo();
});

// ---------- 执行整理 ----------

// 执行整理
$('btn-execute').addEventListener('click', async () => {
  const busy = (on) => {
    $('btn-execute').disabled = on;
    $('btn-reset').disabled = on;
    $('btn-cancel').hidden = !on;
  };
  const chosen = state.preview.files.filter(
    (f) => !state.hiddenCategories.has(f.category) && !state.excluded.has(fileKey(f))
  );
  if (chosen.length === 0) {
    setStatus('没有选中任何文件，请先勾选要整理的文件。', 'error');
    return;
  }
  busy(true);
  try {
    const result = await window.api.execute(state.sourceDir, state.targetDir, chosen);
    $('btn-cancel').hidden = true;
    const title = $('result-title');
    const list = $('result-list');
    list.textContent = '';

    if (result.cancelled) {
      title.textContent = '已取消整理';
      setStatus(`已取消：已复制 ${result.copied.length} 个文件，原文件未受影响。`, 'error');
    } else {
      title.textContent = `整理完成：复制了 ${result.copied.length} 个文件，失败 ${result.errors.length} 个`;
      setStatus('原文件全部保留。请在结果文件夹里核对。', 'success');
    }

    result.copied.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'ok';
      li.textContent = `${c.name} → ${c.destination}${c.renamed ? '（自动加序号）' : ''}`;
      list.append(li);
    });
    result.errors.forEach((e) => {
      const li = document.createElement('li');
      li.className = 'err';
      li.textContent = `${e.name}：${e.message}`;
      list.append(li);
    });
    show('step-result');
  } catch (err) {
    setStatus('整理失败：' + err.message, 'error');
  } finally {
    busy(false);
  }
});

// 取消
$('btn-cancel').addEventListener('click', () => {
  window.api.cancel();
  setStatus('正在取消，已完成当前文件后停止……', 'info');
});

// 打开结果文件夹
$('btn-open-target').addEventListener('click', async () => {
  const r = await window.api.openFolder(state.targetDir);
  if (!r.ok) setStatus('打开失败：' + r.message, 'error');
});

// 重新开始
function restart() {
  state.sourceDir = null;
  state.targetDir = null;
  state.preview = null;
  state.hiddenCategories.clear();
  state.excluded.clear();
  $('source-dir').value = '';
  $('target-dir').value = '';
  setStatus('');
  updatePreviewButton();
  show('step-select');
}
$('btn-reset').addEventListener('click', restart);
$('btn-restart').addEventListener('click', restart);

// ---------- 页面二：打包项目 ----------

const pack = { projectDir: null, check: null, lastArtifactsDir: null };

function setPackStatus(text, kind) {
  const el = $('pack-status');
  el.textContent = text;
  el.className = 'status show ' + (kind || 'info');
}

// 页签切换
function switchTab(page) {
  $('tab-files').classList.toggle('active', page === 'files');
  $('tab-pack').classList.toggle('active', page === 'pack');
  $('tab-conv').classList.toggle('active', page === 'conv');
  $('page-files').hidden = page !== 'files';
  $('page-pack').hidden = page !== 'pack';
  $('page-conv').hidden = page !== 'conv';
}
$('tab-files').addEventListener('click', () => switchTab('files'));
$('tab-pack').addEventListener('click', () => switchTab('pack'));
$('tab-conv').addEventListener('click', () => switchTab('conv'));

// 选择项目文件夹
$('btn-pack-select').addEventListener('click', async () => {
  const dir = await window.api.selectFolder('选择要打包的项目文件夹');
  if (dir) {
    pack.projectDir = dir;
    $('pack-project-dir').value = dir;
    $('btn-pack-check').disabled = false;
    $('pack-check-panel').hidden = true;
    $('pack-build-panel').hidden = true;
    setPackStatus('');
  }
});

// 检查项目（自动筛选打包所需文件）
$('btn-pack-check').addEventListener('click', async () => {
  try {
    const r = await window.api.checkProject(pack.projectDir);
    pack.check = r;
    const { ok, issues, info } = r;
    $('pack-check-summary').textContent = ok
      ? `✔ 检查通过：${info.appName} v${info.appVersion} ｜ Node ${info.nodeVersion} ｜ 构建命令 ${info.buildCmd} ｜ 依赖${info.needsInstall ? '未安装（可自动安装）' : '已就绪'}`
      : `✘ 存在问题：${issues.join('；')}`;
    const matched = $('pack-matched-list');
    matched.textContent = '';
    info.matched.slice(0, 20).forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f;
      matched.append(li);
    });
    $('pack-matched-count').textContent = info.matched.length;
    const excluded = $('pack-excluded-list');
    excluded.textContent = '';
    info.excluded.forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f;
      excluded.append(li);
    });
    $('pack-check-panel').hidden = false;
    $('btn-pack-build').disabled = !ok;
    $('pack-build-panel').hidden = true;
    setPackStatus(ok ? '检查完成，可以开始打包。' : '请先解决上面的问题再打包。', ok ? 'info' : 'error');
  } catch (err) {
    setPackStatus('检查失败：' + err.message, 'error');
  }
});

// 打包日志流
window.api.onBuildLog((line) => {
  const log = $('pack-log');
  log.textContent += line + '\n';
  log.scrollTop = log.scrollHeight;
});
window.api.onBuildDone((data) => {
  $('btn-pack-build').disabled = false;
  $('btn-pack-cancel').hidden = true;
  const resultBox = $('pack-result');
  resultBox.hidden = false;
  $('pack-result-title').textContent = data.message;
  const list = $('pack-artifacts');
  list.textContent = '';
  data.artifacts.forEach((a) => {
    const li = document.createElement('li');
    li.textContent = `${a.name}（${(a.size / 1024 / 1024).toFixed(1)} MB）`;
    list.append(li);
  });
  if (data.artifacts.length) {
    pack.lastArtifactsDir = data.artifacts[0].path.replace(/[\\/][^\\/]+$/, '');
  }
  setPackStatus(data.code === 0 ? '打包完成。' : '打包失败，请查看日志。', data.code === 0 ? 'success' : 'error');
});

// 开始打包
$('btn-pack-build').addEventListener('click', async () => {
  const log = $('pack-log');
  log.textContent = '';
  $('pack-result').hidden = true;
  $('pack-build-panel').hidden = false;
  $('btn-pack-build').disabled = true;
  $('btn-pack-cancel').hidden = false;
  setPackStatus('打包进行中，请勿关闭窗口……', 'info');
  const r = await window.api.startBuild({
    projectDir: pack.projectDir,
    buildCmd: pack.check.info.buildCmd,
    needsInstall: pack.check.info.needsInstall,
    autoInstall: $('pack-auto-install').checked,
  });
  if (r && r.started === false) setPackStatus(r.message, 'error');
});

// 取消打包
$('btn-pack-cancel').addEventListener('click', () => {
  window.api.cancelBuild();
  setPackStatus('正在取消……', 'info');
});

// 打开产物文件夹 / 再次打包
$('btn-pack-open').addEventListener('click', async () => {
  if (pack.lastArtifactsDir) {
    const r = await window.api.openFolder(pack.lastArtifactsDir);
    if (!r.ok) setPackStatus('打开失败：' + r.message, 'error');
  }
});
$('btn-pack-again').addEventListener('click', () => {
  $('pack-build-panel').hidden = true;
  $('btn-pack-build').disabled = false;
});

// ---------- 页面三：文档转换（PDF ⇄ Word） ----------

const conv = { file: null, info: null, lastOut: null };

function setConvStatus(text, kind) {
  const el = $('conv-status');
  el.textContent = text;
  el.className = 'status show ' + (kind || 'info');
}

// 选择文档
$('btn-conv-select').addEventListener('click', async () => {
  const f = await window.api.selectFile('选择文档');
  if (f) await loadConvFile(f);
});

async function loadConvFile(filePath) {
  const info = await window.api.fileInfo(filePath);
  if (info.kind === 'unknown') {
    setConvStatus('仅支持 PDF 或 Word（.docx）文件。', 'error');
    return;
  }
  conv.file = filePath;
  conv.info = info;
  conv.lastOut = null;
  $('conv-file').value = filePath;
  $('conv-result-panel').hidden = true;
  $('btn-conv-go').textContent = info.kind === 'pdf' ? '② 转换为 Word (.docx)' : '② 转换为 PDF';
  $('btn-conv-go').disabled = false;
  $('conv-hint').textContent = info.kind === 'pdf'
    ? 'PDF → Word 为文字版转换：提取全部文字重建为 Word 文档，图片与复杂排版不保留'
    : 'Word → PDF：保留文字、标题、表格与图片的基本排版';
  setConvStatus('');
  await previewConv(filePath, info.kind);
}

// 预览：PDF 用 pdf.js 渲染页面，Word 用 mammoth 转 HTML 显示
async function previewConv(filePath, kind) {
  const panel = $('conv-preview-panel');
  const box = $('conv-preview');
  box.textContent = '';
  $('conv-preview-title').textContent = conv.info.name;
  panel.hidden = false;
  if (kind === 'pdf') {
    box.className = 'conv-preview';
    setConvStatus('正在渲染 PDF 预览……', 'info');
    try {
      // pdf.js 6.x 的构建包含 import.meta，必须以 ES 模块方式创建 worker：
      // 用 Blob URL + type:'module' 自己创建 Worker，再通过 workerPort 交给 pdf.js
      const workerText = await window.api.pdfWorkerText();
      const workerUrl = URL.createObjectURL(new Blob([workerText], { type: 'text/javascript' }));
      window.pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' });
      const b64 = await window.api.fileData(filePath);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        box.append(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
      setConvStatus(`预览就绪：共 ${doc.numPages} 页`, 'success');
    } catch (err) {
      setConvStatus('预览失败：' + err.message, 'error');
    }
  } else {
    box.className = 'conv-preview doc';
    setConvStatus('正在解析 Word 文档……', 'info');
    try {
      const html = await window.api.docxToHtml(filePath);
      box.innerHTML = html;
      setConvStatus('预览就绪', 'success');
    } catch (err) {
      setConvStatus('预览失败：' + err.message, 'error');
    }
  }
}

// 执行转换
$('btn-conv-go').addEventListener('click', async () => {
  $('btn-conv-go').disabled = true;
  setConvStatus(conv.info.kind === 'pdf' ? '正在转换 PDF → Word……' : '正在转换 Word → PDF……', 'info');
  try {
    const r = conv.info.kind === 'pdf'
      ? await window.api.pdfToDocx(conv.file)
      : await window.api.docxToPdf(conv.file);
    conv.lastOut = r.outPath;
    const extra = r.pages ? `（提取 ${r.pages} 页、${r.lines} 行文字）` : '';
    $('conv-result-text').textContent = `✔ 转换完成：${r.outPath}${extra}`;
    $('conv-result-panel').hidden = false;
    setConvStatus('转换完成', 'success');
  } catch (err) {
    setConvStatus('转换失败：' + err.message, 'error');
  } finally {
    $('btn-conv-go').disabled = false;
  }
});

// 预览转换结果 / 打开所在文件夹 / 转换其他文件
$('btn-conv-preview').addEventListener('click', async () => {
  if (conv.lastOut) await loadConvFile(conv.lastOut);
});
$('btn-conv-open').addEventListener('click', async () => {
  if (conv.lastOut) {
    const r = await window.api.openFolder(conv.lastOut.replace(/[\\/][^\\/]+$/, ''));
    if (!r.ok) setConvStatus('打开失败：' + r.message, 'error');
  }
});
$('btn-conv-another').addEventListener('click', async () => {
  const f = await window.api.selectFile('选择文档');
  if (f) await loadConvFile(f);
});
