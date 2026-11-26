'use strict';
/**
 * 内置曲目合成器 —— 纯 Node，零依赖，不联网，不含任何第三方素材。
 *
 * 为什么自己合成：
 *   1) 播放器需要「开箱有两首能放的」，但又不能把别人的商业歌曲打包进仓库；
 *   2) 网上 CC0 曲库需要下载二进制、核对每首授权，换机器/离线时还会缺文件；
 *   3) 合成结果是本项目原创，无版权风险，也不占 git（运行时写进 userdata）。
 *
 * 输出：22050Hz / 单声道 / PCM16 WAV。两首各约 72 秒、3MB 左右。
 * 音质是「背景垫」级别，不是用来替代你歌单的。
 */

const fs = require('fs');

const SR = 22050;

/** MIDI 音高 → Hz */
function hz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * 音频用确定性噪声：按样本序号取哈希，不用 PRNG、不用于任何安全用途。
 * 同一个序号永远得到同一个值，所以每次生成的鼓点完全一致。
 */
function noiseAt(i, seed) {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 一阶低通（时间常数由截止频率决定） */
function lowpass(buf, cutoff) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
}

/** 软削波，避免叠加后爆音 */
function softclip(buf) {
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    buf[i] = Math.tanh(x * 1.2) * 0.85;
  }
}

/** 归一化到目标峰值 */
function normalize(buf, peak) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  if (m < 1e-6) return;
  const g = peak / m;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}

/** 简易反馈延迟（制造空间感） */
function delay(buf, seconds, feedback, mix) {
  const d = Math.max(1, Math.round(seconds * SR));
  for (let i = d; i < buf.length; i++) {
    buf[i] += buf[i - d] * feedback * mix;
  }
}

/** 包络：attack 起、按 tau 指数衰减、末尾 release 收 */
function env(t, dur, attack, tau, release) {
  if (t < 0 || t > dur) return 0;
  let a = attack > 0 ? Math.min(1, t / attack) : 1;
  const body = Math.exp(-Math.max(0, t - attack) / tau);
  const rel = release > 0 ? Math.min(1, (dur - t) / release) : 1;
  return a * body * Math.max(0, rel);
}

/** 加一个正弦/泛音音色 */
function addTone(out, startSec, durSec, freq, amp, opts) {
  const o = opts || {};
  const i0 = Math.max(0, Math.floor(startSec * SR));
  const i1 = Math.min(out.length, Math.floor((startSec + durSec) * SR));
  const attack = o.attack != null ? o.attack : 0.01;
  const tau = o.tau != null ? o.tau : durSec;
  const release = o.release != null ? o.release : Math.min(0.3, durSec * 0.5);
  const harm = o.harm || [1];
  const detune = o.detune || 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const e = env(t, durSec, attack, tau, release);
    if (e <= 0) continue;
    let v = 0;
    for (let k = 0; k < harm.length; k++) {
      const f = freq * (k + 1) * (1 + detune * (k % 2 ? 1 : -1));
      v += harm[k] * Math.sin(2 * Math.PI * f * t);
    }
    out[i] += v * amp * e;
  }
}

/** 底鼓：频率下滑的正弦 */
function addKick(out, startSec, amp) {
  const i0 = Math.floor(startSec * SR);
  const dur = 0.28;
  const i1 = Math.min(out.length, i0 + Math.floor(dur * SR));
  let phase = 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const f = 42 + 90 * Math.exp(-t / 0.035);
    phase += (2 * Math.PI * f) / SR;
    const e = Math.exp(-t / 0.10);
    out[i] += Math.sin(phase) * amp * e;
  }
}

/** 军鼓：噪声 + 一点体声 */
function addSnare(out, startSec, amp, seed) {
  const i0 = Math.floor(startSec * SR);
  const dur = 0.18;
  const i1 = Math.min(out.length, i0 + Math.floor(dur * SR));
  let prev = 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const n = noiseAt(i, seed);
    const hp = n - prev * 0.6;
    prev = n;
    const e = Math.exp(-t / 0.055);
    out[i] += (hp * 0.32 + Math.sin(2 * Math.PI * 190 * t) * 0.10) * amp * e;
  }
}

/** 踩镲：极短高频噪声 */
function addHat(out, startSec, amp, seed) {
  const i0 = Math.floor(startSec * SR);
  const dur = 0.06;
  const i1 = Math.min(out.length, i0 + Math.floor(dur * SR));
  let prev = 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const n = noiseAt(i, seed);
    const hp = n - prev * 0.92;
    prev = n;
    out[i] += hp * amp * Math.exp(-t / 0.016);
  }
}

