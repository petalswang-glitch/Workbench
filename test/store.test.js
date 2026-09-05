import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/store.js';

test('备忘转换会原子地创建计划并归档备忘', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const memo = store.createMemo({ content: '整理项目案例' });

  const plan = store.convertMemo(memo.id, { dueDate: '2026-09-10', priority: 'high' });

  assert.equal(plan.title, '整理项目案例');
  assert.equal(store.getMemo(memo.id).status, 'converted');
  assert.equal(store.getMemo(memo.id).convertedPlanId, plan.id);
});

test('岗位阶段变化会保留历史记录', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const application = store.createApplication({ company: '示例公司', roleName: '算法工程师', stage: '已投递' });

  store.updateApplication(application.id, { stage: '一面' });

  const detail = store.applicationDetail(application.id);
  assert.deepEqual(detail.history.map((item) => item.toStage), ['一面', '已投递']);
});

test('删除当前简历版本会清空方向的当前版本引用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const track = store.create('resume_tracks', { name: 'AI Agent 简历' });
  const version = store.create('resume_versions', { trackId: track.id, versionName: 'v1', originalName: 'resume.pdf', storedName: 'one.pdf', mimeType: 'application/pdf', size: 4, sha256: 'demo' });
  store.setCurrentResumeVersion(track.id, version.id);

  store.deleteResumeVersion(version.id);

  assert.equal(store.get('resume_tracks', track.id).currentVersionId, null);
});

