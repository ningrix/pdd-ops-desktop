'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  malls: [],
  activeId: null,
  visible: true,
  tab: 'goods',
  goods: [],
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
    const r = await window.pdd.poolCollect(g.idx);
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
  if (!items || !items.length) {
    tbl.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  tbl.style.display = 'table';
  tb.innerHTML = '';
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (it.thumb ? '<img src="' + esc(it.thumb) + '" />' : '') + '</td>' +
      '<td class="ttl" title="' + esc(it.title) + '">' + esc(it.title) + '</td>' +
      '<td>' + esc(it.sourceMallName || '-') + '</td>' +
      '<td class="price">' + money(it.price) + '</td>' +
      '<td>' + (it.skus == null ? '-' : it.skus) + '</td>' +
      '<td>' + (it.images == null ? '-' : it.images) + '</td>' +
      '<td>' +
        '<button class="btn mini primary" data-act="pub">上架到当前店</button> ' +
        '<button class="btn mini" data-act="del">移除</button>' +
      '</td>';
    tr.querySelector('[data-act="pub"]').addEventListener('click', () => publishFromPool(it));
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await window.pdd.poolRemove(it.id);
      await refreshPool();
      logInfo('已从采集箱移除');
    });
    tb.appendChild(tr);
  }
}

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
    r = await window.pdd.copyGoods({ index: item.idx, title, submit: false, allowSameStore: true });
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
  setTab('goods');
  if (!state.malls.length) logInfo('第一步：点左上「＋ 添加店铺」，在右侧浏览器里扫码登录');
})();
