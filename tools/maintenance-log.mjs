#!/usr/bin/env node
'use strict';
/**
 * 维护台账 CLI。
 *
 *   node tools/maintenance-log.mjs add --json '{"date":"...","domain":"..."}'
 *   node tools/maintenance-log.mjs add            # 交互式
 *   node tools/maintenance-log.mjs stats [--since YYYY-MM-DD]
 *
 * 台账格式与字段说明见 maintenance/README.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, '..', 'maintenance', 'log.jsonl');

const DOMAINS = ['upload', 'publish', 'collect', 'cashier', 'orders', 'aftersale', 'login', 'ui', 'tooling'];
const CAUSES = ['platform-change', 'own-bug', 'env', 'unknown'];
const DETECTED = ['manual', 'log', 'user-report', 'test'];

function readAll() {
  if (!fs.existsSync(LOG)) return [];
  const raw = fs.readFileSync(LOG, 'utf8').split('\n');
  const out = [];
  raw.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      out.push(JSON.parse(t));
    } catch (e) {
      console.error('[warn] 第 ' + (i + 1) + ' 行不是合法 JSON，已跳过');
    }
  });
  return out;
}

function validate(e) {
  const errs = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || ''))) errs.push('date 必须是 YYYY-MM-DD');
  if (!DOMAINS.includes(e.domain)) errs.push('domain 必须是 ' + DOMAINS.join('/'));
  if (!e.target) errs.push('target 不能为空（文件 · 函数名/选择器，不写行号）');
  if (!e.symptom) errs.push('symptom 不能为空（写现象，不写猜测）');
  if (!CAUSES.includes(e.cause)) errs.push('cause 必须是 ' + CAUSES.join('/'));
  if (!DETECTED.includes(e.detectedBy)) errs.push('detectedBy 必须是 ' + DETECTED.join('/'));
  if (e.fixMin !== null && e.fixMin !== undefined && !(Number.isFinite(Number(e.fixMin)) && Number(e.fixMin) >= 0)) {
    errs.push('fixMin 必须是非负数字或 null（不知道就填 null，不要估）');
  }
  return errs;
}

function append(entry) {
  const errs = validate(entry);
  if (errs.length) {
    console.error('拒绝写入：');
    errs.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  const norm = {
    date: entry.date,
    domain: entry.domain,
    target: String(entry.target).slice(0, 200),
    symptom: String(entry.symptom).slice(0, 300),
    cause: entry.cause,
    detectedBy: entry.detectedBy,
    fixMin: entry.fixMin == null ? null : Number(entry.fixMin),
    commit: entry.commit || null,
    note: entry.note ? String(entry.note).slice(0, 300) : null,
  };
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(norm) + '\n', 'utf8');
  console.log('已追加：' + norm.date + ' ' + norm.domain + ' · ' + norm.target);
}

async function ask(rl, q, dflt) {
  const a = await new Promise((r) => rl.question(q + (dflt ? ' [' + dflt + ']' : '') + '：', r));
  const v = String(a || '').trim();
  return v || dflt || '';
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const e = {};
    e.date = await ask(rl, '日期 YYYY-MM-DD', today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate()));
    e.domain = await ask(rl, '域 ' + DOMAINS.join('/'));
    e.target = await ask(rl, '定位（文件 · 函数名/选择器）');
    e.symptom = await ask(rl, '现象（一句话，写看到的）');
    e.cause = await ask(rl, '根因 ' + CAUSES.join('/'), 'unknown');
    e.detectedBy = await ask(rl, '怎么发现 ' + DETECTED.join('/'), 'manual');
    e.fixMin = await ask(rl, '修复耗时（分钟，不知道留空）', '');
    e.commit = await ask(rl, '修复提交（短 sha，可空）', '');
    e.note = await ask(rl, '备注（可空）', '');
    append(e);
  } finally {
    rl.close();
  }
}

function days(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

function stats(since) {
  let rows = readAll();
  if (since) rows = rows.filter((r) => r.date >= since);
  if (!rows.length) {
    console.log('台账里没有记录' + (since ? '（since ' + since + '）' : '') + '。');
    console.log('先记几条：node tools/maintenance-log.mjs add');
    return;
  }
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const by = (k) => {
    const m = new Map();
    for (const r of rows) m.set(r[k], (m.get(r[k]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  console.log('总条数: ' + rows.length + (since ? '（since ' + since + '）' : '') + '　' +
              rows[0].date + ' → ' + rows[rows.length - 1].date);
  console.log('\n按域:');
  for (const [k, v] of by('domain')) console.log('  ' + String(k).padEnd(12) + v);
  console.log('\n按根因:');
  for (const [k, v] of by('cause')) console.log('  ' + String(k).padEnd(18) + v);

  const plat = rows.filter((r) => r.cause === 'platform-change');
  if (plat.length >= 2) {
    const gaps = [];
    for (let i = 1; i < plat.length; i++) gaps.push(days(plat[i - 1].date, plat[i].date));
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log('\n平台改版导致的失效间隔:');
    console.log('  次数 ' + plat.length + '，间隔 ' + gaps.join(' / ') + ' 天，平均 ' + avg.toFixed(1) + ' 天');
    if (plat.length < 10) console.log('  ⚠ 样本 ' + plat.length + ' 条 < 10，间隔还不能当频率引用');
  } else {
    console.log('\n平台改版导致的失效: ' + plat.length + ' 条 —— 不足 2 条，算不出间隔');
  }

  const fixed = rows.filter((r) => r.fixMin != null);
  if (fixed.length) {
    const arr = fixed.map((r) => Number(r.fixMin)).sort((a, b) => a - b);
    const med = arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
    console.log('\n修复耗时（' + fixed.length + '/' + rows.length + ' 条有数据）:');
    console.log('  中位 ' + med + ' 分钟，最快 ' + arr[0] + '，最慢 ' + arr[arr.length - 1]);
  } else {
    console.log('\n修复耗时: 全部为 null，无数据');
  }

  console.log('\n最脆的三个域:');
  by('domain').slice(0, 3).forEach(([k, v], i) => console.log('  ' + (i + 1) + '. ' + k + '（' + v + ' 次）'));

  if (rows.length < 10) {
    console.log('\n⚠ 台账仅 ' + rows.length + ' 条。少于 10 条只能看个案，不能算频率。');
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'add') {
    const i = rest.indexOf('--json');
    if (i >= 0 && rest[i + 1]) {
      let e;
      try {
        e = JSON.parse(rest[i + 1]);
      } catch (err) {
        console.error('--json 不是合法 JSON：' + err.message);
        process.exit(1);
      }
      append(e);
    } else {
      interactive();
    }
    return;
  }
  if (cmd === 'stats') {
    const i = rest.indexOf('--since');
    stats(i >= 0 ? rest[i + 1] : null);
    return;
  }
  console.log('用法:');
  console.log('  node tools/maintenance-log.mjs add [--json \'{...}\']');
  console.log('  node tools/maintenance-log.mjs stats [--since YYYY-MM-DD]');
}

main();
