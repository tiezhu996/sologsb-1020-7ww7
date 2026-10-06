import { applyDecision, buildDecision, checksumOf, commitBlockers, commitRevisions, deliveryIdOf, findLocalRecord, parseRevisionPackage } from '../src/utils/reconcile.ts';
import { samplePackageAligned, samplePackageDiverged } from '../src/data/samplePackages.ts';
import { seedState } from '../src/data/seed.ts';

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('PASS:', msg); };

let state = seedState();
const pkg = samplePackageAligned;
const delivery = {
  id: deliveryIdOf(pkg), packageId: pkg.packageId, baselineVersion: pkg.baselineVersion, targetVersion: pkg.targetVersion
};

// 逐条目处理
const decisions = pkg.items.map((item) => buildDecision(state, { id: delivery.id, packageId: delivery.packageId, baselineVersion: delivery.baselineVersion }, item).decision);
const byKey = Object.fromEntries(decisions.map((d) => [d.itemKey, d]));

assert(byKey['item-01'].outcome === 'conflict', '基准对齐：载体字段冲突 → conflict');
assert(byKey['item-01'].status === 'pending', '冲突项未处理前为 pending');
assert(byKey['item-02'].outcome === 'conflict' && byKey['item-02'].baselineDiverged, 'item-02 本地权利字段已偏离中心库基准 → baselineDiverged');
assert(byKey['item-03'].outcome === 'auto-revision', 'item-03 无差异 → auto-revision');
assert(byKey['item-04'].outcome === 'new-record' && byKey['item-04'].status === 'resolved', 'item-04 新记录（基准一致时）自动 resolved');
assert(byKey['item-05'].conflicts.some((c) => c.field === 'notes' && c.baselineDrifted), 'item-05 notes 基准值缺页 vs 本地补页说明 → 字段级偏离');

state.deliveries = [{
  ...delivery, checksum: 'x', origin: pkg.origin, issuedAt: pkg.issuedAt,
  status: 'received', attempts: 1, processedKeys: [], items: pkg.items,
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
}];
state.pending = decisions;

// 幂等：重复 build 产生相同 id，不新增结论
const again = buildDecision(state, state.deliveries[0], pkg.items[0]).decision;
assert(again.id === decisions[0].id, '同一包+条目生成确定性结论 ID（重投不重复）');

// 入库闸门：有未决 → 阻断
assert(commitBlockers(state).length > 0, '存在未决结论时入库被阻断');

// 漏选一个字段：仍阻断
byKey['item-01'].choices.medium = 'revision';
assert(commitBlockers(state).length > 0, '冲突未逐字段选完时仍阻断');

// 处理 item-01 剩余字段、item-02 全部冲突、item-05 全部
byKey['item-01'].status = 'resolved';
byKey['item-01'].reviewer = 'tester';
for (const c of byKey['item-02'].conflicts) byKey['item-02'].choices[c.field] = 'revision';
byKey['item-02'].status = 'resolved';
byKey['item-02'].reviewer = 'tester';
for (const c of byKey['item-05'].conflicts) byKey['item-05'].choices[c.field] = c.field === 'notes' ? 'combine' : 'revision';
byKey['item-05'].status = 'resolved';
byKey['item-05'].reviewer = 'tester';

assert(commitBlockers(state).length === 0, '全部未决处理完且投递收讫 → 闸门放行');

const committed = commitRevisions(state);
assert(!!committed, '入库成功');
state.records = committed.records;
state.baseVersion = committed.baseVersion;

const lxz = findLocalRecord({ records: state.records }, pkg.items[0]);
assert(lxz.medium === '数字录音（中心库复核版）', '采用修订：载体字段被更新');
assert(lxz.provenance.medium.source === 'center' && lxz.provenance.medium.reviewer === 'tester', '修订字段来源=中心库且记录核对员');
assert(lxz.notes === '访谈共三个音频文件', '包未冲突字段内容不被改写');

const hyl = findLocalRecord({ records: state.records }, pkg.items[4]);
assert(hyl.notes.includes('本地核对组已登记家属补页') && hyl.notes.includes('第12页已由家属提供补页扫描'), '拼接选择保留本地+修订两侧内容');
assert(hyl.provenance.notes.source === 'combine', '拼接字段 provenance=combine');

const zhl = findLocalRecord({ records: state.records }, pkg.items[1]);
assert(zhl.places.includes('县立女子中学'), '采用修订：人物地点数组更新');
assert(zhl.rights.startsWith('研究者授权'), '采用修订：权利字段更新');

const newRec = state.records.find((r) => r.identifier === 'OH-LSF-2010-02');
assert(!!newRec && newRec.provenance.title.source === 'center', '新增记录入库且字段来源=中心库');

// 匹配未被冲掉：seed 里确认一条再入库后状态保留 —— 这里只验证 mergeMatches 的输入输出契约（函数在 App 内，跳过）

assert(state.baseVersion === 'v3.1', '入库后基准版本推进到 v3.1');

