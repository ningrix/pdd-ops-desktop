'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  malls: [],
  activeId: null,
  visible: true,
  tab: 'goods',
  goods: [],
  pool: [],
  poolSel: new Set(),
  last: null,
  sizeTpl: null,
};

// ------------------------------------------------------------------ 日志
function addLog(line) {
  const box = $('#log');
  const el = document.createElement('div');
  el.className = 'ln ' + (line.level || 'info');
  el.innerHTML = '<span class="t"></span><span class="m"></span>';
  el.querySelector('.t').textContent = line.t || new Date().toTimeString().slice(0, 8);
  el.querySelector('.m').textContent = line.msg || '';
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 500) box.removeChild(box.firstChild);
}
const logOk = (m) => addLog({ level: 'ok', msg: m });
const logErr = (m) => addLog({ level: 'err', msg: m });
const logInfo = (m) => addLog({ level: 'info', msg: m });
const logWarn = (m) => addLog({ level: 'warn', msg: m });

window.pdd.onLog((l) => addLog(l));
$('#btnClearLog').addEventListener('click', () => { $('#log').innerHTML = ''; });

const money = (fen) => (fen === undefined || fen === null ? '-' : (Number(fen) / 100).toFixed(2));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ 原生视图遮挡
// 原生 WebContentsView 一旦被点过就会持有原生键盘焦点。摘掉它之后主窗口
// 不会自动拿回焦点，表现是弹窗里 input 是 activeElement 但打不进字。
// 所以每次摘视图后都要显式 focusWindow()。
async function withViewHidden(fn) {
  let suspended = false;
  if (state.visible && state.malls.length) {
    try { await window.pdd.toggleView(false); suspended = true; } catch (_) { /* ignore */ }
  }
  try { await window.pdd.focusWindow(); } catch (_) { /* ignore */ }
  try {
    return await fn();
  } finally {
    if (suspended) {
      try { await window.pdd.toggleView(true); } catch (_) { /* ignore */ }
      scheduleSync();
    }
  }
}

/** 把焦点稳稳地打到某个输入框上：等两帧 + 重试，避免撑开后才布局完 */
function focusInput(el, selectAll) {
  if (!el) return;
  let tries = 0;
  const tick = () => {
    tries++;
    try {
      window.pdd.focusWindow();
      el.focus({ preventScroll: false });
      if (selectAll) el.select();
    } catch (_) { /* ignore */ }
    if (document.activeElement !== el && tries < 8) {
      requestAnimationFrame(() => setTimeout(tick, 40));
    }
  };
  requestAnimationFrame(() => setTimeout(tick, 30));
}

let rafPending = false;
function syncBounds() {
  if (!state.visible || state.tab !== 'browser' || !state.malls.length) {
    window.pdd.toggleView(false);
    return;
  }
  const pane = $('#pane-browser');
  const r = pane.getBoundingClientRect();
  window.pdd.toggleView(true);
  window.pdd.setBounds({
    x: Math.round(r.left), y: Math.round(r.top),
    width: Math.round(r.width), height: Math.round(r.height),
  });
}
function scheduleSync() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; syncBounds(); });
}
window.addEventListener('resize', scheduleSync);

function setTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
  const pb = $('#pane-browser');
  if (pb) pb.classList.toggle('browser-on', name === 'browser' && !!state.malls.length);
  scheduleSync();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

function setResult(obj) {
  $('#resultBox').textContent = JSON.stringify(obj, null, 2);
}

// ------------------------------------------------------------------ 输入弹窗
function askText({ title = '输入', placeholder = '', value = '' } = {}) {
  return withViewHidden(() => new Promise((resolve) => {
    const mask = $('#modalMask');
    const input = $('#modalInput');
    const err = $('#modalErr');
    $('#modalTitle').textContent = title;
    input.placeholder = placeholder;
    input.value = value;
    err.textContent = '';
    mask.classList.add('on');
    focusInput(input, true);

    const done = (v) => {
      mask.classList.remove('on');
      $('#modalOk').onclick = null;
      $('#modalCancel').onclick = null;
      input.onkeydown = null;
      resolve(v);
    };
    $('#modalOk').onclick = () => {
      const v = input.value.trim();
      if (!v) { err.textContent = '不能为空'; return; }
      done(v);
    };
    $('#modalCancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('#modalOk').click(); }
      if (e.key === 'Escape') done(null);
    };
  }));
}

