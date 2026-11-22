import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildRows, HEADER, COLUMNS } = require('../app/lib/returns-export.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  → ' + (e && e.message)); }
}

const sample = [
  { orderSn: '261111-034959583610022', goodsName: '羽绒服', mallName: '阿泽made',
    stageText: '已完成', signedText: '已签收', returnSn: 'SF123', carrier: '顺丰',
    refundAmount: 25655, done: true },
  { orderSn: '261120-405012529461522', goodsName: '鸭绒马甲', mallName: '阿泽made',
    stageText: '在途', signedText: '未签收', returnSn: '', carrier: '',
    refundAmount: 12800, done: false },
  { orderSn: '261121-000000000000001', goodsName: '测试', mallName: '阿泽高端made',
    stageText: '已完成', signedText: '无退货包裹', returnSn: null, carrier: null,
    refundAmount: null, done: false },
];

ok('表头 9 列且顺序固定', () => {
  assert.deepStrictEqual(HEADER, ['订单号', '商品', '店铺', '状态', '签收情况', '退货单号', '快递', '退款(元)', '是否完成']);
  assert.strictEqual(COLUMNS.length, HEADER.length);
});

ok('行数 = 数据 + 1 表头', () => {
  assert.strictEqual(buildRows(sample).length, 4);
});

ok('已完成写「是」', () => {
  assert.strictEqual(buildRows(sample)[1][8], '是');
});

ok('未完成留空（不是「未完成」）', () => {
  const t = buildRows(sample);
  assert.strictEqual(t[2][8], '');
  assert.strictEqual(t[3][8], '');
});

ok('退款分转元', () => {
  const t = buildRows(sample);
  assert.strictEqual(t[1][7], 256.55);
  assert.strictEqual(t[2][7], 128);
});

ok('退款未知写 null（Excel 空格）', () => {
  assert.strictEqual(buildRows(sample)[3][7], null);
});

ok('订单号保持原始字符串', () => {
  assert.strictEqual(buildRows(sample)[1][0], '261111-034959583610022');
});

ok('null 字段转空串不写 "null"', () => {
  const t = buildRows(sample);
  assert.strictEqual(t[3][5], '');
  assert.strictEqual(t[3][6], '');
});

ok('空输入只有表头', () => {
  assert.strictEqual(buildRows([]).length, 1);
  assert.strictEqual(buildRows(null).length, 1);
});

ok('跳过 null 行', () => {
  assert.strictEqual(buildRows([null, sample[0]]).length, 2);
});

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
