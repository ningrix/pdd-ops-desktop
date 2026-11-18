'use strict';
/**
 * ADB 真人化操作工具包
 *
 * 为什么需要：ADB 的 `input tap x y` 是瞬时的、坐标精确到像素、间隔固定 ——
 * 这三件事本身就是最强的机器人特征。真实手指是：
 *   · 落点有偏差（±十几像素）
 *   · 按下有 50~120ms 的持续时间
 *   · 屏幕上有轻微滑动（手抖）
 *   · 操作之间停顿不规律
 *
 * 本模块把这些都加上。它不能改变模拟器本身的深层指纹（qemu 属性、传感器），
 * 那些只能靠真机解决 —— 但能消掉「行为层」的机器人特征。
 *
 * 用法：node tools/adb-human.js <command> [...]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- adb 定位
function findAdb() {
  const cache = path.join(__dirname, '..', 'work', 'adb_path.txt');
  if (fs.existsSync(cache)) {
    const p = fs.readFileSync(cache, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'C:\\Android\\platform-tools\\adb.exe',
    path.join(process.env.LOCALAPPDATA || '',
      'Microsoft', 'WinGet', 'Packages',
      'Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe',
      'platform-tools', 'adb.exe'),
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return 'adb';
}

const ADB = findAdb();

function adb(args, opts) {
  const o = Object.assign({ encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {});
  try {
    return execFileSync(ADB, args, o) || '';
  } catch (e) {
    const msg = (e && (e.stderr || e.message)) || String(e);
    return '__ERR__' + String(msg).slice(0, 300);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 人类化随机
/** 人类反应时间：对数正态，中位数 ~1.6s，尾部可到 4s */
function humanDelay(min, max) {
  const lo = min === undefined ? 800 : min;
  const hi = max === undefined ? 3500 : max;
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mid = (lo + hi) / 2;
  const v = mid + z * (hi - lo) / 4;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** 在矩形内取一个「避开边缘」的随机点 —— 真人不会点得那么正 */
function jitterPoint(x, y, w, h) {
  const mx = Math.max(2, Math.round(w * 0.18));
  const my = Math.max(2, Math.round(h * 0.18));
  const px = x + mx + Math.random() * Math.max(1, w - mx * 2);
  const py = y + my + Math.random() * Math.max(1, h - my * 2);
  return [Math.round(px), Math.round(py)];
}

// ---------------------------------------------------------------- 动作
/**
 * 人类式点击：用极短微滑代替 tap，并带轻微抖动
 * input tap 是 0ms 瞬时事件，真实按压大约 60~120ms
 */
async function humanTap(x, y) {
  const ox = Math.round((Math.random() - 0.5) * 6);
  const oy = Math.round((Math.random() - 0.5) * 6);
  const dur = 60 + Math.round(Math.random() * 70);
  adb(['shell', 'input', 'swipe', String(x + ox), String(y + oy),
       String(x + ox + 1), String(y + oy + 1), String(dur)]);
  await sleep(humanDelay(400, 1600));
}

/** 人类式点击元素（bounds 来自 uiautomator dump） */
async function humanTapBounds(bounds) {
  const m = String(bounds).match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) throw new Error('bounds 格式不对: ' + bounds);
  const [x1, y1, x2, y2] = [+m[1], +m[2], +m[3], +m[4]];
  const [px, py] = jitterPoint(x1, y1, x2 - x1, y2 - y1);
  await humanTap(px, py);
}

/**
 * 人类式滑动：分 2~4 段，每段速度不同，最后带一点回弹
 * 真实滑动的加速度不是恒定的
 */
async function humanSwipe(x1, y1, x2, y2, opts) {
  const o = opts || {};
  const segs = 2 + Math.floor(Math.random() * 3);     // 2~4 段
  let cx = x1, cy = y1;
  for (let i = 0; i < segs; i++) {
    const t = (i + 1) / segs;
    const nx = Math.round(x1 + (x2 - x1) * t + (Math.random() - 0.5) * 10);
    const ny = Math.round(y1 + (y2 - y1) * t + (Math.random() - 0.5) * 10);
    // 前段慢（起步），中段快，尾段慢（减速）
    const base = o.duration || 380;
    const dur = Math.max(60, Math.round(base / segs * (0.6 + Math.random() * 0.9)));
    adb(['shell', 'input', 'swipe', String(cx), String(cy), String(nx), String(ny), String(dur)]);
    cx = nx; cy = ny;
    if (i < segs - 1) await sleep(40 + Math.round(Math.random() * 90));
  }
  await sleep(humanDelay(500, 1800));
}

