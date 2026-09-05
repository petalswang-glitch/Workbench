import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { coursesConflict } from './domain.js';
import { defaultSchedulePeriods } from './schedule.js';

const TABLES = {
  semesters: ['name', 'starts_on', 'total_weeks', 'is_current'],
  courses: ['semester_id', 'name', 'weekday', 'start_time', 'end_time', 'start_period', 'end_period', 'location', 'start_week', 'end_week', 'week_pattern', 'custom_weeks', 'teacher', 'notes'],
  schedule_periods: ['semester_id', 'period_no', 'label', 'start_time', 'end_time'],
  plans: ['title', 'start_date', 'due_date', 'start_time', 'due_time', 'priority', 'status', 'category', 'notes', 'source_memo_id'],
  memos: ['content', 'status', 'archived_at', 'converted_plan_id'],
  resume_tracks: ['name', 'direction', 'notes', 'current_version_id'],
  resume_versions: ['track_id', 'version_name', 'original_name', 'stored_name', 'mime_type', 'size', 'sha256', 'notes', 'archived'],
  applications: ['company', 'role_name', 'direction', 'location', 'channel', 'channel_label', 'job_url', 'applied_on', 'stage', 'notes', 'resume_version_id'],
  interviews: ['application_id', 'round_name', 'scheduled_at', 'mode', 'location', 'notes', 'result']
};

function snake(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function camel(name) {
  return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function present(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]));
}

