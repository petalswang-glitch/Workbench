import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalClock, formatLocalDeskDate, millisecondsUntilNextMinute } from '../web/clock.js';

test('侧栏时钟在下一分钟边界后立即刷新，不会按页面打开时间漂移整一分钟', () => {
  const almostNextMinute = new Date(2026, 8, 5, 13, 14, 59, 900);
  assert.equal(millisecondsUntilNextMinute(almostNextMinute), 150);
  assert.equal(millisecondsUntilNextMinute(new Date(2026, 8, 5, 13, 14, 0, 0)), 60050);
});

test('本地时钟和日期使用浏览器本地时间格式化', () => {
  const value = new Date(2026, 8, 5, 13, 14, 0, 0);
  assert.match(formatLocalClock(value), /13:14/);
  assert.match(formatLocalDeskDate(value), /9月5日/);
});
