import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { WorkspaceStore } from './store.js';
import { buildBackup, parseBackup, recoverInterruptedRestore, restoreBackup, saveSafetyBackup } from './backup.js';
import { isOverdue, occursOn, parseCustomWeeks, teachingWeek } from './domain.js';
import { importTimetableWorkbook, parseTimetableWorkbook } from './timetable-import.js';
import { renderDocxPreviewHtml } from './document-preview.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'config.json');
if (!process.env.WORKBENCH_DATA_DIR && !existsSync(configPath)) throw new Error('尚未配置数据目录，请使用“启动工作台.cmd”启动。');
const config = process.env.WORKBENCH_DATA_DIR ? { dataDir: process.env.WORKBENCH_DATA_DIR, port: process.env.WORKBENCH_PORT } : JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
const dataDir = resolve(config.dataDir);
mkdirSync(dataDir, { recursive: true });
const store = new WorkspaceStore(dataDir);
recoverInterruptedRestore(store);
recoverFileOperations();
const port = Number(config.port || 47821);

function resumeFilePath(storedName) {
  if (typeof storedName !== 'string' || storedName !== storedName.replaceAll('\\', '/').split('/').pop() || !/^[\w.-]+\.(pdf|doc|docx)$/i.test(storedName)) throw new Error('文件路径无效');
  const base = resolve(dataDir, 'resumes');
  const target = resolve(base, storedName);
  if (!target.startsWith(`${base}\\`) && !target.startsWith(`${base}/`)) throw new Error('文件路径越界');
  return target;
}

