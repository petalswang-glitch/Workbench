import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPickerMarkup } from '../web/compact-picker.js';

test('紧凑选择器保留可提交值、当前显示和搜索创建入口', () => {
  const html = compactPickerMarkup({
    name: 'resumeVersionId',
    value: 'v2',
    options: [['', '暂未关联'], ['v2', '产品方向 · 2026.pdf']],
    placeholder: '选择简历版本',
    searchLabel: '搜索简历版本',
    ariaLabel: '使用简历'
  });

  assert.match(html, /data-compact-picker/);
  assert.match(html, /name="resumeVersionId" value="v2"/);
  assert.match(html, /data-picker-value="v2"/);
  assert.match(html, /data-picker-label[^>]*>产品方向 · 2026\.pdf</);
  assert.match(html, /aria-label="搜索简历版本"/);
  assert.match(html, /class="compact-picker-trigger"[^>]*aria-label="使用简历"/);
  assert.match(html, /data-picker-option[^>]*data-value="v2"/);
});

test('允许自定义的选择器带有创建选项，并安全转义显示文本', () => {
  const html = compactPickerMarkup({
    name: 'channelLabel',
    value: '',
    options: [['', '不设置名称']],
    allowCustom: true,
    searchLabel: '查找或创建渠道名称'
  });

  assert.match(html, /data-picker-create/);
  assert.match(html, /查找或创建渠道名称/);
  assert.match(compactPickerMarkup({ name: 'x', value: '<x>', options: [['<x>', 'A&B']] }), /value="&lt;x&gt;"/);
  assert.match(compactPickerMarkup({ name: 'x', value: '<x>', options: [['<x>', 'A&B']] }), /A&amp;B/);
});