// ------------------------------------------------------------------ 店铺
async function refreshMalls(selectId) {
  const res = await window.pdd.listMalls();
  state.malls = res.malls || [];
  state.activeId = selectId || res.activeId || (state.malls[0] && state.malls[0].id) || null;

  const ul = $('#mallList');
  ul.innerHTML = '';
  if (!state.malls.length) {
    ul.innerHTML = '<li class="empty">还没有店铺，点右上「＋ 添加店铺」</li>';
  } else {
    for (const m of state.malls) {
      const li = document.createElement('li');
      li.className = m.id === state.activeId ? 'active' : '';
      li.dataset.id = m.id;
      li.innerHTML = '<span class="st unknown" title="未检测"></span>' +
                     '<span class="nm"></span>' +
                     '<span class="del" title="移除">✕</span>';
      li.querySelector('.nm').textContent = m.name;
      li.addEventListener('click', async (e) => {
        if (e.target.classList.contains('del')) {
          if (!window.confirm(
            '移除店铺「' + m.name + '」？\n\n' +
            '⚠️ 这会同时删除它的登录状态，下次要重新扫码。\n' +
            '只想重新登录的话不用删，直接点该店铺再扫码即可。')) return;
          await window.pdd.removeMall(m.id);
          await refreshMalls();
          return;
        }
        await window.pdd.activateMall(m.id);
        state.activeId = m.id;
        await refreshMalls(m.id);
        refreshStatus();
      });
      ul.appendChild(li);
    }
  }
  const pb = $('#pane-browser');
  if (pb) pb.classList.toggle('browser-on', state.tab === 'browser' && !!state.malls.length);
  scheduleSync();
  refreshStatus();
}

let statusBusy = false;
async function refreshStatus() {
  if (statusBusy || !state.malls.length) return;
  statusBusy = true;
  try {
    for (const m of state.malls) {
      const r = await window.pdd.pingMall(m.id);
      const dot = document.querySelector('#mallList li[data-id="' + m.id + '"] .st');
      if (!dot) continue;
      const online = !!(r && r.online);
      dot.className = 'st ' + (online ? 'on' : 'off');
      dot.title = online ? '在线（已登录）' : ('离线：' + ((r && r.reason) || '未登录'));
    }
  } finally {
    statusBusy = false;
  }
}
setInterval(refreshStatus, 25000);

async function addMall() {
  const name = await askText({
    title: '给这个店铺起个名字',
    placeholder: '例如：A店-羽绒服',
    value: '店铺' + (state.malls.length + 1),
  });
  if (!name) return;
  logInfo('正在创建店铺「' + name + '」...');
  try {
    const info = await window.pdd.addMall(name);
    await refreshMalls(info.id);
    setTab('browser');
    logOk('店铺「' + name + '」已创建');
    logInfo('在右侧浏览器里扫码登录，登录后点顶部「检测登录」');
  } catch (e) {
    logErr('创建失败：' + (e && e.message ? e.message : e));
  }
}
$('#btnAddMall').addEventListener('click', addMall);

$('#chkView').addEventListener('change', (e) => {
  state.visible = e.target.checked;
  scheduleSync();
});
$('#btnReload').addEventListener('click', async () => {
  await window.pdd.reload();
  logInfo('已刷新页面');
});
$('#btnPing').addEventListener('click', async () => {
  logInfo('检测登录态 ...');
  const r = await window.pdd.ping();
  if (r && r.ok && r.login) logOk('登录有效');
  else if (r && r.__blocked) logWarn(r.error);
  else logErr('未登录：' + JSON.stringify(r && (r.error || r.detail || r)));
});

// ------------------------------------------------------------------ 商品列表
function renderGoods(items) {
  state.goods = items || [];
  const tb = $('#goodsBody');
  tb.innerHTML = '';
  if (!state.goods.length) {
    $('#goodsTable').style.display = 'none';
    $('#goodsEmpty').style.display = 'flex';
    return;
  }
  $('#goodsEmpty').style.display = 'none';
  $('#goodsTable').style.display = 'table';

  for (const g of state.goods) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (g.thumb ? '<img src="' + esc(g.thumb) + '" />' : '') + '</td>' +
      '<td class="ttl" title="' + esc(g.title) + '">' + esc(g.title) + '</td>' +
      '<td class="price">' + money(g.group_price) + '</td>' +
      '<td class="price">' + money(g.single_price) + '</td>' +
      '<td>' + (g.sku_count == null ? '-' : g.sku_count) + '</td>' +
      '<td class="' + (g.stock ? '' : 'warn') + '">' + (g.stock == null ? '-' : g.stock) + '</td>' +
      '<td>' +
        '<button class="btn mini primary" data-act="collect">采集</button> ' +
        '<button class="btn mini" data-act="copy" title="同店复制会在本店再建一条重复链接">复制</button>' +
      '</td>';
    tr.querySelector('[data-act="collect"]').addEventListener('click', () => collectOne(g));
    tr.querySelector('[data-act="copy"]').addEventListener('click', () => openCopyDialog(g));
    tb.appendChild(tr);
  }
}

