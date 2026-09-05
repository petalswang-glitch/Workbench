import test from 'node:test';
import assert from 'node:assert/strict';
import { coursesConflict, isOverdue, occursOn, parseCustomWeeks } from '../src/domain.js';

test('单双周课程只在匹配的教学周出现', () => {
  const semester = { startsOn: '2026-09-07' };
  const course = { weekday: 1, startWeek: 1, endWeek: 18, weekPattern: 'odd' };

  assert.equal(occursOn(course, semester, '2026-09-07'), true);
  assert.equal(occursOn(course, semester, '2026-09-14'), false);
  assert.equal(occursOn(course, semester, '2026-09-08'), false);
});

test('自定义周次课程只在明确列出的教学周出现', () => {
  const semester = { startsOn: '2026-09-07' };
  const course = { weekday: 1, startWeek: 1, endWeek: 18, weekPattern: 'custom', customWeeks: '1, 3, 5-6' };

  assert.equal(occursOn(course, semester, '2026-09-07'), true);
  assert.equal(occursOn(course, semester, '2026-09-21'), true);
  assert.equal(occursOn(course, semester, '2026-10-05'), true);
  assert.equal(occursOn(course, semester, '2026-09-28'), false);
  assert.equal(occursOn(course, semester, '2026-10-19'), false);
});

test('自定义周次解析会拒绝不完整或反向区间', () => {
  assert.deepEqual([...parseCustomWeeks('1, 3, 5-6')], [1, 3, 5, 6]);
  assert.equal(parseCustomWeeks('1,,3'), null);
  assert.equal(parseCustomWeeks('6-5'), null);
  assert.equal(parseCustomWeeks('1,odd'), null);
});

test('无截止时间的计划在截止日期结束后才逾期', () => {
  const plan = { dueDate: '2026-09-04', dueTime: null, status: 'todo' };

  assert.equal(isOverdue(plan, new Date('2026-09-04T12:00:00+08:00')), false);
  assert.equal(isOverdue(plan, new Date('2026-09-05T00:01:00+08:00')), true);
  assert.equal(isOverdue({ ...plan, status: 'done' }, new Date('2026-09-05T00:01:00+08:00')), false);
});

test('同日且教学周与时间重叠的课程会被识别为冲突', () => {
  const base = { weekday: 2, startTime: '09:00', endTime: '10:00', startWeek: 1, endWeek: 18, weekPattern: 'every' };

  assert.equal(coursesConflict(base, { ...base, startTime: '09:30', endTime: '10:30' }), true);
  assert.equal(coursesConflict(base, { ...base, startTime: '10:00', endTime: '11:00' }), false);
  assert.equal(coursesConflict({ ...base, weekPattern: 'odd' }, { ...base, weekPattern: 'even' }), false);
});