function documentMime(storedName) {
  return ({ '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })[extname(storedName).toLowerCase()] || 'application/octet-stream';
}

function resumeFileExists(version) {
  try { return existsSync(resumeFilePath(version.storedName)); } catch { return false; }
}

function recoverFileOperations() {
  const staging = join(dataDir, 'staging');
  for (const name of readdirSync(staging).filter((item) => item.startsWith('file-op-') && item.endsWith('.json'))) {
    const markerPath = join(staging, name);
    let marker;
    try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { continue; }
    try {
      if (marker.type === 'replace') {
        const previousPath = resumeFilePath(marker.oldStoredName);
        const replacementPath = resumeFilePath(marker.newStoredName);
        const version = store.db.prepare('SELECT stored_name FROM resume_versions WHERE id = ?').get(marker.id);
        if (version?.stored_name === marker.newStoredName) {
          if (marker.oldStoredName !== marker.newStoredName && existsSync(previousPath)) unlinkSync(previousPath);
        } else if (existsSync(replacementPath)) unlinkSync(replacementPath);
        unlinkSync(markerPath);
        continue;
      }
      const original = resumeFilePath(marker.storedName);
      const version = store.db.prepare('SELECT id FROM resume_versions WHERE stored_name = ?').get(marker.storedName);
      if (marker.type === 'upload' && !version && existsSync(original)) unlinkSync(original);
      if (marker.type === 'delete') {
        const trash = join(staging, marker.trashName);
        if (version && !existsSync(original) && existsSync(trash)) renameSync(trash, original);
        else if (!version && existsSync(trash)) unlinkSync(trash);
      }
      unlinkSync(markerPath);
    } catch {}
  }
}

const resources = {
  semesters: 'semesters', courses: 'courses', plans: 'plans', memos: 'memos',
  'resume-tracks': 'resume_tracks', applications: 'applications', interviews: 'interviews'
};
const stages = ['待投递','已投递','笔试','一面','二面','HR 面','Offer','拒绝','主动放弃'];

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function error(res, status, message) { json(res, status, { error: message }); }

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dashboard(dateText) {
  const now = new Date();
  const currentSemester = store.db.prepare('SELECT * FROM semesters WHERE is_current = 1 LIMIT 1').get();
  const allCourses = currentSemester ? store.db.prepare('SELECT * FROM courses WHERE semester_id = ? ORDER BY start_time').all(currentSemester.id) : [];
  const occursOnDate = course => currentSemester && occursOn({ weekday: course.weekday, startWeek: course.start_week, endWeek: course.end_week, weekPattern: course.week_pattern, customWeeks: course.custom_weeks }, { startsOn: currentSemester.starts_on }, dateText);
  const courses = allCourses.filter(occursOnDate);
  const today = localDate(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const todayCourse = dateText === today ? courses.find(course => toMinutes(course.start_time) <= currentMinutes && currentMinutes < toMinutes(course.end_time)) : null;
  let nextCourse = dateText === today ? courses.find(course => toMinutes(course.start_time) > currentMinutes) : null;
  if (!nextCourse && currentSemester && dateText === today) {
    const cursor = new Date(`${dateText}T00:00:00`);
    const searchDays = Math.max(7, Number(currentSemester.total_weeks || 1) * 7);
    for (let offset = 1; offset <= searchDays; offset += 1) {
      const futureDate = new Date(cursor);
      futureDate.setDate(futureDate.getDate() + offset);
      const futureText = localDate(futureDate);
      const candidate = allCourses.find(course => occursOn({ weekday: course.weekday, startWeek: course.start_week, endWeek: course.end_week, weekPattern: course.week_pattern, customWeeks: course.custom_weeks }, { startsOn: currentSemester.starts_on }, futureText));
      if (candidate) { nextCourse = { ...candidate, next_date: futureText }; break; }
    }
  }
  const plans = store.list('plans', 'due_date ASC').filter((plan) => plan.status !== 'done');
  const todayPlans = plans.filter((plan) => (!plan.startDate || plan.startDate <= dateText) && plan.dueDate >= dateText);
  const overdue = plans.filter((plan) => isOverdue(plan, now));
  const seven = new Date(`${dateText}T00:00:00`); seven.setDate(seven.getDate() + 7);
  const through = localDate(seven);
  const important = plans.filter((plan) => plan.priority === 'high' && plan.dueDate >= dateText && plan.dueDate <= through);
  const interviews = store.db.prepare(`SELECT interviews.*, applications.company, applications.role_name
    FROM interviews JOIN applications ON applications.id = interviews.application_id
    WHERE scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at`).all(`${dateText}T00:00`, `${through}T23:59`);
  const allPlans = store.list('plans');
  const applications = store.list('applications');
  const resumeTracks = store.list('resume_tracks');
  const resumeVersions = store.list('resume_versions');
  const memos = store.list('memos').filter((memo) => memo.status === 'inbox');
  return {
    date: dateText,
    teachingWeek: currentSemester ? teachingWeek(currentSemester.starts_on, dateText) : null,
    currentSemester,
    courses,
    todayCourses: courses,
    currentCourse: todayCourse,
    nextCourse,
    todayPlans,
    overdue,
    important,
    interviews,
    memos: memos.slice(0, 8),
    summary: {
      planTotal: allPlans.length,
      planOpen: allPlans.filter((plan) => plan.status !== 'done').length,
      planDone: allPlans.filter((plan) => plan.status === 'done').length,
      applicationTotal: applications.length,
      applicationOpen: applications.filter((application) => !['拒绝', '主动放弃'].includes(application.stage)).length,
      resumeTracks: resumeTracks.length,
      resumeVersions: resumeVersions.length,
      memoInbox: memos.length
    }
  };
}

function toMinutes(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
}

function validateRequired(table, input) {
  const required = {
    semesters: ['name', 'startsOn'], courses: ['semesterId', 'name', 'weekday', 'startTime', 'endTime', 'startWeek', 'endWeek'],
    plans: ['title', 'dueDate'], memos: ['content'], resume_tracks: ['name'], applications: ['company', 'roleName'],
    interviews: ['applicationId', 'roundName', 'scheduledAt']
  }[table] ?? [];
  for (const key of required) if (input[key] === undefined || input[key] === '') throw new Error(`缺少必填项：${key}`);
}

function validDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTimeText(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function validateValues(table, input) {
  const nonBlank = {
    semesters: ['name','startsOn','totalWeeks'],
    courses: ['semesterId','name','weekday','startTime','endTime','startWeek','endWeek','weekPattern'],
    plans: ['title','dueDate','priority','status'], memos: ['content'], resume_tracks: ['name'],
    applications: ['company','roleName','stage'], interviews: ['applicationId','roundName','scheduledAt']
  }[table] ?? [];
  for (const key of nonBlank) if (key in input && !String(input[key] ?? '').trim()) throw new Error(`${key} 不能为空`);
  if (table === 'semesters') {
    if (input.startsOn && !validDateText(input.startsOn)) throw new Error('学期开始日期格式无效');
    if (input.totalWeeks !== undefined && (!Number.isInteger(Number(input.totalWeeks)) || Number(input.totalWeeks) < 1 || Number(input.totalWeeks) > 30)) throw new Error('学期周数必须是 1–30');
  }
  if (table === 'courses') {
    if (input.weekday !== undefined && (!Number.isInteger(Number(input.weekday)) || Number(input.weekday) < 1 || Number(input.weekday) > 7)) throw new Error('星期必须是 1–7 的整数');
    if (input.startTime && !validTimeText(input.startTime) || input.endTime && !validTimeText(input.endTime)) throw new Error('课程时间格式无效');
    if (input.startTime && input.endTime && input.startTime >= input.endTime) throw new Error('课程结束时间必须晚于开始时间');
    if (input.startPeriod !== undefined && (!Number.isInteger(Number(input.startPeriod)) || Number(input.startPeriod) < 1 || Number(input.startPeriod) > 12)) throw new Error('起始节次必须是 1–12 的整数');
    if (input.endPeriod !== undefined && (!Number.isInteger(Number(input.endPeriod)) || Number(input.endPeriod) < 1 || Number(input.endPeriod) > 12)) throw new Error('结束节次必须是 1–12 的整数');
    if (input.startPeriod !== undefined && input.endPeriod !== undefined && Number(input.startPeriod) > Number(input.endPeriod)) throw new Error('结束节次不能早于起始节次');
    if (input.startWeek !== undefined && (!Number.isInteger(Number(input.startWeek)) || Number(input.startWeek) < 1) || input.endWeek !== undefined && (!Number.isInteger(Number(input.endWeek)) || Number(input.endWeek) < 1)) throw new Error('教学周必须是大于 0 的整数');
    if (input.startWeek && input.endWeek && Number(input.startWeek) > Number(input.endWeek)) throw new Error('结束周不能早于起始周');
    if (input.weekPattern !== undefined && !['every','odd','even','custom'].includes(input.weekPattern)) throw new Error('周规则无效');
    if (input.weekPattern === 'custom' && !String(input.customWeeks || '').trim()) throw new Error('自定义周次不能为空');
    if (input.customWeeks !== undefined) {
      const customWeeks = String(input.customWeeks || '').trim();
      if (customWeeks.length > 200) throw new Error('自定义周次不能超过 200 个字符');
      if (customWeeks && !parseCustomWeeks(customWeeks)) throw new Error('自定义周次格式无效，请使用数字、逗号和区间');
      if (input.weekPattern === 'custom' && customWeeks) {
        const startWeek = Number(input.startWeek);
        const endWeek = Number(input.endWeek);
        if ([...parseCustomWeeks(customWeeks)].some(week => week < startWeek || week > endWeek)) throw new Error('自定义周次必须落在起始周和结束周范围内');
      }
    }
  }
  if (table === 'plans') {
    if (input.dueDate && !validDateText(input.dueDate) || input.startDate && !validDateText(input.startDate)) throw new Error('计划日期格式无效');
    if (input.startTime && !validTimeText(input.startTime) || input.dueTime && !validTimeText(input.dueTime)) throw new Error('计划时间格式无效');
    if (input.startDate && input.dueDate && input.startDate > input.dueDate) throw new Error('截止日期不能早于开始日期');
    if (input.priority !== undefined && !['high','medium','low'].includes(input.priority)) throw new Error('计划优先级无效');
    if (input.status !== undefined && !['todo','doing','done'].includes(input.status)) throw new Error('计划状态无效');
  }
  if (table === 'memos') {
    if (input.content !== undefined && (!String(input.content).trim() || String(input.content).length > 500)) throw new Error('备忘内容应为 1–500 个字符');
    if (input.status !== undefined && !['inbox', 'archived', 'converted'].includes(input.status)) throw new Error('备忘状态无效');
  }
  if (table === 'applications') {
    if (input.stage !== undefined && !stages.includes(input.stage)) throw new Error('招聘阶段无效');
    if (input.jobUrl && !/^https?:\/\//i.test(input.jobUrl)) throw new Error('岗位链接必须以 http:// 或 https:// 开头');
    if (input.channelLabel !== undefined && String(input.channelLabel).length > 80) throw new Error('投递渠道名称不能超过 80 个字符');
    if (input.channel !== undefined && String(input.channel).length > 500) throw new Error('投递网址不能超过 500 个字符');
    if (input.appliedOn && !validDateText(input.appliedOn)) throw new Error('投递日期无效');
  }
  if (table === 'interviews' && input.scheduledAt && Number.isNaN(new Date(input.scheduledAt).getTime())) throw new Error('面试时间无效');
}

function validDocument(bytes, extension) {
  if (extension === '.pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (extension === '.docx') return bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (extension === '.doc') return bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  return false;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'personal-workbench', dataDir });
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, dashboard(url.searchParams.get('date') || localDate()));
  if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, { dataDir, version: '1.0.0' });
  if (req.method === 'GET' && url.pathname === '/api/schedule-periods') {
    const semesterId = url.searchParams.get('semesterId');
    if (!semesterId) throw new Error('缺少 semesterId');
    return json(res, 200, store.listSchedulePeriods(semesterId));
  }
  if (req.method === 'PUT' && url.pathname === '/api/schedule-periods') {
    const input = await body(req);
    const periods = Array.isArray(input.periods) ? input.periods : [];
    if (!input.semesterId || periods.length !== 12) throw new Error('需要完整设置 12 节作息时间');
    const numbers = periods.map(period => Number(period.periodNo));
    if (new Set(numbers).size !== 12 || numbers.some(number => !Number.isInteger(number) || number < 1 || number > 12)) throw new Error('节次必须完整且为 1–12');
    const orderedPeriods = [...periods].sort((a, b) => Number(a.periodNo) - Number(b.periodNo));
    for (let index = 0; index < orderedPeriods.length; index += 1) {
      const period = orderedPeriods[index];
      if (!validTimeText(period.startTime) || !validTimeText(period.endTime) || period.startTime >= period.endTime) throw new Error('作息时间格式无效或结束时间不晚于开始时间');
      if (index > 0 && period.startTime < orderedPeriods[index - 1].endTime) throw new Error(`第${period.periodNo}节与前一节时间重叠`);
    }
    return json(res, 200, store.saveSchedulePeriods(input.semesterId, periods));
  }
  if (req.method === 'POST' && url.pathname === '/api/timetable-import') {
    const input = await body(req, 25 * 1024 * 1024);
    if (!input.file?.data || !input.file?.name) throw new Error('请选择一个 XLSX 文件');
    if (extname(input.file.name).toLowerCase() !== '.xlsx') throw new Error('课表导入只支持 XLSX 文件');
    const bytes = Buffer.from(input.file.data, 'base64');
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error('XLSX 文件不能超过 15MB');
    const options = { sourceName: input.file.name, semesterId: input.semesterId || undefined, semesterName: input.semesterName || undefined, startsOn: input.startsOn || undefined, totalWeeks: input.totalWeeks === '' || input.totalWeeks === undefined ? undefined : input.totalWeeks, makeCurrent: input.makeCurrent !== false };
    const parsed = parseTimetableWorkbook(bytes, options);
    if (input.preview) return json(res, 200, { sheetName: parsed.sheetName, semesterName: parsed.semesterName, totalWeeks: parsed.totalWeeks, totalCount: parsed.arrangements.length, sample: parsed.arrangements.slice(0, 5) });
    return json(res, 200, importTimetableWorkbook(store, bytes, options));
  }
  if (req.method === 'GET' && url.pathname === '/api/backup') {
    const backup = buildBackup(store);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="personal-workbench-${localDate()}.pwb"`, 'Content-Length': backup.length });
    return res.end(backup);
  }
  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const input = await body(req, 80 * 1024 * 1024);
    const bytes = Buffer.from(input.data || '', 'base64');
    const parsed = parseBackup(bytes);
    saveSafetyBackup(store);
    return json(res, 200, restoreBackup(store, parsed));
  }
  if (req.method === 'POST' && /^\/api\/memos\/[^/]+\/convert$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const input = await body(req); validateRequired('plans', { title: '由备忘生成', ...input }); validateValues('plans', input);
    return json(res, 201, store.convertMemo(id, input));
  }
  if (req.method === 'GET' && /^\/api\/applications\/[^/]+\/detail$/.test(url.pathname)) {
    const value = store.applicationDetail(url.pathname.split('/')[3]);
    if (!value.id) return error(res, 404, '岗位不存在');
    if (value.resumeVersion) value.resumeVersion = { ...value.resumeVersion, fileExists: resumeFileExists(value.resumeVersion), referenceCount: store.resumeVersionReferenceCount(value.resumeVersion.id) };
    return json(res, 200, value);
  }
  if (req.method === 'POST' && url.pathname === '/api/resume-versions') {
    const input = await body(req);
    if (!input.trackId || !input.versionName || !input.file?.data || !input.file?.name) throw new Error('简历方向、版本和文件均为必填项');
    const bytes = Buffer.from(input.file.data, 'base64');
    if (bytes.length > 15 * 1024 * 1024) throw new Error('文件不能超过 15MB');
    const extension = extname(input.file.name).toLowerCase();
    if (!['.pdf', '.doc', '.docx'].includes(extension)) throw new Error('只支持 PDF、DOC 和 DOCX 文件');
    if (!validDocument(bytes, extension)) throw new Error('文件内容与扩展名不匹配或文件已经损坏');
    const storedName = `${randomUUID()}${extension}`;
    const operationMarker = join(dataDir, 'staging', `file-op-upload-${storedName}.json`);
    writeFileSync(operationMarker, JSON.stringify({ type: 'upload', storedName }));
    writeFileSync(resumeFilePath(storedName), bytes, { flag: 'wx' });
    try {
      const version = store.createResumeVersion({ trackId: input.trackId, versionName: input.versionName, originalName: input.file.name, storedName, mimeType: documentMime(storedName), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), notes: input.notes || '', archived: 0 }, input.makeCurrent !== false);
      unlinkSync(operationMarker);
      return json(res, 201, version);
    } catch (err) { if (existsSync(resumeFilePath(storedName))) unlinkSync(resumeFilePath(storedName)); if (existsSync(operationMarker)) unlinkSync(operationMarker); throw err; }
  }
  if (req.method === 'POST' && /^\/api\/resume-versions\/[^/]+\/replace-file$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const existing = store.get('resume_versions', id);
    if (!existing) throw new Error('简历版本不存在');
    const input = await body(req);
    if (!input.file?.data || !input.file?.name) throw new Error('简历文件是必填项');
    const bytes = Buffer.from(input.file.data, 'base64');
    if (bytes.length > 15 * 1024 * 1024) throw new Error('文件不能超过 15MB');
    const extension = extname(input.file.name).toLowerCase();
    if (!['.pdf', '.doc', '.docx'].includes(extension)) throw new Error('只支持 PDF、DOC 和 DOCX 文件');
    if (!validDocument(bytes, extension)) throw new Error('文件内容与扩展名不匹配或文件已经损坏');
    const storedName = `${randomUUID()}${extension}`;
    const replacementPath = resumeFilePath(storedName);
    const operationMarker = join(dataDir, 'staging', `file-op-replace-${id}-${storedName}.json`);
    writeFileSync(operationMarker, JSON.stringify({ type: 'replace', id, oldStoredName: existing.storedName, newStoredName: storedName }));
    let updated;
    try {
      writeFileSync(replacementPath, bytes, { flag: 'wx' });
      updated = store.replaceResumeVersionFile(id, { originalName: input.file.name, storedName, mimeType: documentMime(storedName), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (err) {
      if (existsSync(replacementPath)) unlinkSync(replacementPath);
      if (existsSync(operationMarker)) unlinkSync(operationMarker);
      throw err;
    }
    try {
      const previousPath = resumeFilePath(existing.storedName);
      if (previousPath !== replacementPath && existsSync(previousPath)) unlinkSync(previousPath);
    } catch {}
    try { unlinkSync(operationMarker); } catch {}
    return json(res, 200, updated);
  }
  if (req.method === 'GET' && url.pathname === '/api/resume-versions') return json(res, 200, store.list('resume_versions').map(version => ({ ...version, fileExists: resumeFileExists(version), referenceCount: store.resumeVersionReferenceCount(version.id) })));
  if (req.method === 'PATCH' && /^\/api\/resume-versions\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const input = await body(req);
    const version = store.get('resume_versions', id);
    if (!version) throw new Error('简历版本不存在');
    if (input.versionName !== undefined) {
      if (!String(input.versionName).trim()) throw new Error('版本名称不能为空');
      if (String(input.versionName).trim().length > 120) throw new Error('版本名称不能超过 120 个字符');
    }
    if (input.notes !== undefined && String(input.notes).length > 2000) throw new Error('版本备注不能超过 2000 个字符');
    if (input.makeCurrent) store.setCurrentResumeVersion(version.trackId, id);
    const changes = {};
    if (input.versionName !== undefined) changes.versionName = String(input.versionName).trim();
    if (input.notes !== undefined) changes.notes = String(input.notes || '');
    if (input.archived !== undefined) changes.archived = input.archived ? 1 : 0;
    const updated = Object.keys(changes).length ? store.update('resume_versions', id, changes) : store.get('resume_versions', id);
    return json(res, 200, updated);
  }
  if (req.method === 'DELETE' && /^\/api\/resume-versions\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const existing = store.get('resume_versions', id);
    if (!existing) throw new Error('简历版本不存在');
    if (store.resumeVersionReferenced(id)) throw new Error('该版本已被岗位引用，只能归档');
    const original = resumeFilePath(existing.storedName);
    const trashName = `delete-${randomUUID()}-${existing.storedName}`;
    const trash = join(dataDir, 'staging', trashName);
    const operationMarker = join(dataDir, 'staging', `file-op-delete-${id}.json`);
    writeFileSync(operationMarker, JSON.stringify({ type: 'delete', storedName: existing.storedName, trashName }));
    if (existsSync(original)) renameSync(original, trash);
    try { store.deleteResumeVersion(id); }
    catch (err) { if (existsSync(trash)) renameSync(trash, original); if (existsSync(operationMarker)) unlinkSync(operationMarker); throw err; }
    try { if (existsSync(trash)) unlinkSync(trash); } catch {}
    try { unlinkSync(operationMarker); } catch {}
    return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && /^\/api\/resume-tracks\/[^/]+$/.test(url.pathname)) {
    store.removeResumeTrack(url.pathname.split('/')[3]);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && /^\/api\/files\/[^/]+\/preview$/.test(url.pathname)) {
    const version = store.get('resume_versions', url.pathname.split('/')[3]);
    if (!version) return error(res, 404, '文件不存在');
    const path = resumeFilePath(version.storedName);
    if (!existsSync(path)) return error(res, 404, '受管文件缺失');
    const extension = extname(version.storedName).toLowerCase();
    if (extension === '.pdf') return error(res, 415, 'PDF 请直接使用文件预览');
    const preview = renderDocxPreviewHtml(readFileSync(path), version.originalName);
    const bytes = Buffer.from(preview, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    });
    return res.end(bytes);
  }
  if (req.method === 'GET' && /^\/api\/files\/[^/]+$/.test(url.pathname)) {
    const version = store.get('resume_versions', url.pathname.split('/')[3]);
    if (!version) return error(res, 404, '文件不存在');
    const path = resumeFilePath(version.storedName);
    if (!existsSync(path)) return error(res, 404, '受管文件缺失');
    const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    res.writeHead(200, { 'Content-Type': documentMime(version.storedName), 'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(version.originalName)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return createReadStream(path).pipe(res);
  }

  const match = url.pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/);
  if (!match || !resources[match[1]]) return false;
  const table = resources[match[1]];
  const id = match[2];
  if (req.method === 'GET') { const value=id?store.get(table,id):store.list(table); return id&&!value?error(res,404,'记录不存在'):json(res,200,value); }
  if (req.method === 'POST' && !id) {
    const input = await body(req); validateRequired(table, input); validateValues(table, input);
    const value = table === 'memos' ? store.createMemo(input) : table === 'applications' ? store.createApplication(input) : table === 'semesters' ? store.saveSemester(input) : store.create(table, input);
    return json(res, 201, value);
  }
  if (req.method === 'PATCH' && id) {
    const input = await body(req);
    const validationInput = table === 'courses' ? { ...(store.get(table, id) || {}), ...input } : input;
    validateValues(table, validationInput);
    const value = table === 'applications' ? store.updateApplication(id, input) : table === 'semesters' ? store.saveSemester(input, id) : store.update(table, id, input);
    return json(res, 200, value);
  }
  if (req.method === 'DELETE' && id) { store.remove(table, id); return json(res, 200, { ok: true }); }
  return false;
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function staticFile(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const path = resolve(root, 'web', requested);
  const webRoot = resolve(root, 'web');
  const rel = relative(webRoot, path);
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(path)) return false;
  const bytes = readFileSync(path);
  res.writeHead(200, {
    'Content-Type': contentTypes[extname(path)] || 'application/octet-stream',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store'
  });
  res.end(bytes); return true;
}

const server = createServer(async (req, res) => {
  try {
    const remote = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return error(res, 403, '仅允许本机访问');
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = req.headers.host;
    if (!allowedHosts.has(host)) return error(res, 403, '请求主机无效');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return error(res, 403, '不允许跨站请求');
    if (['POST','PATCH','DELETE'].includes(req.method) && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return error(res, 415, '写入请求必须使用 application/json');
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled === false) error(res, 404, '接口不存在');
    } else if (!staticFile(res, url.pathname)) error(res, 404, '页面不存在');
  } catch (err) { console.error(err.message); if (!res.headersSent) error(res, 400, err.message); else res.destroy(); }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭占用程序后重试。` : `本地服务启动失败：${err.message}`);
  store.close();
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${port}`;
  console.log(`个人工作台已启动：${address}`);
  if (!process.argv.includes('--no-open')) execFile('cmd', ['/c', 'start', '', address], { windowsHide: true });
});

function shutdown() { server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
