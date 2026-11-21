// test-atomic-write.mjs —— Z-1 断言（纯 Node，不碰应用）
// ① 写入后文件存在且能 JSON.parse ② 目录无 .tmp 残留 ③ 连续 100 次不报错不残留
// 另附源码级断言：app/main.js 里 helper 存在、任务书点名的 4 个保存函数确实走它。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name + ' :: ' + (e && e.message)]);
  }
}

// 与 app/main.js 的 writeJsonAtomic 逐行同构（源码级对照见文末）
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-atomic-'));
const file = path.join(dir, 'a', 'b', 'out.json');   // 故意带上未创建的子目录，验证 mkdirSync

check('① 写入后文件存在且能 JSON.parse', () => {
  writeJsonAtomic(file, { hello: '世界', n: 1 });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.hello !== '世界' || parsed.n !== 1) throw new Error('内容不一致');
});

check('② 写完后目录里没有残留 .tmp', () => {
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
  if (leftovers.length) throw new Error('残留: ' + leftovers.join(','));
});

check('③ 连续写 100 次不报错、不残留', () => {
  for (let i = 0; i < 100; i++) writeJsonAtomic(file, { i });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.i !== 99) throw new Error('第 100 次内容不对');
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
  if (leftovers.length) throw new Error('残留: ' + leftovers.join(','));
});

// —— 源码级断言： shipped 代码确实在用这个模式 ——
const SRC = fs.readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
check('④ main.js 定义了 writeJsonAtomic（含 mkdirSync）', () => {
  if (!/function writeJsonAtomic\(file, obj\)/.test(SRC)) throw new Error('helper 未找到');
  if (!/fs\.mkdirSync\(path\.dirname\(file\), \{ recursive: true \}\)/.test(SRC)) throw new Error('缺 mkdirSync');
});
for (const fn of ['saveMalls', 'saveFinanceFees', 'saveProductCosts', 'saveFinanceOrders']) {
  check('⑤ ' + fn + ' 走 writeJsonAtomic', () => {
    const body = SRC.slice(SRC.indexOf('function ' + fn + '('));
    const seg = body.slice(0, body.indexOf('\n}', body.indexOf('writeJsonAtomic')) >= 0 ? undefined : 0);
    const within = body.slice(0, body.indexOf('\n}') + 2);
    if (!within.includes('writeJsonAtomic(')) throw new Error(fn + ' 未调用原子写');
  });
}

let pass = 0;
for (const [st, name] of results) {
  console.log(st, name);
  if (st === 'PASS') pass++;
}
console.log(`PASS ${pass}/${results.length}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);
