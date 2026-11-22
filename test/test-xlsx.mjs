import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const xlsx = require('../app/lib/xlsx.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

// 1) 基础工具
ok('crc32 已知值', xlsx.crc32(Buffer.from('123456789')) === 0xCBF43926);
ok('列名 A/Z/AA', xlsx.colName(0) === 'A' && xlsx.colName(25) === 'Z' && xlsx.colName(26) === 'AA');

// 2) 生成一个真实文件
const rows = [
  ['订单号', '商品', '店铺', '状态', '签收情况', '退货单号', '快递', '退款(元)', '是否完成'],
  ['261111-034959583610022', '羽绒服 A&B <test>', '阿泽made', '已完成', '已签收', 'SF1234567890', '顺丰', 256.55, '是'],
  ['261120-405012529461522', '鸭绒马甲', '阿泽made', '在途', '未签收', '', '', 128.0, ''],
  ['261121-000000000000001', '测试商品', '阿泽made', '在途', '未签收', '', '', 88.0, ''],
];
const buf = xlsx.build({
  sheetName: '退货跟进',
  columns: [{ w: 24 }, { w: 40 }, { w: 12 }, { w: 10 }, { w: 12 }, { w: 20 }, { w: 10 }, { w: 10 }, { w: 10 }],
  rows,
});
const tmp = path.join(os.tmpdir(), 'xlsx-selftest.xlsx');
fs.writeFileSync(tmp, buf);
ok('文件已写出', fs.existsSync(tmp) && fs.statSync(tmp).size > 1000, 'size=' + buf.length);
ok('zip 魔数 PK', buf[0] === 0x50 && buf[1] === 0x4B);

// 3) 用 openpyxl 读回
const py = `
import sys
try:
    from openpyxl import load_workbook
except Exception as e:
    print('SKIP', e); sys.exit(0)
wb = load_workbook(sys.argv[1])
ws = wb.active
print('SHEET', ws.title)
print('DIM', ws.max_row, ws.max_column)
for row in ws.iter_rows(min_row=1, max_row=ws.max_row, values_only=True):
    print('ROW', '|'.join('' if v is None else str(v) for v in row))
`;
const r = spawnSync('python', ['-c', py, tmp], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
});
const out = (r.stdout || '').trim();
if (/SKIP/.test(out)) {
  console.log('SKIP  openpyxl 不可用，跳过读回验证');
} else {
  ok('openpyxl 打开成功', out.includes('SHEET 退货跟进'), out.slice(0, 120));
  ok('行列数正确', out.includes('DIM 4 9'), (out.match(/DIM[^\n]*/) || [])[0]);
  ok('订单号保持文本', out.includes('261111-034959583610022'));
  ok('长单号未被科学计数', !/E\+/.test(out));
  ok('退款是数字', out.includes('256.55'));
  // Windows 下子进程 stdout 是 CRLF，先剥掉 \r 再比对
  const line120 = (out.split('\n').find((l) => l.includes('261120')) || '').replace(/\r$/, '');
  ok('未完成导出为空', line120.endsWith('128|'), line120);
  ok('特殊字符被转义', out.includes('羽绒服 A&B <test>'));
}

// 4) 空表也能生成
const emptyBuf = xlsx.build({ sheetName: 'X', rows: [['A', 'B']] });
ok('空数据表可生成', emptyBuf.length > 500);

fs.unlinkSync(tmp);
console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