$('#btnList').addEventListener('click', async () => {
  const btn = $('#btnList');
  btn.disabled = true;
  btn.textContent = '读取中 ...';
  logInfo('正在读取本店在售商品 ...');
  try {
    const r = await window.pdd.listGoods();
    if (r && r.ok) {
      logOk('读到 ' + r.count + ' 个在售商品');
      renderGoods(r.items);
      setTab('goods');
      logInfo('点某一行的「采集」把商品存进采集箱；「复制」是同店复制，会产生重复链接');
    } else {
      logErr('读取失败：' + JSON.stringify(r && (r.error || r)));
    }
    setResult(r);
  } finally {
    btn.disabled = false;
    btn.textContent = '读取本店在售商品';
  }
});

// ------------------------------------------------------------------ 采集箱
async function collectOne(g) {
  logInfo('正在采集「' + String(g.title || '').slice(0, 18) + '」到采集箱 ...');
  try {
    const r = await window.pdd.poolCollect(g.idx, g.goods_id);
    if (r && r.ok) {
      logOk('已采集：' + r.pack.skus + ' 个 SKU / ' + r.pack.images + ' 张图 → 采集箱');
      await refreshPool();
      setTab('pool');
    } else {
      logErr('采集失败：' + JSON.stringify((r && (r.error || r.detail)) || r));
      setResult(r);
    }
  } catch (e) {
    logErr('采集异常：' + (e && e.message ? e.message : e));
  }
}

async function refreshPool() {
  const items = await window.pdd.poolList();
  const tb = $('#poolBody');
  const tbl = $('#poolTable');
  const empty = $('#poolEmpty');
  state.pool = items || [];
  if (!items || !items.length) {
    tbl.style.display = 'none';
    empty.style.display = 'flex';
    updateSelCount();
    return;
  }
  empty.style.display = 'none';
  tbl.style.display = 'table';
  tb.innerHTML = '';
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="checkbox" data-sel="' + esc(it.id) + '"' +
        (state.poolSel.has(it.id) ? ' checked' : '') + ' /></td>' +
      '<td>' + (it.thumb ? '<img src="' + esc(it.thumb) + '" />' : '') + '</td>' +
      '<td class="ttl" title="' + esc(it.title) + '">' + esc(it.title) + '</td>' +
      '<td>' + esc(it.sourceMallName || '-') + '</td>' +
      '<td class="price">' + money(it.price) + '</td>' +
      '<td>' + (it.skus == null ? '-' : it.skus) + '</td>' +
      '<td>' + (it.images == null ? '-' : it.images) + '</td>' +
      '<td>' +
        '<button class="btn mini" data-act="chk" title="检测标题/价格/主图/规格">检测</button> ' +
        '<button class="btn mini" data-act="wm" title="给主图加水印，输出到本地">水印</button> ' +
        '<button class="btn mini primary" data-act="pub">上架</button> ' +
        '<button class="btn mini" data-act="del">移除</button>' +
      '</td>';
    const cb = tr.querySelector('[data-sel]');
    cb.addEventListener('change', () => {
      if (cb.checked) state.poolSel.add(it.id); else state.poolSel.delete(it.id);
      updateSelCount();
    });
    tr.querySelector('[data-act="chk"]').addEventListener('click', () => openInspect(it));
    tr.querySelector('[data-act="wm"]').addEventListener('click', () => openWatermark(it));
    tr.querySelector('[data-act="pub"]').addEventListener('click', () => publishFromPool(it));
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await window.pdd.poolRemove(it.id);
      state.poolSel.delete(it.id);
      await refreshPool();
      logInfo('已从采集箱移除');
    });
    tb.appendChild(tr);
  }
  updateSelCount();
}

// ---------------------------------------------------------------- 商品检测
const LEVEL_TXT = { error: '必修', warn: '建议改', info: '参考' };

