import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { defaultSchedulePeriods } from './schedule.js';

const TABLE_ORDER = ['semesters', 'schedule_periods', 'courses', 'plans', 'memos', 'resume_tracks', 'resume_versions', 'applications', 'stage_history', 'interviews'];
const DELETE_ORDER = [...TABLE_ORDER].reverse();
const TABLE_COLUMNS = {
  semesters: ['id','name','starts_on','total_weeks','is_current','created_at','updated_at'],
  schedule_periods: ['id','semester_id','period_no','label','start_time','end_time','created_at','updated_at'],
  courses: ['id','semester_id','name','weekday','start_time','end_time','start_period','end_period','location','start_week','end_week','week_pattern','custom_weeks','teacher','notes','created_at','updated_at'],
  plans: ['id','title','start_date','due_date','start_time','due_time','priority','status','category','notes','source_memo_id','created_at','updated_at'],
  memos: ['id','content','status','archived_at','converted_plan_id','created_at','updated_at'],
  resume_tracks: ['id','name','direction','notes','current_version_id','created_at','updated_at'],
  resume_versions: ['id','track_id','version_name','original_name','stored_name','mime_type','size','sha256','notes','archived','created_at','updated_at'],
  applications: ['id','company','role_name','direction','location','channel','channel_label','job_url','applied_on','stage','notes','resume_version_id','created_at','updated_at'],
  stage_history: ['id','application_id','from_stage','to_stage','changed_at'],
  interviews: ['id','application_id','round_name','scheduled_at','mode','location','notes','result','created_at','updated_at']
};

function digest(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function inferPeriodNumber(time, side, fallback) {
  return defaultSchedulePeriods().find(period => period[side] === time)?.periodNo ?? fallback;
}
function validDocument(bytes, extension) {
  if (extension === '.pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (extension === '.docx') return bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (extension === '.doc') return bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  return false;
}

export function buildBackup(store) {
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  const data = Object.fromEntries(TABLE_ORDER.map((table) => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]));
  const resumesDir = join(store.dataDir, 'resumes');
  const names = [...new Set(data.resume_versions.map((version) => version.stored_name))];
  const files = names.map((name) => {
    if (basename(name) !== name || !/^[\w.-]+\.(pdf|doc|docx)$/i.test(name)) throw new Error('简历文件路径无效');
    const path = join(resumesDir, name);
    if (!existsSync(path)) throw new Error(`简历文件缺失：${name}`);
    const bytes = readFileSync(path);
    return { name, sha256: digest(bytes), data: bytes.toString('base64') };
  });
  const payload = { format: 'personal-workbench', version: 3, createdAt: new Date().toISOString(), data, files };
  return gzipSync(Buffer.from(JSON.stringify(payload)));
}

export function parseBackup(buffer) {
  let payload;
  try { payload = JSON.parse(gunzipSync(buffer, { maxOutputLength: 200 * 1024 * 1024 }).toString('utf8')); }
  catch { throw new Error('备份文件无法读取或已经损坏'); }
  if (payload?.format !== 'personal-workbench' || ![1, 2, 3].includes(payload?.version)) throw new Error('不支持的备份格式');
  normalizeScheduleData(payload);
  if (!Array.isArray(payload.files)) throw new Error('备份缺少简历文件清单');
  for (const table of TABLE_ORDER) {
    if (!Array.isArray(payload.data?.[table])) throw new Error(`备份缺少 ${table} 数据`);
    const allowed = new Set(TABLE_COLUMNS[table]);
    for (const row of payload.data[table]) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== allowed.size || Object.keys(row).some((key) => !allowed.has(key))) throw new Error(`${table} 数据结构无效`);
      if (typeof row.id !== 'string' || !row.id) throw new Error(`${table} 标识无效`);
    }
  }
  const fileMap = new Map();
  for (const file of payload.files) {
    const bytes = Buffer.from(file.data, 'base64');
    const extension = file.name?.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (basename(file.name) !== file.name || !/^[\w.-]+\.(pdf|doc|docx)$/i.test(file.name) || digest(bytes) !== file.sha256 || !validDocument(bytes, extension) || fileMap.has(file.name)) throw new Error('备份中的简历文件校验失败');
    fileMap.set(file.name, { ...file, size: bytes.length });
  }
  const referencedFiles = new Set();
  for (const version of payload.data.resume_versions) {
    const file = fileMap.get(version.stored_name);
    if (basename(String(version.stored_name || '')) !== version.stored_name || !file || Number(version.size) !== file.size || version.sha256 !== file.sha256) throw new Error('简历版本与备份文件不一致');
    referencedFiles.add(version.stored_name);
  }
  if (referencedFiles.size !== fileMap.size) throw new Error('备份包含未关联的简历文件');
  if (payload.data.courses.some((row) => !['every','odd','even','custom'].includes(row.week_pattern))) throw new Error('备份包含无效课程规则');
  if (payload.data.plans.some((row) => !['high','medium','low'].includes(row.priority) || !['todo','doing','done'].includes(row.status))) throw new Error('备份包含无效计划状态');
  if (payload.data.memos.some((row) => !['inbox','converted','archived'].includes(row.status))) throw new Error('备份包含无效备忘状态');
  if (payload.data.resume_versions.some((row) => ![0,1].includes(Number(row.archived)))) throw new Error('备份包含无效简历状态');
  return payload;
}

