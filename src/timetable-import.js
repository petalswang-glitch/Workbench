import { zipReader } from './zip-reader.js';

const XLSX_MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MAX_TOTAL_XML_BYTES = 50 * 1024 * 1024;

function decodeXml(value = '') {
  return String(value).replace(/&#x([0-9a-f]+);|&#([0-9]+);|&([a-z]+);/gi, (whole, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number(decimal));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()] || whole;
  });
}

function xmlAttributes(tag = '') {
  const result = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  return result;
}

function xmlText(fragment = '') {
  return decodeXml([...String(fragment).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => match[1]).join(''));
}

function resolveZipPath(base, target) {
  const parts = `${base}/${target}`.replaceAll('\\', '/').split('/');
  const result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return result.join('/');
}

function parseCellRef(ref = '') {
  const match = String(ref).match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  let column = 0;
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function cellRef(row, column) {
  let value = '';
  let remaining = column;
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    value = String.fromCharCode(65 + digit) + value;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return `${value}${row}`;
}

function parseRange(ref = '') {
  const [startRef, endRef = startRef] = String(ref).split(':');
  const start = parseCellRef(startRef);
  const end = parseCellRef(endRef);
  if (!start || !end) return null;
  return { startRow: Math.min(start.row, end.row), endRow: Math.max(start.row, end.row), startColumn: Math.min(start.column, end.column), endColumn: Math.max(start.column, end.column) };
}

function parseWorkbookSheet(zip) {
  const workbook = zip.read('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new Error('XLSX 缺少工作簿目录');
  const relationships = zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relationshipMap = new Map();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*?)\/?>(?:<\/Relationship>)?/g)) {
    const attrs = xmlAttributes(match[1]);
    if (attrs.Id && attrs.Target) relationshipMap.set(attrs.Id, attrs.Target);
  }
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/?>(?:<\/sheet>)?/g)].map(match => xmlAttributes(match[1]));
  const sheet = sheets.find(item => !['hidden', 'veryHidden'].includes(item.state)) || sheets[0];
  if (!sheet) throw new Error('XLSX 没有可读的工作表');
  const target = relationshipMap.get(sheet['r:id']) || 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : resolveZipPath('xl', target);
  const xml = zip.read(sheetPath)?.toString('utf8');
  if (!xml) throw new Error('XLSX 工作表内容缺失');
  return { name: sheet.name || 'sheet1', xml };
}

function parseSharedStrings(zip) {
  const xml = zip.read('xl/sharedStrings.xml')?.toString('utf8');
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => xmlText(match[1]));
}

function parseCells(xml, sharedStrings) {
  const cells = [];
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = xmlAttributes(match[1]);
    const location = parseCellRef(attrs.r);
    if (!location) continue;
    const body = match[2] || '';
    const valueMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
    let value = valueMatch ? decodeXml(valueMatch[1]) : '';
    if (attrs.t === 's' && /^\d+$/.test(value)) value = sharedStrings[Number(value)] ?? '';
    else if (attrs.t === 'inlineStr') value = xmlText(body);
    else if (attrs.t === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
    cells.push({ ref: attrs.r, row: location.row, column: location.column, value: String(value ?? '').trim(), style: attrs.s || '' });
  }
  return cells;
}

function normalizeWhitespace(value = '') {
  return String(value).replace(/[\u0000\u200b\ufeff]/g, '').replaceAll('\u3000', ' ').replace(/[ \t]+/g, ' ').trim();
}

function parseWeekday(value = '') {
  const match = normalizeWhitespace(value).match(/(?:星期|周)\s*([一二三四五六日天1-7])/u);
  if (!match) return null;
  if (/\d/.test(match[1])) return Number(match[1]);
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }[match[1]] || null;
}

function parseTabularWeekday(value = '') {
  const explicit = parseWeekday(value);
  if (explicit) return explicit;
  const text = normalizeWhitespace(value).replace(/^(?:星期|周|礼拜)\s*/u, '');
  if (/^[1-7]$/.test(text)) return Number(text);
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }[text] || null;
}

function periodRangeIn(value = '') {
  const text = normalizeWhitespace(value);
  const patterns = [
    /(?:第\s*)?(\d{1,2})\s*节?\s*[-—~～至到]\s*(?:第\s*)?(\d{1,2})\s*节/u,
    /(?:第\s*)?(\d{1,2})\s*节/u
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return { start: Number(match[1]), end: Number(match[2] || match[1]), index: match.index, length: match[0].length };
  }
  const plain = text.match(/^\s*(\d{1,2})\s*(?:[-—~～至到]\s*(\d{1,2}))?\s*$/u);
  return plain ? { start: Number(plain[1]), end: Number(plain[2] || plain[1]), index: plain.index, length: plain[0].length } : null;
}