function renderInsp(res, deepNote) {
  const box = $('#inspBody');
  const cls = res.level === 'ok' ? 'ok' : (res.level === 'error' ? 'error' : 'warn');
  const grade = res.level === 'ok' ? '通过' : (res.level === 'error' ? '有问题' : '基本可用');

  let html = '<div class="insp-score">' +
    '<div class="insp-num ' + cls + '">' + res.score + '</div>' +
    '<div><b>' + grade + '</b><div class="insp-meta">' +
    '必修 ' + res.summary.error + ' 项 ｜ 建议 ' + res.summary.warn + ' 项 ｜ 参考 ' + res.summary.info + ' 项<br>' +
    '标题 ' + res.summary.titleLen + ' 字 ｜ SKU ' + res.summary.skuCount +
    ' 个 ｜ 主图 ' + res.summary.galleryCount + ' 张</div></div></div>';

  if (deepNote) {
    html += '<div class="insp-item info"><div class="t">' + esc(deepNote) + '</div></div>';
  }

  if (!res.issues.length) {
    html += '<div class="insp-item info"><div class="t">没发现问题</div></div>';
  }
  for (const s of res.issues) {
    html += '<div class="insp-item ' + esc(s.level) + '">' +
      '<div class="t"><span class="insp-tag ' + esc(s.level) + '">' + LEVEL_TXT[s.level] + '</span>' +
      esc(s.msg) +
      (s.unconfirmed ? '<span class="insp-unc" title="这条阈值没有官方依据，只是经验值">未确认</span>' : '') +
      '</div>' +
      (s.fix ? '<div class="f">→ ' + esc(s.fix) + '</div>' : '') +
      '</div>';
  }

  if (res.images && res.images.length) {
    html += '<div class="insp-meta" style="margin-top:12px">主图逐张测量</div><div class="insp-imgs">';
    for (const im of res.images) {
      const bad = im.level === 'warn' || im.level === 'error' || im.error;
      const cap = im.error ? '下载失败'
        : (im.w + '×' + im.h + '<br>' + (im.bytes ? (im.bytes / 1024).toFixed(0) + 'KB' : ''));
      html += '<div class="insp-img ' + (bad ? 'bad' : '') + '" title="' +
        esc((im.issues || []).map((x) => x.msg).join('\n') || '正常') + '">' +
        '<img src="' + esc(im.url) + '" />' + cap + '</div>';
    }
    html += '</div>';
  }
  if (res.imageErrors && res.imageErrors.length) {
    html += '<div class="hint" style="color:#f5a623">' + esc(res.imageErrors.join('；')) + '</div>';
  }

  box.innerHTML = html;
}

async function openInspect(it) {
  await withViewHidden(async () => {
    const mask = $('#inspMask');
    $('#inspTitle').textContent = String(it.title || '').slice(0, 22);
    $('#inspBody').innerHTML = '<div class="insp-meta">检测中…</div>';
    $('#inspErr').textContent = '';
    mask.classList.add('on');
    $('#inspDeep').disabled = true;
    $('#inspClose').onclick = () => { mask.classList.remove('on'); };

    // 先跑规则层（快）
    const r = await window.pdd.inspectItem({ id: it.id, withImages: false });
    $('#inspDeep').disabled = false;
    if (!r || !r.ok) {
      $('#inspErr').textContent = (r && r.error) || '检测失败';
      $('#inspBody').innerHTML = '';
      return;
    }
    state.lastInsp = it;
    renderInsp(r);

    // 图像层：按需触发
    $('#inspDeep').textContent = '连主图一起查';
    $('#inspDeep').onclick = async () => {
      $('#inspDeep').disabled = true;
      $('#inspDeep').textContent = '正在下载主图…';
      const r2 = await window.pdd.inspectItem({ id: it.id, withImages: true });
      $('#inspDeep').disabled = false;
      $('#inspDeep').textContent = '重新查主图';
      if (r2 && r2.ok) {
        renderInsp(r2, '已合并主图检测（' + ((r2.images || []).length) + ' 张）');
        logOk('主图检测完成：' + (r2.images || []).length + ' 张');
      } else {
        $('#inspErr').textContent = (r2 && r2.error) || '主图检测失败';
      }
    };
  });
}

// ---------------------------------------------------------------- 主图水印
const WM_DEFAULT_TEXT = {
  mall: '',
};

