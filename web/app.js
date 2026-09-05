import { formatLocalClock, formatLocalDeskDate, scheduleMinuteUpdates } from './clock.js';
import { compactPickerMarkup } from './compact-picker.js';
import { applicationViewModel } from './application-view.js';
import { applicationTextPickerMeta, applicationTextPickerOptions } from './application-picker.js';

const content = document.querySelector('#content');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
const confirmModal = document.querySelector('#confirm-modal');
const confirmCard = confirmModal.querySelector('.confirm-card');
const confirmKicker = document.querySelector('#confirm-kicker');
const confirmTitle = document.querySelector('#confirm-title');
const confirmMessage = document.querySelector('#confirm-message');
const confirmOk = document.querySelector('[data-confirm-ok]');
const appShell = document.querySelector('.app-shell');
const sidebar = document.querySelector('#sidebar');
const sidebarToggle = document.querySelector('#sidebar-toggle');
const sidebarOpen = document.querySelector('#sidebar-open');
const sidebarWindow = document.querySelector('.sidebar-window');
const sidebarWindowToggle = document.querySelector('[data-sidebar-window-toggle]');
const titles = {
  dashboard: ['TODAY / 今日', '今天，从重点开始'],
  courses: ['WEEK / 教学周', '课表'],
  applications: ['PIPELINE / 求职进展', '岗位投递'],
  resumes: ['ARCHIVE / 版本库', '简历'],
  plans: ['ACTIONS / 行动', '计划'],
  settings: ['LOCAL / 本机数据', '设置']
};
const pageMeta = {
  dashboard: { stamp: 'DESK / 01', caption: 'A DAILY INDEX' },
  courses: { stamp: 'WEEK / 02', caption: 'CLASSROOM MAP' },
  applications: { stamp: 'PIPE / 03', caption: 'NEXT MOVE' },
  resumes: { stamp: 'FILE / 04', caption: 'VERSION SHELF' },
  plans: { stamp: 'DO / 05', caption: 'ACTION FIELD' },
  settings: { stamp: 'LOCAL / 06', caption: 'OFFLINE VAULT' }
};
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const stageOptions = ['待投递', '已投递', '笔试', '一面', '二面', 'HR 面', 'Offer', '拒绝', '主动放弃'];
const statusNames = { high: '高优先级', medium: '中优先级', low: '低优先级', overdue: '逾期', done: '已完成' };
let page = 'dashboard';
let cache = {};
let courseWeekOffset = 0;
let applicationResumeFilterId = '';
let toastTimer;
let lastFocusElement = null;
let confirmState = null;
let sidebarCollapsed = false;
let navigationToken = 0;
let detailRequestToken = 0;
let sidebarClockTimer;
let liveScheduleTimer;
let sidebarWindowCollapsed = false;
const themeStorageKey = 'personal-workbench-theme';
const freshEntryIds = new Set();
// Inline application edits survive a page switch during this browser session;
// a full refresh still intentionally clears unsaved drafts.
const applicationDrafts = new Map();
const applicationDraftVersions = new Map();
const applicationPendingRows = new Set();
let applicationsViewToken = 0;

const esc = (value = '') => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const safeHttpUrl = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};
const externalLinkMarkup = (value, label = '打开链接 ↗', className = 'btn small') => {
  const href = safeHttpUrl(value);
  return href ? `<a class="${className}" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : '';
};
const fmt = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: value.includes?.('T') ? '2-digit' : undefined, minute: value.includes?.('T') ? '2-digit' : undefined }).format(new Date(value)) : '—';
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const planIsOverdue = (plan, now = new Date()) => { if (plan.status === 'done' || !plan.dueDate) return false; const time = plan.dueTime ? `${plan.dueTime}:00` : '23:59:59.999'; return now > new Date(`${plan.dueDate}T${time}`); };
const empty = (title, text) => `<div class="empty"><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`;
const durationMinutes = (start, end) => {
  if (!start || !end) return 0;
  const [startHour, startMinute] = String(start).split(':').map(Number);
  const [endHour, endMinute] = String(end).split(':').map(Number);
  const value = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  return Number.isFinite(value) && value > 0 ? value : 0;
};
const formatHours = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
const freshKey = (kind, id) => `${kind}:${id}`;
const markFresh = (record, kind) => {
  if (record?.id === undefined || record?.id === null) return;
  const key = freshKey(kind, record.id);
  freshEntryIds.add(key);
  setTimeout(() => freshEntryIds.delete(key), 1100);
};
const freshClass = (kind, id) => freshEntryIds.has(freshKey(kind, id)) ? ' is-sticking' : '';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

const scrollableSelector = '.sidebar, .modal-card, .table-wrap, .week-grid, .week-table, .pipeline-grid';
const pageTriggerSelector = 'button[data-page], a[data-page], [role="button"][data-page]';
function captureScrollState() {
  const root = document.scrollingElement || document.documentElement;
  return {
    window: { left: Number(window.scrollX || root.scrollLeft || 0), top: Number(window.scrollY || root.scrollTop || 0) },
    elements: [...document.querySelectorAll(scrollableSelector)].map(element => ({ element, left: element.scrollLeft, top: element.scrollTop }))
  };
}
function restoreScrollState(state) {
  if (!state) return;
  const restore = () => {
    const root = document.scrollingElement || document.documentElement;
    if (typeof window.scrollTo === 'function') {
      try { window.scrollTo({ left: state.window.left, top: state.window.top, behavior: 'auto' }); } catch { window.scrollTo(state.window.left, state.window.top); }
    }
    root.scrollLeft = state.window.left;
    root.scrollTop = state.window.top;
    state.elements.forEach(({ element, left, top }) => {
      if (element && element.isConnected !== false) { element.scrollLeft = left; element.scrollTop = top; }
    });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore); else setTimeout(restore, 0);
}
function preserveScroll(action) {
  const state = captureScrollState();
  try { return action(); } finally { restoreScrollState(state); }
}
function refreshCurrentPage(renderer) {
  const state = captureScrollState();
  const expectedPage = page;
  const expectedToken = navigationToken + 1;
  const restoreIfCurrent = () => { if (page === expectedPage && navigationToken === expectedToken) restoreScrollState(state); };
  return Promise.resolve().then(() => renderer()).then(value => { restoreIfCurrent(); return value; }, error => { restoreIfCurrent(); throw error; });
}
function resetScrollPosition() {
  const root = document.scrollingElement || document.documentElement;
  if (typeof window.scrollTo === 'function') {
    try { window.scrollTo({ left: 0, top: 0, behavior: 'auto' }); } catch { window.scrollTo(0, 0); }
  }
  root.scrollLeft = 0;
  root.scrollTop = 0;
}
function syncThemeControls(theme = document.documentElement.dataset.theme || 'day') {
  document.querySelectorAll('[data-theme-choice]').forEach(control => {
    const active = control.dataset.themeChoice === theme;
    control.classList.toggle('is-active', active);
    control.setAttribute('aria-pressed', String(active));
  });
  const label = document.querySelector('[data-theme-status]');
  if (label) label.textContent = theme === 'night' ? '夜间桌面 · 墨蓝光线' : '白天桌面 · 暖纸光线';
}
function applyTheme(next = 'day', announce = false) {
  const theme = next === 'night' ? 'night' : 'day';
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  syncThemeControls(theme);
  try { localStorage.setItem(themeStorageKey, theme); } catch {}
  if (announce) toast(theme === 'night' ? '已切换到夜间桌面' : '已切换到白天桌面');
}
function updateDeskWindow() {
  const now = new Date();
  const time = document.querySelector('#sidebar-time');
  const date = document.querySelector('#sidebar-date');
  const current = document.querySelector('#sidebar-current-page');
  if (time) time.textContent = formatLocalClock(now);
  if (date) date.textContent = formatLocalDeskDate(now);
  if (current) current.textContent = titles[page]?.[1] || '今天，从重点开始';
}
function armLiveScheduleRefresh() {
  if (liveScheduleTimer) liveScheduleTimer();
  liveScheduleTimer = null;
  if (!['dashboard', 'courses'].includes(page)) return;
  liveScheduleTimer = scheduleMinuteUpdates(() => {
    if (!modal.hidden || !confirmModal.hidden) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (page === 'dashboard') refreshCurrentPage(renderDashboard);
    if (page === 'courses') refreshCurrentPage(renderCourses);
  });
}
const dissolve = element => {
  if (!element || reducedMotion()) return Promise.resolve();
  element.classList.add('is-dissolving');
  return new Promise(resolve => setTimeout(resolve, 440));
};
const isCurrentView = (view, token) => token === navigationToken && page === view;
const pageIntro = ({ kicker, title, copy, accent = 'sun', art = 'orbit', artLabel = '', stats = [] }) => `<section class="page-intro intro-${esc(accent)}" data-spotlight data-float>
  <div class="page-intro-copy"><p class="section-kicker">${esc(kicker)}</p><h2>${esc(title)}</h2><p>${esc(copy)}</p></div>
  <div class="page-intro-art art-${esc(art)}" aria-hidden="true"><span class="art-label">${esc(artLabel)}</span><span class="art-orbit one"></span><span class="art-orbit two"></span><span class="art-dot one"></span><span class="art-dot two"></span><span class="art-line one"></span><span class="art-line two"></span></div>
  <div class="page-intro-stats">${stats.map(stat => `<div class="intro-stat"${stat.key ? ` data-stat-key="${esc(stat.key)}"` : ''}><strong>${esc(stat.value)}</strong><span>${esc(stat.label)}</span></div>`).join('')}</div>
</section>`;
function dashboardFocus(d) {
  if (d.currentCourse) {
    const course = d.currentCourse;
    return { accent: 'blue', kicker: 'IN SESSION / 当前课程', title: course.name, copy: `${course.start_time}–${course.end_time} · ${course.location || '地点未填写'}。先把这一节留在眼前。`, action: '<button class="btn small" data-page="courses">打开课表</button>' };
  }
  if (d.nextCourse) {
    const course = d.nextCourse;
    const dateLabel = course.next_date && course.next_date !== d.date ? `${course.next_date} · ` : '';
    return { accent: 'blue', kicker: 'NEXT CLASS / 下一节课', title: course.name, copy: `${dateLabel}${course.start_time}–${course.end_time} · ${course.location || '地点未填写'}。还有一段时间可以准备。`, action: '<button class="btn small" data-page="courses">查看课表</button>' };
  }
  if (d.overdue[0]) {
    const plan = d.overdue[0];
    return { accent: 'coral', kicker: 'CLOSE THE LOOP / 先收尾', title: plan.title, copy: `已经逾期 · 截止 ${plan.dueDate}。先把这一件从桌面上移走。`, action: `<button class="btn small" data-plan-edit-dashboard="${esc(plan.id)}">打开计划</button>` };
  }
  if (d.todayPlans[0]) {
    const plan = d.todayPlans[0];
    return { accent: 'sun', kicker: 'FIRST MOVE / 第一行动', title: plan.title, copy: `${plan.category || '未分类'} · 截止 ${plan.dueDate}。从今天的第一项开始。`, action: `<button class="btn small" data-plan-edit-dashboard="${esc(plan.id)}">打开计划</button>` };
  }
  if (d.interviews[0]) {
    const interview = d.interviews[0];
    const appId = interview.application_id || interview.applicationId;
    return { accent: 'coral', kicker: 'UP NEXT / 接下来', title: `${interview.company} · ${interview.round_name || interview.roundName}`, copy: `${fmt(interview.scheduled_at || interview.scheduledAt)}。提前留出准备时间。`, action: `<button class="btn small" data-dashboard-app="${esc(appId)}">查看岗位</button>` };
  }
  if (d.courses[0]) {
    const course = d.courses[0];
    return { accent: 'blue', kicker: 'ON THE DESK / 今日课程', title: course.name, copy: `${course.start_time}–${course.end_time} · ${course.location || '地点未填写'}。给今天留出一段专注时间。`, action: '<button class="btn small" data-page="courses">查看课表</button>' };
  }
  return { accent: 'sage', kicker: 'OPEN DESK / 起笔', title: '桌面还在等第一笔', copy: '从一门课程、一个行动，或者一条快速备忘开始。记录下来，页面就会慢慢长出自己的节奏。', action: '<div class="starter-actions"><button class="btn small" data-page="plans">新增计划</button><button class="btn small" data-page="courses">设置课表</button><button class="btn small" data-page="applications">记录岗位</button></div>' };
}
const focusPanel = focus => `<aside class="focus-card focus-${esc(focus.accent)}" data-spotlight data-float><div class="focus-card-head"><span>${esc(focus.kicker)}</span><i aria-hidden="true"></i></div><h3>${esc(focus.title)}</h3><p>${esc(focus.copy)}</p><div class="focus-card-action">${focus.action}</div></aside>`;
const badge = (text, cls = '') => {
  const safe = ['high', 'medium', 'low', 'overdue', 'done', 'offer', 'stage', 'current'].includes(cls) ? cls : '';
  return `<span class="status-label ${safe}">${esc(statusNames[cls] || text)}</span>`;
};

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(value.error || '操作失败');
  }
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.blob();
}

function toast(message, bad = false) {
  const el = document.querySelector('#toast');
  clearTimeout(toastTimer);
  el.textContent = message;
  el.className = `toast show ${bad ? 'error' : ''}`;
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function filterCompactPicker(picker) {
  const search = picker.querySelector('[data-picker-search]');
  const options = [...picker.querySelectorAll('[data-picker-option]')];
  const query = String(search?.value || '').trim().toLocaleLowerCase('zh-CN');
  let visibleCount = 0;
  for (const option of options) {
    const value = String(option.dataset.value || '').toLocaleLowerCase('zh-CN');
    const label = String(option.textContent || '').trim().toLocaleLowerCase('zh-CN');
    const visible = !query || value.includes(query) || label.includes(query);
    option.hidden = !visible;
    if (visible) visibleCount += 1;
  }
  const create = picker.querySelector('[data-picker-create]');
  if (create) {
    const customValue = String(search?.value || '').trim();
    const duplicate = options.some(option => String(option.dataset.value || '').trim().toLocaleLowerCase('zh-CN') === customValue.toLocaleLowerCase('zh-CN') || String(option.textContent || '').trim().toLocaleLowerCase('zh-CN') === customValue.toLocaleLowerCase('zh-CN'));
    create.hidden = !customValue || duplicate;
    const createLabel = create.querySelector('[data-picker-create-label]');
    if (createLabel) createLabel.textContent = customValue;
  }
  const empty = picker.querySelector('[data-picker-empty]');
  if (empty) empty.hidden = visibleCount > 0 || Boolean(create && !create.hidden);
}

function closeCompactPickers(except = null) {
  document.querySelectorAll('[data-compact-picker].is-open').forEach(picker => {
    if (picker !== except) setCompactPickerOpen(picker, false);
  });
}

function positionCompactPickerPopover(picker) {
  const trigger = picker?.querySelector('[data-picker-trigger]');
  const popover = picker?.querySelector('[data-picker-popover]');
  if (!trigger || !popover || popover.hidden) return;
  const viewportPadding = 16;
  const gap = 8;
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const width = popoverRect.width || Math.min(260, window.innerWidth - viewportPadding * 2);
  const left = Math.max(viewportPadding, Math.min(triggerRect.left, window.innerWidth - width - viewportPadding));
  const roomBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
  const roomAbove = triggerRect.top - viewportPadding;
  const flipped = roomBelow < popoverRect.height && roomAbove > roomBelow;
  const top = flipped ? triggerRect.top - popoverRect.height - gap : triggerRect.bottom + gap;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(Math.max(viewportPadding, top))}px`;
  picker.classList.toggle('is-flipped', flipped);
}