function scheduleMinutes(value) {
  const match = String(value ?? '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export class WorkspaceStore {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, 'resumes'), { recursive: true });
    mkdirSync(join(dataDir, 'staging'), { recursive: true });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semesters (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, starts_on TEXT NOT NULL,
        total_weeks INTEGER NOT NULL DEFAULT 18, is_current INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY, semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
        name TEXT NOT NULL, weekday INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
        start_period INTEGER NOT NULL DEFAULT 1, end_period INTEGER NOT NULL DEFAULT 1,
        location TEXT NOT NULL DEFAULT '', start_week INTEGER NOT NULL, end_week INTEGER NOT NULL,
        week_pattern TEXT NOT NULL DEFAULT 'every', custom_weeks TEXT NOT NULL DEFAULT '', teacher TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_periods (
        id TEXT PRIMARY KEY, semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
        period_no INTEGER NOT NULL, label TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(semester_id, period_no)
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT, due_date TEXT NOT NULL,
        start_time TEXT, due_time TEXT, priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'todo',
        category TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', source_memo_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'inbox', archived_at TEXT,
        converted_plan_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resume_tracks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, direction TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        current_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resume_versions (
        id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES resume_tracks(id) ON DELETE CASCADE,
        version_name TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY, company TEXT NOT NULL, role_name TEXT NOT NULL, direction TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', channel_label TEXT NOT NULL DEFAULT '', job_url TEXT NOT NULL DEFAULT '',
        applied_on TEXT, stage TEXT NOT NULL DEFAULT '待投递', notes TEXT NOT NULL DEFAULT '', resume_version_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(resume_version_id) REFERENCES resume_versions(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS stage_history (
        id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        from_stage TEXT, to_stage TEXT NOT NULL, changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interviews (
        id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        round_name TEXT NOT NULL, scheduled_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_courses_semester ON courses(semester_id);
      CREATE INDEX IF NOT EXISTS idx_plans_due ON plans(due_date, status);
      CREATE INDEX IF NOT EXISTS idx_applications_stage ON applications(stage);
      CREATE INDEX IF NOT EXISTS idx_interviews_time ON interviews(scheduled_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_semester ON semesters(is_current) WHERE is_current = 1;
    `);
    const courseColumns = this.db.prepare('PRAGMA table_info(courses)').all().map(column => column.name);
    const applicationColumns = this.db.prepare('PRAGMA table_info(applications)').all().map(column => column.name);
    if (!applicationColumns.includes('channel_label')) this.db.exec("ALTER TABLE applications ADD COLUMN channel_label TEXT NOT NULL DEFAULT ''");
    const missingStartPeriod = !courseColumns.includes('start_period');
    const missingEndPeriod = !courseColumns.includes('end_period');
    if (missingStartPeriod) this.db.exec('ALTER TABLE courses ADD COLUMN start_period INTEGER NOT NULL DEFAULT 1');
    if (missingEndPeriod) this.db.exec('ALTER TABLE courses ADD COLUMN end_period INTEGER NOT NULL DEFAULT 1');
    if (!courseColumns.includes('custom_weeks')) this.db.exec("ALTER TABLE courses ADD COLUMN custom_weeks TEXT NOT NULL DEFAULT ''");
    if (missingStartPeriod || missingEndPeriod) {
      const defaults = defaultSchedulePeriods();
      const starts = new Map(defaults.map(period => [period.startTime, period.periodNo]));
      const ends = new Map(defaults.map(period => [period.endTime, period.periodNo]));
      const update = this.db.prepare('UPDATE courses SET start_period = ?, end_period = ? WHERE id = ?');
      for (const course of this.db.prepare('SELECT id, start_time, end_time, start_period, end_period FROM courses').all()) {
        const start = missingStartPeriod ? (starts.get(course.start_time) || course.start_period || 1) : course.start_period;
        const end = missingEndPeriod ? (ends.get(course.end_time) || start) : course.end_period;
        update.run(start, Math.max(start, end || start), course.id);
      }
    }
  }

  close() { this.db.close(); }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(table, order = 'created_at DESC') {
    if (!TABLES[table]) throw new Error('未知资源');
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map(present);
  }

  listSchedulePeriods(semesterId) {
    if (!this.get('semesters', semesterId)) return [];
    return this.db.prepare('SELECT * FROM schedule_periods WHERE semester_id = ? ORDER BY period_no').all(semesterId).map(present);
  }

  ensureSchedulePeriods(semesterId) {
    if (!this.get('semesters', semesterId)) throw new Error('学期不存在');
    if (this.db.prepare('SELECT COUNT(*) AS count FROM schedule_periods WHERE semester_id = ?').get(semesterId).count) return this.listSchedulePeriods(semesterId);
    const now = new Date().toISOString();
    const insert = this.db.prepare('INSERT INTO schedule_periods (id, semester_id, period_no, label, start_time, end_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const period of defaultSchedulePeriods()) insert.run(randomUUID(), semesterId, period.periodNo, period.label, period.startTime, period.endTime, now, now);
    return this.listSchedulePeriods(semesterId);
  }

  saveSchedulePeriods(semesterId, periods) {
    if (!this.get('semesters', semesterId)) throw new Error('学期不存在');
    const normalized = [...periods].sort((a, b) => Number(a.periodNo) - Number(b.periodNo));
    if (normalized.length !== 12 || normalized.some((period, index) => Number(period.periodNo) !== index + 1)) throw new Error('节次必须完整且为 1–12');
    for (let index = 0; index < normalized.length; index += 1) {
      const period = normalized[index];
      const start = scheduleMinutes(period.startTime);
      const end = scheduleMinutes(period.endTime);
      if (start === null || end === null || start >= end) throw new Error('作息时间格式无效或结束时间不晚于开始时间');
      if (index > 0 && start < scheduleMinutes(normalized[index - 1].endTime)) throw new Error(`第${period.periodNo}节与前一节时间重叠`);
    }
    return this.transaction(() => {
      this.db.prepare('DELETE FROM schedule_periods WHERE semester_id = ?').run(semesterId);
      const now = new Date().toISOString();
      const insert = this.db.prepare('INSERT INTO schedule_periods (id, semester_id, period_no, label, start_time, end_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const period of normalized) {
        insert.run(randomUUID(), semesterId, Number(period.periodNo), String(period.label || `第${period.periodNo}节`), String(period.startTime), String(period.endTime), now, now);
      }
      const updateCourses = this.db.prepare('UPDATE courses SET start_time = COALESCE((SELECT start_time FROM schedule_periods WHERE semester_id = courses.semester_id AND period_no = courses.start_period), start_time), end_time = COALESCE((SELECT end_time FROM schedule_periods WHERE semester_id = courses.semester_id AND period_no = courses.end_period), end_time), updated_at = ? WHERE semester_id = ?');
      updateCourses.run(now, semesterId);
      return this.listSchedulePeriods(semesterId);
    });
  }

  get(table, id) {
    if (!TABLES[table]) throw new Error('未知资源');
    return present(this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
  }

  findCourseConflict(candidate, excludeId = null) {
    if (!candidate?.semesterId) return null;
    const courses = this.db.prepare('SELECT * FROM courses WHERE semester_id = ? ORDER BY start_time').all(candidate.semesterId).map(present);
    return courses.find(course => course.id !== excludeId && coursesConflict(candidate, course)) || null;
  }

  normalizeResumeTrackName(value) {
    return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  }

  assertUniqueResumeTrackName(name, excludeId = null) {
    const normalized = this.normalizeResumeTrackName(name);
    if (!normalized) throw new Error('简历方向名称不能为空');
    const duplicate = this.db.prepare('SELECT id, name FROM resume_tracks WHERE id != ?').all(excludeId || '').find(track => this.normalizeResumeTrackName(track.name) === normalized);
    if (duplicate) throw new Error('简历方向名称已存在，请换一个名称');
  }

  create(table, input) {
    const allowed = TABLES[table];
    if (!allowed) throw new Error('未知资源');
    if (table === 'resume_tracks') {
      const name = String(input.name ?? '').normalize('NFKC').trim();
      this.assertUniqueResumeTrackName(name);
      input = { ...input, name };
    }
    if (table === 'courses') {
      const conflict = this.findCourseConflict(input);
      if (conflict) throw new Error(`课程时间冲突：${conflict.name} ${conflict.startTime}–${conflict.endTime}`);
    }
    const now = new Date().toISOString();
    const record = { id: randomUUID(), created_at: now, updated_at: now };
    for (const [key, value] of Object.entries(input)) {
      const column = snake(key);
      if (allowed.includes(column)) record[column] = value;
    }
    const columns = Object.keys(record);
    const placeholders = columns.map(() => '?').join(', ');
    this.db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(...columns.map((key) => record[key]));
    return this.get(table, record.id);
  }

  update(table, id, input) {
    const allowed = TABLES[table];
    if (!allowed) throw new Error('未知资源');
    if (table === 'resume_tracks' && input.name !== undefined) {
      const name = String(input.name ?? '').normalize('NFKC').trim();
      this.assertUniqueResumeTrackName(name, id);
      input = { ...input, name };
    }
    if (table === 'courses') {
      const existing = this.get(table, id);
      const conflict = this.findCourseConflict({ ...existing, ...input }, id);
      if (conflict) throw new Error(`课程时间冲突：${conflict.name} ${conflict.startTime}–${conflict.endTime}`);
    }
    const values = {};
    for (const [key, value] of Object.entries(input)) {
      const column = snake(key);
      if (allowed.includes(column)) values[column] = value;
    }
    values.updated_at = new Date().toISOString();
    const columns = Object.keys(values);
    if (!columns.length) return this.get(table, id);
    const result = this.db.prepare(`UPDATE ${table} SET ${columns.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...columns.map((key) => values[key]), id);
    if (!result.changes) throw new Error('记录不存在');
    return this.get(table, id);
  }

  remove(table, id) {
    if (!TABLES[table]) throw new Error('未知资源');
    const result = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (!result.changes) throw new Error('记录不存在');
  }

  createMemo(input) { return this.create('memos', { ...input, status: 'inbox' }); }
  getMemo(id) { return this.get('memos', id); }

  convertMemo(id, planInput) {
    return this.transaction(() => {
      const memo = this.getMemo(id);
      if (!memo || memo.status !== 'inbox') throw new Error('备忘不可转换');
      const plan = this.create('plans', { title: memo.content, status: 'todo', ...planInput, sourceMemoId: id });
      this.update('memos', id, { status: 'converted', archivedAt: new Date().toISOString(), convertedPlanId: plan.id });
      return plan;
    });
  }

  createApplication(input) {
    return this.transaction(() => {
      const application = this.create('applications', input);
      this.db.prepare('INSERT INTO stage_history (id, application_id, from_stage, to_stage, changed_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), application.id, null, application.stage, new Date().toISOString());
      return application;
    });
  }

  saveSemester(input, id = null) {
    return this.transaction(() => {
      if (input.isCurrent) this.db.exec('UPDATE semesters SET is_current = 0');
      const semester = id ? this.update('semesters', id, input) : this.create('semesters', input);
      this.ensureSchedulePeriods(semester.id);
      return semester;
    });
  }

  createResumeVersion(input, makeCurrent = true) {
    return this.transaction(() => {
      const version = this.create('resume_versions', input);
      if (makeCurrent) this.setCurrentResumeVersion(input.trackId, version.id);
      return version;
    });
  }

  replaceResumeVersionFile(id, input) {
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE resume_versions SET original_name = ?, stored_name = ?, mime_type = ?, size = ?, sha256 = ?, updated_at = ? WHERE id = ?`)
        .run(input.originalName, input.storedName, input.mimeType, input.size, input.sha256, new Date().toISOString(), id);
      if (!result.changes) throw new Error('简历版本不存在');
      return this.get('resume_versions', id);
    });
  }

  updateApplication(id, input) {
    return this.transaction(() => {
      const existing = this.get('applications', id);
      if (!existing) throw new Error('岗位不存在');
      const updated = this.update('applications', id, input);
      if (input.stage && input.stage !== existing.stage) {
        this.db.prepare('INSERT INTO stage_history (id, application_id, from_stage, to_stage, changed_at) VALUES (?, ?, ?, ?, ?)')
          .run(randomUUID(), id, existing.stage, input.stage, new Date().toISOString());
      }
      return updated;
    });
  }

  applicationDetail(id) {
    const application = this.get('applications', id);
    return {
      ...application,
      resumeVersion: application?.resumeVersionId ? this.get('resume_versions', application.resumeVersionId) : null,
      history: this.db.prepare('SELECT * FROM stage_history WHERE application_id = ? ORDER BY changed_at DESC, rowid DESC').all(id).map(present),
      interviews: this.db.prepare('SELECT * FROM interviews WHERE application_id = ? ORDER BY scheduled_at').all(id).map(present)
    };
  }

  setCurrentResumeVersion(trackId, versionId) {
    const version = this.get('resume_versions', versionId);
    if (!version || version.trackId !== trackId) throw new Error('简历版本不属于该方向');
    return this.update('resume_tracks', trackId, { currentVersionId: versionId });
  }

  resumeVersionReferenced(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM applications WHERE resume_version_id = ? LIMIT 1').get(id));
  }

  resumeVersionReferenceCount(id) {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM applications WHERE resume_version_id = ?').get(id).count);
  }

  deleteResumeVersion(id) {
    return this.transaction(() => {
      const version = this.get('resume_versions', id);
      if (!version) throw new Error('简历版本不存在');
      if (this.resumeVersionReferenced(id)) throw new Error('该版本已被岗位引用，只能归档');
      this.db.prepare('UPDATE resume_tracks SET current_version_id = NULL, updated_at = ? WHERE current_version_id = ?').run(new Date().toISOString(), id);
      this.remove('resume_versions', id);
      return version;
    });
  }

  removeResumeTrack(id) {
    if (this.db.prepare('SELECT 1 FROM resume_versions WHERE track_id = ? LIMIT 1').get(id)) throw new Error('请先处理该方向下的简历版本');
    this.remove('resume_tracks', id);
  }
}
