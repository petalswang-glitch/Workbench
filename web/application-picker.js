const pickerMeta = {
  company: {
    valuesKey: 'companies',
    placeholder: '公司',
    emptyLabel: '未填写',
    searchLabel: '搜索或创建公司',
    allowCustom: true,
    className: 'application-company-picker'
  },
  roleName: {
    valuesKey: 'roles',
    placeholder: '岗位名称',
    emptyLabel: '未填写',
    searchLabel: '搜索或创建岗位名称',
    allowCustom: true,
    className: 'application-roleName-picker'
  },
  location: {
    valuesKey: 'locations',
    placeholder: '城市',
    emptyLabel: '未填写',
    searchLabel: '搜索或创建城市',
    allowCustom: true,
    className: 'application-location-picker'
  }
};

export const applicationTextPickerMeta = Object.freeze(Object.fromEntries(
  Object.entries(pickerMeta).map(([key, value]) => [key, Object.freeze(value)])
));

export function applicationTextPickerOptions(values = [], emptyLabel = '未填写') {
  const normalizedValues = Array.isArray(values)
    ? [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    : [];
  return [['', String(emptyLabel ?? '未填写')], ...normalizedValues.map(value => [value, value])];
}