function setCompactPickerOpen(picker, open, returnFocus = false) {
  const trigger = picker?.querySelector('[data-picker-trigger]');
  const popover = picker?.querySelector('[data-picker-popover]');
  if (!trigger || !popover) return;
  if (open) {
    closeCompactPickers(picker);
    picker.classList.add('is-open', 'is-fixed-popover');
    trigger.setAttribute('aria-expanded', 'true');
    popover.hidden = false;
    popover.style.left = '0px';
    popover.style.top = '0px';
    filterCompactPicker(picker);
    positionCompactPickerPopover(picker);
    requestAnimationFrame(() => picker.querySelector('[data-picker-search]')?.focus({ preventScroll: true }));
  } else {
    picker.classList.remove('is-open', 'is-fixed-popover', 'is-flipped');
    trigger.setAttribute('aria-expanded', 'false');
    popover.hidden = true;
    popover.style.removeProperty('left');
    popover.style.removeProperty('top');
    if (returnFocus) trigger.focus({ preventScroll: true });
  }
}

function addCompactPickerOption(picker, value, label) {
  const options = picker.querySelector('[data-picker-options]');
  if (!options) return null;
  const existing = [...options.querySelectorAll('[data-picker-option]')].find(option => option.dataset.value === value);
  if (existing) return existing;
  const option = document.createElement('button');
  option.type = 'button';
  option.className = 'compact-picker-option';
  option.setAttribute('role', 'option');
  option.dataset.pickerOption = '';
  option.dataset.value = value;
  option.setAttribute('aria-selected', 'false');
  const text = document.createElement('span');
  text.textContent = label;
  option.append(text);
  options.prepend(option);
  return option;
}

function commitCompactPicker(picker, value, label) {
  const input = picker.querySelector('input[type="hidden"]');
  const currentLabel = picker.querySelector('[data-picker-label]');
  if (!input || input.disabled) return;
  const normalizedValue = String(value ?? '');
  const normalizedLabel = String(label ?? normalizedValue);
  if (picker.dataset.pickerAllowCustom === 'true' && normalizedValue) addCompactPickerOption(picker, normalizedValue, normalizedLabel);
  input.dataset.pickerValue = normalizedValue;
  input.value = normalizedValue;
  if (currentLabel) currentLabel.textContent = normalizedLabel;
  picker.querySelectorAll('[data-picker-option]').forEach(option => option.setAttribute('aria-selected', String(option.dataset.value === normalizedValue)));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  setCompactPickerOpen(picker, false, true);
}

function bindCompactPickers(root = document) {
  root.querySelectorAll('[data-compact-picker]').forEach(picker => {
    if (picker.dataset.pickerBound === 'true') return;
    picker.dataset.pickerBound = 'true';
    const hiddenInput = picker.querySelector('input[type="hidden"]');
    if (hiddenInput && hiddenInput.value !== hiddenInput.dataset.pickerValue) hiddenInput.value = hiddenInput.dataset.pickerValue || '';
    const trigger = picker.querySelector('[data-picker-trigger]');
    const search = picker.querySelector('[data-picker-search]');
    const options = picker.querySelector('[data-picker-options]');
    const create = picker.querySelector('[data-picker-create]');
    trigger?.addEventListener('click', () => setCompactPickerOpen(picker, !picker.classList.contains('is-open')));
    search?.addEventListener('input', () => filterCompactPicker(picker));
    search?.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setCompactPickerOpen(picker, false, true);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        picker.querySelector('[data-picker-option]:not([hidden])')?.focus();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (create && !create.hidden) commitCompactPicker(picker, search.value.trim(), search.value.trim());
        else {
          const option = picker.querySelector('[data-picker-option]:not([hidden])');
          if (option) commitCompactPicker(picker, option.dataset.value, option.textContent.trim());
        }
      }
    });
    options?.addEventListener('click', event => {
      const option = event.target instanceof Element ? event.target.closest('[data-picker-option]') : null;
      if (option && option.closest('[data-picker-options]') === options) commitCompactPicker(picker, option.dataset.value, option.textContent.trim());
    });
    create?.addEventListener('click', () => commitCompactPicker(picker, search.value.trim(), search.value.trim()));
  });
}

window.addEventListener('resize', () => document.querySelectorAll('[data-compact-picker].is-open').forEach(positionCompactPickerPopover));
document.addEventListener('scroll', () => document.querySelectorAll('[data-compact-picker].is-open').forEach(positionCompactPickerPopover), true);

function setSidebar(collapsed, focus = true) {
  sidebarCollapsed = collapsed;
  appShell.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarOpen.setAttribute('aria-expanded', String(!collapsed));
  sidebarOpen.hidden = !collapsed;
  sidebar.setAttribute('aria-hidden', String(collapsed));
  sidebar.inert = collapsed;
  const icon = sidebarToggle.querySelector('span:first-child');
  const label = sidebarToggle.querySelector('span:last-child');
  if (icon) icon.textContent = collapsed ? '›' : '‹';
  if (label) label.textContent = collapsed ? '展开导航' : '收起导航';
  try { localStorage.setItem('personal-workbench-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
  if (focus) (collapsed ? sidebarOpen : sidebarToggle).focus();
}

sidebarToggle.addEventListener('click', () => setSidebar(true));
sidebarOpen.addEventListener('click', () => setSidebar(false));
try { setSidebar(localStorage.getItem('personal-workbench-sidebar-collapsed') === '1', false); } catch { setSidebar(false, false); }
try { sidebarWindowCollapsed = localStorage.getItem('personal-workbench-window-collapsed') === '1'; } catch {}
if (sidebarWindow) sidebarWindow.classList.toggle('is-collapsed', sidebarWindowCollapsed);
if (sidebarWindowToggle) {
  sidebarWindowToggle.setAttribute('aria-expanded', String(!sidebarWindowCollapsed));
  sidebarWindowToggle.textContent = sidebarWindowCollapsed ? '+' : '−';
  sidebarWindowToggle.addEventListener('click', () => {
    sidebarWindowCollapsed = !sidebarWindowCollapsed;
    sidebarWindow?.classList.toggle('is-collapsed', sidebarWindowCollapsed);
    sidebarWindowToggle.setAttribute('aria-expanded', String(!sidebarWindowCollapsed));
    sidebarWindowToggle.textContent = sidebarWindowCollapsed ? '+' : '−';
    try { localStorage.setItem('personal-workbench-window-collapsed', sidebarWindowCollapsed ? '1' : '0'); } catch {}
  });
}
try { applyTheme(localStorage.getItem(themeStorageKey) || 'day'); } catch { applyTheme('day'); }
updateDeskWindow();
sidebarClockTimer = scheduleMinuteUpdates(updateDeskWindow);

function openModal(html) {
  lastFocusElement = document.activeElement;
  modalContent.innerHTML = html;
  const heading = modalContent.querySelector('h2');
  const dialog = modal.querySelector('.modal-card');
  if (heading) { heading.id = 'modal-title'; dialog.setAttribute('aria-labelledby', 'modal-title'); }
  modal.hidden = false;
  document.body.classList.add('modal-open');
  modalContent.querySelector('input:not([type="hidden"]),select,textarea,button')?.focus();
}

function closeModal() {
  detailRequestToken += 1;
  const restoreTarget = lastFocusElement;
  modal.hidden = true;
  modalContent.innerHTML = '';
  document.body.classList.remove('modal-open');
  const fallback = document.querySelector('#nav button.active') || content.querySelector('button,a,input,select,textarea');
  if (restoreTarget?.isConnected) restoreTarget.focus();
  else fallback?.focus();
  lastFocusElement = null;
}

function settleConfirm(result, dissolve = true) {
  if (!confirmState) return;
  const state = confirmState;
  confirmState = null;
  confirmOk.disabled = true;
  confirmModal.querySelectorAll('[data-confirm-cancel]').forEach(control => { control.disabled = true; });
  const finish = () => {
    confirmCard.classList.remove('is-dissolving');
    confirmModal.hidden = true;
    document.body.classList.remove('confirm-open');
    confirmOk.disabled = false;
    confirmModal.querySelectorAll('[data-confirm-cancel]').forEach(control => { control.disabled = false; });
    if (state.focus?.isConnected) state.focus.focus({ preventScroll: true });
    state.resolve(result);
  };
  if (dissolve && !reducedMotion()) {
    confirmCard.classList.add('is-dissolving');
    setTimeout(finish, 340);
  } else finish();
}

function askConfirm(message, { title = '确认这项操作', confirmLabel = '确认', kicker = 'DESK CHECK / 请确认', danger = false } = {}) {
  if (confirmState) settleConfirm(false, false);
  return new Promise(resolve => {
    confirmState = { resolve, focus: document.activeElement };
    confirmKicker.textContent = kicker;
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmOk.textContent = confirmLabel;
    confirmOk.classList.toggle('danger', danger);
    confirmCard.classList.remove('is-dissolving');
    confirmModal.hidden = false;
    document.body.classList.add('confirm-open');
    requestAnimationFrame(() => confirmOk.focus());
  });
}

confirmModal.addEventListener('click', e => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest('[data-confirm-ok]')) settleConfirm(true);
  else if (target.closest('[data-confirm-cancel]')) settleConfirm(false);
});

document.addEventListener('click', e => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest('[data-close]')) closeModal();
  if (!target.closest('[data-compact-picker]')) closeCompactPickers();
  // body also carries data-page for page-specific CSS. Only interactive
  // controls are allowed to trigger navigation; blank/content clicks must be inert.
  const pageTrigger = target.closest(pageTriggerSelector);
  if (pageTrigger && !pageTrigger.closest('#nav')) {
    e.preventDefault();
    navigate(pageTrigger.dataset.page);
  }
  if (target.closest('[data-reload]')) navigate(page);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const openPicker = document.querySelector('[data-compact-picker].is-open');
    if (openPicker) { e.preventDefault(); setCompactPickerOpen(openPicker, false, true); return; }
  }
  if (e.key === 'Escape' && confirmState) { e.preventDefault(); settleConfirm(false); return; }
  if (e.key === 'Escape' && !modal.hidden) closeModal();
  else if (e.key === 'Escape' && !sidebarCollapsed) setSidebar(true);
  if (e.key === 'Tab' && confirmState) {
    const focusable = [...confirmModal.querySelectorAll('button:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.key === 'Tab' && !modal.hidden) {
    const focusable = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),a[href]')].filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function spotlightTarget(target) {
  return target instanceof Element ? target.closest('[data-spotlight]') : null;
}

document.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch' || reducedMotion()) return;
  const target = spotlightTarget(e.target);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  target.style.setProperty('--spot-x', `${(e.clientX - rect.left).toFixed(1)}px`);
  target.style.setProperty('--spot-y', `${(e.clientY - rect.top).toFixed(1)}px`);
  target.style.setProperty('--spot-opacity', '1');
});

document.addEventListener('pointerout', e => {
  if (e.pointerType === 'touch') return;
  const target = spotlightTarget(e.target);
  if (target && !target.contains(e.relatedTarget)) target.style.setProperty('--spot-opacity', '0');
});

function setHeader() {
  document.querySelector('#eyebrow').textContent = titles[page][0];
  document.querySelector('#page-title').textContent = titles[page][1];
  const meta = pageMeta[page] || pageMeta.dashboard;
  document.body.dataset.page = page;
  document.querySelector('#page-stamp').textContent = meta.stamp;
  document.querySelector('#page-caption').textContent = meta.caption;
  updateDeskWindow();
  const d = new Date();
  document.querySelector('#date-day').textContent = String(d.getDate()).padStart(2, '0');
  document.querySelector('#date-rest').textContent = `${d.toLocaleDateString('zh-CN', { month: 'long' })}\n${d.toLocaleDateString('zh-CN', { weekday: 'long' })}`;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
}

async function navigate(next = page, { preserve = next === page } = {}) {
  const scrollState = preserve ? captureScrollState() : null;
  page = next;
  const viewToken = ++navigationToken;
  setHeader();
  content.innerHTML = '<div class="loading">正在整理本地数据…</div>';
  if (!preserve) resetScrollPosition();
  try {
    await renderers[page](viewToken);
    if (!isCurrentView(page, viewToken)) return;
    if (preserve) restoreScrollState(scrollState);
    else resetScrollPosition();
    armLiveScheduleRefresh();
  } catch (e) {
    if (!isCurrentView(page, viewToken)) return;
    content.innerHTML = `<div class="error-state"><h2>暂时无法显示此页面</h2><p>${esc(e.message)}</p><button class="btn" data-reload>重新读取</button></div>`;
    if (preserve) restoreScrollState(scrollState);
    else resetScrollPosition();
  }
}

document.querySelector('#nav').addEventListener('click', e => {
  const target = e.target instanceof Element ? e.target : null;
  const button = target?.closest('#nav button[data-page]');
  if (button) {
    navigate(button.dataset.page);
    if (window.matchMedia?.('(max-width: 700px)').matches) setSidebar(true);
  }
});

