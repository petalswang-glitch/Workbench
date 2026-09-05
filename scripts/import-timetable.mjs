import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from '../src/store.js';
import { importTimetableWorkbook } from '../src/timetable-import.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(readFileSync(resolve(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const firstArgument = process.argv[2] || '';
const workbookPath = extname(firstArgument).toLowerCase() === '.xlsx' ? resolve(firstArgument) : resolve(root, '我的课表.xlsx');
const dataDir = resolve(extname(firstArgument).toLowerCase() === '.xlsx' ? (process.argv[3] || config.dataDir) : (firstArgument || config.dataDir));
const store = new WorkspaceStore(dataDir);

try {
  const result = importTimetableWorkbook(store, readFileSync(workbookPath), {
    startsOn: process.env.WORKBENCH_TERM_START || undefined,
    totalWeeks: process.env.WORKBENCH_TOTAL_WEEKS || undefined,
    sourceName: basename(workbookPath)
  });
  console.log(`已从 ${basename(workbookPath)} 识别 ${result.totalCount} 条课程安排，新增 ${result.importedCount} 条，跳过重复 ${result.skippedCount} 条。`);
} finally {
  store.close();
}