async function openWatermark(it) {
  await withViewHidden(async () => {
    const mask = $('#wmMask');
    $('#wmTitle').textContent = String(it.title || '').slice(0, 20) + ' · ' + (it.images || 0) + ' 张';
    $('#wmErr').textContent = '';
    $('#wmSteps').innerHTML = '';
    $('#wmProgress').style.display = 'none';
    if (!$('#wmText').value) {
      $('#wmText').value = (it.sourceMallName || '') + ' 严选';
    }
    const syncPos = () => {
      $('#wmPosWrap').style.display = ($('#wmMode').value === 'corner') ? 'block' : 'none';
    };
    const syncOpacity = () => {
      $('#wmOpacityVal').textContent = Math.round(Number($('#wmOpacity').value) * 100) + '%';
    };
    syncPos(); syncOpacity();
    $('#wmMode').onchange = () => {
      syncPos();
      // 平铺默认更淡
      if ($('#wmMode').value === 'tile') {
        $('#wmOpacity').value = '0.20';
      } else if ($('#wmMode').value === 'band') {
        $('#wmOpacity').value = '0.50';
      } else {
        $('#wmOpacity').value = '0.55';
      }
      syncOpacity();
    };
    $('#wmOpacity').oninput = syncOpacity;

    mask.classList.add('on');
    $('#wmCancel').onclick = () => mask.classList.remove('on');
    $('#wmOk').disabled = false;
    $('#wmOk').textContent = '生成水印图';
    $('#wmOk').onclick = async () => {
      const text = $('#wmText').value.trim();
      if (!text) { $('#wmErr').textContent = '请填水印文字'; return; }
      $('#wmOk').disabled = true;
      $('#wmOk').textContent = '处理中…';
      $('#wmErr').textContent = '';
      $('#wmProgress').style.display = 'block';
      $('#wmSteps').innerHTML = '<div>正在下载主图并加水印（' + (it.images || 0) + ' 张）…</div>';

      const r = await window.pdd.watermarkItem({
        id: it.id,
        text,
        mode: $('#wmMode').value,
        pos: $('#wmPos').value,
        opacity: Number($('#wmOpacity').value),
      });

      $('#wmOk').disabled = false;
      $('#wmOk').textContent = '重新生成';
      if (r && r.ok) {
        logOk('水印完成 ' + r.count + '/' + r.total + ' 张');
        $('#wmSteps').innerHTML =
          '<div class="s-ok">已生成 ' + r.count + ' 张</div>' +
          '<div style="color:#8fa3c0;font-size:11px;word-break:break-all">' + esc(r.outDir) + '</div>';
        $('#wmHint').innerHTML = '生成好了。<b>不会动平台上的图</b>——需要你自己上传替换。';
        // 加一个打开目录按钮
        if (!$('#wmOpen')) {
          const b = document.createElement('button');
          b.className = 'btn mini primary';
          b.id = 'wmOpen';
          b.textContent = '打开文件夹';
          b.style.marginTop = '8px';
          b.onclick = () => window.pdd.openPath(r.outDir);
          $('#wmSteps').appendChild(b);
        } else {
          $('#wmOpen').onclick = () => window.pdd.openPath(r.outDir);
        }
        if (r.errors && r.errors.length) {
          $('#wmSteps').innerHTML += '<div style="color:#f5a623">' + esc(r.errors.join('；')) + '</div>';
        }
      } else {
        $('#wmErr').textContent = (r && r.error) || '生成失败';
        logErr('水印失败：' + ((r && r.error) || '未知'));
      }
    };
  });
}

// ---------------------------------------------------------------- 批量队列
function updateSelCount() {
  const n = state.poolSel.size;
  const el = $('#poolSelCount');
  if (el) el.textContent = '已选 ' + n + ' 个';
  const all = $('#poolAll');
  const all2 = $('#poolAll2');
  const total = (state.pool || []).length;
  const on = n > 0 && n === total;
  if (all) all.checked = on;
  if (all2) all2.checked = on;
}

function toggleSelectAll(checked) {
  state.poolSel.clear();
  if (checked) for (const it of (state.pool || [])) state.poolSel.add(it.id);
  document.querySelectorAll('#poolBody [data-sel]').forEach((cb) => {
    cb.checked = !!checked;
  });
  updateSelCount();
}

const BATCH_STATE_TEXT = {
  queued: '排队中', running: '执行中', done: '成功',
  failed_known: '失败', failed_unknown: '状态未知',
};

function renderBatch(payload) {
  if (!payload) return;
  const s = payload.stats || {};
  const running = !!payload.running;

  const stat = $('#batchStat');
  if (stat) {
    if (s.total) {
      stat.style.display = 'block';
      stat.textContent = '共 ' + s.total + ' 项 ｜ 成功 ' + (s.done || 0) +
        ' ｜ 失败 ' + (s.failed_known || 0) +
        ' ｜ 状态未知 ' + (s.failed_unknown || 0) +
        ' ｜ 排队 ' + (s.queued || 0) + (running ? ' ｜ 运行中…' : '');
    } else {
      stat.style.display = 'none';
    }
  }

  const btnStart = $('#btnBatchStart');
  const btnStop = $('#btnBatchStop');
  if (btnStart) btnStart.style.display = running ? 'none' : '';
  if (btnStop) btnStop.style.display = running ? '' : 'none';

  const items = payload.items || [];
  const panel = $('#batchPanel');
  const tb = $('#batchBody');
  if (!items.length) {
    if (panel) panel.style.display = 'none';
    return;
  }
  if (panel) panel.style.display = 'block';
  if (tb) {
    tb.innerHTML = '';
    items.forEach((it, i) => {
      const tr = document.createElement('tr');
      const cls = 'st-' + it.state;
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(String(it.title || '').slice(0, 26)) + '</td>' +
        '<td class="' + cls + '">' + (BATCH_STATE_TEXT[it.state] || it.state) + '</td>' +
        '<td>' + (it.attempts || 0) + '</td>' +
        '<td>' + esc(it.errorMsg || '') +
          (it.state === 'failed_unknown'
            ? '<br><span style="color:#ef5b5b">⚠ 状态未知，请去后台核对，不要直接重试</span>'
            : '') + '</td>';
      tb.appendChild(tr);
    });
  }
  const sum = $('#batchSummary');
  if (sum) sum.textContent = '成功 ' + (s.done || 0) + ' / 共 ' + (s.total || 0);
}