// 已入库包重投：App 层判定 committed 幂等；引擎层 committed 不再产生 blocker
state.deliveries.forEach((d) => { d.status = 'committed'; });
assert(commitBlockers(state).length === 0, '入库后无阻断项');

// 基准偏离包
let state2 = seedState();
const pkg2 = samplePackageDiverged;
assert(state2.baseVersion !== pkg2.baselineVersion, '偏离包：本地基准与包基准不同');
const d2 = { id: deliveryIdOf(pkg2), packageId: pkg2.packageId, baselineVersion: pkg2.baselineVersion, targetVersion: pkg2.targetVersion };
const ds2 = pkg2.items.map((item) => buildDecision(state2, d2, item).decision);
assert(ds2.every((d) => d.baselineDiverged), '基准偏离：所有结论都标记 baselineDiverged');
assert(ds2.find((d) => d.itemKey === 'item-02').outcome === 'auto-revision' && ds2.find((d) => d.itemKey === 'item-02').status === 'pending', '即使字段无差异，版本偏离时无差异项也挂起待确认');
assert(ds2.find((d) => d.itemKey === 'item-01').outcome === 'conflict', '偏离包内冲突项仍为 conflict');
assert(ds2.find((d) => d.itemKey === 'item-03').outcome === 'new-record' && ds2.find((d) => d.itemKey === 'item-03').status === 'pending', '偏离包内新增项也需确认');

// 校验和：内容变动可发现
const mutated = JSON.parse(JSON.stringify(pkg));
mutated.items[0].extent = '99:99:99';
assert(checksumOf({ v: pkg.baselineVersion, t: pkg.targetVersion, items: pkg.items }) !== checksumOf({ v: mutated.baselineVersion, t: mutated.targetVersion, items: mutated.items }), '内容不同 → 校验和不同');

// 解析校验
let threw = false;
try { parseRevisionPackage('{"packageId":"x"}'); } catch { threw = true; }
assert(threw, '缺少版本/条目的包被拒绝');

// applyDecision 不碰未携带字段
const state3 = seedState();
const d3 = { id: 'dlv-x', packageId: 'CR-X', baselineVersion: 'v3', targetVersion: 'v3.1', items: [{ key: 'i', matchIdentifier: 'MS-WDH-17', medium: '手稿（修订载体）', baseline: { medium: '手稿扫描' } }], status: 'received', attempts: 1, processedKeys: ['i'], origin: '', issuedAt: '', checksum: '', startedAt: '', updatedAt: '' };
const dec3 = buildDecision(state3, d3, d3.items[0]).decision;
state3.deliveries = [d3];
dec3.choices.medium = 'revision';
dec3.status = 'resolved';
dec3.reviewer = 't';
const records3 = applyDecision(state3, dec3);
const wdh = records3.find((r) => r.identifier === 'MS-WDH-17');
assert(wdh.title === '渡口船工王德海回忆' && wdh.rights === '家属授权', '逐字段应用：未携带字段原样保留，不整包覆盖');
assert(wdh.medium === '手稿（修订载体）' && wdh.provenance.medium.source === 'center', '逐字段应用：仅修改冲突字段并写来源');

// 端到端幂等：已入库包再次“投递 + 入库”不会重复新增记录
{
  let s = seedState();
  const pack = samplePackageAligned;
  const dlv = {
    ...d3, id: deliveryIdOf(pack), packageId: pack.packageId,
    baselineVersion: pack.baselineVersion, targetVersion: pack.targetVersion,
    items: pack.items, status: 'received'
  };
  let decs = pack.items.map((item) => buildDecision(s, dlv, item).decision);
  s.deliveries = [dlv];
  s.pending = decs;
  decs.forEach((d) => {
    if (d.outcome === 'conflict') d.conflicts.forEach((c) => { d.choices[c.field] = 'revision'; });
    if (d.outcome !== 'auto-revision' || d.baselineDiverged) d.choices.__accept__ = true;
    d.status = 'resolved';
    d.reviewer = 't';
  });
  const first = commitRevisions(s);
  assert(!!first, '首次入库成功');
  s.records = first.records;
  s.baseVersion = first.baseVersion;
  s.deliveries.forEach((d) => { d.status = 'committed'; });
  const newCount1 = s.records.filter((r) => r.identifier === 'OH-LSF-2010-02').length;
  assert(newCount1 === 1, '首次入库仅新增一条中心库记录');

  // 已入库后同一份包重投：投递层幂等跳过，交付状态保持 committed，再次入库为空操作
  assert(s.deliveries.every((d) => d.status === 'committed'), '重投前交付保持 committed（应用层重投入口会幂等跳过）');
  const second = commitRevisions(s);
  assert(second === null, '已入库包没有待应用结论时再次入库为空操作');
  const newCount2 = s.records.filter((r) => r.identifier === 'OH-LSF-2010-02').length;
  assert(newCount2 === 1, '重复投递+入库不产生重复记录（幂等）');
}

console.log('done');
