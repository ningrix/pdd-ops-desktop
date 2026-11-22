import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const register = require('../app/ipc/finance-extra.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  → ' + (e && e.message)); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exportdir-'));

/** 造一个只装 pickExportDir 所需上下文的桩 */
function makeCtx({ downloads, home }) {
  const dataDir = path.join(root, 'userdata');
  const ctx = {
    ipcMain: { handle() {} },
    app: {
      getPath(k) {
        if (k === 'downloads') return downloads;
        if (k === 'home') return home;
        throw new Error('unexpected path ' + k);
      },
    },
    fs, path,
    DATA_DIR: dataDir,
    FINANCE_DIR: path.join(dataDir, 'finance'),
    FINANCE_COSTS_FILE: '', FINANCE_PRODUCT_COSTS_FILE: '', FINANCE_FEES_FILE: '',
    FINANCE_RETURNS_FILE: '', FINANCE_TRACES_FILE: '', FINANCE_CARRIER_FILE: '',
    CARRIER_BY_ID: {}, malls: new Map(), currentMall: () => null,
    createHiddenMallWindow: () => null, withPlatform: async (f) => f(),
    sleep: async () => {}, trace: () => {}, writeJsonAtomic: () => {},
    loadCarrierLearned: () => ({}), saveCarrierLearned: () => {},
    carrierOf: () => '', loadReturnTraces: () => ({}), saveReturnTraces: () => {},
    parseReturnTrace: () => null, loadFinanceCosts: () => [], saveFinanceCosts: () => {},
    loadProductCosts: () => [], saveProductCosts: () => [],
    readFinanceFees: () => ({}), saveFinanceFees: () => {}, readFinanceOrders: () => ({}),
    dialog: {}, shell: {}, getMainWindow: () => null,
  };  return { ctx, dataDir, api: register(ctx) };
}

ok('downloads 不可写 → 落到 home/Downloads', () => {
  const bad = path.join(root, 'not-a-dir');
  fs.writeFileSync(bad, 'x');                     // 同名文件 → mkdir 必失败
  const home = path.join(root, 'home1');
  const { api } = makeCtx({ downloads: path.join(bad, 'Downloads'), home });
  const dir = api.pickExportDir();
  assert.strictEqual(dir, path.join(home, 'Downloads'), '实际: ' + dir);
  assert.ok(fs.existsSync(dir));
});

ok('两个 Downloads 都不可写 → 落到 userdata/exports', () => {
  const bad1 = path.join(root, 'nd1'); fs.writeFileSync(bad1, 'x');
  const bad2 = path.join(root, 'nd2'); fs.writeFileSync(bad2, 'x');
  const { api, dataDir } = makeCtx({ downloads: path.join(bad1, 'D'), home: bad2 });
  const dir = api.pickExportDir();
  assert.strictEqual(dir, path.join(dataDir, 'exports'), '实际: ' + dir);
  assert.ok(fs.existsSync(dir));
});

ok('downloads 可写就用 downloads', () => {
  const dl = path.join(root, 'good-downloads');
  const { api } = makeCtx({ downloads: dl, home: path.join(root, 'home2') });
  assert.strictEqual(api.pickExportDir(), dl);
  assert.ok(fs.existsSync(dl));
});

ok('探测后不留 .write_probe 残留', () => {
  const dl = path.join(root, 'clean-downloads');
  const { api } = makeCtx({ downloads: dl, home: path.join(root, 'home3') });
  api.pickExportDir();
  const left = fs.readdirSync(dl).filter((f) => f.includes('write_probe'));
  assert.deepStrictEqual(left, []);
});

fs.rmSync(root, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
