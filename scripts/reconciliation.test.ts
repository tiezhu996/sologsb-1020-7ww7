/* 手工端到端测试：跨系统对账核心逻辑 */
import { seedState } from '../src/data/seed';
import { recomputeMatchesPreserving } from '../src/utils/matching';
import { receivePackage, commitConflict, isConflictReady, differingFields } from '../src/utils/reconciliation';
import { samplePackageCurrent, samplePackageDiverged } from '../src/data/samplePackages';
import type { RevisionPackage } from '../src/types';

let passed = 0;
let failed = 0;
const assert = (cond: boolean, message: string) => {
  if (cond) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
};

const now = () => new Date().toISOString();
const ctxFrom = (state: ReturnType<typeof seedState>, processed: Array<{ recordId: string; op: 'upsert' | 'delete' }> = []) => ({
  records: state.records,
  matches: state.matches,
  conflicts: state.conflicts,
  processed,
  repoVersion: state.repoVersion,
  now: now(),
  uuid: () => `test-${Math.random().toString(36).slice(2)}`,
  newRecordGroup: 'C' as const
});

console.log('1) 接收基准一致的包：新增 / 无冲突更新 / 冲突挂起');
{
  const state = seedState();
  const result = receivePackage(samplePackageCurrent, ctxFrom(state));
  assert(result.baselineDiverged === false, '基准一致时不报告偏离');
  const ids = result.records.map((r) => r.id);
  assert(ids.includes('c-101'), '新记录 c-101 已写入');
  assert(result.records.find((r) => r.id === 'c-101')?.fieldOrigins?.title === 'package', '新记录字段来源标记为 package');
  const a007 = result.appliedDrafts.find((d) => d.recordId === 'a-007');
  assert(a007?.outcome === 'unchanged', '与本地逐项一致的修订项标记 unchanged，不改动记录');
  assert(result.records.find((r) => r.id === 'a-007')?.notes === '', 'a-007 记录未被包快照触碰');
  assert(result.conflicts.length === 3, `a-001/b-003/b-005 挂起为 3 条冲突（实际 ${result.conflicts.length}）`);
  const a001Conflict = result.conflicts.find((c) => c.recordId === 'a-001')!;
  assert(a001Conflict.differingFields.includes('title'), 'a-001 标题差异被识别');
  const a001 = result.records.find((r) => r.id === 'a-001')!;
  assert(a001.title === '李秀珍口述史访谈', '冲突记录在裁决前保持本地原值（未入库）');
}

console.log('2) 未完成全部字段裁决前禁止入库');
{
  const state = seedState();
  const result = receivePackage(samplePackageCurrent, ctxFrom(state));
  const conflict = result.conflicts.find((c) => c.recordId === 'a-001')!;
  assert(!isConflictReady(conflict), '初始冲突未裁决齐，isConflictReady=false');
  conflict.resolutions.title = 'package';
  assert(!isConflictReady(conflict), '只选了 1/4 字段，仍不可入库');
  conflict.differingFields.forEach((f) => { if (!conflict.resolutions[f]) conflict.resolutions[f] = 'package'; });
  assert(isConflictReady(conflict), '全部字段选择后可入库');
}

console.log('3) 裁决入库：逐字段选择来源，不整包覆盖');
{
  const state = seedState();
  const received = receivePackage(samplePackageCurrent, ctxFrom(state));
  const conflict = received.conflicts.find((c) => c.recordId === 'a-001')!;
  conflict.resolutions.title = 'package';
  conflict.resolutions.medium = 'local';
  conflict.resolutions.extent = 'combine';
  conflict.resolutions.notes = 'local';
  const committed = commitConflict(received.records, received.matches, conflict, now(), 1);
  const a001 = committed.records.find((r) => r.id === 'a-001')!;
  assert(a001.title.includes('核订题名'), '标题采用修订包值');
  assert(a001.fieldOrigins?.title === 'package', '标题来源 = package');
  assert(a001.medium === '数字录音', '载体保留本地值');
  assert(a001.fieldOrigins?.medium === 'local', '载体来源 = local');
  assert(a001.extent.includes('02:14:38') && a001.extent.includes('02:14:41'), '数量为两侧拼接');
  assert(a001.fieldOrigins?.extent === 'reviewer', '拼接字段来源 = reviewer');
  assert(a001.identifier === 'OH-LXZ-2019-01', '未涉及字段编号完全不动');
  assert(a001.date === '2019-04-12', '未涉及字段日期完全不动');
}