async function startBatch() {
  const ids = [...state.poolSel];
  if (!ids.length) { logWarn('先在左边勾选要上架的商品'); return; }
  const stock = Number($('#batchStock').value) || 50;
  const factor = Number($('#batchFactor').value) || 1;
  const gmin = Number($('#batchGapMin').value) || 15;
  const gmax = Number($('#batchGapMax').value) || 25;
  logInfo('批量上架 ' + ids.length + ' 个商品，库存 ' + stock +
          '，加价 ×' + factor + '，间隔 ' + gmin + '~' + gmax + ' 秒 ...');
  const r = await window.pdd.batchStart(ids, {
    stock, factor, intervalMin: gmin, intervalMax: gmax, maxAttempts: 2,
  });
  if (!r || !r.ok) { logErr('批量启动失败：' + ((r && r.error) || '未知')); return; }
  setTab('pool');
}

$('#poolAll') && $('#poolAll').addEventListener('change', (e) => toggleSelectAll(e.target.checked));
$('#poolAll2') && $('#poolAll2').addEventListener('change', (e) => toggleSelectAll(e.target.checked));
$('#btnBatchStart') && $('#btnBatchStart').addEventListener('click', startBatch);
$('#btnBatchStop') && $('#btnBatchStop').addEventListener('click', async () => {
  await window.pdd.batchStop();
  logWarn('已请求停止，当前这一件跑完就停');
});
$('#btnBatchRetry') && $('#btnBatchRetry').addEventListener('click', async () => {
  const r = await window.pdd.batchRetryKnown();
  if (r && r.ok) { logInfo('已把「失败」项重置为排队，点「批量上架」继续'); await refreshBatch(); }
});
$('#btnBatchClear') && $('#btnBatchClear').addEventListener('click', async () => {
  const r = await window.pdd.batchClear();
  if (r && r.ok) { logInfo('批量记录已清空'); await refreshBatch(); }
  else logWarn((r && r.error) || '清空失败');
});

async function refreshBatch() {
  try {
    const p = await window.pdd.batchList();
    renderBatch(p);
  } catch (_) { /* ignore */ }
}

window.pdd.onBatch((p) => renderBatch(p));


async function publishFromPool(it) {
  logInfo('从采集箱上架：' + String(it.title || '').slice(0, 18) + ' → 当前店铺 ...');
  const r = await window.pdd.poolPublish({ id: it.id });
  if (r && r.ok) logOk('已上架');
  else {
    logWarn((r && r.error) || '上架失败');
    if (r && r.advice) logInfo('建议：' + r.advice);
  }
  setResult(r);
  setTab('result');
}

// ------------------------------------------------------------------ 复制（同店）
let currentItem = null;

function suggestTitle(t) {
  const s = String(t || '');
  return s.length > 56 ? s.slice(0, 56) + '-新款' : s + '-新款';
}

function updatePreview() {
  const f = Number($('#copyFactor').value);
  const box = $('#copyPreview');
  if (!currentItem || !f || f <= 0) { box.textContent = '填一个大于 0 的倍数，例如 1.05'; return; }
  const g = Number(currentItem.group_price) || 0;
  const s = Number(currentItem.single_price) || 0;
  const ng = Math.round(g * f);
  const ns = Math.round(s * f);
  box.innerHTML = '拼单价 <b>' + money(g) + '</b> → <b>' + money(ng) + '</b>（+' +
                  ((ng - g) / 100).toFixed(2) + ' 元）<br>单买价 <b>' + money(s) +
                  '</b> → <b>' + money(ns) + '</b>';
}

// 改倍数时实时更新价格预览。
// 之前 updatePreview() 只在开窗时算一次，用户改完看不见自己设了什么价 —— 批量下会放大成 50 条错价。
(function bindFactorPreview() {
  const el = document.getElementById('copyFactor');
  if (!el) return;
  const onEdit = () => updatePreview();
  el.addEventListener('input', onEdit);
  el.addEventListener('change', onEdit);
  el.addEventListener('keyup', onEdit);
})();