function normalizeScheduleData(payload) {
  const data = payload.data;
  if (!data || typeof data !== 'object') throw new Error('备份缺少数据');
  const oldApplicationColumns = new Set(['id','company','role_name','direction','location','channel','job_url','applied_on','stage','notes','resume_version_id','created_at','updated_at']);
  data.applications = Array.isArray(data.applications) ? data.applications.map(row => {
    const keys = new Set(Object.keys(row || {}));
    return keys.size === oldApplicationColumns.size && [...keys].every(key => oldApplicationColumns.has(key)) ? { ...row, channel_label: '' } : row;
  }) : data.applications;
  const oldCourseColumns = new Set(['id','semester_id','name','weekday','start_time','end_time','location','start_week','end_week','week_pattern','teacher','notes','created_at','updated_at']);
  data.courses = Array.isArray(data.courses) ? data.courses.map(row => {
    const keys = new Set(Object.keys(row || {}));
    if (keys.size === oldCourseColumns.size && [...keys].every(key => oldCourseColumns.has(key))) {
      const startPeriod = inferPeriodNumber(row.start_time, 'startTime', 1);
      const endPeriod = inferPeriodNumber(row.end_time, 'endTime', startPeriod);
      return { ...row, start_period: startPeriod, end_period: endPeriod >= startPeriod ? endPeriod : startPeriod, custom_weeks: '' };
    }
    return row;
  }) : data.courses;
  if (!Array.isArray(data.schedule_periods)) data.schedule_periods = [];
  if (!data.schedule_periods.length) {
    const now = new Date().toISOString();
    data.schedule_periods = (data.semesters || []).flatMap(semester => defaultSchedulePeriods().map(period => ({
      id: randomUUID(), semester_id: semester.id, period_no: period.periodNo, label: period.label,
      start_time: period.startTime, end_time: period.endTime, created_at: now, updated_at: now
    })));
  }
}

export function restoreBackup(store, bufferOrPayload) {
  const payload = Buffer.isBuffer(bufferOrPayload) ? parseBackup(bufferOrPayload) : bufferOrPayload;
  const staging = join(store.dataDir, 'staging', `restore-${Date.now()}`);
  const stagedResumes = join(staging, 'resumes');
  mkdirSync(stagedResumes, { recursive: true });
  for (const file of payload.files ?? []) writeFileSync(join(stagedResumes, file.name), Buffer.from(file.data, 'base64'));

  const resumesDir = join(store.dataDir, 'resumes');
  const previous = join(staging, 'previous-resumes');
  const markerPath = join(store.dataDir, 'restore-in-progress.json');
  const restoreId = randomUUID();
  writeFileSync(markerPath, JSON.stringify({ restoreId, staging }));
  let filesSwapped = false;
  try {
    if (existsSync(resumesDir)) renameSync(resumesDir, previous);
    renameSync(stagedResumes, resumesDir);
    filesSwapped = true;
    store.transaction(() => {
      for (const table of DELETE_ORDER) store.db.exec(`DELETE FROM ${table}`);
      for (const table of TABLE_ORDER) {
        for (const row of payload.data[table]) {
          const columns = Object.keys(row);
          store.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((key) => row[key]));
        }
      }
      store.db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_restore_id', ?)").run(restoreId);
    });
  } catch (error) {
    if (filesSwapped) rmSync(resumesDir, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, resumesDir);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  try { rmSync(previous, { recursive: true, force: true }); } catch {}
  try { rmSync(staging, { recursive: true, force: true }); } catch {}
  try { unlinkSync(markerPath); } catch {}
  return { createdAt: payload.createdAt, counts: Object.fromEntries(TABLE_ORDER.map((table) => [table, payload.data[table].length])) };
}

export function recoverInterruptedRestore(store) {
  const markerPath = join(store.dataDir, 'restore-in-progress.json');
  if (!existsSync(markerPath)) return;
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { return; }
  const stagingRoot = resolve(join(store.dataDir, 'staging'));
  const staging = resolve(String(marker.staging || ''));
  if (!staging.startsWith(`${stagingRoot}\\`) && !staging.startsWith(`${stagingRoot}/`)) return;
  const previous = join(staging, 'previous-resumes');
  const resumesDir = join(store.dataDir, 'resumes');
  const committed = store.db.prepare("SELECT value FROM app_meta WHERE key = 'last_restore_id'").get()?.value === marker.restoreId;
  if (!committed && existsSync(previous)) {
    rmSync(resumesDir, { recursive: true, force: true });
    renameSync(previous, resumesDir);
  }
  try { rmSync(staging, { recursive: true, force: true }); } catch {}
  try { unlinkSync(markerPath); } catch {}
}

export function saveSafetyBackup(store) {
  const dir = join(store.dataDir, 'safety-backups');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `before-restore-${new Date().toISOString().replaceAll(':', '-')}.pwb`);
  writeFileSync(path, buildBackup(store));
  return path;
}