console.log('4) 同包重投幂等：已处理项不重复应用，冲突选择保留');
{
  const state = seedState();
  const first = receivePackage(samplePackageCurrent, ctxFrom(state));
  assert(first.appliedDrafts.length === 5, `首次 5 项处理（实际 ${first.appliedDrafts.length}）`);
  // 模拟中断后重投：把第一次结果作为已处理台账传入
  const state2: ReturnType<typeof seedState> = {
    ...state,
    records: first.records,
    conflicts: first.conflicts,
    matches: first.matches
  };
  const second = receivePackage(samplePackageCurrent, ctxFrom(state2, first.appliedDrafts.map((d) => ({ recordId: d.recordId, op: d.op }))));
  assert(second.skippedProcessed === 5, `重投时 5 项全部去重跳过（实际 ${second.skippedProcessed}）`);
  assert(second.records.length === first.records.length, '重投不重复创建 c-101');
  assert(second.records.filter((r) => r.id === 'c-101').length === 1, 'c-101 仍只有一条');
  // 核对员已对冲突做了部分选择，重投刷新快照但选择保留
  const conflict = second.conflicts.find((c) => c.recordId === 'a-001')!;
  conflict.resolutions.title = 'local';
  const third = receivePackage(samplePackageCurrent, ctxFrom(
    { ...state2, records: second.records, conflicts: second.conflicts },
    first.appliedDrafts.map((d) => ({ recordId: d.recordId, op: d.op }))
  ));
  assert(third.conflicts.find((c) => c.recordId === 'a-001')?.resolutions.title === 'local', '重投保留核对员已选的字段来源');
}

console.log('5) 已确认匹配不被冲掉（重新导入/重算匹配保留操作记录）');
{
  const state = seedState();
  const firstId = state.matches[0].id;
  state.matches[0].status = 'confirmed';
  state.matches[0].reviewedAt = now();
  const rejected = state.matches[1];
  rejected.status = 'rejected';
  const recomputed = recomputeMatchesPreserving(state.records, state.matches);
  const kept = recomputed.find((m) => m.id === firstId);
  assert(kept?.status === 'confirmed', '重新匹配后已确认项保持 confirmed');
  assert(kept?.reviewedAt !== undefined, '确认时间保留');
  const keptRejected = recomputed.find((m) => m.id === rejected.id);
  assert(keptRejected?.status === 'rejected', '已忽略项保持 rejected');
}

console.log('6) 基准版本偏离：未决冲突照常显示并标记');
{
  const state = seedState(); // repoVersion 0
  const result = receivePackage(samplePackageDiverged, ctxFrom(state));
  assert(result.baselineDiverged === true, '包基准 r3 ≠ 本地 r0，报告偏离');
  assert(result.conflicts.some((c) => c.recordId === 'a-004'), 'a-004 冲突仍挂起并显示（未因偏离而丢弃）');
}

console.log('7) 删除冲突：有关联确认匹配时挂起，裁决后保留确认事实');
{
  const state = seedState();
  // b-008 关联一条已确认匹配
  const linked = state.matches.find((m) => m.rightId === 'b-008');
  assert(!!linked, '种子数据存在 b-008 的匹配');
  linked!.status = 'confirmed';
  linked!.reviewedAt = now();
  const result = receivePackage(samplePackageDiverged, ctxFrom(state));
  const del = result.conflicts.find((c) => c.kind === 'delete' && c.recordId === 'b-008');
  assert(!!del, 'b-008 删除指令因已确认匹配而挂起');
  assert(result.records.some((r) => r.id === 'b-008'), '裁决前记录仍在（不删除）');
  del!.deleteResolution = true;
  const committed = commitConflict(result.records, result.matches, del!, now(), 0);
  assert(!committed.records.some((r) => r.id === 'b-008'), '裁决删除后记录移除');
  const match = committed.matches.find((m) => m.id === linked!.id);
  assert(match?.status === 'confirmed', '已确认匹配的状态不被抹掉（审计可追溯）');
}

console.log('8) 无关联的删除指令直接生效，台账可追溯');
{
  const state = seedState();
  const pkg: RevisionPackage = {
    packageId: 'CR-TEST-DEL', source: '测试', baseVersion: 0, issuedAt: now(),
    items: [{ recordId: 'a-002', op: 'delete' }] // a-002 的匹配都是 suggested
  };
  const result = receivePackage(pkg, ctxFrom(state));
  assert(!result.records.some((r) => r.id === 'a-002'), '无确认关联的记录直接删除');
  assert(!result.matches.some((m) => m.leftId === 'a-002' || m.rightId === 'a-002'), '建议匹配同步移除');
  assert(result.appliedDrafts[0].outcome === 'deleted', '台账记录 deleted');
  // 删除不存在的记录
  const again = receivePackage(pkg, ctxFrom({ ...state, records: result.records, matches: result.matches, conflicts: [] }));
  assert(again.appliedDrafts[0].outcome === 'missing', '再次投递删除缺失记录标记 missing');
}

console.log('9) 字段相等判定：数组顺序敏感、空白归一');
{
  const state = seedState();
  const a002 = state.records.find((r) => r.id === 'a-002')!;
  assert(differingFields(a002, { recordId: 'a-002', op: 'upsert', fields: { title: '渡口船工王德海回忆', people: ['王德海'] } }).length === 0, '相同文本/数组不产生冲突');
  assert(differingFields(a002, { recordId: 'a-002', op: 'upsert', fields: { title: '完全不同的题名' } }).length === 1, '差异恰好识别 1 个字段');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