function openCopyDialog(item) {
  currentItem = item;
  $('#copyErr').textContent = '';
  $('#copyProgress').style.display = 'none';
  $('#copyBar').style.width = '0';
  $('#copySteps').innerHTML = '';
  $('#copyTitle').value = suggestTitle(item.title);
  $('#copyFactor').value = '1.05';
  $('#copyDoPrice').checked = true;
  $('#copyPublish').checked = false;
  $('#copyThumb').src = item.thumb || '';
  $('#copySrcTitle').textContent = item.title || '';
  $('#copySrcMeta').textContent = '拼单价 ' + money(item.group_price) + ' ｜ 单买价 ' +
    money(item.single_price) + ' ｜ ' + (item.sku_count || 0) + ' 个 SKU ｜ 库存 ' + (item.stock || 0);
  updatePreview();
  renderSizeBox(item);

  withViewHidden(() => new Promise((resolve) => {
    const mask = $('#copyMask');
    mask.classList.add('on');
    focusInput($('#copyTitle'), true);   // 标题框自动获得焦点并全选，方便直接改
    $('#copyCancel').textContent = '取消';
    $('#copyOk').textContent = '开始复制';

    const close = () => {
      mask.classList.remove('on');
      $('#copyCancel').onclick = null;
      $('#copyOk').onclick = null;
      resolve(null);
    };
    $('#copyCancel').onclick = close;
    $('#copyOk').onclick = async () => {
      const title = $('#copyTitle').value.trim();
      const factor = Number($('#copyFactor').value);
      const doPrice = $('#copyDoPrice').checked;
      const publish = $('#copyPublish').checked;
      if (!title) { $('#copyErr').textContent = '标题不能为空'; return; }
      if (!factor || factor <= 0) { $('#copyErr').textContent = '倍数不合法'; return; }

      $('#copyOk').disabled = true;
      $('#copyCancel').disabled = true;
      $('#copyProgress').style.display = 'block';
      await runCopy(item, title, factor, doPrice, publish, (pct, text, cls) => {
        $('#copyBar').style.width = Math.round(pct) + '%';
        const d = document.createElement('div');
        d.className = cls || '';
        d.textContent = text;
        $('#copySteps').appendChild(d);
      });
      $('#copyOk').disabled = false;
      $('#copyCancel').disabled = false;
      $('#copyCancel').textContent = '关闭';
      $('#copyOk').textContent = '再复制一条';
      $('#copyOk').onclick = close;
    };
  }));
}

// ------------------------------------------------------------------ 尺码表匹配
async function renderSizeBox(item) {
  const box = $('#copySizeBody');
  if (!box) return;
  box.textContent = '按尺码标签匹配中 ...';
  let tpl = null;
  try {
    tpl = await window.pdd.sizeMatch({ catNames: item.catNames || [], sizes: item.sizes || [] });
  } catch (e) {
    box.innerHTML = '<span class="no">匹配失败：' + esc(e && e.message ? e.message : e) + '</span>';
    return;
  }
  if (!tpl) {
    box.innerHTML = '<span class="no">没有匹配到模板</span><br>' +
      '<span style="color:#7d8aa3">类目：' + esc((item.catNames || []).join(' / ') || '（无）') + '</span><br>' +
      '<span style="color:#7d8aa3">商品尺码：' + esc((item.sizes || []).join(', ') || '（未读到）') + '</span>';
    return;
  }
  const chips = tpl.sizes.map((s) => '<span class="chip">' + esc(s) + '</span>').join('');
  const how = tpl.bySizes
    ? ('尺码标签匹配 · ' + tpl.rowCount + ' 个尺码')
    : ('类目关键词 · ' + esc(tpl.matchedBy || ''));
  box.innerHTML = '<span class="ok">已匹配：' + esc(tpl.name) + '</span><br>' +
    '<span style="color:#7d8aa3">' + how + '</span>' +
    '<div class="chips">' + chips + '</div>' +
    '<div style="margin-top:6px;color:#f5a623;font-size:11px">自动写入尚未接入</div>';
  state.sizeTpl = tpl;
}

