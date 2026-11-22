'use strict';
/**
 * 批量任务队列的持久化状态。
 *
 * 状态机（严格按 AGENTS.md §5）：
 *   queued → running → done
 *                    ├→ failed_known    确定失败，可重试
 *                    └→ failed_unknown  状态未知，只允许人工核对
 *
 * 为什么必须分开：把两者合并成一个 failed，批量就会自己造重复草稿 ——
 * 超时那一刻远端往往已经建好了，再重试就是第二条。
 */
const fs = require('fs');
const path = require('path');

let FILE = null;
let mem = { createdAt: null, running: false, items: [] };

function init(userDataDir) {
  FILE = path.join(userDataDir, 'batch.json');
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}
  mem = load();
}

function load() {
  try {
    if (!FILE || !fs.existsSync(FILE)) return { createdAt: null, running: false, items: [] };
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!o || !Array.isArray(o.items)) return { createdAt: null, running: false, items: [] };
    return o;
  } catch (_) {
    return { createdAt: null, running: false, items: [] };
  }
}

function save() {
  try {
    if (!FILE) return false;
    fs.writeFileSync(FILE, JSON.stringify(mem, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
}

/** 新建一批任务。items: [{poolId, title, mallId}] */
function create(items) {
  mem = {
    createdAt: new Date().toISOString(),
    running: false,
    items: (items || []).map((x) => ({
      poolId: x.poolId,
      title: String(x.title || '').slice(0, 40),
      mallId: x.mallId || null,
      state: 'queued',
      attempts: 0,
      errorCode: null,
      errorMsg: null,
      goodsId: null,
      commitId: null,
      startedAt: null,
      endedAt: null,
    })),
  };
  save();
  return mem.items;
}

function list() { return mem; }
function getItems() { return mem.items; }
function isRunning() { return !!mem.running; }
function setRunning(v) { mem.running = !!v; save(); }

function update(index, patch) {
  const it = mem.items[index];
  if (!it) return null;
  Object.assign(it, patch || {});
  save();
  return it;
}

/** 可执行的任务：queued，或 failed_known 且未超过重试次数 */
function getRunnable(maxAttempts) {
  const cap = maxAttempts || 2;
  const out = [];
  mem.items.forEach((it, i) => {
    if (it.state === 'queued') out.push({ index: i, item: it });
    else if (it.state === 'failed_known' && !it.noRetry && (it.attempts || 0) < cap) out.push({ index: i, item: it });
    // failed_unknown 与 done 一律跳过 —— 前者必须人工核对，后者已完成
  });
  return out;
}

function stats() {
  const s = { total: mem.items.length, queued: 0, running: 0, done: 0, failed_known: 0, failed_unknown: 0 };
  for (const it of mem.items) {
    if (s[it.state] !== undefined) s[it.state]++;
  }
  return s;
}

function clear() {
  mem = { createdAt: null, running: false, items: [] };
  save();
}

function resetFailedKnown() {
  for (const it of mem.items) {
    if (it.state === 'failed_known') {
      it.state = 'queued';
      it.errorCode = null;
      it.errorMsg = null;
    }
  }
  save();
}

module.exports = { init, create, list, getItems, isRunning, setRunning,
                   update, getRunnable, stats, clear, resetFailedKnown };
