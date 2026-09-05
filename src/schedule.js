export const DEFAULT_SCHEDULE_PERIODS = [
  ['第1节', '08:00', '08:45'],
  ['第2节', '08:50', '09:35'],
  ['第3节', '10:00', '10:45'],
  ['第4节', '10:50', '11:35'],
  ['第5节', '14:00', '14:45'],
  ['第6节', '14:50', '15:35'],
  ['第7节', '16:00', '16:45'],
  ['第8节', '16:50', '17:35'],
  ['第9节', '19:00', '19:45'],
  ['第10节', '19:50', '20:35'],
  ['第11节', '20:45', '21:30'],
  ['第12节', '21:35', '22:20']
].map(([label, startTime, endTime], index) => ({ periodNo: index + 1, label, startTime, endTime }));

export function defaultSchedulePeriods() {
  return DEFAULT_SCHEDULE_PERIODS.map(period => ({ ...period }));
}
