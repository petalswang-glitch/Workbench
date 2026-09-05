import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationViewModel } from '../web/application-view.js';

test('岗位视图模型会把新保存的岗位同步到统计和公司、岗位、城市建议', () => {
  const model = applicationViewModel([
    { company: '旧公司', roleName: '旧岗位', location: '旧城市', stage: '待投递' },
    { company: '新公司', roleName: '新岗位', location: '新城市', stage: '已投递' }
  ], [{ id: 'interview-1' }]);

  assert.equal(model.total, 2);
  assert.equal(model.active, 2);
  assert.equal(model.interviews, 1);
  assert.deepEqual(model.companies, ['旧公司', '新公司']);
  assert.deepEqual(model.roles, ['旧岗位', '新岗位']);
  assert.deepEqual(model.locations, ['旧城市', '新城市']);
  assert.deepEqual(model.stageCounts, { 待投递: 1, 已投递: 1, 笔试: 0, 一面: 0, 二面: 0, 'HR 面': 0, Offer: 0, 拒绝: 0, 主动放弃: 0 });
});
