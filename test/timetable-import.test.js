import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTimetableWorkbook, parseTimetableWorkbook, courseImportKey } from '../src/timetable-import.js';
import { WorkspaceStore } from '../src/store.js';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    local.push(header, nameBuffer, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBuffer);
    offset += header.length + nameBuffer.length + data.length;
  }
  const localBuffer = Buffer.concat(local);
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localBuffer.length, 16);
  return Buffer.concat([localBuffer, centralBuffer, end]);
}

function inlineCell(ref, value) {
  const escaped = String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<c r="${ref}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
}

function tabularWorkbook() {
  const headers = ['课程名称', '星期', '节次', '周次', '地点', '教师'];
  const rows = [
    ['线性代数', '星期一', '第1-2节', '1-17周', '教学楼101', '王老师'],
    ['数据结构', '3', '3-4', '1,3-9', '南区教室', '李老师'],
    ['学术写作', '周五', '5', '', '线上', '']
  ];
  const rowXml = [
    `<row r="1">${headers.map((value, index) => inlineCell(`${String.fromCharCode(65 + index)}1`, value)).join('')}</row>`,
    ...rows.map((row, rowIndex) => `<row r="${rowIndex + 2}">${row.map((value, index) => value === '' ? '' : inlineCell(`${String.fromCharCode(65 + index)}${rowIndex + 2}`, value)).join('')}</row>`)
  ].join('');
  return storedZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="课程清单" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`
  });
}

test('通用课表解析器可以从 XLSX 网格识别学期、节次、周次和地点', async () => {
  const workbook = await readFile(join(process.cwd(), '我的课表.xlsx'));
  const result = parseTimetableWorkbook(workbook);

  assert.equal(result.semesterName, '2026-2027 学年第1学期');
  assert.equal(result.totalWeeks, 17);
  assert.equal(result.arrangements.length, 20);
  assert.deepEqual(result.arrangements.find(item => item.name === '数据挖掘' && item.weekday === 1), {
    name: '数据挖掘', weekday: 1, startPeriod: 7, endPeriod: 8,
    startWeek: 2, endWeek: 9, weekPattern: 'every', customWeeks: '',
    location: '前卫-敬信教学楼-F区第一阶梯', teacher: '', notes: ''
  });
  assert.deepEqual(result.arrangements.find(item => item.name === '网页设计与网站建设'), {
    name: '网页设计与网站建设', weekday: 7, startPeriod: 1, endPeriod: 4,
    startWeek: 1, endWeek: 9, weekPattern: 'custom', customWeeks: '1,3-9',
    location: '软件综合实验室3A310', teacher: '', notes: ''
  });
});

test('同一份 XLSX 可以重复导入到同一学期且不会重复创建课程', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-import-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workbook = await readFile(join(process.cwd(), '我的课表.xlsx'));

  const first = importTimetableWorkbook(store, workbook, { startsOn: '2026-09-07', totalWeeks: 17, sourceName: '我的课表.xlsx' });
  const second = importTimetableWorkbook(store, workbook, { semesterId: first.semester.id, startsOn: '2026-09-07', totalWeeks: 17, makeCurrent: true, sourceName: '我的课表.xlsx' });

  assert.equal(first.importedCount, 20);
  assert.equal(first.skippedCount, 0);
  assert.equal(second.importedCount, 0);
  assert.equal(second.skippedCount, 20);
  assert.equal(store.list('courses').filter(item => item.semesterId === first.semester.id).length, 20);
});

test('解析器也能识别常见的行式课程清单，并将展示性校区前缀视为同一地点', () => {
  const result = parseTimetableWorkbook(tabularWorkbook(), { sourceName: '课程清单.xlsx', totalWeeks: 17 });

  assert.equal(result.arrangements.length, 3);
  assert.deepEqual(result.arrangements.find(item => item.name === '线性代数'), {
    name: '线性代数', weekday: 1, startPeriod: 1, endPeriod: 2,
    startWeek: 1, endWeek: 17, weekPattern: 'every', customWeeks: '',
    location: '教学楼101', teacher: '王老师', notes: ''
  });
  assert.deepEqual(result.arrangements.find(item => item.name === '数据结构'), {
    name: '数据结构', weekday: 3, startPeriod: 3, endPeriod: 4,
    startWeek: 1, endWeek: 9, weekPattern: 'custom', customWeeks: '1,3-9',
    location: '南区教室', teacher: '李老师', notes: ''
  });
  assert.equal(courseImportKey({ name: '线性代数', weekday: 1, startPeriod: 1, endPeriod: 2, startWeek: 1, endWeek: 17, weekPattern: 'every', location: '前卫-教学楼101', teacher: '王老师' }), courseImportKey({ name: '线性代数', weekday: 1, startPeriod: 1, endPeriod: 2, startWeek: 1, endWeek: 17, weekPattern: 'every', location: '教学楼101', teacher: '王老师' }));
});