// ------------------------------------------------------------------ 执行复制
async function runCopy(item, title, factor, doPrice, doPublish, progress) {
  progress(8, '正在复制商品 ...');
  let r;
  try {
    r = await window.pdd.copyGoods({ index: item.idx, goodsId: item.goods_id, title, submit: false, allowSameStore: true });
  } catch (e) {
    progress(100, '出错：' + (e && e.message ? e.message : e), 's-err');
    logErr('复制异常：' + (e && e.message ? e.message : e));
    return;
  }
  if (!r || !r.ok) {
    const raw = (r && r.detail && (r.detail.error_msg || r.detail.errorMsg)) || (r && r.error) || '未知';
    let human = raw;
    if (r && r.detail && r.detail.error_code === 600102) {
      human = '这个商品之前已经复制过一次，平台限制不能连续新建。换一个商品试试。';
    }
    progress(100, '复制失败：' + human, 's-err');
    logErr('复制失败：' + human);
    setResult(r);
    state.last = { ok: false, title: item.title, error: human, code: r && r.detail && r.detail.error_code };
    renderLastCard();
    return;
  }

  const d = r.result;
  progress(45, '草稿已建：图 ' + d.images + ' 张，SKU ' + d.skus + ' 个', 's-ok');
  logOk('草稿已建 commit=' + d.commit_id + ' goods=' + d.goods_id);
  if (d.stock_warning && d.stock_warning !== 'ok') logWarn(d.stock_warning);

  let priceInfo = null;
  if (doPrice) {
    progress(55, '正在改价（约 15 秒）...');
    try {
      const pr = await window.pdd.changePrice({ commit: d.commit_id, goods: d.goods_id, factor });
      if (pr && pr.ok) {
        priceInfo = pr.after;
        progress(95, '改价成功：拼单价 ' + money(pr.after && pr.after.min_group_price), 's-ok');
      } else {
        progress(95, '改价失败：' + JSON.stringify((pr && pr.save) || pr), 's-err');
      }
    } catch (e) {
      progress(95, '改价异常：' + (e && e.message ? e.message : e), 's-err');
    }
  }

  state.last = { ok: true, result: d, priceInfo, published: false };

  if (doPublish) {
    progress(97, '正在提交上架 ...');
    try {
      const sr = await window.pdd.publish({ commit: d.commit_id, goods: d.goods_id, stock: 50 });
      (sr.steps || []).forEach((s) => logInfo('  ' + s));
      if (sr && sr.ok) {
        state.last.published = true;
        progress(100, '已提交上架，等审核', 's-ok');
        logOk('已提交上架 —— 审核通过后才出现在在售列表');
      } else {
        if (sr && sr.advice) logWarn('建议：' + sr.advice);
        progress(100, '提交失败：' + ((sr && sr.error) || '未知'), 's-err');
      }
    } catch (e) {
      progress(100, '提交异常：' + (e && e.message ? e.message : e), 's-err');
    }
  } else {
    progress(100, '完成（已存草稿，未上架）', 's-ok');
  }

  setResult(r);
  renderLastCard();
}

// ------------------------------------------------------------------ 结果卡片
function renderLastCard() {
  const box = $('#lastCard');
  const L = state.last;
  if (!L) return;
  if (!L.ok) {
    box.className = 'card fail';
    box.innerHTML =
      '<div class="title">操作失败 <span class="badge fail">失败</span></div>' +
      '<div class="row"><span class="k">商品</span><span class="v">' +
      esc(String(L.title || '').slice(0, 26)) + '</span></div>' +
      '<div class="row"><span class="k">原因</span><span class="v">' + esc(L.error || '') + '</span></div>';
    return;
  }
  const d = L.result;
  box.className = 'card ok';
  box.innerHTML =
    '<div class="title">草稿已创建 ' +
    (L.published ? '<span class="badge ok">已提交上架</span>' : '<span class="badge wait">未上架</span>') +
    '</div>' +
    '<div class="row"><span class="k">标题</span><span class="v">' + esc(String(d.title || '').slice(0, 24)) + '</span></div>' +
    '<div class="row"><span class="k">图片 / SKU</span><span class="v">' + d.images + ' 张 / ' + d.skus + ' 个</span></div>' +
    '<div class="row"><span class="k">拼单价</span><span class="v">' +
    money((L.priceInfo && L.priceInfo.min_group_price) || d.min_group_price) + '</span></div>' +
    '<div class="row"><span class="k">草稿号</span><span class="v">' + d.commit_id + '</span></div>' +
    (L.published ? '' : '<button class="btn primary block" id="btnPublish">提交上架到店铺</button>');

  const btn = $('#btnPublish');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '准备并提交 ...';
      logInfo('提交上架 ' + d.commit_id + ' ...');
      try {
        const sr = await window.pdd.publish({ commit: d.commit_id, goods: d.goods_id, stock: 50 });
        (sr.steps || []).forEach((s) => logInfo('  ' + s));
        if (sr && sr.ok) {
          state.last.published = true;
          logOk('已提交上架 —— 审核通过后才出现在在售列表');
        } else {
          if (sr && sr.advice) logWarn('建议：' + sr.advice);
          logErr('提交失败：' + ((sr && sr.error) || JSON.stringify(sr && sr.submit) || ''));
        }
      } catch (e) {
        logErr('提交异常：' + (e && e.message ? e.message : e));
      }
      renderLastCard();
    };
  }
}

// ------------------------------------------------------------------ 启动
(async () => {
  logInfo('界面已就绪');
  await refreshMalls();
  await refreshPool();
  await refreshBatch();
  setTab('goods');
  if (!state.malls.length) logInfo('第一步：点左上「＋ 添加店铺」，在右侧浏览器里扫码登录');
})();
