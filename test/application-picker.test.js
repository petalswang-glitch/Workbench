import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTextPickerMeta, applicationTextPickerOptions } from '../web/application-picker.js';

test('公司、岗位名称和城市选择器使用统一的紧凑字段配置', () => {
  const fields = ['company', 'roleName', 'location'];

  assert.deepEqual(applicationTextPickerOptions(['华为', ' ', '阿里', '华为', null]), [
    ['', '未填写'],
    ['阿里', '阿里'],
    ['华为', '华为']
  ]);

  for (const field of fields) {
    const meta = applicationTextPickerMeta[field];
    assert.ok(meta, `缺少 ${field} 的选择器配置`);
    assert.equal(meta.allowCustom, true);
    assert.match(meta.className, new RegExp(`application-${field}-picker`));
    assert.ok(meta.searchLabel.includes('搜索或创建'));
  }
});
