function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

export function compactPickerMarkup({ name, value = '', options = [], placeholder = '请选择', searchLabel = '搜索选项', ariaLabel = '', allowCustom = false, className = '', inputAttributes = '', disabled = false } = {}) {
  const normalizedValue = String(value ?? '');
  const normalizedOptions = options.map(([optionValue, optionLabel]) => [String(optionValue ?? ''), String(optionLabel ?? '')]);
  const selected = normalizedOptions.find(([optionValue]) => optionValue === normalizedValue);
  const selectedLabel = selected?.[1] || (allowCustom && normalizedValue ? normalizedValue : placeholder);
  const optionMarkup = normalizedOptions.map(([optionValue, optionLabel]) => `<button type="button" class="compact-picker-option" role="option" data-picker-option data-value="${escapeHtml(optionValue)}" aria-selected="${optionValue === normalizedValue ? 'true' : 'false'}"><span>${escapeHtml(optionLabel)}</span></button>`).join('');
  const classes = ['compact-picker', className].filter(Boolean).map(escapeHtml).join(' ');
  const aria = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '';
  return `<div class="${classes}" data-compact-picker${allowCustom ? ' data-picker-allow-custom="true"' : ''}><input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(normalizedValue)}" data-picker-value="${escapeHtml(normalizedValue)}"${inputAttributes}><button type="button" class="compact-picker-trigger" data-picker-trigger aria-haspopup="listbox" aria-expanded="false"${aria}${disabled ? ' disabled' : ''}><span class="compact-picker-value" data-picker-label>${escapeHtml(selectedLabel)}</span><span class="compact-picker-chevron" aria-hidden="true">⌄</span></button><div class="compact-picker-popover" data-picker-popover hidden><div class="compact-picker-search-wrap"><input type="search" class="compact-picker-search" data-picker-search aria-label="${escapeHtml(searchLabel)}" placeholder="${escapeHtml(searchLabel)}" autocomplete="off"></div><div class="compact-picker-options" data-picker-options role="listbox">${optionMarkup}</div>${allowCustom ? '<button type="button" class="compact-picker-create" data-picker-create hidden>创建“<span data-picker-create-label></span>”</button>' : ''}<p class="compact-picker-empty" data-picker-empty hidden>没有匹配项</p></div></div>`;
}