function weekInfoIn(value = '') {
  const text = normalizeWhitespace(value);
  const dayMatch = text.match(/(?:星期|周)\s*[一二三四五六日天1-7]/u);
  const beforeDay = dayMatch ? text.slice(0, dayMatch.index) : text;
  const matches = [...beforeDay.matchAll(/(?:第\s*)?(\d{1,3})\s*(?:[-—~～至到]\s*(?:第\s*)?(\d{1,3})\s*)?周/g)];
  const ranges = matches.map(match => ({ start: Number(match[1]), end: Number(match[2] || match[1]) })).filter(range => range.start > 0 && range.end >= range.start);
  return ranges.length ? { ranges, index: matches[0].index, text: matches.map(match => match[0]).join(',') } : null;
}

function expandRanges(ranges = []) {
  const weeks = new Set();
  for (const range of ranges) for (let week = range.start; week <= range.end; week += 1) weeks.add(week);
  return [...weeks].sort((a, b) => a - b);
}

function formatWeekSet(weeks = []) {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  const ranges = [];
  for (const week of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous[1] === week - 1) previous[1] = week;
    else ranges.push([week, week]);
  }
  return ranges.map(([start, end]) => start === end ? String(start) : `${start}-${end}`).join(',');
}

function normalizeWeekPattern(text, ranges) {
  if (/(?:单周|奇数周|odd)/i.test(text)) return { weekPattern: 'odd', customWeeks: '' };
  if (/(?:双周|偶数周|even)/i.test(text)) return { weekPattern: 'even', customWeeks: '' };
  const weeks = expandRanges(ranges);
  const start = weeks[0];
  const end = weeks[weeks.length - 1];
  return weeks.length === end - start + 1 ? { weekPattern: 'every', customWeeks: '' } : { weekPattern: 'custom', customWeeks: formatWeekSet(weeks) };
}

function cleanCourseName(value = '') {
  let text = normalizeWhitespace(value);
  text = text.replace(/^(?:课程名称|课程名|课程|名称)\s*[:：]\s*/u, '');
  text = text.replace(/^[A-Za-z0-9][A-Za-z0-9_-]{3,}\s*[-—]\s*/u, '');
  text = text.replace(/\s*[\[\(（]\s*\d{1,3}\s*[\]\)）]\s*$/u, '');
  return text.replace(/^[,，;；:：\-—\s]+|[,，;；:：\-—\s]+$/gu, '').trim();
}

function locationAfterPeriod(line, period) {
  if (!period) return '';
  let value = normalizeWhitespace(line.slice(period.index + period.length));
  value = value.replace(/^[,，;；\s]+/u, '');
  value = value.replace(/^(?:前半|后半|整节|全程|上午|下午)\s*[-—:：]\s*/u, '');
  value = value.replace(/^[-—:：]\s*/u, '').replace(/[,，;；]+$/u, '').trim();
  return /^(?:无|暂无|未设置|未填写)$/u.test(value) ? '' : value;
}

