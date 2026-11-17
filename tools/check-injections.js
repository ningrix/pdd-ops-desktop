'use strict';
/**
 * 校验 ops.js 里所有"注入页面执行的脚本"语法是否正确。
 *
 * 为什么需要：ops.js 用模板字面量拼 JS 代码字符串，注入到拼多多页面里执行。
 * 一旦拼出来的字符串有语法错误，Electron 只会抛一句
 *   "Script failed to execute, this normally means an error was thrown"
 * —— 具体哪里错完全看不到，排查成本极高。
 *
 * 已经踩过的坑：在模板字面量里写注释，注释里的 \n 变成真实换行，
 * 把注释截断，后半句变成代码 → 整体语法错误。
 *
 * 用法：node tools/check-injections.js
 */
const vm = require('vm');
const path = require('path');

const ops = require(path.resolve(__dirname, '..', 'app', 'lib', 'ops.js'));

const CASES = [
  ['ping', () => (ops.ping ? ops.ping() : null)],
  ['hasSaveButton', () => (ops.hasSaveButton ? ops.hasSaveButton() : null)],
  ['clickSaveDraft', () => (ops.clickSaveDraft ? ops.clickSaveDraft() : null)],
  ['readPageCommit', () => (ops.readPageCommit ? ops.readPageCommit() : null)],
  ['readPageErrors', () => (ops.readPageErrors ? ops.readPageErrors() : null)],
  ['setBatchStock', () => (ops.setBatchStock ? ops.setBatchStock(50) : null)],
  ['setColors', () => (ops.setColors ? ops.setColors(['黑色', '白色', '亚麻色']) : null)],
  ['setSizes', () => (ops.setSizes ? ops.setSizes(['39', '40', '41']) : null)],
  ['scrollToSpec', () => (ops.scrollToSpec ? ops.scrollToSpec() : null)],
  ['readSpecState', () => (ops.readSpecState ? ops.readSpecState() : null)],
  ['listGoods', () => (ops.listGoods ? ops.listGoods(5) : null)],
  ['collectGoods', () => (ops.collectGoods ? ops.collectGoods({ goodsId: 1 }) : null)],
  ['draftDetail', () => (ops.draftDetail ? ops.draftDetail(1) : null)],
  ['submitDraft', () => (ops.submitDraft ? ops.submitDraft(1, 2) : null)],
  ['resolveCommit', () => (ops.resolveCommit ? ops.resolveCommit(1) : null)],
];

let bad = 0;
let checked = 0;

for (const [name, fn] of CASES) {
  let src;
  try {
    src = fn();
  } catch (e) {
    console.log('  SKIP ' + name + '（调用失败：' + e.message + '）');
    continue;
  }
  if (!src) {
    console.log('  SKIP ' + name + '（该函数不存在）');
    continue;
  }
  checked++;
  try {
    new vm.Script(src, { filename: name + '.js' });
    console.log('  OK   ' + name + '  (' + src.length + ' 字符)');
  } catch (e) {
    bad++;
    console.log('  FAIL ' + name + '  ->  ' + e.message);
    // 打印出错行附近，便于定位
    const m = /:(\d+)/.exec(e.stack || '');
    if (m) {
      const ln = Number(m[1]);
      const lines = src.split('\n');
      const from = Math.max(0, ln - 3);
      const to = Math.min(lines.length, ln + 2);
      console.log('       --- 第 ' + ln + ' 行附近 ---');
      for (let i = from; i < to; i++) {
        console.log('       ' + (i + 1) + ' | ' + lines[i]);
      }
    }
  }
}

console.log('');
if (bad) {
  console.log('FAILED: ' + bad + '/' + checked + ' 个注入脚本语法错误');
  process.exit(1);
}
console.log('PASS: ' + checked + ' 个注入脚本语法全部正确');
