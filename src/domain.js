const DAY_MS = 86_400_000;

function utcDate(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function teachingWeek(startsOn, dateText) {
  return Math.floor((utcDate(dateText) - utcDate(startsOn)) / (7 * DAY_MS)) + 1;
}

export function occursOn(course, semester, dateText) {
  const date = utcDate(dateText);
  const weekday = date.getUTCDay() || 7;
  const week = teachingWeek(semester.startsOn, dateText);
  if (weekday !== Number(course.weekday) || week < course.startWeek || week > course.endWeek) return false;
  return matchesWeekPattern(course.weekPattern, week, course.customWeeks);
}

export function parseCustomWeeks(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const weeks = new Set();
  for (const token of text.split(',')) {
    const part = token.trim();
    if (!part) return null;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end - start > 52) return null;
      for (let current = start; current <= end; current += 1) weeks.add(current);
      continue;
    }
    if (!/^\d+$/.test(part) || Number(part) < 1) return null;
    weeks.add(Number(part));
  }
  return weeks;
}

export function customWeekSet(value) {
  return parseCustomWeeks(value) ?? new Set();
}

export function matchesWeekPattern(pattern, week, customWeeks = '') {
  if (pattern === 'odd') return week % 2 === 1;
  if (pattern === 'even') return week % 2 === 0;
  if (pattern === 'custom') return customWeekSet(customWeeks).has(Number(week));
  return true;
}

export function coursesConflict(first, second) {
  if (Number(first.weekday) !== Number(second.weekday)) return false;
  if (String(first.startTime) >= String(second.endTime) || String(second.startTime) >= String(first.endTime)) return false;
  const startWeek = Math.max(Number(first.startWeek), Number(second.startWeek));
  const endWeek = Math.min(Number(first.endWeek), Number(second.endWeek));
  for (let week = startWeek; week <= endWeek; week += 1) {
    if (matchesWeekPattern(first.weekPattern, week, first.customWeeks) && matchesWeekPattern(second.weekPattern, week, second.customWeeks)) return true;
  }
  return false;
}

export function isOverdue(plan, now = new Date()) {
  if (plan.status === 'done' || !plan.dueDate) return false;
  const time = plan.dueTime ? `${plan.dueTime}:00` : '23:59:59.999';
  return now > new Date(`${plan.dueDate}T${time}`);
}
