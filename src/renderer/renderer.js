// 界面逻辑：选择文件夹 → 预览 → 确认整理 → 查看结果
const $ = (id) => document.getElementById(id);

const state = { sourceDir: null, targetDir: null, preview: null };

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

// 预览
$('btn-preview').addEventListener('click', async () => {
  if (state.sourceDir === state.targetDir) {
    setStatus('结果文件夹不能和要整理的文件夹相同，请换一个位置。', 'error');
    return;
  }
  try {
    const result = await window.api.preview(state.sourceDir, state.targetDir);
    state.preview = result;
    if (result.total === 0) {
      setStatus('这个文件夹里没有文件，请换一个文件夹。', 'error');
      return;
    }
    const byCat = Object.entries(result.byCategory)
      .map(([cat, n]) => `${cat} ${n} 个`)
      .join(' · ');
    $('summary').textContent = `共 ${result.total} 个文件，将复制到：${byCat || '无'}（原文件保留，同名自动加序号）`;
    const tbody = $('preview-body');
    tbody.textContent = '';
    result.files.forEach((f) => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.className = 'name';
      tdName.textContent = f.name;
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
      tr.append(tdName, tdCat, tdDest, tdNote);
      tbody.append(tr);
    });
    show('step-preview');
    $('btn-cancel').hidden = true;
    setStatus('预览只显示结果，还没有复制任何文件。');
  } catch (err) {
    setStatus('预览失败：' + err.message, 'error');
  }
});

// 执行整理
$('btn-execute').addEventListener('click', async () => {
  const busy = (on) => {
    $('btn-execute').disabled = on;
    $('btn-reset').disabled = on;
    $('btn-cancel').hidden = !on;
  };
  busy(true);
  try {
    const result = await window.api.execute(state.sourceDir, state.targetDir);
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
  $('source-dir').value = '';
  $('target-dir').value = '';
  setStatus('');
  updatePreviewButton();
  show('step-select');
}
$('btn-reset').addEventListener('click', restart);
$('btn-restart').addEventListener('click', restart);
