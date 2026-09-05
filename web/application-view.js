const applicationStages = ['待投递', '已投递', '笔试', '一面', '二面', 'HR 面', 'Offer', '拒绝', '主动放弃'];

const trimmed = value => String(value ?? '').trim();
const uniqueValues = (applications, key) => [...new Set(applications.map(application => trimmed(application[key])).filter(Boolean))]
  .sort((left, right) => left.localeCompare(right, 'zh-CN'));
const safeHttpUrl = value => {
  const raw = trimmed(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};

export function applicationViewModel(applications = [], interviews = []) {
  const rows = Array.isArray(applications) ? applications : [];
  const stageCounts = Object.fromEntries(applicationStages.map(stage => [stage, 0]));
  rows.forEach(application => {
    const stage = trimmed(application.stage);
    if (Object.hasOwn(stageCounts, stage)) stageCounts[stage] += 1;
  });
  const channelLabels = uniqueValues(rows, 'channelLabel');
  const channels = [...new Set(rows.map(application => {
    const label = trimmed(application.channelLabel);
    return label || (safeHttpUrl(application.channel) ? '' : trimmed(application.channel));
  }).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return {
    total: rows.length,
    active: rows.filter(application => !['拒绝', '主动放弃'].includes(trimmed(application.stage))).length,
    interviews: Array.isArray(interviews) ? interviews.length : 0,
    companies: uniqueValues(rows, 'company'),
    roles: uniqueValues(rows, 'roleName'),
    locations: uniqueValues(rows, 'location'),
    channels,
    channelLabels,
    urls: [...new Set(rows.map(application => safeHttpUrl(application.channel)).filter(Boolean))].sort(),
    stageCounts
  };
}

export { applicationStages };