test('简历方向名称规范化后不可重复，但不同方向可以复用版本名称', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const agent = store.create('resume_tracks', { name: '  AI Agent  ' });
  assert.equal(agent.name, 'AI Agent');
  assert.throws(() => store.create('resume_tracks', { name: 'ＡＩ　ＡＧＥＮＴ' }), /名称已存在/);
  const product = store.create('resume_tracks', { name: '产品工程' });

  const first = store.create('resume_versions', { trackId: agent.id, versionName: 'v1', originalName: 'agent.docx', storedName: 'agent.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 4, sha256: 'agent' });
  const second = store.create('resume_versions', { trackId: product.id, versionName: 'v1', originalName: 'product.docx', storedName: 'product.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 4, sha256: 'product' });

  assert.equal(first.versionName, second.versionName);
  assert.throws(() => store.update('resume_tracks', product.id, { name: 'ai agent' }), /名称已存在/);
});

test('课程保存会拒绝同教学周内的时间冲突', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const semester = store.saveSemester({ name: '秋季学期', startsOn: '2026-09-07', totalWeeks: 18, isCurrent: 1 });
  const base = { semesterId: semester.id, name: '课程 A', weekday: 2, startTime: '09:00', endTime: '10:00', startWeek: 1, endWeek: 18, weekPattern: 'every' };
  store.create('courses', base);

  assert.throws(() => store.create('courses', { ...base, name: '课程 B', startTime: '09:30', endTime: '10:30' }), /课程时间冲突/);
  assert.doesNotThrow(() => store.create('courses', { ...base, name: '课程 C', startTime: '10:00', endTime: '11:00' }));
});

test('创建学期会带有可编辑的十二节作息时间', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const semester = store.saveSemester({ name: '2026 秋季学期', startsOn: '2026-09-07', totalWeeks: 17, isCurrent: 1 });
  const periods = store.listSchedulePeriods(semester.id);

  assert.equal(periods.length, 12);
  assert.deepEqual(periods[0], { ...periods[0], semesterId: semester.id, periodNo: 1, startTime: '08:00', endTime: '08:45' });
  assert.equal(periods[11].periodNo, 12);
  const course = store.create('courses', {
    semesterId: semester.id,
    name: '跟随作息的课程',
    weekday: 1,
    startTime: '08:00',
    endTime: '09:35',
    startPeriod: 1,
    endPeriod: 2,
    startWeek: 1,
    endWeek: 17,
    weekPattern: 'every'
  });

  const overlapping = periods.map(period => period.periodNo === 2 ? { ...period, startTime: '08:30' } : period);
  assert.throws(() => store.saveSchedulePeriods(semester.id, overlapping), /时间重叠/);
  const updated = periods.map(period => period.periodNo === 1 ? { ...period, startTime: '07:50', endTime: '08:35' } : period);
  store.saveSchedulePeriods(semester.id, updated);
  assert.equal(store.listSchedulePeriods(semester.id)[0].startTime, '07:50');
  assert.equal(store.get('courses', course.id).startTime, '07:50');
  assert.equal(store.get('courses', course.id).endTime, '09:35');
});

test('旧课程表迁移会根据原有钟点推断节次', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const legacy = new DatabaseSync(join(dir, 'workspace.sqlite'));
  legacy.exec(`
    CREATE TABLE semesters (id TEXT PRIMARY KEY, name TEXT NOT NULL, starts_on TEXT NOT NULL, total_weeks INTEGER NOT NULL DEFAULT 18, is_current INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE courses (id TEXT PRIMARY KEY, semester_id TEXT NOT NULL, name TEXT NOT NULL, weekday INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', start_week INTEGER NOT NULL, end_week INTEGER NOT NULL, week_pattern TEXT NOT NULL DEFAULT 'every', teacher TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO semesters VALUES ('legacy-semester', '旧学期', '2026-09-07', 18, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO courses VALUES ('legacy-course', 'legacy-semester', '旧课程', 1, '16:00', '17:35', '旧教室', 1, 18, 'every', '旧老师', '旧备注', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const course = store.get('courses', 'legacy-course');
  assert.equal(course.startPeriod, 7);
  assert.equal(course.endPeriod, 8);
});

test('岗位详情会带出所关联的简历版本', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const track = store.create('resume_tracks', { name: 'AI Agent' });
  const version = store.create('resume_versions', { trackId: track.id, versionName: 'v3', originalName: 'agent.pdf', storedName: 'agent.pdf', mimeType: 'application/pdf', size: 10, sha256: 'hash' });
  const application = store.createApplication({ company: '示例公司', roleName: '产品经理', stage: '已投递', resumeVersionId: version.id });

  assert.equal(store.applicationDetail(application.id).resumeVersion.versionName, 'v3');
  assert.equal(store.resumeVersionReferenceCount(version.id), 1);
});

test('投递渠道可以独立保存显示名称和可跳转网址', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const application = store.createApplication({ company: '示例公司', roleName: '产品经理', channel: 'https://example.com/apply', channelLabel: 'Boss 直聘' });
  assert.equal(application.channel, 'https://example.com/apply');
  assert.equal(application.channelLabel, 'Boss 直聘');

  const renamed = store.updateApplication(application.id, { channelLabel: '校招官网' });
  assert.equal(renamed.channel, 'https://example.com/apply');
  assert.equal(renamed.channelLabel, '校招官网');
});

test('简历文件替换会保留版本标识和岗位引用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const track = store.create('resume_tracks', { name: 'AI Agent' });
  const version = store.create('resume_versions', { trackId: track.id, versionName: 'v1', originalName: 'missing.pdf', storedName: 'missing.pdf', mimeType: 'application/pdf', size: 10, sha256: 'old' });
  const application = store.createApplication({ company: '示例公司', roleName: '产品经理', stage: '已投递', resumeVersionId: version.id });

  const replaced = store.replaceResumeVersionFile(version.id, { originalName: 'restored.pdf', storedName: 'restored.pdf', mimeType: 'application/pdf', size: 12, sha256: 'new' });

  assert.equal(replaced.id, version.id);
  assert.equal(replaced.originalName, 'restored.pdf');
  assert.equal(store.get('applications', application.id).resumeVersionId, version.id);
  assert.equal(store.resumeVersionReferenceCount(version.id), 1);
});

test('快速备忘可以归档并按需删除', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const memo = store.createMemo({ content: '清理收件箱' });

  const archived = store.update('memos', memo.id, { status: 'archived', archivedAt: '2026-09-04T00:00:00.000Z' });
  assert.equal(archived.status, 'archived');
  store.remove('memos', memo.id);
  assert.equal(store.getMemo(memo.id), null);
});