/** 上滑一屏（浏览用），距离和速度都随机 */
async function humanScrollUp() {
  const w = screenSize().w || 1080;
  const h = screenSize().h || 1920;
  const x = Math.round(w * (0.35 + Math.random() * 0.3));
  const fromY = Math.round(h * (0.70 + Math.random() * 0.10));
  const toY = Math.round(h * (0.28 + Math.random() * 0.12));
  await humanSwipe(x, fromY, x + Math.round((Math.random() - 0.5) * 40), toY,
                   { duration: 300 + Math.round(Math.random() * 260) });
}

// ---------------------------------------------------------------- 屏幕
let _screen = null;
function screenSize() {
  if (_screen) return _screen;
  const out = adb(['shell', 'wm', 'size']);
  const m = String(out).match(/(\d+)x(\d+)/);
  _screen = m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 1920 };
  return _screen;
}

/** 导出界面结构 XML（uiautomator） */
function dumpUi() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  const xml = adb(['shell', 'cat', '/sdcard/ui.xml']);
  return String(xml);
}

/** 从 XML 里找带某段文字的元素 bounds */
function findByText(xml, text) {
  const re = new RegExp('text="([^"]*' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"]*)"[^>]*bounds="(\\[[^"]+\\])"');
  const m = String(xml).match(re);
  return m ? { text: m[1], bounds: m[2] } : null;
}

/** 人类式浏览：先滑几次、有停顿，再动作 */
async function humanBrowse(times) {
  const n = times === undefined ? (2 + Math.floor(Math.random() * 3)) : times;
  for (let i = 0; i < n; i++) {
    await humanScrollUp();
    await sleep(humanDelay(900, 3200));
  }
}

// ---------------------------------------------------------------- 指纹体检
/** 检查会暴露模拟器的属性（这些 ADB 改不了，只能看） */
function fingerprintReport() {
  const props = [
    'ro.kernel.qemu', 'ro.hardware', 'ro.product.model', 'ro.product.brand',
    'ro.product.manufacturer', 'ro.build.fingerprint', 'ro.serialno',
    'ro.boot.qemu', 'ro.product.cpu.abi', 'gsm.sim.state', 'ro.debuggable',
  ];
  const out = {};
  for (const p of props) {
    out[p] = String(adb(['shell', 'getprop', p])).trim();
  }
  const bat = String(adb(['shell', 'dumpsys', 'battery'])).match(/level:\s*(\d+)/);
  out['battery.level'] = bat ? bat[1] : null;
  const sensors = String(adb(['shell', 'dumpsys', 'sensorservice'])).length;
  out['sensors.dumpBytes'] = sensors;
  return out;
}

// ---------------------------------------------------------------- CLI
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const devices = String(adb(['devices']));
  const connected = /device\s*$/m.test(devices);

  if (!cmd || cmd === 'status') {
    console.log('adb:', ADB);
    console.log('设备:', connected ? '已连接' : '未连接');
    console.log(devices.trim());
    return;
  }
  if (!connected) {
    console.log('没有连接设备。先启动模拟器，或用 USB 连真机并开 USB 调试。');
    return;
  }

  if (cmd === 'fingerprint') {
    console.log(JSON.stringify(fingerprintReport(), null, 2));
    return;
  }
  if (cmd === 'screen') {
    console.log(JSON.stringify(screenSize()));
    return;
  }
  if (cmd === 'browse') {
    await humanBrowse(rest[0] ? Number(rest[0]) : undefined);
    console.log('浏览完成');
    return;
  }
  if (cmd === 'tap') {
    await humanTap(Number(rest[0]), Number(rest[1]));
    console.log('点击完成');
    return;
  }
  if (cmd === 'tap-text') {
    const xml = dumpUi();
    const hit = findByText(xml, rest[0]);
    if (!hit) { console.log('没找到文字:', rest[0]); return; }
    await humanTapBounds(hit.bounds);
    console.log('已点击:', hit.text, hit.bounds);
    return;
  }
  if (cmd === 'dump') {
    const xml = dumpUi();
    const texts = [...String(xml).matchAll(/text="([^"]{2,40})"/g)].map((m) => m[1]);
    console.log('页面上出现的文字（去重）:');
    for (const t of [...new Set(texts)].slice(0, 80)) console.log('  ', t);
    return;
  }

  console.log('未知命令:', cmd);
  console.log('可用: status | fingerprint | screen | dump | browse [n] | tap X Y | tap-text 文字');
}

if (require.main === module) {
  main().catch((e) => { console.error('失败:', e && e.message); process.exit(1); });
}

module.exports = {
  ADB, adb, sleep, humanDelay, jitterPoint, humanTap, humanTapBounds,
  humanSwipe, humanScrollUp, humanBrowse, screenSize, dumpUi, findByText,
  fingerprintReport,
};