async function renderDashboard(viewToken = ++navigationToken) {
  const d = await api(`/dashboard?date=${localDate()}`);
  if (!isCurrentView('dashboard', viewToken)) return;
  cache.dashboard = d;
  const summary = d.summary || {};
  const focus = dashboardFocus(d);
  const activityTotal = Number(summary.planTotal || 0) + Number(summary.applicationTotal || 0) + Number(summary.resumeVersions || 0) + Number(summary.memoInbox || 0) + d.courses.length;
  const dashboardBlank = activityTotal === 0;
  const currentCourse = d.currentCourse;
  const nextCourse = d.nextCourse;
  const courseStatus = currentCourse
    ? `<div class="course-status-card is-live"><div><span class="course-status-kicker">NOW / 当前课程</span><strong>${esc(currentCourse.name)}</strong><p>${esc(currentCourse.start_time)}–${esc(currentCourse.end_time)} · ${esc(currentCourse.location || '地点未填写')}</p></div><span class="course-status-mark">进行中</span></div>`
    : nextCourse
      ? `<div class="course-status-card"><div><span class="course-status-kicker">NEXT / 下一节课</span><strong>${esc(nextCourse.name)}</strong><p>${nextCourse.next_date && nextCourse.next_date !== d.date ? `${esc(nextCourse.next_date)} · ` : ''}${esc(nextCourse.start_time)}–${esc(nextCourse.end_time)} · ${esc(nextCourse.location || '地点未填写')}</p></div><span class="course-status-mark">接下来</span></div>`
      : `<div class="course-status-card is-empty"><div><span class="course-status-kicker">COURSE RHYTHM / 今日节奏</span><strong>${d.courses.length ? '今天的课程已经结束' : '今天没有课程安排'}</strong><p>${d.courses.length ? '把剩余时间留给下一件重要的事。' : '可以查看本周课表，或去课表设置里补全节次。'}</p></div><button type="button" class="btn small" data-page="courses">查看课表</button></div>`;
  const courseRows = d.courses.length
    ? d.courses.map(c => `<button type="button" class="row-link rail-item ${currentCourse?.id === c.id ? 'is-current' : ''}" data-page="courses"><span class="rail-time">${esc(c.start_time)}<br>${esc(c.end_time)}</span><span><strong>${esc(c.name)}</strong><p>${esc(c.location || '地点未填写')}${currentCourse?.id === c.id ? ' · 正在上课' : ''}</p></span></button>`).join('')
    : `<div class="empty"><strong>今天没有课程安排</strong><span>留一点时间给自己，或查看本周课表。</span><button class="btn small" data-page="courses">查看本周课表</button></div>`;
  const planRows = d.todayPlans.length
    ? d.todayPlans.map(p => `<div class="list-item sticky-note dashboard-plan-note${freshClass('plan', p.id)}"><div class="task-copy"><span class="task-mark" aria-hidden="true">□</span><span><strong>${esc(p.title)}</strong><p>${esc(p.category || '未分类')} · 截止 ${esc(p.dueDate)}</p></span></div><div class="row-actions">${badge(p.priority, p.priority)}<button class="btn small" data-plan-edit-dashboard="${p.id}">编辑</button><button class="btn small" data-done="${p.id}">完成</button></div></div>`).join('')
    : empty('今天没有需要推进的计划', '新增一个真正需要完成的事项。');
  const interviews = d.interviews.map(i => ({ ...i, kind: 'interview' }));
  const closing = [
    ...d.overdue.map(p => ({ ...p, kind: 'overdue', reason: `逾期 · 截止 ${p.dueDate}` })),
    ...d.important.map(p => ({ ...p, kind: 'important', reason: `高优先级 · 截止 ${p.dueDate}` }))
  ];
  const interviewRows = interviews.length
    ? interviews.map(i => `<div class="list-item"><div><strong>${esc(i.company)} · ${esc(i.round_name || i.roundName)}</strong><p>${fmt(i.scheduled_at || i.scheduledAt)}</p></div><button class="btn small" data-dashboard-app="${i.application_id || i.applicationId}">查看岗位</button></div>`).join('')
    : empty('未来 7 天没有面试安排', '新的面试时间会自动出现在这里。');
  const closingRows = closing.length
    ? closing.map(p => `<div class="list-item"><div><strong>${esc(p.title)}</strong><p>${esc(p.reason)}</p></div><button class="btn small" data-plan-edit-dashboard="${p.id}">查看计划</button></div>`).join('')
    : empty('未来 7 天没有需要收尾的事项', '逾期和高优先级计划会出现在这里。');
  const memoRows = d.memos.length
    ? d.memos.map(m => `<div class="list-item sticky-note memo-note${freshClass('memo', m.id)}"><div><strong>${esc(m.content)}</strong><p>${fmt(m.createdAt)} · 未整理</p></div><div class="actions"><button class="btn small" data-convert="${m.id}">转成计划</button><button class="btn small" data-archive-memo="${m.id}">归档</button><button class="btn small danger" data-delete-memo="${m.id}">删除备忘</button></div></div>`).join('')
    : empty('还没有快速备忘', '先把突然想到的事情记下来。');

  const dateMark = String(d.date || localDate()).slice(5).replace('-', ' / ');
  const intro = pageIntro({
    kicker: dashboardBlank ? 'FIRST MARK / 从这里开始' : 'DESK MAP / 今日索引',
    title: dashboardBlank ? '把第一件事放到桌面上' : '今天的版面已经有了重心',
    copy: dashboardBlank ? '这张桌面还在等你的第一笔记录。先安排一件真实的事，其他内容会从它旁边长出来。' : `先看「${focus.title}」。${focus.copy}`,
    accent: dashboardBlank ? 'sage' : 'sun',
    art: dashboardBlank ? 'empty' : 'orbit',
    artLabel: `TODAY ${dateMark}`,
    stats: [
      { value: summary.planOpen ?? d.todayPlans.length, label: '未完成计划' },
      { value: summary.applicationTotal ?? 0, label: '求职档案' },
      { value: summary.resumeVersions ?? 0, label: '简历版本' },
      { value: summary.memoInbox ?? d.memos.length, label: '待整理备忘' }
    ]
  });
  content.innerHTML = `${intro}<div class="dashboard-brief"><div class="dashboard-note"><p class="lede">一张给今天的版面，留出足够空间做重要的事。</p><div class="index-line"><span>${d.courses.length} 节课程</span><span>${d.todayPlans.length} 项计划</span><span>${interviews.length} 场面试</span><span>${closing.length} 件需要收尾</span></div></div>${focusPanel(focus)}</div><section class="dashboard-course-strip">${courseStatus}<div class="course-strip-next"><span>今日课程</span><strong>${d.courses.length ? `共 ${d.courses.length} 节` : '留白'}</strong><button type="button" class="btn small" data-page="courses">打开周课表 ↗</button></div></section><div class="dashboard-grid dashboard-primary"><article class="card dashboard-courses"><div class="card-head"><h2>今日课程</h2><small>${d.currentSemester ? (d.teachingWeek ? `第 ${d.teachingWeek} 教学周` : '开学前') : '未设置学期'}</small></div><div class="card-body day-rail">${courseRows}</div></article><article class="card dashboard-plans"><div class="card-head"><h2>今日计划</h2><button type="button" class="btn small" data-add-plan>新增计划</button></div><div class="card-body">${planRows}</div></article></div><div class="dashboard-grid dashboard-secondary"><article class="card"><div class="card-head"><h2>快速备忘</h2><small>先记下来，之后再整理</small></div><div class="card-body"><form id="quick-memo" class="quick-input"><input name="content" required maxlength="500" placeholder="突然想到什么？"><button type="submit" class="btn primary">记下</button></form><div class="list">${memoRows}</div></div></article><article class="card"><div class="card-head"><h2>近期面试</h2><small>未来 7 天</small></div><div class="card-body list">${interviewRows}</div></article><article class="card"><div class="card-head"><h2>需要收尾</h2><small>逾期 / 高优先级</small></div><div class="card-body list">${closingRows}</div></article></div>`;

  const memoForm = document.querySelector('#quick-memo');
  bindFormSubmit(memoForm, memoForm.querySelector('button[type="submit"]'), async () => {
    const created = await api('/memos', { method: 'POST', body: { content: new FormData(memoForm).get('content') } });
    markFresh(created, 'memo');
    toast('已记下 · 可稍后整理');
    refreshCurrentPage(renderDashboard);
  }, { busyText: '记下中…', idleText: '记下' });
  content.querySelector('[data-add-plan]')?.addEventListener('click', () => planForm());
  content.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
    const note = b.closest('.sticky-note');
    b.disabled = true;
    try { await api(`/plans/${b.dataset.done}`, { method: 'PATCH', body: { status: 'done' } }); await dissolve(note); toast('计划已完成 · 刚刚'); refreshCurrentPage(renderDashboard); }
    catch (err) { b.disabled = false; toast(err.message, true); }
  });
  const dashboardPlans = [...new Map([...d.todayPlans, ...d.overdue, ...d.important].map(plan => [plan.id, plan])).values()];
  content.querySelectorAll('[data-plan-edit-dashboard]').forEach(b => b.onclick = () => {
    const plan = dashboardPlans.find(item => item.id === b.dataset.planEditDashboard);
    if (!plan) { toast('计划数据已更新，请重新读取首页', true); return; }
    planForm(plan);
  });
  content.querySelectorAll('[data-dashboard-app]').forEach(b => b.onclick = () => applicationDetail(b.dataset.dashboardApp).catch(err => toast(err.message, true)));
  content.querySelectorAll('[data-convert]').forEach(b => b.onclick = () => convertForm(b.dataset.convert));
  content.querySelectorAll('[data-archive-memo]').forEach(b => b.onclick = async () => { const note = b.closest('.sticky-note'); b.disabled = true; try { await api(`/memos/${b.dataset.archiveMemo}`, { method: 'PATCH', body: { status: 'archived', archivedAt: new Date().toISOString() } }); await dissolve(note); toast('备忘已归档 · 刚刚'); refreshCurrentPage(renderDashboard); } catch (err) { b.disabled = false; toast(err.message, true); } });
  content.querySelectorAll('[data-delete-memo]').forEach(b => b.onclick = async () => { if (await askConfirm('删除后只能从完整备份恢复。', { title: '删除这条备忘？', confirmLabel: '删除备忘', danger: true })) { const note = b.closest('.sticky-note'); b.disabled = true; try { await api(`/memos/${b.dataset.deleteMemo}`, { method: 'DELETE', body: {} }); await dissolve(note); toast('备忘已删除 · 刚刚'); refreshCurrentPage(renderDashboard); } catch (err) { b.disabled = false; toast(err.message, true); } } });
}

function mondayFor(date) {
  const monday = new Date(date);
  const day = monday.getDay() || 7;
  monday.setDate(monday.getDate() - day + 1);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

const defaultSchedulePeriods = [
  ['第1节', '08:00', '08:45'], ['第2节', '08:50', '09:35'],
  ['第3节', '10:00', '10:45'], ['第4节', '10:50', '11:35'],
  ['第5节', '14:00', '14:45'], ['第6节', '14:50', '15:35'],
  ['第7节', '16:00', '16:45'], ['第8节', '16:50', '17:35'],
  ['第9节', '19:00', '19:45'], ['第10节', '19:50', '20:35'],
  ['第11节', '20:45', '21:30'], ['第12节', '21:35', '22:20']
].map(([label, startTime, endTime], index) => ({ periodNo: index + 1, label, startTime, endTime }));

const courseValue = (course, camelName, snakeName) => course?.[camelName] ?? course?.[snakeName];
const periodValue = (period, camelName, snakeName) => period?.[camelName] ?? period?.[snakeName];
const courseStartTime = course => courseValue(course, 'startTime', 'start_time') || '';
const courseEndTime = course => courseValue(course, 'endTime', 'end_time') || '';
const courseWeekPattern = course => courseValue(course, 'weekPattern', 'week_pattern') || 'every';
const courseCustomWeeks = course => courseValue(course, 'customWeeks', 'custom_weeks') || '';
const courseWeekday = course => Number(courseValue(course, 'weekday', 'weekday'));

function teachingWeekNumber(semester, date) {
  if (!semester?.startsOn) return 0;
  const start = new Date(`${semester.startsOn}T00:00:00`);
  return Math.floor((date.getTime() - start.getTime()) / 604800000) + 1;
}

function courseOccursInTeachingWeek(course, week) {
  if (week < Number(courseValue(course, 'startWeek', 'start_week')) || week > Number(courseValue(course, 'endWeek', 'end_week'))) return false;
  const pattern = courseWeekPattern(course);
  if (pattern === 'odd') return week % 2 === 1;
  if (pattern === 'even') return week % 2 === 0;
  if (pattern === 'custom') {
    return String(courseCustomWeeks(course)).split(',').some(token => {
      const value = token.trim();
      const range = value.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) return week >= Number(range[1]) && week <= Number(range[2]);
      return /^\d+$/.test(value) && Number(value) === week;
    });
  }
  return true;
}

function occursInCourseWeek(course, date, semester) {
  return Boolean(semester) && courseOccursInTeachingWeek(course, teachingWeekNumber(semester, date));
}

function normalizedCoursePeriods(course, periods) {
  const count = periods.length || defaultSchedulePeriods.length;
  let start = Number(courseValue(course, 'startPeriod', 'start_period'));
  let end = Number(courseValue(course, 'endPeriod', 'end_period'));
  const legacySinglePeriod = periods.length && start === 1 && end === 1 && (courseStartTime(course) !== periodValue(periods[0], 'startTime', 'start_time') || courseEndTime(course) !== periodValue(periods[0], 'endTime', 'end_time'));
  if (legacySinglePeriod || !Number.isInteger(start) || start < 1 || start > count) {
    start = Math.max(1, periods.findIndex(period => periodValue(period, 'startTime', 'start_time') === courseStartTime(course)) + 1);
  }
  if (legacySinglePeriod || !Number.isInteger(end) || end < start || end > count) {
    const matching = periods.findIndex(period => periodValue(period, 'endTime', 'end_time') === courseEndTime(course));
    end = matching >= start - 1 ? matching + 1 : start;
  }
  return { start: Math.min(start, count), end: Math.max(start, Math.min(end, count)), span: Math.max(1, Math.min(end, count) - Math.min(start, count) + 1) };
}

function periodText(course, periods) {
  const range = normalizedCoursePeriods(course, periods);
  return range.start === range.end ? `第${range.start}节` : `第${range.start}–${range.end}节`;
}

function weekRuleText(course) {
  const start = Number(courseValue(course, 'startWeek', 'start_week'));
  const end = Number(courseValue(course, 'endWeek', 'end_week'));
  const pattern = courseWeekPattern(course);
  if (pattern === 'odd') return `${start}–${end} 周 · 单周`;
  if (pattern === 'even') return `${start}–${end} 周 · 双周`;
  if (pattern === 'custom') return `自定义 · ${courseCustomWeeks(course)} 周`;
  return `${start}–${end} 周 · 每周`;
}

function timeMinutes(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
}

function currentTimePosition(periods, now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const count = periods.length || defaultSchedulePeriods.length;
  for (let index = 0; index < periods.length; index += 1) {
    const start = timeMinutes(periodValue(periods[index], 'startTime', 'start_time'));
    const end = timeMinutes(periodValue(periods[index], 'endTime', 'end_time'));
    if (minutes <= start) return (index / count) * 100;
    if (minutes <= end) return ((index + Math.max(0, Math.min(1, (minutes - start) / Math.max(1, end - start)))) / count) * 100;
  }
  return periods.length ? 100 : null;
}

function formatCourseDate(date) {
  return `${date.getMonth() + 1}.${String(date.getDate()).padStart(2, '0')}`;
}

