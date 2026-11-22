'use strict';
/**
 * 极简 XLSX 生成器 —— 零依赖，把二维数组写成单表 .xlsx。
 *
 * 为什么不用 CSV：订单号是 18 位长数字，CSV 用 Excel 打开会被转成科学计数法
 * （261111034959583610022 → 2.61111E+20），对账就没法用了。xlsx 里按文本存
 * 才能保住原样。另外中文 CSV 还要处理 BOM 与编码，反而更麻烦。
 *
 * 实现方式：xlsx 就是一个 zip，里面几个固定 XML。这里只实现「不压缩」的 zip
 * （method=0），省掉 deflate 依赖，文件大一点但几十行数据无所谓。
 *
 * 用法：
 *   const xlsx = require('./lib/xlsx');
 *   const buf = xlsx.build({ sheetName: '退货', columns: [{w:18},{w:40}], rows: [[...], ...] });
 *   fs.writeFileSync(file, buf);
 *
 * 单元格规则：
 *   - string  → 文本（inlineStr，不做转义猜测）
 *   - number  → 数字
 *   - null / undefined / '' → 空单元格
 *   - 第一行自动加粗（表头）
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/** 列序号 0 → A, 25 → Z, 26 → AA */
function colName(n) {
  let s = '';
  let x = n;
  for (;;) {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
    if (x < 0) break;
  }
  return s;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 不允许的控制字符，直接去掉，否则 Excel 打不开
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function cellXml(ref, value, styleIdx) {
  const st = styleIdx ? ' s="' + styleIdx + '"' : '';
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return '<c r="' + ref + '"' + st + '><v>' + value + '</v></c>';
  }
  return '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">'
    + xmlEscape(value) + '</t></is></c>';
}

function sheetXml(rows, columns, freezeHeader) {
  const cols = (columns || []).map((c, i) =>
    '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.w || 12) + '" customWidth="1"/>'
  ).join('');

  const body = rows.map((row, ri) => {
    const cells = row.map((v, ci) => cellXml(colName(ci) + (ri + 1), v, ri === 0 ? 1 : (typeof v === 'number' ? 2 : 0))).join('');
    return '<row r="' + (ri + 1) + '">' + cells + '</row>';
  }).join('');

  const view = freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + view
    + (cols ? '<cols>' + cols + '</cols>' : '')
    + '<sheetData>' + body + '</sheetData>'
    + '</worksheet>';
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

function workbookXml(sheetName) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="' + xmlEscape(sheetName || 'Sheet1') + '" sheetId="1" r:id="rId1"/></sheets>'
    + '</workbook>';
}

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

// cellXfs: 0 = 常规，1 = 表头加粗，2 = 数字两位小数
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2">'
  + '<font><sz val="11"/><name val="等线"/></font>'
  + '<font><b/><sz val="11"/><name val="等线"/></font>'
  + '</fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** 打一个 zip 包（store，不压缩） */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  // 固定时间戳：1980-01-01 00:00，保证同样内容生成同样字节
  const dosTime = 0;
  const dosDate = 0x0021; // 1980-01-01

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const dataBuf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    local.writeUInt16LE(0, 8);        // method 0 = store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, dataBuf);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(dataBuf.length, 20);
    cen.writeUInt32LE(dataBuf.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  }

  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(chunks), cenBuf, end]);
}

/**
 * @param {{sheetName?:string, columns?:{w:number}[], rows:any[][], freezeHeader?:boolean}} opts
 * @returns {Buffer} xlsx 文件内容
 */
function build(opts) {
  const o = opts || {};
  const rows = o.rows || [];
  const files = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbookXml(o.sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows, o.columns, o.freezeHeader !== false) },
  ];
  return zipStore(files);
}

module.exports = { build, crc32, colName };