/** ① 夜航：缓慢的七和弦垫 + 钟琴琶音，72 秒 */
function renderAmbient(seconds) {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const chords = [
    [57, 60, 64, 67, 71], // Am9
    [53, 57, 60, 64],     // Fmaj7
    [48, 55, 59, 62],     // Cmaj7
    [55, 59, 62, 66],     // Gmaj7
  ];
  const bar = 9; // 每个和弦 9 秒

  for (let t0 = 0; t0 < seconds; t0 += bar) {
    const ch = chords[Math.floor(t0 / bar) % chords.length];
    // 垫子：三个轻微失谐的正弦，慢起慢收
    for (const m of ch) {
      addTone(out, t0, bar + 1.5, hz(m), 0.052, {
        attack: 1.6, tau: 9, release: 2.2, harm: [1, 0.18, 0.06], detune: 0.0012,
      });
    }
    // 低音：每小节根音
    addTone(out, t0, bar + 1, hz(ch[0] - 24), 0.075, { attack: 0.8, tau: 10, release: 2.0, harm: [1, 0.12] });
    // 钟琴琶音
    for (let k = 0; k < 4; k++) {
      const m = ch[(k * 2 + 1) % ch.length] + 12;
      addTone(out, t0 + k * 2.2, 2.4, hz(m), 0.05, {
        attack: 0.005, tau: 0.55, release: 0.4, harm: [1, 0.35, 0.12, 0.05],
      });
    }
  }

  lowpass(out, 5200);
  delay(out, 0.47, 0.42, 0.45);
  delay(out, 0.73, 0.30, 0.28);
  // 首尾淡入淡出
  const fade = Math.floor(2.5 * SR);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  softclip(out);
  normalize(out, 0.68);
  return out;
}

/** ② 打单节拍：84BPM 的 lo-fi 循环，72 秒 */
function renderLofi(seconds) {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);

  const bpm = 84;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const roots = [45, 41, 36, 43];      // A2 F2 C2 G2
  const chords = [
    [57, 60, 64], // Am
    [53, 57, 60], // F
    [48, 52, 55], // C
    [55, 59, 62], // G
  ];

  const bars = Math.ceil(seconds / bar);
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const root = roots[b % 4];
    const ch = chords[b % 4];

    // 底鼓 1、3 拍
    addKick(out, t0, 0.55);
    addKick(out, t0 + beat * 2, 0.45);
    // 军鼓 2、4 拍
    addSnare(out, t0 + beat, 0.42, 11);
    addSnare(out, t0 + beat * 3, 0.42, 23);
    // 八分踩镲
    for (let k = 0; k < 8; k++) {
      addHat(out, t0 + beat * k * 0.5, k % 2 ? 0.10 : 0.16, 37 + k);
    }
    // 贝斯：每小节两下
    addTone(out, t0, beat * 1.7, hz(root), 0.24, { attack: 0.01, tau: 0.55, release: 0.15, harm: [1, 0.25] });
    addTone(out, t0 + beat * 2, beat * 1.7, hz(root), 0.20, { attack: 0.01, tau: 0.5, release: 0.15, harm: [1, 0.25] });
    // 和弦短音（电钢味）
    for (const m of ch) {
      addTone(out, t0 + beat * 0.5, 1.1, hz(m), 0.055, {
        attack: 0.006, tau: 0.42, release: 0.25, harm: [1, 0.3, 0.08],
      });
      addTone(out, t0 + beat * 2.5, 1.1, hz(m), 0.05, {
        attack: 0.006, tau: 0.40, release: 0.25, harm: [1, 0.28, 0.07],
      });
    }
  }

  lowpass(out, 3800);
  delay(out, beat * 0.75, 0.22, 0.22);
  const fade = Math.floor(1.5 * SR);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  softclip(out);
  normalize(out, 0.72);
  return out;
}

/** Float32 → PCM16 WAV 二进制 */
function toWav(pcm) {
  const n = pcm.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);          // PCM
  b.writeUInt16LE(1, 22);          // 单声道
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);     // byte rate
  b.writeUInt16LE(2, 32);          // block align
  b.writeUInt16LE(16, 34);         // bits
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = clamp(pcm[i], -1, 1);
    b.writeInt16LE(Math.round(s * 32000), 44 + i * 2);
  }
  return b;
}

const BUILTINS = [
  { file: 'builtin-night-ambient.wav', title: '夜航（环境垫）', seconds: 72, kind: 'ambient' },
  { file: 'builtin-lofi-print.wav', title: '打单节拍（Lo-fi）', seconds: 72, kind: 'lofi' },
];

/** 渲染一首并写盘。返回写入字节数。 */
function render(spec, dest) {
  const pcm = spec.kind === 'lofi' ? renderLofi(spec.seconds) : renderAmbient(spec.seconds);
  const buf = toWav(pcm);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

module.exports = { BUILTINS, render, SR };
