const minuteMs = 60 * 1000;

export function formatLocalClock(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function formatLocalDeskDate(date = new Date()) {
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${date.toLocaleDateString('zh-CN', { weekday: 'short' })}`;
}

export function millisecondsUntilNextMinute(date = new Date(), safetyMs = 50) {
  const elapsed = date.getSeconds() * 1000 + date.getMilliseconds();
  return Math.max(safetyMs, minuteMs - elapsed + safetyMs);
}

export function scheduleMinuteUpdates(callback, setTimeoutFn = setTimeout, setIntervalFn = setInterval, clearTimeoutFn = clearTimeout, clearIntervalFn = clearInterval) {
  let intervalId = null;
  const timeoutId = setTimeoutFn(() => {
    callback();
    intervalId = setIntervalFn(callback, minuteMs);
  }, millisecondsUntilNextMinute());
  return () => {
    clearTimeoutFn(timeoutId);
    if (intervalId !== null) clearIntervalFn(intervalId);
  };
}