function labeledValue(text, labels) {
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[:：]\\s*([^,，;；\\n]+)`, 'u');
  return normalizeWhitespace(text.match(pattern)?.[1] || '');
}

function ignorableLine(value) {
  const text = normalizeWhitespace(value);
  return !text || /^(?:无|暂无|空|—|-|时间|星期|课程表|我的课表)$/u.test(text);
}

function parseCellRecords(value, fallbackPeriod, defaultWeeks) {
  const lines = String(value).replaceAll('\r', '').split('\n').map(normalizeWhitespace).filter(Boolean);
  const records = [];
  let pendingName = '';
  for (const line of lines) {
    const weekday = parseWeekday(line);
    const weeks = weekInfoIn(line);
    const period = periodRangeIn(line) || fallbackPeriod;
    if (weekday && weeks && period) {
      const nameFromPrefix = cleanCourseName(line.slice(0, weeks.index));
      const name = nameFromPrefix || cleanCourseName(pendingName);
      if (name && period.start >= 1 && period.end >= period.start) {
        const pattern = normalizeWeekPattern(line, weeks.ranges);
        records.push({ name, weekday, startPeriod: period.start, endPeriod: period.end, startWeek: Math.min(...expandRanges(weeks.ranges)), endWeek: Math.max(...expandRanges(weeks.ranges)), ...pattern, location: locationAfterPeriod(line, period), teacher: labeledValue(line, ['教师', '老师', '任课教师']), notes: '', weeksInferred: false });
      }
      pendingName = '';
      continue;
    }
    if (!ignorableLine(line)) pendingName = line;
  }
  if (!records.length && fallbackPeriod) {
    const nameLine = lines.find(line => !ignorableLine(line) && !parseWeekday(line) && !periodRangeIn(line));
    const name = cleanCourseName(nameLine || '');
    if (name) records.push({ name, weekday: null, startPeriod: fallbackPeriod.start, endPeriod: fallbackPeriod.end, startWeek: 1, endWeek: defaultWeeks, weekPattern: 'every', customWeeks: '', location: labeledValue(lines.join('\n'), ['地点', '教室', '上课地点']), teacher: labeledValue(lines.join('\n'), ['教师', '老师', '任课教师']), notes: '', weeksInferred: true });
  }
  return records;
}

const TABULAR_FIELD_ALIASES = Object.freeze({
  name: ['课程名称', '课程名', '课程标题', '科目', '课程', 'course name', 'course'],
  weekday: ['上课星期', '上课日', '周几', '星期', 'weekday'],
  period: ['上课节次', '上课时段', '节次', '课时', 'period'],
  weeks: ['上课周次', '教学周', '周次', '周数', 'weeks'],
  location: ['上课地点', '上课教室', '地点', '教室', 'location', 'room'],
  teacher: ['任课教师', '授课教师', '教师', '老师', 'teacher'],
  notes: ['备注', '说明', 'notes']
});

function tabularField(value = '') {
  const text = normalizeWhitespace(value).toLocaleLowerCase('zh-CN');
  for (const [field, aliases] of Object.entries(TABULAR_FIELD_ALIASES)) {
    if (aliases.some(alias => text === alias || text.startsWith(`${alias} `) || text.startsWith(`${alias}（`) || text.startsWith(`${alias}(`))) return field;
  }
  return null;
}

function findTabularHeader(cells) {
  const byRow = new Map();
  for (const cell of cells) {
    const field = tabularField(cell.value);
    if (!field) continue;
    if (!byRow.has(cell.row)) byRow.set(cell.row, new Map());
    const fields = byRow.get(cell.row);
    if (!fields.has(field)) fields.set(field, cell.column);
  }
  const required = ['name', 'weekday', 'period'];
  const candidate = [...byRow.entries()]
    .filter(([, fields]) => required.every(field => fields.has(field)))
    .sort((a, b) => b[1].size - a[1].size || a[0] - b[0])[0];
  return candidate ? { row: candidate[0], columns: candidate[1] } : null;
}

function tabularWeekRanges(value = '') {
  const text = normalizeWhitespace(value);
  if (!text) return [];
  const cleaned = text
    .replace(/[第]/gu, '')
    .replace(/(?:教学周|周次|周)/gu, '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .trim();
  return cleaned.split(/[,，、;；\s]+/u).map(token => {
    const match = token.match(/^(\d{1,3})\s*(?:[-—~～至到]\s*(\d{1,3}))?$/u);
    return match ? { start: Number(match[1]), end: Number(match[2] || match[1]) } : null;
  }).filter(range => range && range.start > 0 && range.end >= range.start);
}

function tabularFieldValue(row, columns, field) {
  const column = columns.get(field);
  return column ? row.get(column)?.value || '' : '';
}

function stripFieldLabel(value, labels) {
  const text = normalizeWhitespace(value);
  if (!text) return '';
  return text.replace(new RegExp(`^(?:${labels.join('|')})\\s*[:：]\\s*`, 'iu'), '').trim();
}

function parseTabularRows(cells, header) {
  const rows = new Map();
  for (const cell of cells) {
    if (cell.row <= header.row) continue;
    if (!rows.has(cell.row)) rows.set(cell.row, new Map());
    rows.get(cell.row).set(cell.column, cell);
  }
  const records = [];
  for (const row of rows.values()) {
    const name = cleanCourseName(tabularFieldValue(row, header.columns, 'name'));
    const weekday = parseTabularWeekday(tabularFieldValue(row, header.columns, 'weekday'));
    const period = periodRangeIn(tabularFieldValue(row, header.columns, 'period'));
    if (!name || !weekday || !period || period.start < 1 || period.end < period.start) continue;
    const weekText = tabularFieldValue(row, header.columns, 'weeks');
    const ranges = tabularWeekRanges(weekText);
    const weeks = expandRanges(ranges);
    const pattern = ranges.length ? normalizeWeekPattern(weekText, ranges) : { weekPattern: /(?:单周|奇数周|odd)/iu.test(weekText) ? 'odd' : /(?:双周|偶数周|even)/iu.test(weekText) ? 'even' : 'every', customWeeks: '' };
    records.push({
      name,
      weekday,
      startPeriod: period.start,
      endPeriod: period.end,
      startWeek: weeks[0] || 1,
      endWeek: weeks[weeks.length - 1] || 0,
      ...pattern,
      location: stripFieldLabel(tabularFieldValue(row, header.columns, 'location'), TABULAR_FIELD_ALIASES.location),
      teacher: stripFieldLabel(tabularFieldValue(row, header.columns, 'teacher'), TABULAR_FIELD_ALIASES.teacher),
      notes: stripFieldLabel(tabularFieldValue(row, header.columns, 'notes'), TABULAR_FIELD_ALIASES.notes),
      weeksInferred: !weeks.length
    });
  }
  return records;
}

function mergedRangeFor(cell, merges) {
  return merges.find(range => cell.row >= range.startRow && cell.row <= range.endRow && cell.column >= range.startColumn && cell.column <= range.endColumn) || null;
}

function parseSemesterName(text, sourceName = '') {
  const compact = normalizeWhitespace(text).replace(/\s+/g, ' ');
  const match = compact.match(/\d{4}\s*[-－—]\s*\d{4}\s*学年\s*(?:第\s*[0-9一二三四]\s*学期|[上下]学期)/u);
  if (match) return match[0].replace(/\s*[-－—]\s*/u, '-').replace(/\s+/g, ' ').replace(/(\d{4}-\d{4})\s*学年/u, '$1 学年');
  const source = normalizeWhitespace(sourceName).replace(/\.[^.]+$/u, '');
  return source ? `${source}导入` : '新导入学期';
}

function inferTotalWeeks(text, arrangements, requested) {
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') return Number(requested);
  const explicitMax = arrangements.reduce((max, item) => item.weeksInferred ? max : Math.max(max, item.endWeek), 0);
  if (explicitMax) return explicitMax;
  const titleMatch = normalizeWhitespace(text).match(/(?:共|总计|总共|总周数)\s*(\d{1,2})\s*周/u);
  return titleMatch ? Number(titleMatch[1]) : 18;
}

function itemValue(item, camel, snake) {
  return item?.[camel] ?? item?.[snake] ?? '';
}

function parseWeekList(value = '') {
  return expandRanges([...String(value).matchAll(/(\d{1,3})\s*(?:[-—~～至到]\s*(\d{1,3}))?/g)].map(match => ({ start: Number(match[1]), end: Number(match[2] || match[1]) })).filter(range => range.start > 0 && range.end >= range.start));
}

function weeksForItem(item) {
  const pattern = itemValue(item, 'weekPattern', 'week_pattern') || 'every';
  if (pattern === 'custom') return parseWeekList(itemValue(item, 'customWeeks', 'custom_weeks'));
  const start = Number(itemValue(item, 'startWeek', 'start_week'));
  const end = Number(itemValue(item, 'endWeek', 'end_week'));
  return Number.isInteger(start) && Number.isInteger(end) && end >= start ? Array.from({ length: end - start + 1 }, (_, index) => start + index) : [];
}

function locationKey(value) {
  const text = normalizeWhitespace(value).toLocaleLowerCase('zh-CN');
  // Some campus exports prefix every building with a campus name while older
  // records omit that presentation-only segment. Keep the displayed source
  // value, but treat a building-like suffix as the same import location.
  return text.replace(/^[^,，;；\-—]{1,8}[-—](?=.*(?:楼|实验室|阶梯|教室|校区|区\b|[A-Z]\d{2,}))/u, '');
}

function mergeCourseRanges(items) {
  const groups = new Map();
  for (const item of items) {
    const pattern = item.weekPattern === 'odd' || item.weekPattern === 'even' ? item.weekPattern : 'flexible';
    const signature = JSON.stringify([normalizeWhitespace(item.name), item.weekday, item.startPeriod, item.endPeriod, locationKey(item.location), normalizeWhitespace(item.teacher), pattern]);
    if (!groups.has(signature)) groups.set(signature, { ...item, _weeks: new Set() });
    for (const week of weeksForItem(item)) groups.get(signature)._weeks.add(week);
  }
  return [...groups.values()].map(item => {
    const weeks = [...item._weeks].sort((a, b) => a - b);
    const contiguous = weeks.length > 0 && weeks[weeks.length - 1] - weeks[0] + 1 === weeks.length;
    const weekPattern = item.weekPattern === 'odd' || item.weekPattern === 'even' ? item.weekPattern : contiguous ? 'every' : 'custom';
    const result = { ...item, startWeek: weeks[0] ?? item.startWeek, endWeek: weeks[weeks.length - 1] ?? item.endWeek, weekPattern, customWeeks: weekPattern === 'custom' ? formatWeekSet(weeks) : '' };
    delete result._weeks;
    return result;
  });
}

export function courseImportKey(item) {
  const pattern = itemValue(item, 'weekPattern', 'week_pattern') || 'every';
  const custom = String(itemValue(item, 'customWeeks', 'custom_weeks') || '');
  const customWeeks = pattern === 'custom' ? formatWeekSet(parseWeekList(custom)) : '';
  return JSON.stringify([
    normalizeWhitespace(itemValue(item, 'name', 'name')).toLocaleLowerCase('zh-CN'),
    Number(itemValue(item, 'weekday', 'weekday')),
    Number(itemValue(item, 'startPeriod', 'start_period')),
    Number(itemValue(item, 'endPeriod', 'end_period')),
    Number(itemValue(item, 'startWeek', 'start_week')),
    Number(itemValue(item, 'endWeek', 'end_week')),
    pattern,
    customWeeks,
    locationKey(itemValue(item, 'location', 'location')),
    normalizeWhitespace(itemValue(item, 'teacher', 'teacher'))
  ]);
}

function finalizeParsedArrangements(sheetName, sourceText, raw, options) {
  if (!raw.length) throw new Error('未识别到课程安排，请确认 XLSX 包含可识别的课程行或课程单元格');
  const totalWeeks = inferTotalWeeks(sourceText, raw, options.totalWeeks);
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > 30) throw new Error('课表总周数必须是 1–30');
  const unique = new Map();
  for (const item of raw) {
    const normalized = item.weeksInferred ? { ...item, endWeek: totalWeeks } : { ...item };
    delete normalized.weeksInferred;
    if (normalized.startWeek < 1 || normalized.endWeek > totalWeeks || normalized.startPeriod < 1 || normalized.endPeriod > 12) continue;
    const key = courseImportKey(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  const arrangements = mergeCourseRanges([...unique.values()]).sort((a, b) => a.weekday - b.weekday || a.startPeriod - b.startPeriod || a.name.localeCompare(b.name, 'zh-CN') || a.startWeek - b.startWeek);
  if (!arrangements.length) throw new Error('未识别到有效课程安排');
  return { sheetName, semesterName: parseSemesterName(sourceText, options.sourceName), totalWeeks, arrangements };
}

export function parseTimetableWorkbook(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('请选择有效的 XLSX 文件');
  const zip = zipReader(buffer);
  const { name: sheetName, xml } = parseWorkbookSheet(zip);
  const sharedStrings = parseSharedStrings(zip);
  const cells = parseCells(xml, sharedStrings);
  if (!cells.length) throw new Error('XLSX 工作表没有可读单元格');
  const totalXmlBytes = sharedStrings.reduce((total, value) => total + Buffer.byteLength(value), 0) + Buffer.byteLength(xml);
  if (totalXmlBytes > MAX_TOTAL_XML_BYTES) throw new Error('XLSX 文本内容过大');

  const merges = [...xml.matchAll(/<mergeCell\b([^>]*?)\/?>(?:<\/mergeCell>)?/g)].map(match => parseRange(xmlAttributes(match[1]).ref)).filter(Boolean);
  const sourceText = cells.map(cell => cell.value).filter(Boolean).join('\n');
  const defaultWeeks = Number(options.totalWeeks || 18);
  const headerCandidates = new Map();
  for (const cell of cells) {
    const weekday = parseWeekday(cell.value);
    if (weekday) {
      if (!headerCandidates.has(cell.row)) headerCandidates.set(cell.row, new Map());
      headerCandidates.get(cell.row).set(weekday, cell);
    }
  }
  const headerRow = [...headerCandidates.entries()].sort((a, b) => b[1].size - a[1].size || a[0] - b[0])[0];
  if (!headerRow || headerRow[1].size < 3) {
    const tabularHeader = findTabularHeader(cells);
    const tabularRaw = tabularHeader ? parseTabularRows(cells, tabularHeader) : [];
    if (tabularRaw.length) return finalizeParsedArrangements(sheetName, sourceText, tabularRaw, options);
    throw new Error(`未识别到星期列或课程清单表头（工作表：${sheetName}）`);
  }
  const dayColumns = new Map([...headerRow[1].entries()].map(([weekday, cell]) => [weekday, cell.column]));
  const firstDayColumn = Math.min(...dayColumns.values());
  const periodByRow = new Map();
  for (const cell of cells.filter(item => item.column < firstDayColumn && item.row > headerRow[0])) {
    const period = periodRangeIn(cell.value);
    if (!period || period.start < 1 || period.end > 12) continue;
    const merge = mergedRangeFor(cell, merges);
    const startRow = merge?.startRow ?? cell.row;
    const endRow = merge?.endRow ?? cell.row;
    for (let row = startRow; row <= endRow; row += 1) periodByRow.set(row, { start: period.start, end: period.end });
  }

  const raw = [];
  for (const cell of cells) {
    const weekday = [...dayColumns.entries()].find(([, column]) => column === cell.column)?.[0];
    if (!weekday || cell.row <= headerRow[0] || !cell.value) continue;
    const merge = mergedRangeFor(cell, merges);
    if (merge && (cell.row !== merge.startRow || cell.column !== merge.startColumn)) continue;
    const fallback = periodByRow.get(cell.row) || (merge ? periodByRow.get(merge.startRow) : null);
    const items = parseCellRecords(cell.value, fallback, defaultWeeks).map(item => ({ ...item, weekday: item.weekday || weekday }));
    raw.push(...items);
  }
  return finalizeParsedArrangements(sheetName, sourceText, raw, options);
}

function validDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function importTimetableWorkbook(store, buffer, options = {}) {
  const parsed = parseTimetableWorkbook(buffer, options);
  const requestedName = String(options.semesterName || parsed.semesterName).trim();
  const existingById = options.semesterId ? store.get('semesters', options.semesterId) : null;
  if (options.semesterId && !existingById) throw new Error('目标学期不存在');
  const existingByName = existingById || store.list('semesters').find(semester => semester.name === requestedName) || null;
  const startsOn = String(options.startsOn || existingByName?.startsOn || '').trim();
  if (!validDateText(startsOn)) throw new Error('请填写有效的第一教学周周一');
  const requestedWeeks = options.totalWeeks === undefined || options.totalWeeks === '' ? null : Number(options.totalWeeks);
  const totalWeeks = requestedWeeks || Number(existingByName?.totalWeeks || parsed.totalWeeks);
  if (!Number.isInteger(totalWeeks) || totalWeeks < parsed.totalWeeks || totalWeeks > 30) throw new Error(`总周数必须是 ${parsed.totalWeeks}–30`);
  let semester;
  if (existingByName) {
    const changes = { name: existingByName.name, startsOn, totalWeeks, isCurrent: options.makeCurrent === false ? existingByName.isCurrent : 1 };
    if (options.semesterName) changes.name = requestedName;
    semester = store.saveSemester(changes, existingByName.id);
  } else {
    semester = store.saveSemester({ name: requestedName, startsOn, totalWeeks, isCurrent: options.makeCurrent === false ? 0 : 1 });
  }
  const periods = store.ensureSchedulePeriods(semester.id);
  const existingKeys = new Set(store.list('courses').filter(course => course.semesterId === semester.id).map(courseImportKey));
  const created = [];
  const skipped = [];
  store.transaction(() => {
    for (const item of parsed.arrangements) {
      const key = courseImportKey({ ...item, semesterId: semester.id });
      if (existingKeys.has(key)) { skipped.push(item); continue; }
      const start = periods.find(period => period.periodNo === item.startPeriod);
      const end = periods.find(period => period.periodNo === item.endPeriod);
      if (!start || !end) throw new Error(`无法映射第 ${item.startPeriod}–${item.endPeriod} 节的作息时间`);
      const course = store.create('courses', { ...item, semesterId: semester.id, startTime: start.startTime, endTime: end.endTime });
      existingKeys.add(key);
      created.push(course);
    }
  });
  return { semester, semesterName: parsed.semesterName, sheetName: parsed.sheetName, totalWeeks, totalCount: parsed.arrangements.length, importedCount: created.length, skippedCount: skipped.length, arrangements: parsed.arrangements };
}