async function renderCourses(viewToken = ++navigationToken) {
  const [semesters, courses] = await Promise.all([api('/semesters'), api('/courses')]);
  if (!isCurrentView('courses', viewToken)) return;
  const current = semesters.find(s => s.isCurrent);
  const configuredPeriods = current ? await api(`/schedule-periods?semesterId=${encodeURIComponent(current.id)}`) : [];
  const periods = configuredPeriods.length === 12 ? configuredPeriods : current ? defaultSchedulePeriods.map(period => ({ ...period })) : [];
  if (!isCurrentView('courses', viewToken)) return;
  cache = { ...cache, semesters, courses, periods };
  const today = new Date();
  const baseWeek = current ? Math.max(1, Math.min(Number(current.totalWeeks), teachingWeekNumber(current, today))) : 1;
  const weekNumber = current ? Math.max(1, Math.min(Number(current.totalWeeks), baseWeek + courseWeekOffset)) : null;
  const monday = current ? new Date(`${current.startsOn}T00:00:00`) : mondayFor(today);
  if (current) monday.setDate(monday.getDate() + (weekNumber - 1) * 7);
  const weekStart = localDate(monday);
  const weekEndDate = new Date(monday); weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEnd = localDate(weekEndDate);
  const weekEntries = weekdays.map((name, index) => {
    const date = new Date(monday); date.setDate(date.getDate() + index);
    const entries = current ? courses.filter(c => courseWeekday(c) === index + 1 && c.semesterId === current.id && courseOccursInTeachingWeek(c, weekNumber)).sort((a, b) => courseStartTime(a).localeCompare(courseStartTime(b))) : [];
    return { name, date, entries };
  });
  const todayText = localDate(today);
  const todayInWeek = weekEntries.find(day => localDate(day.date) === todayText);
  const visibleCourseCount = weekEntries.reduce((count, day) => count + day.entries.length, 0);
  const visibleCourseMinutes = weekEntries.flatMap(day => day.entries).reduce((total, course) => total + durationMinutes(courseStartTime(course), courseEndTime(course)), 0);
  const currentTop = todayInWeek ? currentTimePosition(periods, today) : null;
  const periodCount = periods.length || defaultSchedulePeriods.length;
  const dayHeaders = weekEntries.map(({ name, date }) => `<div class="schedule-day-head ${localDate(date) === todayText ? 'is-today' : ''}"><span>${esc(name)}</span><strong>${String(date.getDate()).padStart(2, '0')}</strong><small>${esc(date.toLocaleDateString('zh-CN', { month: 'short' }))}</small>${localDate(date) === todayText ? '<em>今天</em>' : ''}</div>`).join('');
  const periodRail = periods.map(period => `<div class="period-label"><strong>${esc(periodValue(period, 'label', 'label') || `第${periodValue(period, 'periodNo', 'period_no')}节`)}</strong><span>${esc(periodValue(period, 'startTime', 'start_time'))}–${esc(periodValue(period, 'endTime', 'end_time'))}</span></div>`).join('');
  const dayColumns = weekEntries.map(({ name, date, entries }, dayIndex) => {
    const isToday = localDate(date) === todayText;
    const slots = periods.map(period => `<button type="button" class="period-slot" style="grid-row:${periodValue(period, 'periodNo', 'period_no')}" data-add-course-day="${dayIndex + 1}" data-add-course-period="${periodValue(period, 'periodNo', 'period_no')}" aria-label="${esc(name)} ${esc(periodValue(period, 'label', 'label'))}，添加课程"></button>`).join('');
    const blocks = entries.map((course, index) => {
      const range = normalizedCoursePeriods(course, periods);
      const previousRange = index > 0 ? normalizedCoursePeriods(entries[index - 1], periods) : null;
      const nextRange = index < entries.length - 1 ? normalizedCoursePeriods(entries[index + 1], periods) : null;
      const touchesPrevious = previousRange && previousRange.start + previousRange.span === range.start;
      const touchesNext = nextRange && range.start + range.span === nextRange.start;
      const edgeClasses = `${touchesPrevious ? ' is-adjacent-prev' : ''}${touchesNext ? ' is-adjacent-next' : ''}`;
      const startTime = courseStartTime(course);
      const endTime = courseEndTime(course);
      const isCurrent = isToday && timeMinutes(startTime) <= today.getHours() * 60 + today.getMinutes() && today.getHours() * 60 + today.getMinutes() < timeMinutes(endTime);
      const location = courseValue(course, 'location', 'location') || '地点未填写';
      return `<button type="button" class="course-block${edgeClasses} ${isCurrent ? 'is-current' : ''}${freshClass('course', course.id)}" style="grid-row:${range.start} / span ${range.span}" data-course-detail="${esc(course.id)}" aria-label="${esc(course.name)}，${esc(periodText(course, periods))}，${esc(location)}"><span class="course-block-top"><small>${esc(periodText(course, periods))}</small>${isCurrent ? '<b>正在上课</b>' : ''}</span><strong>${esc(course.name)}</strong><span class="course-time">${esc(startTime)}–${esc(endTime)}</span><span class="course-location">${esc(location)}</span></button>`;
    }).join('');
    const line = isToday && currentTop !== null ? `<div class="current-time-line" style="--current-top:${currentTop}%"><span>现在 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(today)}</span></div>` : '';
    return `<div class="schedule-day-surface ${isToday ? 'is-today' : ''}">${slots}${blocks}${line}</div>`;
  }).join('');
  const semesterLabel = current ? `${esc(current.name)} · 第 ${weekNumber} 教学周` : '请先设置一个学期';
  const introLine = current ? `${weekStart} — ${weekEnd} · ${visibleCourseCount} 节课 · 预计 ${visibleCourseMinutes ? formatHours(visibleCourseMinutes) : '—'}` : '建立学期后，课程会按真实的教学周和节次展开。';
  const emptyState = !current ? '<div class="empty semester-empty"><strong>先设置一个学期</strong><span>系统才能计算教学周并显示重复课程。</span><button type="button" class="btn primary" data-semester>设置当前学期</button></div>' : !visibleCourseCount ? '<p class="week-empty">第 ' + weekNumber + ' 周没有课程安排。可以切换教学周，或新增一门固定课程。</p>' : '';
  content.innerHTML = `<section class="schedule-overview" data-spotlight><div><p class="section-kicker">CLASSROOM MAP / 教学周</p><h2>${current ? `第 ${weekNumber} 周的课表` : '先搭好这张时间地图'}</h2><p>${esc(introLine)}</p></div><div class="schedule-overview-side"><strong>${current ? visibleCourseCount : '—'}</strong><span>本周出现课程</span><small>${current ? '节次网格 · 点击课程看详情' : 'WEEK MAP'}</small></div></section><div class="schedule-toolbar"><div class="schedule-toolbar-group">${semesters.length ? `<label class="inline-select"><span>学期</span><select id="current-semester" aria-label="当前学期">${semesters.map(s => `<option value="${s.id}" ${s.isCurrent ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : '<span class="muted">还没有学期</span>'}<label class="inline-select"><span>教学周</span><select id="teaching-week" aria-label="当前教学周" ${current ? '' : 'disabled'}>${current ? Array.from({ length: Number(current.totalWeeks) }, (_, index) => `<option value="${index + 1}" ${index + 1 === weekNumber ? 'selected' : ''}>第 ${index + 1} 周</option>`).join('') : '<option>—</option>'}</select></label><span class="schedule-semester-label">${semesterLabel}</span></div><div class="schedule-toolbar-group schedule-week-controls"><button type="button" class="btn small" data-week-shift="-1" ${!current || weekNumber <= 1 ? 'disabled' : ''}>上一周</button><button type="button" class="btn small" data-week-reset ${!current || weekNumber === baseWeek ? 'disabled' : ''}>本周</button><button type="button" class="btn small" data-week-shift="1" ${!current || weekNumber >= Number(current.totalWeeks) ? 'disabled' : ''}>下一周</button></div><div class="schedule-toolbar-group schedule-actions"><button type="button" class="btn" data-timetable-import>导入 XLSX</button><button type="button" class="btn" data-schedule-settings ${current ? '' : 'disabled'}>课表设置</button><button type="button" class="btn primary" data-course ${current ? '' : 'disabled'}>添加课程</button></div></div><div class="schedule-legend"><span><i class="legend-dot today"></i>今天</span><span><i class="legend-dot current"></i>当前课程</span><span><i class="legend-line"></i>当前时间</span><span class="schedule-legend-note">点击空白节次可快速添加</span></div>${emptyState}<div class="week-table" style="--period-count:${periodCount}"><div class="schedule-corner"><span>节次</span><small>START / END</small></div>${dayHeaders}<div class="period-rail">${periodRail}</div>${dayColumns}</div>`;
  content.querySelector('[data-semester]')?.addEventListener('click', () => semesterForm());
  content.querySelector('[data-timetable-import]')?.addEventListener('click', () => timetableImportForm(semesters, current));
  content.querySelector('[data-course]')?.addEventListener('click', () => { if (current) courseForm(current, {}, periods); });
  content.querySelector('[data-schedule-settings]')?.addEventListener('click', () => { if (current) scheduleSettingsForm(current, periods); });
  content.querySelector('#current-semester')?.addEventListener('change', async e => { try { await api(`/semesters/${e.target.value}`, { method: 'PATCH', body: { isCurrent: 1 } }); courseWeekOffset = 0; toast('当前学期已切换 · 刚刚'); refreshCurrentPage(renderCourses); } catch (err) { toast(err.message, true); } });
  content.querySelector('#teaching-week')?.addEventListener('change', e => { courseWeekOffset = Number(e.target.value) - baseWeek; refreshCurrentPage(renderCourses); });
  content.querySelectorAll('[data-week-shift]').forEach(button => button.addEventListener('click', () => { courseWeekOffset = Math.max(1, Math.min(Number(current.totalWeeks), weekNumber + Number(button.dataset.weekShift))) - baseWeek; refreshCurrentPage(renderCourses); }));
  content.querySelector('[data-week-reset]')?.addEventListener('click', () => { courseWeekOffset = 0; refreshCurrentPage(renderCourses); });
  content.querySelectorAll('[data-course-detail]').forEach(button => button.addEventListener('click', () => { const course = courses.find(item => item.id === button.dataset.courseDetail); if (course) courseDetail(course, current, periods, weekNumber); }));
  content.querySelectorAll('[data-add-course-day]').forEach(button => button.addEventListener('click', () => { if (current) courseForm(current, { weekday: Number(button.dataset.addCourseDay), startPeriod: Number(button.dataset.addCoursePeriod), endPeriod: Number(button.dataset.addCoursePeriod) }, periods); }));
}

function courseDetail(course, semester, periods, weekNumber) {
  if (!course || !semester) return;
  const weekday = courseWeekday(course);
  const startTime = courseStartTime(course);
  const endTime = courseEndTime(course);
  const location = courseValue(course, 'location', 'location') || '地点未填写';
  const teacher = courseValue(course, 'teacher', 'teacher') || '教师未填写';
  const scheduleDate = new Date(`${semester.startsOn}T00:00:00`);
  scheduleDate.setDate(scheduleDate.getDate() + (Number(weekNumber) - 1) * 7 + weekday - 1);
  const activeNow = localDate(scheduleDate) === localDate(new Date()) && timeMinutes(startTime) <= new Date().getHours() * 60 + new Date().getMinutes() && new Date().getHours() * 60 + new Date().getMinutes() < timeMinutes(endTime);
  openModal(`<p class="drawer-kicker">COURSE / 课程安排</p><h2>${esc(course.name)}</h2><div class="course-detail-tags"><span>${esc(weekdays[weekday - 1] || '未设置星期')}</span><span>${esc(periodText(course, periods))}</span>${activeNow ? '<span class="is-live">正在上课</span>' : ''}</div><dl class="detail-meta course-detail-meta"><div><dt>时间</dt><dd>${esc(startTime)}–${esc(endTime)}<br><small>${esc(periodText(course, periods))}</small></dd></div><div><dt>地点</dt><dd>${esc(location)}</dd></div><div><dt>周次</dt><dd>${esc(weekRuleText(course))}<br><small>当前查看：第 ${esc(weekNumber)} 周</small></dd></div><div><dt>教师</dt><dd>${esc(teacher)}</dd></div></dl>${course.notes ? `<p class="detail-notes"><span class="detail-label">备注</span>${esc(course.notes)}</p>` : '<p class="detail-notes muted">还没有备注。需要补充时可以编辑课程。</p>'}<div class="form-actions course-detail-actions"><button type="button" class="btn" data-course-edit-drawer>编辑课程</button><button type="button" class="btn danger" data-course-delete-drawer>删除课程</button></div>`);
  document.querySelector('[data-course-edit-drawer]')?.addEventListener('click', () => courseForm(semester, course, periods));
  document.querySelector('[data-course-delete-drawer]')?.addEventListener('click', async () => {
    if (!await askConfirm('删除后这门课程在所有教学周的固定安排都会消失。', { title: '删除这门课程？', confirmLabel: '删除课程', danger: true })) return;
    try { await api(`/courses/${course.id}`, { method: 'DELETE' }); closeModal(); toast('课程已删除 · 刚刚'); refreshCurrentPage(renderCourses); }
    catch (err) { toast(err.message, true); }
  });
}

async function renderPlans(viewToken = ++navigationToken) {
  const plans = await api('/plans');
  if (!isCurrentView('plans', viewToken)) return;
  cache.plans = plans;
  const dismissedPlanIds = new Set();
  const now = new Date();
  const today = localDate(now);
  const weekStartDate = mondayFor(now);
  const weekEndDate = new Date(weekStartDate); weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekStart = localDate(weekStartDate);
  const weekEnd = localDate(weekEndDate);
  const donePlans = plans.filter(plan => plan.status === 'done').length;
  const overduePlans = plans.filter(plan => planIsOverdue(plan, now)).length;
  const activePlans = plans.length - donePlans;
  const planRhythm = weekdays.map((name, index) => {
    const date = new Date(weekStartDate); date.setDate(date.getDate() + index);
    const count = plans.filter(plan => plan.dueDate === localDate(date)).length;
    return `<div class="plan-day-stat"><span>${name.slice(1)}</span><strong>${count}</strong><i style="--day-size:${count ? Math.min(100, 26 + count * 19) : 8}%"></i></div>`;
  }).join('');
  const intro = pageIntro({
    kicker: plans.length ? 'ACTION FIELD / 行动场' : 'MAKE ROOM FOR ACTION / 留出行动',
    title: plans.length ? `${activePlans} 件事还在路上` : '把想法变成有日期的行动',
    copy: plans.length ? `从 ${weekStart} 到 ${weekEnd}，把截止日期变成可见的节奏。完成不是终点，下一次更新也会留在这里。` : '计划需要一个标题和截止日期，才会从“想做”变成今天可以推进的事情。',
    accent: 'sun',
    art: 'pulse',
    artLabel: 'KEEP MOVING',
    stats: [
      { value: plans.length, label: '计划总数' },
      { value: activePlans, label: '进行中' },
      { value: donePlans, label: '已完成' },
      { value: overduePlans, label: '逾期' }
    ]
  });
  content.innerHTML = `${intro}<div class="plan-rhythm" data-spotlight data-float><div class="plan-rhythm-copy"><p class="section-kicker">WEEK RHYTHM / 周节奏</p><strong>${plans.length ? '看见截止日期的聚集处' : '这一周还没有落点'}</strong><span>${plans.length ? '先从最早的截止日期开始，避免所有事情一起挤到最后。' : '新增计划后，这里会显示一周内的行动密度。'}</span></div><div class="plan-day-stats">${planRhythm}</div></div><div class="toolbar filters"><input id="plan-search" placeholder="搜索计划或备注" aria-label="搜索计划或备注"><select id="plan-range" aria-label="日期范围"><option value="">全部日期</option><option value="today">今日</option><option value="week">本周</option><option value="overdue">逾期</option><option value="done">已完成</option></select><select id="plan-status" aria-label="计划状态"><option value="">全部状态</option><option value="todo">待开始</option><option value="doing">进行中</option><option value="done">已完成</option></select><select id="plan-sort" aria-label="计划排序"><option value="due">截止时间</option><option value="priority">优先级</option><option value="updated">最近更新</option></select><span class="spacer"></span><button class="btn primary" data-add-plan>新增计划</button></div><div id="plan-notes" class="plan-note-grid" aria-live="polite"></div>`;
  const draw = () => {
    const scrollState = captureScrollState();
    const q = document.querySelector('#plan-search').value.toLowerCase();
    const range = document.querySelector('#plan-range').value;
    const s = document.querySelector('#plan-status').value;
    const sort = document.querySelector('#plan-sort').value;
    const inRange = p => {
      const overdue = planIsOverdue(p, now);
      if (range === 'today') return (!p.startDate || p.startDate <= today) && p.dueDate >= today;
      if (range === 'week') return (!p.startDate || p.startDate <= weekEnd) && p.dueDate >= weekStart;
      if (range === 'overdue') return overdue;
      if (range === 'done') return p.status === 'done';
      return true;
    };
    const rows = plans.filter(p => (!dismissedPlanIds.has(p.id) || s === 'done' || range === 'done') && (!q || `${p.title} ${p.notes || ''}`.toLowerCase().includes(q)) && (!s || p.status === s) && inRange(p)).sort((a, b) => {
      if (sort === 'priority') return ({ high: 0, medium: 1, low: 2 }[a.priority] ?? 9) - ({ high: 0, medium: 1, low: 2 }[b.priority] ?? 9);
      if (sort === 'updated') return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      return `${a.dueDate}T${a.dueTime || '23:59'}`.localeCompare(`${b.dueDate}T${b.dueTime || '23:59'}`);
    });
    document.querySelector('#plan-notes').innerHTML = rows.length ? rows.map((p, index) => { const overdue = planIsOverdue(p, now); const status = p.status === 'done' ? '已完成' : overdue ? '逾期' : p.status === 'doing' ? '进行中' : '待开始'; const statusClass = p.status === 'done' ? 'done' : overdue ? 'overdue' : ''; return `<article class="plan-note sticky-note${freshClass('plan', p.id)}" data-plan-id="${esc(p.id)}"><div class="plan-note-head"><span class="row-no">${String(index + 1).padStart(2, '0')}</span>${badge(status, statusClass)}</div><h3 class="plan-note-title">${esc(p.title)}</h3><p class="plan-note-meta">${esc(p.startDate || '—')} → ${esc(p.dueDate)}${p.dueTime ? ` · ${esc(p.dueTime)}` : ''}${p.category ? ` · ${esc(p.category)}` : ''}</p>${p.notes ? `<p class="plan-note-notes">${esc(p.notes)}</p>` : ''}<div class="actions plan-note-actions"><button class="btn small" data-plan-toggle="${p.id}" data-status="${p.status}">${p.status === 'done' ? '恢复计划' : '完成计划'}</button><button class="btn small" data-plan-edit="${p.id}">编辑</button><button class="btn small danger" data-plan-del="${p.id}">删除这条计划</button></div></article>`; }).join('') : `<div class="plan-note-empty">${empty('没有符合条件的计划', '调整筛选条件或新增计划。')}</div>`;
    bindPlanRows();
    restoreScrollState(scrollState);
  };
  const bindPlanRows = () => {
    content.querySelectorAll('[data-plan-toggle]').forEach(b => b.onclick = async () => {
      const id = b.dataset.planToggle;
      const completing = b.dataset.status !== 'done';
      const note = b.closest('.plan-note');
      b.disabled = true;
      try {
        const result = await api(`/plans/${id}`, { method: 'PATCH', body: { status: completing ? 'done' : 'doing' } });
        const plan = plans.find(item => item.id === id);
        if (plan) Object.assign(plan, result || {}, { status: completing ? 'done' : 'doing' });
        if (completing) dismissedPlanIds.add(id); else dismissedPlanIds.delete(id);
        await dissolve(note);
        toast(completing ? '计划已完成 · 刚刚' : '计划已恢复 · 刚刚');
        draw();
      } catch (err) { b.disabled = false; toast(err.message, true); }
    });
    content.querySelectorAll('[data-plan-edit]').forEach(b => b.onclick = () => planForm(plans.find(p => p.id === b.dataset.planEdit)));
    content.querySelectorAll('[data-plan-del]').forEach(b => b.onclick = async () => { if (await askConfirm('删除不可从列表恢复，但完整备份可以恢复。', { title: '删除这条计划？', confirmLabel: '删除计划', danger: true })) { const note = b.closest('.plan-note'); b.disabled = true; try { await api(`/plans/${b.dataset.planDel}`, { method: 'DELETE' }); await dissolve(note); toast('计划已删除 · 刚刚'); refreshCurrentPage(renderPlans); } catch (err) { b.disabled = false; toast(err.message, true); } } });
  };
  document.querySelector('#plan-search').oninput = draw;
  document.querySelector('#plan-range').onchange = draw;
  document.querySelector('#plan-status').onchange = draw;
  document.querySelector('#plan-sort').onchange = draw;
  content.querySelector('[data-add-plan]').onclick = () => planForm();
  draw();
}

async function renderApplications(viewToken = ++navigationToken) {
  const applicationToken = ++applicationsViewToken;
  const [apps, versions, interviews] = await Promise.all([api('/applications'), api('/resume-versions'), api('/interviews')]);
  if (!isCurrentView('applications', viewToken) || applicationToken !== applicationsViewToken) return;
  cache = { ...cache, apps, versions, interviews };
  for (const id of [...applicationDrafts.keys()]) if (id !== 'new' && !apps.some(a => a.id === id)) { applicationDrafts.delete(id); applicationDraftVersions.delete(id); }
  if (applicationResumeFilterId && !versions.some(v => v.id === applicationResumeFilterId)) applicationResumeFilterId = '';
  let applicationModel = applicationViewModel(apps, interviews);
  const pipelineGroups = [
    { label: '待投递', stages: ['待投递'] },
    { label: '已投递', stages: ['已投递'] },
    { label: '笔试', stages: ['笔试'] },
    { label: '面试', stages: ['一面', '二面', 'HR 面'] },
    { label: '结果', stages: ['Offer', '拒绝', '主动放弃'] }
  ];
  const pipelineMarkup = () => pipelineGroups.map(group => {
    const count = group.stages.reduce((total, stage) => total + Number(applicationModel.stageCounts[stage] || 0), 0);
    const ratio = applicationModel.total ? Math.max(8, Math.round(count / applicationModel.total * 100)) : 8;
    return `<div class="pipeline-item" data-pipeline-group="${esc(group.label)}"><div><span>${esc(group.label)}</span><strong>${count}</strong></div><i style="--pipeline-size:${ratio}%"></i></div>`;
  }).join('');
  const drafts = applicationDrafts;
  const lists = `<datalist id="app-channels">${applicationModel.urls.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;
  const filterPickerMarkup = ({ id, name, value = '', placeholder, searchLabel, ariaLabel, options, className = '' }) => compactPickerMarkup({ name, value, options, placeholder, searchLabel, ariaLabel, className: `compact-picker-filter ${className}`.trim(), inputAttributes: ` id="${id}"` });
  const channelFilterOptions = () => [['', '全部渠道'], ...applicationModel.channels.map(value => [value, value])];
  const stageFilter = filterPickerMarkup({ id: 'app-stage', name: 'filterStage', value: '', placeholder: '全部阶段', searchLabel: '搜索招聘阶段', ariaLabel: '招聘阶段', options: [['', '全部阶段'], ...stageOptions.map(value => [value, value])] });
  const channelFilter = filterPickerMarkup({ id: 'app-channel', name: 'filterChannel', value: '', placeholder: '全部渠道', searchLabel: '搜索投递渠道', ariaLabel: '投递渠道', options: channelFilterOptions(), className: 'compact-picker-filter-channel' });
  const resumeFilter = filterPickerMarkup({ id: 'app-resume', name: 'filterResume', value: applicationResumeFilterId, placeholder: '全部简历版本', searchLabel: '搜索简历版本', ariaLabel: '简历版本', options: [['', '全部简历版本'], ...versions.map(v => [v.id, `${v.versionName} · ${v.originalName}`])] });
  const sortFilter = filterPickerMarkup({ id: 'app-sort', name: 'filterSort', value: 'updated', placeholder: '最近更新', searchLabel: '搜索排序方式', ariaLabel: '排序', options: [['updated', '最近更新'], ['applied', '最近投递'], ['company', '公司名称']] });
  const applicationIntroMarkup = () => pageIntro({
    kicker: applicationModel.total ? 'PIPELINE PULSE / 求职脉搏' : 'MAKE THE FIRST MOVE / 从第一份开始',
    title: applicationModel.total ? `${applicationModel.active} 个岗位还在向前` : '让第一份投递留下轨迹',
    copy: applicationModel.total ? '阶段、面试和简历引用都在同一张桌面上。每一次变化，都应该指向下一步。' : '先记录一个真正想投递的岗位，之后的阶段变化、面试安排和简历版本才有地方落脚。',
    accent: 'coral',
    art: 'flow',
    artLabel: 'NEXT MOVE',
    stats: [
      { value: applicationModel.total, label: '岗位档案', key: 'application-total' },
      { value: applicationModel.active, label: '进行中', key: 'application-active' },
      { value: applicationModel.interviews, label: '面试记录', key: 'application-interviews' },
      { value: versions.length, label: '可用简历', key: 'application-versions' }
    ]
  });
  const applicationPipelineMarkup = () => `<div class="pipeline-panel"><div class="pipeline-copy"><p class="section-kicker">STAGE RHYTHM / 阶段节奏</p><strong>${applicationModel.total ? '把求职进展看成一条线' : '一条空白的求职路径'}</strong><span>${applicationModel.total ? '从待投递到结果，每一格都只保留当前最值得关注的信号。' : '新增一行后，这里会显示你的岗位分布。'}</span></div><div class="pipeline-grid">${pipelineMarkup()}</div></div>`;
  content.innerHTML = `${applicationIntroMarkup()}${applicationPipelineMarkup()}${lists}<div class="toolbar table-toolbar"><div class="table-toolbar-main"><button type="button" class="btn primary" data-add-app>＋ 新增一行</button><span class="table-hint">单元格可直接填写；投递渠道可填写网址，保存后点击 ↗ 直达；日期点击打开日历。</span></div><div class="filters"><input id="app-search" placeholder="搜索公司、岗位或备注" aria-label="搜索公司、岗位或备注">${stageFilter}${channelFilter}${resumeFilter}${sortFilter}</div></div><div class="table-wrap application-table-wrap"><table class="application-table"><thead><tr><th class="col-index">#</th><th>公司</th><th>岗位名称</th><th>城市</th><th>投递渠道</th><th>投递日期</th><th>当前状态</th><th>使用简历</th><th>操作</th></tr></thead><tbody id="app-rows"></tbody></table></div>`;
  const refreshApplicationOptions = () => {
    applicationModel = applicationViewModel(apps, interviews);
    const urlList = document.querySelector('#app-channels');
    if (urlList) urlList.replaceChildren(...applicationModel.urls.map(value => { const option = document.createElement('option'); option.value = value; return option; }));
    const channelPicker = document.querySelector('.compact-picker-filter-channel');
    if (channelPicker) {
      const current = document.querySelector('#app-channel')?.value || '';
      const validValues = channelFilterOptions().map(([value]) => value);
      channelPicker.outerHTML = filterPickerMarkup({ id: 'app-channel', name: 'filterChannel', value: validValues.includes(current) ? current : '', placeholder: '全部渠道', searchLabel: '搜索投递渠道', ariaLabel: '投递渠道', options: channelFilterOptions(), className: 'compact-picker-filter-channel' });
      document.querySelector('#app-channel').onchange = draw;
      bindCompactPickers(content);
    }
  };
  const refreshApplicationSummary = () => {
    const intro = content.querySelector('.page-intro');
    if (intro) intro.outerHTML = applicationIntroMarkup();
    const pipeline = content.querySelector('.pipeline-panel');
    if (pipeline) pipeline.outerHTML = applicationPipelineMarkup();
  };
  const viewMounted = () => isCurrentView('applications', viewToken) && applicationToken === applicationsViewToken && Boolean(document.querySelector('#app-search'));
  const blank = () => ({ company: '', roleName: '', direction: '', location: '', channel: '', channelLabel: '', appliedOn: '', stage: '待投递', resumeVersionId: '', jobUrl: '', notes: '' });
  const valueFor = (row, key) => drafts.has(row.id) && drafts.get(row.id)[key] !== undefined ? drafts.get(row.id)[key] : (row[key] ?? '');
  const textCell = (row, key, label, list = '', type = 'text') => `<input class="grid-input" data-app-row="${esc(row.id)}" data-app-field="${esc(key)}" aria-label="${esc(label)}" type="${type}" value="${esc(valueFor(row, key))}"${list ? ` list="${list}"` : ''}${key === 'company' || key === 'roleName' ? ' required' : ''}${applicationPendingRows.has(row.id) ? ' disabled' : ''}>`;
  const textPickerCell = (row, key, label) => {
    const meta = applicationTextPickerMeta[key];
    const disabled = applicationPendingRows.has(row.id);
    return compactPickerMarkup({
      name: key,
      value: valueFor(row, key),
      options: applicationTextPickerOptions(applicationModel[meta.valuesKey], meta.emptyLabel),
      placeholder: meta.placeholder,
      searchLabel: meta.searchLabel,
      ariaLabel: label,
      allowCustom: meta.allowCustom,
      className: `compact-picker-table application-text-picker ${meta.className}`,
      disabled,
      inputAttributes: ` data-app-row="${esc(row.id)}" data-app-field="${esc(key)}"${key === 'company' || key === 'roleName' ? ' required' : ''}${disabled ? ' disabled' : ''}`
    });
  };
  const channelCell = row => {
    const href = safeHttpUrl(valueFor(row, 'channel'));
    const labelPicker = compactPickerMarkup({
      name: 'channelLabel',
      value: valueFor(row, 'channelLabel'),
      options: [['', '不设置名称'], ...applicationModel.channelLabels.map(label => [label, label])],
      placeholder: '渠道名称',
      searchLabel: '查找或创建渠道名称',
      ariaLabel: '投递渠道名称',
      allowCustom: true,
      className: 'compact-picker-table channel-label-picker',
      disabled: applicationPendingRows.has(row.id),
      inputAttributes: ` data-app-row="${esc(row.id)}" data-app-field="channelLabel"${applicationPendingRows.has(row.id) ? ' disabled' : ''}`
    });
    return `<div class="channel-cell">${labelPicker}${textCell(row, 'channel', '投递网址', 'app-channels')}<a class="grid-link" data-channel-link href="${esc(href || '#')}" target="_blank" rel="noreferrer" aria-label="打开投递网址"${href ? '' : ' hidden'}>↗</a></div>`;
  };
  const selectCell = (row, key, label, options) => `<select class="grid-input grid-select${key === 'resumeVersionId' ? ' resume-choice-cell' : ''}" data-app-row="${esc(row.id)}" data-app-field="${esc(key)}" aria-label="${esc(label)}"${applicationPendingRows.has(row.id) ? ' disabled' : ''}>${options.map(([value, text]) => `<option value="${esc(value)}" ${String(value) === String(valueFor(row, key)) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
  const resumePickerCell = row => {
    const disabled = applicationPendingRows.has(row.id);
    return compactPickerMarkup({
      name: 'resumeVersionId',
      value: valueFor(row, 'resumeVersionId'),
      options: [['', '未关联'], ...versions.map(v => [v.id, `${v.versionName} · ${v.originalName}${v.fileExists === false ? ' · 文件缺失' : ''}`])],
      placeholder: '未关联',
      searchLabel: '搜索简历版本',
      ariaLabel: '使用简历',
      className: 'compact-picker-table resume-choice-picker',
      disabled,
      inputAttributes: ` data-app-row="${esc(row.id)}" data-app-field="resumeVersionId"${disabled ? ' disabled' : ''}`
    });
  };
  const rowMarkup = (row, index, isNew = false) => { const dirty = drafts.has(row.id); const saving = applicationPendingRows.has(row.id); const locked = dirty || saving; return `<tr class="${isNew ? 'is-draft' : ''}${dirty ? ' is-dirty' : ''}${saving ? ' is-saving' : ''}" data-app-row-view="${esc(row.id)}"><td class="row-no">${isNew ? '＋' : String(index + 1).padStart(2, '0')}</td><td>${textPickerCell(row, 'company', '公司')}</td><td>${textPickerCell(row, 'roleName', '岗位名称')}</td><td>${textPickerCell(row, 'location', '城市')}</td><td>${channelCell(row)}</td><td>${textCell(row, 'appliedOn', '投递日期', '', 'date')}</td><td>${selectCell(row, 'stage', '当前状态', stageOptions.map(s => [s, s]))}</td><td>${resumePickerCell(row)}</td><td class="actions row-actions-cell"><button type="button" class="btn small" data-app-save="${esc(row.id)}"${dirty && !saving ? '' : ' disabled'}>${isNew ? '保存新增' : '保存本行'}</button>${isNew ? `<button type="button" class="btn small danger" data-app-cancel${saving ? ' disabled' : ''}>取消</button>` : `<button type="button" class="btn small" data-app-detail="${esc(row.id)}"${locked ? ' disabled' : ''}>详情</button><button type="button" class="btn small" data-app-edit="${esc(row.id)}"${locked ? ' disabled' : ''}>编辑详情</button><button type="button" class="btn small danger" data-app-cancel-row="${esc(row.id)}"${dirty && !saving ? '' : ' hidden'}${saving ? ' disabled' : ''}>取消修改</button>`}</td></tr>`; };
  const draw = () => {
    const scrollState = captureScrollState();
    const q = document.querySelector('#app-search').value.toLowerCase();
    const stage = document.querySelector('#app-stage').value;
    const channel = document.querySelector('#app-channel').value;
    const resume = document.querySelector('#app-resume').value;
    const sort = document.querySelector('#app-sort').value;
    const rows = apps.filter(a => {
      const company = valueFor(a, 'company');
      const roleName = valueFor(a, 'roleName');
      const notes = valueFor(a, 'notes');
      const channelText = `${valueFor(a, 'channelLabel')} ${valueFor(a, 'channel')}`;
      const rowText = `${company} ${roleName} ${valueFor(a, 'location')} ${channelText} ${notes}`.toLowerCase();
      return (!q || rowText.includes(q)) && (!stage || valueFor(a, 'stage') === stage) && (!channel || valueFor(a, 'channelLabel') === channel || (!safeHttpUrl(valueFor(a, 'channel')) && valueFor(a, 'channel') === channel)) && (!resume || valueFor(a, 'resumeVersionId') === resume);
    }).sort((a, b) => {
      if (sort === 'company') return `${valueFor(a, 'company')}${valueFor(a, 'roleName')}`.localeCompare(`${valueFor(b, 'company')}${valueFor(b, 'roleName')}`, 'zh-CN');
      if (sort === 'applied') return String(valueFor(b, 'appliedOn') || '').localeCompare(String(valueFor(a, 'appliedOn') || ''));
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    const draftRow = drafts.has('new') ? rowMarkup({ id: 'new', ...blank(), ...drafts.get('new') }, 0, true) : '';
    document.querySelector('#app-rows').innerHTML = draftRow + (rows.length ? rows.map((a, index) => rowMarkup(a, index, false)).join('') : draftRow ? '' : `<tr class="application-empty"><td colspan="9">${empty('还没有求职档案', '点击“新增一行”开始记录第一个岗位。')}</td></tr>`);
    bind();
    restoreScrollState(scrollState);
  };
  const markDirty = e => {
    const field = e.target.dataset.appField;
    const rowId = e.target.dataset.appRow;
    if (!field || !rowId) return;
    const draft = drafts.get(rowId) || {};
    draft[field] = e.target.value;
    drafts.set(rowId, draft);
    applicationDraftVersions.set(rowId, (applicationDraftVersions.get(rowId) ?? 0) + 1);
    const row = e.target.closest('tr');
    row?.classList.add('is-dirty');
    const save = row?.querySelector('[data-app-save]');
    if (save) save.disabled = false;
    const cancel = row?.querySelector('[data-app-cancel-row]');
    if (cancel) cancel.hidden = false;
    row?.querySelector('[data-app-detail]')?.setAttribute('disabled', '');
    row?.querySelector('[data-app-edit]')?.setAttribute('disabled', '');
    if (field === 'channel') {
      const link = row?.querySelector('[data-channel-link]');
      const href = safeHttpUrl(e.target.value);
      if (link) { link.href = href || '#'; link.hidden = !href; }
    }
  };
  const saveRow = async id => {
    if (applicationPendingRows.has(id)) return;
    const base = id === 'new' ? blank() : apps.find(a => a.id === id);
    if (!base) return;
    const requestDraft = drafts.get(id);
    const requestRevision = applicationDraftVersions.get(id) ?? 0;
    const values = { ...base, ...requestDraft };
    const payload = { company: String(values.company || '').trim(), roleName: String(values.roleName || '').trim(), direction: String(values.direction || '').trim(), location: String(values.location || '').trim(), channel: String(values.channel || '').trim(), channelLabel: String(values.channelLabel || '').trim(), appliedOn: values.appliedOn || null, stage: values.stage || '待投递', resumeVersionId: values.resumeVersionId || null, jobUrl: String(values.jobUrl || '').trim(), notes: String(values.notes || '') };
    if (!payload.company || !payload.roleName) {
      toast('请先填写公司和岗位名称', true);
      const missingInput = document.querySelector(`[data-app-row="${id}"][data-app-field="${payload.company ? 'roleName' : 'company'}"]`);
      const focusTarget = missingInput?.closest('[data-compact-picker]')?.querySelector('[data-picker-trigger]') || missingInput;
      focusTarget?.focus?.();
      return;
    }
    const button = document.querySelector(`[data-app-save="${id}"]`);
    const row = document.querySelector(`[data-app-row-view="${id}"]`);
    applicationPendingRows.add(id);
    row?.classList.add('is-saving');
    row?.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
    try {
      if (button) { button.disabled = true; button.textContent = '保存中…'; }
      const result = await api(id === 'new' ? '/applications' : `/applications/${id}`, { method: id === 'new' ? 'POST' : 'PATCH', body: payload });
      if (id === 'new') {
        if (!apps.some(app => app.id === result.id)) apps.unshift(result);
        if (cache.apps && cache.apps !== apps && !cache.apps.some(app => app.id === result.id)) cache.apps.unshift(result);
      } else {
        Object.assign(base, result);
        const cached = cache.apps?.find(app => app.id === id);
        if (cached && cached !== base) Object.assign(cached, result);
      }
      applicationPendingRows.delete(id);
      const draftIsUnchanged = (applicationDraftVersions.get(id) ?? 0) === requestRevision && drafts.get(id) === requestDraft;
      if (draftIsUnchanged) { drafts.delete(id); applicationDraftVersions.delete(id); }
      toast(id === 'new' ? '新岗位已添加 · 刚刚' : '本行已保存 · 刚刚');
      if (viewMounted()) { refreshApplicationOptions(); refreshApplicationSummary(); draw(); }
      else if (draftIsUnchanged && page === 'applications') refreshCurrentPage(renderApplications).catch(err => toast(err.message, true));
    } catch (err) {
      applicationPendingRows.delete(id);
      if (viewMounted()) draw();
      else if (page === 'applications') refreshCurrentPage(renderApplications).catch(reloadError => toast(reloadError.message, true));
      toast(err.message, true);
    }
  };
  const bind = () => {
    content.querySelectorAll('[data-app-field]').forEach(field => { field.addEventListener('input', markDirty); field.addEventListener('change', markDirty); field.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.type !== 'date' && e.target.tagName === 'INPUT') { e.preventDefault(); saveRow(e.target.dataset.appRow); } }); });
    bindCompactPickers(content);
    content.querySelectorAll('[data-app-save]').forEach(b => b.onclick = () => saveRow(b.dataset.appSave));
    content.querySelectorAll('[data-app-cancel]').forEach(b => b.onclick = () => { drafts.delete('new'); applicationDraftVersions.delete('new'); draw(); });
    content.querySelectorAll('[data-app-cancel-row]').forEach(b => b.onclick = () => { drafts.delete(b.dataset.appCancelRow); applicationDraftVersions.delete(b.dataset.appCancelRow); draw(); });
    content.querySelectorAll('[data-app-detail]').forEach(b => b.onclick = () => {
      if (drafts.has(b.dataset.appDetail)) { toast('请先保存或取消本行修改', true); return; }
      applicationDetail(b.dataset.appDetail).catch(err => toast(err.message, true));
    });
    content.querySelectorAll('[data-app-edit]').forEach(b => b.onclick = () => {
      if (drafts.has(b.dataset.appEdit)) { toast('请先保存或取消本行修改', true); return; }
      applicationForm(apps.find(a => a.id === b.dataset.appEdit), versions);
    });
  };
  document.querySelector('#app-search').oninput = draw;
  document.querySelector('#app-stage').onchange = draw;
  document.querySelector('#app-channel').onchange = draw;
  document.querySelector('#app-resume').onchange = e => { applicationResumeFilterId = e.target.value; draw(); };
  document.querySelector('#app-sort').onchange = draw;
  const revealNewApplicationRow = (message = '') => {
    const input = document.querySelector('[data-app-row="new"][data-app-field="company"]');
    if (!input) return;
    input.closest('tr')?.scrollIntoView?.({ behavior: 'auto', block: 'center' });
    const focusTarget = input.closest('[data-compact-picker]')?.querySelector('[data-picker-trigger]') || input;
    focusTarget.focus?.({ preventScroll: true });
    if (message) toast(message);
  };
  content.querySelector('[data-add-app]').onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    if (drafts.has('new')) { revealNewApplicationRow('已有一条未保存的新增岗位，已定位到输入行'); return; }
    drafts.set('new', blank());
    applicationDraftVersions.set('new', (applicationDraftVersions.get('new') ?? 0) + 1);
    draw();
    revealNewApplicationRow('已新增一行，请先填写公司和岗位名称');
  };
  draw();
}

async function renderResumes(viewToken = ++navigationToken) {
  const [tracks, versions] = await Promise.all([api('/resume-tracks'), api('/resume-versions')]);
  if (!isCurrentView('resumes', viewToken)) return;
  cache = { ...cache, tracks, versions };
  const currentTracks = tracks.filter(track => track.currentVersionId).length;
  const referencedVersions = versions.filter(version => version.referenceCount > 0).length;
  const shelf = tracks.length ? tracks.slice(0, 6).map((track, index) => `<div class="shelf-item"><i class="shelf-spine spine-${index % 4}"></i><span>${esc(track.name)}</span><small>${track.currentVersionId ? '有当前版本' : '待上传'}</small></div>`).join('') : '<div class="shelf-empty"><span>你的简历架</span><small>从一个求职方向开始</small></div>';
  const intro = pageIntro({
    kicker: tracks.length ? 'VERSION SHELF / 版本架' : 'BUILD YOUR SHELF / 先建一格',
    title: tracks.length ? `${tracks.length} 个方向，${versions.length} 个版本` : '让每个方向都有自己的版本架',
    copy: tracks.length ? '简历不是一次性交付的文件，而是一组会随岗位变化的工作样本。这里保留每一次迭代和它被使用过的地方。' : '先写下你的求职方向，再把不同岗位使用过的版本收进来。之后的岗位引用会自动连回这里。',
    accent: 'sage',
    art: 'shelf',
    artLabel: 'KEEP A COPY',
    stats: [
      { value: tracks.length, label: '简历方向' },
      { value: versions.length, label: '版本总数' },
      { value: currentTracks, label: '有当前版本' },
      { value: referencedVersions, label: '已被岗位引用' }
    ]
  });
  content.innerHTML = `${intro}<div class="resume-overview"><div class="resume-overview-copy"><p class="section-kicker">ARCHIVE NOTE / 档案提示</p><strong>${tracks.length ? '每次更新都留下一个可回看的节点' : '先给一个方向命名'}</strong><span>${tracks.length ? '历史投递不会被新版本覆盖，引用关系会一直保留。' : '例如：AI Agent、RAG、产品工程。名称会成为你的简历档案入口。'}</span></div><div class="resume-shelf" aria-label="简历方向概览">${shelf}</div></div><div class="toolbar"><span class="muted">每次更新创建新版本，历史投递保持原关联。</span><span class="spacer"></span><button type="button" class="btn primary" data-add-track>新建简历方向</button></div><div class="resume-grid">${tracks.length ? tracks.map(t => {
    const vs = versions.filter(v => v.trackId === t.id);
    const versionList = vs.map(v => {
      const fileUrl = `/api/files/${v.id}`;
      const fileLink = v.fileExists === false ? `<span class="resume-file-name">${esc(v.originalName)}</span>` : `<button type="button" class="resume-file-link" data-preview-version="${esc(v.id)}" title="在工作台内预览简历">${esc(v.originalName)} ↗</button>`;
      const fileActions = v.fileExists === false ? `<span class="status-label overdue">文件缺失</span><button type="button" class="btn small" data-reassociate-version="${v.id}">重新关联文件</button>` : `<button type="button" class="btn small primary" data-preview-version="${esc(v.id)}">打开简历 ↗</button><a class="btn small" href="${fileUrl}?download=1" download="${esc(v.originalName)}">下载原文件</a><button type="button" class="btn small" data-reassociate-version="${v.id}">替换文件</button>`;
      const referenceNote = v.referenceCount ? `<button class="status-label current reference-link" data-reference-filter="${v.id}">被 ${v.referenceCount} 个岗位引用 · 只能归档</button>` : '';
      const deleteAction = v.referenceCount ? '' : `<button class="btn small danger" data-delete-version="${v.id}">删除版本</button>`;
      return `<div class="list-item sticky-note resume-note${freshClass('resume-version', v.id)}"><div><strong>${esc(v.versionName)} ${v.id === t.currentVersionId ? badge('当前版本', 'current') : ''}</strong><p>${fileLink}${v.archived ? ' · 已归档' : ''}</p><div class="version-notes">${referenceNote}</div></div><div class="actions"><button type="button" class="btn small" data-edit-version="${v.id}">编辑信息</button>${fileActions}${v.id !== t.currentVersionId ? `<button type="button" class="btn small" data-current="${v.id}">设为当前</button>` : ''}<button type="button" class="btn small" data-archive="${v.id}" data-value="${v.archived ? 0 : 1}">${v.archived ? '取消归档' : '归档'}</button>${deleteAction}</div></div>`;
    }).join('');
    return `<article class="resume-card${freshClass('resume-track', t.id)}" data-float><div class="resume-card-head"><h3>${esc(t.name)}</h3><button type="button" class="btn small" data-edit-track="${t.id}">编辑方向</button></div><div class="direction">${esc(t.direction || '未填写方向')}</div><div class="version-row">${vs.length ? `<div class="list">${versionList}</div>` : empty('这个方向还没有文件', '上传第一版简历。')}</div><div class="track-actions"><button type="button" class="btn primary small" data-upload="${t.id}">上传版本</button>${vs.length ? '' : `<button type="button" class="btn small danger" data-delete-track="${t.id}">删除方向</button>`}</div></article>`;
  }).join('') : empty('还没有简历档案', '先创建一个求职方向，再上传简历版本。')}</div>`;
  content.querySelector('[data-add-track]').onclick = () => trackForm();
  content.querySelectorAll('[data-edit-track]').forEach(b => b.onclick = () => trackForm(tracks.find(t => t.id === b.dataset.editTrack)));
  content.querySelectorAll('[data-upload]').forEach(b => b.onclick = () => versionForm(b.dataset.upload));
  content.querySelectorAll('[data-edit-version]').forEach(b => b.onclick = () => versionMetaForm(versions.find(v => v.id === b.dataset.editVersion)));
  content.querySelectorAll('[data-reassociate-version]').forEach(b => b.onclick = () => reassociateVersion(b.dataset.reassociateVersion));
  content.querySelectorAll('[data-reference-filter]').forEach(b => b.onclick = () => { applicationResumeFilterId = b.dataset.referenceFilter; navigate('applications'); });
  content.querySelectorAll('[data-preview-version]').forEach(b => b.onclick = () => previewVersion(b.dataset.previewVersion));
  content.querySelectorAll('[data-current]').forEach(b => b.onclick = async () => { try { await api(`/resume-versions/${b.dataset.current}`, { method: 'PATCH', body: { makeCurrent: true } }); toast('已设为当前版本 · 刚刚'); refreshCurrentPage(renderResumes); } catch (err) { toast(err.message, true); } });
  content.querySelectorAll('[data-archive]').forEach(b => b.onclick = async () => { try { await api(`/resume-versions/${b.dataset.archive}`, { method: 'PATCH', body: { archived: Number(b.dataset.value) } }); toast('版本状态已更新 · 刚刚'); refreshCurrentPage(renderResumes); } catch (err) { toast(err.message, true); } });
  content.querySelectorAll('[data-delete-version]').forEach(b => b.onclick = async () => { if (await askConfirm('永久删除这个未被岗位引用的版本及其文件。', { title: '删除这个简历版本？', confirmLabel: '删除版本', danger: true })) { const note = b.closest('.resume-note'); b.disabled = true; try { await api(`/resume-versions/${b.dataset.deleteVersion}`, { method: 'DELETE', body: {} }); await dissolve(note); toast('简历版本已删除 · 刚刚'); refreshCurrentPage(renderResumes); } catch (err) { b.disabled = false; toast(err.message, true); } } });
  content.querySelectorAll('[data-delete-track]').forEach(b => b.onclick = async () => { if (await askConfirm('这个方向目前没有简历版本。', { title: '删除这个简历方向？', confirmLabel: '删除方向', danger: true })) { try { await api(`/resume-tracks/${b.dataset.deleteTrack}`, { method: 'DELETE' }); toast('简历方向已删除 · 刚刚'); refreshCurrentPage(renderResumes); } catch (err) { toast(err.message, true); } } });
}

async function renderSettings(viewToken = ++navigationToken) {
  const settings = await api('/settings');
  if (!isCurrentView('settings', viewToken)) return;
  const intro = pageIntro({
    kicker: 'OFFLINE VAULT / 本地档案',
    title: '你的数据，安静地留在这里',
    copy: '工作台只监听本机地址。数据目录、简历文件和完整备份都由你掌握，重要的动作都会先留下可恢复的安全副本。',
    accent: 'blue',
    art: 'vault',
    artLabel: 'LOCAL ONLY',
    stats: [
      { value: '本机', label: '运行位置' },
      { value: '离线', label: '连接方式' },
      { value: settings.version, label: '工作台版本' },
      { value: '可恢复', label: '备份策略' }
    ]
  });
  content.innerHTML = `${intro}<section class="theme-panel" data-spotlight data-float><div class="theme-panel-copy"><p class="section-kicker">LIGHTING / 桌面光线</p><h2>选择今天的工作场景</h2><p>白天保留暖纸张与清晰线条；夜间切换成更安静的墨蓝桌面。你的选择只保存在本机。</p><strong data-theme-status>白天桌面 · 暖纸光线</strong></div><div class="theme-choices"><button type="button" class="theme-choice" data-theme-choice="day" aria-pressed="true"><span class="theme-swatch theme-swatch-day"></span><strong>白天</strong><small>PAPER DESK</small></button><button type="button" class="theme-choice" data-theme-choice="night" aria-pressed="false"><span class="theme-swatch theme-swatch-night"></span><strong>夜间</strong><small>AFTER HOURS</small></button></div></section><div class="setting-principles"><div class="setting-principle"><span>01</span><strong>留在本机</strong><p>课程、计划、岗位和简历文件都写入当前数据目录。</p></div><div class="setting-principle"><span>02</span><strong>保留版本</strong><p>导出的是完整档案，简历版本和岗位引用不会被压扁成一份文件。</p></div><div class="setting-principle"><span>03</span><strong>先留副本</strong><p>整体恢复前会自动保留恢复前的安全副本，方便回到上一个状态。</p></div></div><div class="dashboard-grid settings-grid"><article class="card"><div class="card-head"><h2>本地数据</h2>${badge('运行正常', 'current')}</div><div class="card-body"><p class="muted">当前数据目录</p><p class="setting-value"><strong>${esc(settings.dataDir)}</strong></p><p class="muted">工作台 ${esc(settings.version)} · 仅监听本机地址</p></div></article><article class="card"><div class="card-head"><h2>备份与恢复</h2></div><div class="card-body"><p>完整备份包含课程、计划、岗位、备忘和受管简历文件。</p><div class="actions file-actions"><a class="btn primary" href="/api/backup">导出完整备份</a><input id="restore-file" class="file-input" type="file" accept=".pwb"><button type="button" class="btn file-picker-trigger" data-file-trigger="restore-file">选择备份</button><span class="file-name" data-file-name="restore-file">未选择文件</span></div><p id="restore-status" class="muted" aria-live="polite">恢复会整体替换当前数据，并自动保留恢复前安全副本。</p></div></article></div>`;
  bindFilePicker(document, 'restore-file');
  content.querySelectorAll('[data-theme-choice]').forEach(control => control.onclick = () => applyTheme(control.dataset.themeChoice, true));
  syncThemeControls();
  document.querySelector('#restore-file').onchange = async e => {
    const file = e.target.files[0];
    if (!file || !(await askConfirm(`使用“${file.name}”完整替换当前数据？当前数据会先保留安全副本。`, { title: '恢复这份完整备份？', confirmLabel: '开始恢复', danger: true, kicker: 'RESTORE DESK / 恢复桌面' }))) return;
    const status = document.querySelector('#restore-status'); const picker = document.querySelector('#restore-file');
    try { picker.disabled = true; status.textContent = '校验备份文件…'; toast('校验备份文件…'); const data = await fileToBase64(file); status.textContent = '替换本地数据…'; toast('替换本地数据…'); const result = await api('/backup/restore', { method: 'POST', body: { data } }); const total = Object.values(result.counts || {}).reduce((sum, count) => sum + Number(count || 0), 0); status.textContent = `已恢复 · 共 ${total} 条记录 · 已保留恢复前安全副本`; toast(`恢复完成 · 共 ${total} 条记录`); navigate('dashboard'); }
    catch (err) { picker.disabled = false; status.textContent = `恢复失败：${err.message}`; toast(err.message, true); }
  };
}

const field = (label, name, type = 'text', value = '', extra = '') => `<label class="field-label"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${extra}></label>`;
const select = (label, name, options, value = '', className = '') => `<label class="field-label${className ? ` ${esc(className)}-field` : ''}"><span>${esc(label)}</span><select class="${esc(className)}" name="${esc(name)}">${options.map(([v, t]) => `<option value="${esc(v)}" ${v == value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
const fileField = (id, label, accept, hint) => `<div class="field-label full file-field"><span>${esc(label)}</span><div class="file-picker"><input id="${esc(id)}" name="file" class="file-input" type="file" accept="${esc(accept)}" required><button type="button" class="btn file-picker-trigger" data-file-trigger="${esc(id)}">选择文件</button><span class="file-name" data-file-name="${esc(id)}">未选择文件</span></div><small class="file-hint">${esc(hint)}</small></div>`;

function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function bindFilePicker(container, id) {
  const input = container.querySelector(`#${id}`);
  const trigger = container.querySelector(`[data-file-trigger="${id}"]`);
  const name = container.querySelector(`[data-file-name="${id}"]`);
  const update = () => {
    const file = input?.files?.[0];
    if (name) name.textContent = file ? `${file.name} · ${formatFileSize(file.size)}` : '未选择文件';
    if (trigger) trigger.classList.toggle('has-file', Boolean(file));
  };
  trigger?.addEventListener('click', () => input?.click?.());
  input?.addEventListener('change', update);
  update();
}

function bindFormSubmit(form, submit, action, { busyText, idleText }) {
  let running = false;
  const execute = async event => {
    event.preventDefault();
    if (running) return;
    const requiredFile = form.querySelector('input[type="file"][required]');
    if (requiredFile && !requiredFile.files?.length) { toast('请先选择文件', true); requiredFile.focus?.(); return; }
    if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    running = true;
    submit.disabled = true;
    submit.textContent = busyText;
    try { await action(); }
    catch (err) { running = false; submit.disabled = false; submit.textContent = idleText; toast(err.message, true); }
  };
  form.addEventListener('submit', execute);
  submit.addEventListener('click', execute);
}

function formShell(title, fields, handler, { freshKind = '' } = {}) {
  openModal(`<h2>${esc(title)}</h2><form id="edit-form" class="form-grid">${fields}<div class="form-actions"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">保存到本机</button></div></form>`);
  const form = document.querySelector('#edit-form');
  const submit = form.querySelector('button[type="submit"]');
  bindFormSubmit(form, submit, async () => { const result = await handler(Object.fromEntries(new FormData(form))); if (freshKind) markFresh(result, freshKind); closeModal(); toast('已保存 · 刚刚'); navigate(page, { preserve: true }); }, { busyText: '保存中…', idleText: '保存到本机' });
}

function semesterForm(semester = {}) {
  const editing = Boolean(semester.id);
  const endpoint = editing ? `/semesters/${semester.id}` : '/semesters';
  const method = editing ? 'PATCH' : 'POST';
  formShell(editing ? '编辑当前学期' : '设置当前学期', `${field('学期名称', 'name', 'text', semester.name || '', 'required')}${field('第一教学周周一', 'startsOn', 'date', semester.startsOn || localDate(new Date()), 'required')}${field('总周数', 'totalWeeks', 'number', semester.totalWeeks || '18', 'min="1" max="30" required')}<input type="hidden" name="isCurrent" value="1">`, d => api(endpoint, { method, body: { ...d, totalWeeks: Number(d.totalWeeks), isCurrent: 1 } }));
}

function scheduleSettingsForm(semester, periods = defaultSchedulePeriods) {
  const values = periods.length === 12 ? periods : defaultSchedulePeriods;
  const periodRows = values.map(period => {
    const number = periodValue(period, 'periodNo', 'period_no');
    return `<div class="schedule-setting-row"><strong>${esc(number).padStart?.(2, '0') || esc(number)}</strong><span>${esc(periodValue(period, 'label', 'label') || `第${number}节`)}</span><input name="period-start-${number}" type="time" value="${esc(periodValue(period, 'startTime', 'start_time'))}" required aria-label="第${number}节开始时间"><i>—</i><input name="period-end-${number}" type="time" value="${esc(periodValue(period, 'endTime', 'end_time'))}" required aria-label="第${number}节结束时间"></div>`;
  }).join('');
  openModal(`<p class="drawer-kicker">SCHEDULE SETTINGS / 课表设置</p><h2>让这张时间地图贴合你的作息</h2><form id="schedule-settings-form" class="schedule-settings-form"><section class="settings-form-section"><p class="section-kicker">TERM / 学期设置</p><div class="form-grid">${field('学期名称', 'name', 'text', semester.name, 'required')}${field('第一教学周周一', 'startsOn', 'date', semester.startsOn, 'required')}${field('总周数', 'totalWeeks', 'number', semester.totalWeeks, 'min="1" max="30" required')}</div></section><section class="settings-form-section"><div class="settings-section-head"><div><p class="section-kicker">RHYTHM / 作息时间</p><h3>12 节课的起止时间</h3></div><span class="muted">课程块会跟随这里更新</span></div><div class="schedule-setting-list">${periodRows}</div></section><div class="form-actions"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">保存课表设置</button></div></form>`);
  const form = document.querySelector('#schedule-settings-form');
  const submit = form.querySelector('button[type="submit"]');
  bindFormSubmit(form, submit, async () => {
    const data = Object.fromEntries(new FormData(form));
    await api(`/semesters/${semester.id}`, { method: 'PATCH', body: { name: data.name, startsOn: data.startsOn, totalWeeks: Number(data.totalWeeks), isCurrent: 1 } });
    await api('/schedule-periods', { method: 'PUT', body: { semesterId: semester.id, periods: values.map(period => { const number = periodValue(period, 'periodNo', 'period_no'); return { periodNo: Number(number), label: periodValue(period, 'label', 'label') || `第${number}节`, startTime: data[`period-start-${number}`], endTime: data[`period-end-${number}`] }; }) } });
    closeModal();
    toast('课表设置已保存 · 刚刚');
    navigate(page, { preserve: true });
  }, { busyText: '保存中…', idleText: '保存课表设置' });
}

function courseForm(semester, c = {}, periods = cache.periods?.length ? cache.periods : defaultSchedulePeriods) {
  const range = normalizedCoursePeriods(c, periods);
  const periodOptions = periods.map(period => [periodValue(period, 'periodNo', 'period_no'), periodValue(period, 'label', 'label') || `第${periodValue(period, 'periodNo', 'period_no')}节`]);
  const customPattern = courseWeekPattern(c) === 'custom';
  const fields = `<input type="hidden" name="semesterId" value="${esc(semester.id)}">${field('课程名称', 'name', 'text', c.name, 'required')}${select('星期', 'weekday', weekdays.map((x, i) => [i + 1, x]), c.weekday || 1)}<div class="field-label period-range-field"><span>节次范围</span><div class="period-range-inputs">${select('', 'startPeriod', periodOptions, range.start)}<b>至</b>${select('', 'endPeriod', periodOptions, range.end)}</div><output class="period-time-preview" data-period-preview></output></div>${field('地点', 'location', 'text', c.location)}${field('任课老师', 'teacher', 'text', c.teacher)}${field('起始周', 'startWeek', 'number', c.startWeek || 1, 'min="1" required')}${field('结束周', 'endWeek', 'number', c.endWeek || semester.totalWeeks, 'min="1" required')}${select('周规则', 'weekPattern', [['every', '每周'], ['odd', '单周'], ['even', '双周'], ['custom', '自定义周次']], c.weekPattern || 'every')}<label class="field-label full course-custom-weeks-field" data-custom-weeks-field><span>自定义周次</span><input name="customWeeks" value="${esc(c.customWeeks || c.custom_weeks || '')}" placeholder="例如：1, 3, 5-6"><small>用逗号分隔单周或区间；课程仍受起始周和结束周限制。</small></label><label class="field-label full"><span>备注</span><textarea name="notes">${esc(c.notes)}</textarea></label>`;
  formShell(c.id ? '编辑课程' : '新增课程', fields, d => {
    const startPeriod = Number(d.startPeriod);
    const endPeriod = Number(d.endPeriod);
    const start = periods.find(period => Number(periodValue(period, 'periodNo', 'period_no')) === startPeriod) || periods[0];
    const end = periods.find(period => Number(periodValue(period, 'periodNo', 'period_no')) === endPeriod) || periods[periods.length - 1];
    return api(`/courses${c.id ? '/' + c.id : ''}`, { method: c.id ? 'PATCH' : 'POST', body: { ...d, weekday: Number(d.weekday), startPeriod, endPeriod, startTime: periodValue(start, 'startTime', 'start_time'), endTime: periodValue(end, 'endTime', 'end_time'), startWeek: Number(d.startWeek), endWeek: Number(d.endWeek), customWeeks: d.weekPattern === 'custom' ? String(d.customWeeks || '').trim() : '' } });
  }, { freshKind: c.id ? '' : 'course' });
  const form = document.querySelector('#edit-form');
  const pattern = form.querySelector('[name="weekPattern"]');
  const customField = form.querySelector('[data-custom-weeks-field]');
  const preview = form.querySelector('[data-period-preview]');
  const sync = () => {
    const start = periods.find(period => Number(periodValue(period, 'periodNo', 'period_no')) === Number(form.querySelector('[name="startPeriod"]').value)) || periods[0];
    const end = periods.find(period => Number(periodValue(period, 'periodNo', 'period_no')) === Number(form.querySelector('[name="endPeriod"]').value)) || periods[periods.length - 1];
    if (preview) preview.textContent = `${periodValue(start, 'startTime', 'start_time')}–${periodValue(end, 'endTime', 'end_time')} · ${form.querySelector('[name="startPeriod"]').value}–${form.querySelector('[name="endPeriod"]').value} 节`;
    if (customField) customField.hidden = pattern.value !== 'custom';
  };
  form.querySelectorAll('[name="startPeriod"],[name="endPeriod"], [name="weekPattern"]').forEach(control => control.addEventListener('change', sync));
  sync();
}

function timetableImportForm(semesters = [], current = null) {
  const targetOptions = `<option value="">新建学期 / 按名称匹配</option>${semesters.map(semester => `<option value="${esc(semester.id)}">${esc(semester.name)}${semester.isCurrent ? ' · 当前' : ''}</option>`).join('')}`;
  const defaultStartsOn = current?.startsOn || localDate(mondayFor(new Date()));
  const defaultTotalWeeks = current?.totalWeeks || 18;
  openModal(`<p class="drawer-kicker">IMPORT / XLSX 课表</p><h2>把另一份课表带进来</h2><p class="import-lede">选择任意同类 XLSX，系统会按星期列、节次和课程明细识别安排；同一安排重复导入会自动跳过。这里只导入固定课表，不包含临时调课。</p><form id="timetable-import-form" class="form-grid import-form"><div class="import-summary full" data-import-summary><strong>等待选择课表文件</strong><span>支持之后继续导入其他学期的 XLSX。</span></div>${fileField('timetable-file', '课表文件', '.xlsx', '支持常见教务系统导出的 XLSX；系统会先解析预览，不会直接覆盖已有课程。')}<div class="field-label full"><span>导入目标</span><select name="semesterId" id="timetable-target">${targetOptions}</select><small>选择已有学期会合并并跳过重复安排；选择新建会按检测到的学期名称创建。</small></div>${field('学期名称', 'semesterName', 'text', '', 'required')}${field('第一教学周周一', 'startsOn', 'date', defaultStartsOn, 'required')}${field('总周数', 'totalWeeks', 'number', defaultTotalWeeks, 'min="1" max="30" required')}<label class="field-label full import-current-choice"><input type="checkbox" name="makeCurrent" checked><span>导入后设为当前学期</span></label><div class="form-actions"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">导入到课表</button></div></form>`);
  const form = document.querySelector('#timetable-import-form');
  const fileInput = form.querySelector('#timetable-file');
  const target = form.querySelector('#timetable-target');
  const nameInput = form.querySelector('[name="semesterName"]');
  const startsInput = form.querySelector('[name="startsOn"]');
  const totalInput = form.querySelector('[name="totalWeeks"]');
  const summary = form.querySelector('[data-import-summary]');
  const semesterById = new Map(semesters.map(semester => [semester.id, semester]));
  let file = null;
  let workbookData = '';
  let previewToken = 0;
  let nameTouched = false;
  let totalTouched = false;
  bindFilePicker(form, 'timetable-file');
  nameInput.addEventListener('input', () => { nameTouched = true; });
  totalInput.addEventListener('input', () => { totalTouched = true; });
  target.addEventListener('change', () => {
    const semester = semesterById.get(target.value);
    if (!semester) return;
    if (!nameTouched) nameInput.value = semester.name;
    if (!startsInput.value || startsInput.value === defaultStartsOn) startsInput.value = semester.startsOn;
    if (!totalTouched) totalInput.value = semester.totalWeeks;
  });
  fileInput.addEventListener('change', async () => {
    file = fileInput.files?.[0] || null;
    workbookData = '';
    if (!file) return;
    const request = ++previewToken;
    summary.classList.remove('is-error');
    summary.innerHTML = '<strong>正在读取课表…</strong><span>会先检查工作表和课程安排。</span>';
    try {
      workbookData = await fileToBase64(file);
      const preview = await api('/timetable-import', { method: 'POST', body: { preview: true, file: { name: file.name, data: workbookData } } });
      if (request !== previewToken) return;
      if (!nameTouched && !target.value) nameInput.value = preview.semesterName;
      if (!totalTouched) totalInput.value = Math.max(Number(totalInput.value || 1), Number(preview.totalWeeks || 1));
      summary.innerHTML = `<strong>${esc(preview.semesterName)}</strong><span>工作表 ${esc(preview.sheetName)} · 识别 ${esc(preview.totalCount)} 条课程安排；示例：${esc(preview.sample?.slice(0, 2).map(item => item.name).join('、') || '—')}</span>`;
    } catch (err) {
      if (request !== previewToken) return;
      summary.classList.add('is-error');
      summary.innerHTML = `<strong>无法识别这份课表</strong><span>${esc(err.message)}</span>`;
    }
  });
  const submit = form.querySelector('button[type="submit"]');
  bindFormSubmit(form, submit, async () => {
    if (!file) throw new Error('请选择一个 XLSX 文件');
    if (!workbookData) workbookData = await fileToBase64(file);
    const data = Object.fromEntries(new FormData(form));
    const result = await api('/timetable-import', { method: 'POST', body: { file: { name: file.name, data: workbookData }, semesterId: data.semesterId || undefined, semesterName: String(data.semesterName || '').trim(), startsOn: data.startsOn, totalWeeks: Number(data.totalWeeks), makeCurrent: data.makeCurrent === 'on' } });
    closeModal();
    courseWeekOffset = 0;
    toast(`课表导入完成 · 新增 ${result.importedCount} 条，跳过重复 ${result.skippedCount} 条`);
    refreshCurrentPage(renderCourses);
  }, { busyText: '导入中…', idleText: '导入到课表' });
}
function planForm(p = {}) { formShell(p.id ? '编辑计划' : '新增计划', `${field('标题', 'title', 'text', p.title, 'required')}${field('分类', 'category', 'text', p.category)}${field('开始日期', 'startDate', 'date', p.startDate)}${field('截止日期', 'dueDate', 'date', p.dueDate || localDate(), 'required')}${field('开始时间', 'startTime', 'time', p.startTime)}${field('截止时间', 'dueTime', 'time', p.dueTime)}${select('优先级', 'priority', [['high', '高'], ['medium', '中'], ['low', '低']], p.priority || 'medium')}${select('状态', 'status', [['todo', '待开始'], ['doing', '进行中'], ['done', '已完成']], p.status || 'todo')}<label class="field-label full"><span>备注</span><textarea name="notes">${esc(p.notes)}</textarea></label>`, d => api(`/plans${p.id ? '/' + p.id : ''}`, { method: p.id ? 'PATCH' : 'POST', body: d }), { freshKind: p.id ? '' : 'plan' }); }
function convertForm(id) { formShell('把备忘转成计划', `${field('截止日期', 'dueDate', 'date', localDate(), 'required')}${select('优先级', 'priority', [['high', '高'], ['medium', '中'], ['low', '低']], 'medium')}${field('分类', 'category', 'text', '')}`, d => api(`/memos/${id}/convert`, { method: 'POST', body: d }), { freshKind: 'plan' }); }
function applicationForm(a = {}, versions = []) {
  const channelLabels = [...new Set([...(cache.apps || []).map(item => item.channelLabel || ''), a.channelLabel || ''].map(value => String(value).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const channelPicker = compactPickerMarkup({ name: 'channelLabel', value: a.channelLabel || '', options: [['', '不设置名称'], ...channelLabels.map(label => [label, label])], placeholder: '渠道名称', searchLabel: '查找或创建渠道名称', ariaLabel: '投递渠道名称', allowCustom: true, className: 'channel-label-picker' });
  const resumePicker = compactPickerMarkup({ name: 'resumeVersionId', value: a.resumeVersionId || '', options: [['', '暂未关联'], ...versions.map(v => [v.id, `${v.versionName} · ${v.originalName}`])], placeholder: '暂未关联', searchLabel: '搜索简历版本', ariaLabel: '使用简历', className: 'resume-choice-picker' });
  const fields = `${field('公司', 'company', 'text', a.company, 'required')}${field('岗位名称', 'roleName', 'text', a.roleName, 'required')}${field('地点', 'location', 'text', a.location)}<label class="field-label channel-label-field"><span>投递渠道名称</span>${channelPicker}</label>${field('投递网址', 'channel', 'text', a.channel, 'placeholder="https://example.com/apply"')}<p class="field-hint full">名称只负责显示，网址仍保留为可点击的 http/https 链接。</p>${field('投递日期', 'appliedOn', 'date', a.appliedOn)}${select('当前阶段', 'stage', stageOptions.map(x => [x, x]), a.stage || '待投递')}<label class="field-label resume-choice-select-field"><span>使用的简历版本</span>${resumePicker}</label><label class="field-label full"><span>备注</span><textarea name="notes">${esc(a.notes)}</textarea></label>`;
  formShell(a.id ? '编辑岗位' : '新增岗位', fields, d => api(`/applications${a.id ? '/' + a.id : ''}`, { method: a.id ? 'PATCH' : 'POST', body: { ...d, resumeVersionId: d.resumeVersionId || null } }));
  bindCompactPickers(document.querySelector('#edit-form'));
}
async function applicationDetail(id) {
  const requestToken = ++detailRequestToken;
  const a = await api(`/applications/${id}/detail`);
  if (requestToken !== detailRequestToken || !['dashboard', 'applications'].includes(page)) return;
  const version = a.resumeVersion || cache.versions?.find(v => v.id === a.resumeVersionId);
  const resumeText = version ? `${version.versionName} · ${version.originalName}${version.fileExists === false ? ' · 文件缺失，请上传新版本' : ''}` : '未关联';
  const channelDisplay = a.channelLabel || a.channel || '未填写';
  const channelLink = externalLinkMarkup(a.channel, a.channelLabel ? `${a.channelLabel} ↗` : '打开投递链接 ↗', 'detail-link');
  const legacyJobLink = externalLinkMarkup(a.jobUrl, '打开岗位链接 ↗', 'detail-link');
  const details = `<dl class="detail-meta"><div><dt>投递渠道</dt><dd>${channelLink || esc(channelDisplay)}${a.channelLabel && a.channel && !channelLink ? `<small class="detail-subtle">${esc(a.channel)}</small>` : ''}</dd></div><div><dt>投递日期</dt><dd>${esc(a.appliedOn || '未填写')}</dd></div><div><dt>使用简历</dt><dd>${esc(resumeText)}</dd></div></dl>`;
  const stageEditor = `<label class="detail-stage"><span>当前阶段</span><select id="detail-stage">${stageOptions.map(stage => `<option value="${esc(stage)}" ${stage === a.stage ? 'selected' : ''}>${esc(stage)}</option>`).join('')}</select></label>`;
  openModal(`<h2>${esc(a.company)} · ${esc(a.roleName)}</h2><p>${badge(a.stage, 'stage')} <span class="muted">${esc(a.location || '地点未填写')}</span></p>${stageEditor}${details}${a.notes ? `<p class="detail-notes"><span class="detail-label">备注</span>${esc(a.notes)}</p>` : ''}${legacyJobLink ? `<p>${legacyJobLink}<span class="muted"> 旧岗位链接 · 将离开本地工作台</span></p>` : ''}<h3>面试安排</h3><div class="list">${a.interviews.length ? a.interviews.map(i => `<div class="list-item"><div><strong>${esc(i.roundName)}</strong><p>${fmt(i.scheduledAt)} · ${esc(i.mode || i.location || '')}${i.result ? ' · ' + esc(i.result) : ''}${i.notes ? ' · ' + esc(i.notes) : ''}</p></div><div class="actions"><button class="btn small" data-interview-edit="${i.id}">编辑</button><button class="btn small danger" data-interview-del="${i.id}">删除面试</button></div></div>`).join('') : empty('暂无面试安排', '收到安排后添加。')}</div><button class="btn primary" id="add-interview">添加面试</button><h3>阶段历史</h3><div class="list">${a.history.map(h => `<div class="list-item"><span>${esc(h.fromStage || '开始')} → <strong>${esc(h.toStage)}</strong></span><small>${fmt(h.changedAt)}</small></div>`).join('')}</div><button class="btn danger" data-app-del="${a.id}">删除岗位</button>`);
  document.querySelector('#detail-stage').onchange = async e => { try { await api(`/applications/${id}`, { method: 'PATCH', body: { stage: e.target.value } }); toast('当前阶段已更新 · 刚刚'); applicationDetail(id); } catch (err) { toast(err.message, true); } };
  document.querySelector('#add-interview').onclick = () => interviewForm(id);
  document.querySelectorAll('[data-interview-edit]').forEach(b => b.onclick = () => interviewForm(id, a.interviews.find(i => i.id === b.dataset.interviewEdit)));
  document.querySelectorAll('[data-interview-del]').forEach(b => b.onclick = async () => { if (await askConfirm('删除后这条面试记录将从岗位时间线移除。', { title: '删除这条面试记录？', confirmLabel: '删除面试', danger: true })) { try { await api(`/interviews/${b.dataset.interviewDel}`, { method: 'DELETE', body: {} }); toast('面试记录已删除 · 刚刚'); applicationDetail(id); } catch (err) { toast(err.message, true); } } });
  document.querySelector('[data-app-del]').onclick = async () => { if (await askConfirm('删除后岗位、阶段历史和面试安排都会移除，但不会删除被引用的简历文件。', { title: '删除这个岗位？', confirmLabel: '删除岗位', danger: true })) { try { await api(`/applications/${a.id}`, { method: 'DELETE', body: {} }); closeModal(); toast('岗位已删除 · 刚刚'); refreshCurrentPage(renderApplications); } catch (err) { toast(err.message, true); } } };
}
function interviewForm(applicationId, i = {}) { formShell(i.id ? '编辑面试安排' : '添加面试安排', `<input type="hidden" name="applicationId" value="${esc(applicationId)}">${field('轮次', 'roundName', 'text', i.roundName, 'required')}${field('面试时间', 'scheduledAt', 'datetime-local', i.scheduledAt?.slice(0, 16), 'required')}${select('方式', 'mode', [['线上', '线上'], ['线下', '线下'], ['电话', '电话']], i.mode || '线上')}${field('地点 / 会议说明', 'location', 'text', i.location)}${field('结果', 'result', 'text', i.result)}<label class="field-label full"><span>备注</span><textarea name="notes">${esc(i.notes)}</textarea></label>`, d => api(`/interviews${i.id ? '/' + i.id : ''}`, { method: i.id ? 'PATCH' : 'POST', body: d })); }
function trackForm(track = {}) {
  const editing = Boolean(track.id);
  const endpoint = editing ? `/resume-tracks/${track.id}` : '/resume-tracks';
  const method = editing ? 'PATCH' : 'POST';
  formShell(editing ? '编辑简历方向' : '新建简历方向', `${field('名称', 'name', 'text', track.name, 'required')}${field('求职方向', 'direction', 'text', track.direction)}<label class="field-label full"><span>备注</span><textarea name="notes">${esc(track.notes)}</textarea></label>`, d => api(endpoint, { method, body: d }), { freshKind: editing ? '' : 'resume-track' });
}
function versionForm(trackId) {
  openModal(`<h2>新增简历版本</h2><form id="version-form" class="form-grid"><input type="hidden" name="trackId" value="${esc(trackId)}">${field('版本名称', 'versionName', 'text', '', 'required')}${fileField('version-file', '简历文件', '.pdf,.doc,.docx', '支持 PDF、DOC、DOCX；选择后会在这里显示文件名。')}<label class="field-label full"><span>版本备注</span><textarea name="notes"></textarea></label><div class="form-actions"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">上传并设为当前版本</button></div></form>`);
  const form = document.querySelector('#version-form');
  bindFilePicker(form, 'version-file');
  const submit = form.querySelector('button[type="submit"]');
  bindFormSubmit(form, submit, async () => { const fd = new FormData(form); const file = fd.get('file'); if (!file || !file.size) throw new Error('请选择一个简历文件'); const result = await api('/resume-versions', { method: 'POST', body: { trackId, versionName: fd.get('versionName'), notes: fd.get('notes'), makeCurrent: true, file: { name: file.name, type: file.type, data: await fileToBase64(file) } } }); markFresh(result, 'resume-version'); closeModal(); toast('简历版本已保存 · 刚刚'); refreshCurrentPage(renderResumes); }, { busyText: '上传中…', idleText: '上传并设为当前版本' });
}
function versionMetaForm(version) {
  if (!version) return;
  formShell('编辑简历版本', `${field('版本名称', 'versionName', 'text', version.versionName, 'required')}<label class="field-label full"><span>版本备注</span><textarea name="notes">${esc(version.notes)}</textarea></label>`, d => api(`/resume-versions/${version.id}`, { method: 'PATCH', body: d }));
}
function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }
function reassociateVersion(id) {
  const version = cache.versions?.find(v => v.id === id);
  if (!version) return;
  openModal(`<h2>重新关联文件</h2><p class="muted">${esc(version.versionName)} · ${esc(version.originalName)}<br>会保留这个版本以及所有岗位引用，只替换受管文件。</p><form id="reassociate-form" class="form-grid">${fileField('reassociate-file', '选择新的简历文件', '.pdf,.doc,.docx', '选择后会显示文件名，原版本和岗位引用都会保留。')}<div class="form-actions"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">重新关联并保存</button></div></form>`);
  const form = document.querySelector('#reassociate-form');
  bindFilePicker(form, 'reassociate-file');
  const submit = form.querySelector('button[type="submit"]');
  bindFormSubmit(form, submit, async () => { const file = new FormData(form).get('file'); if (!file || !file.size) throw new Error('请选择一个简历文件'); await api(`/resume-versions/${id}/replace-file`, { method: 'POST', body: { file: { name: file.name, type: file.type, data: await fileToBase64(file) } } }); closeModal(); toast('文件已重新关联 · 岗位引用保持不变'); refreshCurrentPage(renderResumes); }, { busyText: '保存中…', idleText: '重新关联并保存' });
}
function previewVersion(id) {
  const version = cache.versions?.find(v => v.id === id);
  if (!version || version.fileExists === false) { toast('文件缺失，请先上传新版本', true); return; }
  const fileUrl = `/api/files/${id}`;
  const isPdf = /\.pdf$/i.test(version.originalName || version.storedName || '');
  const previewUrl = isPdf ? fileUrl : `${fileUrl}/preview`;
  const modeLabel = isPdf ? 'PDF 原样预览' : 'Office 文档快速预览';
  openModal(`<h2>预览简历 · ${esc(version.versionName)}</h2><div class="resume-preview-toolbar"><p class="muted">${esc(version.originalName)} · ${modeLabel}</p><a class="btn small" href="${fileUrl}?download=1" download="${esc(version.originalName)}">下载原文件</a></div><iframe class="resume-preview-frame${isPdf ? ' pdf-preview' : ''}" src="${previewUrl}" title="${esc(version.originalName)}"></iframe>`);
}

const renderers = { dashboard: renderDashboard, courses: renderCourses, applications: renderApplications, resumes: renderResumes, plans: renderPlans, settings: renderSettings };
navigate();
