import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WorkspaceStore } from '../src/store.js';
import { buildBackup, parseBackup, restoreBackup } from '../src/backup.js';

test('完整备份可以恢复业务记录和受管文件', async (t) => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'workbench-source-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'workbench-target-'));
  const source = new WorkspaceStore(sourceDir);
  const target = new WorkspaceStore(targetDir);
  t.after(async () => { source.close(); target.close(); await rm(sourceDir,{recursive:true,force:true}); await rm(targetDir,{recursive:true,force:true}); });
  source.createMemo({ content: '不会丢失的备忘' });
  const file = Buffer.from('%PDF-1.4 sample');
  const track = source.create('resume_tracks', { name: '通用简历' });
  source.create('resume_versions', { trackId: track.id, versionName: 'v1', originalName: 'sample.pdf', storedName: 'sample.pdf', mimeType: 'application/pdf', size: file.length, sha256: createHash('sha256').update(file).digest('hex') });
  await writeFile(join(sourceDir, 'resumes', 'sample.pdf'), file);

  restoreBackup(target, buildBackup(source));

  assert.equal(target.list('memos')[0].content, '不会丢失的备忘');
  assert.equal((await readFile(join(targetDir, 'resumes', 'sample.pdf'))).toString(), '%PDF-1.4 sample');
});

test('备份会保留投递渠道的显示名称，并兼容没有该字段的旧备份', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-channel-backup-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createApplication({ company: '示例公司', roleName: '工程师', channel: 'https://example.com/apply', channelLabel: '校招官网' });

  const payload = JSON.parse(gunzipSync(buildBackup(store)).toString('utf8'));
  assert.equal(payload.version, 3);
  assert.equal(payload.data.applications[0].channel_label, '校招官网');
  const legacy = JSON.parse(JSON.stringify(payload));
  legacy.version = 2;
  legacy.data.applications = legacy.data.applications.map(row => { const { channel_label, ...old } = row; return old; });
  const parsed = parseBackup(gzipSync(Buffer.from(JSON.stringify(legacy))));
  assert.equal(parsed.data.applications[0].channel_label, '');
});

test('旧版本课表备份会按原有钟点补出节次和默认作息', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-'));
  const store = new WorkspaceStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const semester = store.saveSemester({ name: '旧课表学期', startsOn: '2026-09-07', totalWeeks: 18, isCurrent: 1 });
  store.create('courses', { semesterId: semester.id, name: '旧课程', weekday: 1, startTime: '16:00', endTime: '17:35', startWeek: 1, endWeek: 18, weekPattern: 'every' });

  const payload = JSON.parse(gunzipSync(buildBackup(store)).toString('utf8'));
  const legacyCourse = { ...payload.data.courses[0] };
  delete legacyCourse.start_period;
  delete legacyCourse.end_period;
  delete legacyCourse.custom_weeks;
  payload.version = 1;
  delete payload.data.schedule_periods;
  payload.data.courses = [legacyCourse];

  const normalized = parseBackup(gzipSync(Buffer.from(JSON.stringify(payload))));
  assert.equal(normalized.data.courses[0].start_period, 7);
  assert.equal(normalized.data.courses[0].end_period, 8);
  assert.equal(normalized.data.schedule_periods.length, 12);
});
