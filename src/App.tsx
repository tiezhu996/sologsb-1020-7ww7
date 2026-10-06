import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, Delivery, FieldKey, MatchCandidate, PendingDecision,
  RecordGroup, RevisionPackage
} from './types';
import { computeMatches, fieldValue, scorePair } from './utils/matching';
import { seedState } from './data/seed';
import { samplePackageAligned, samplePackageDiverged } from './data/samplePackages';
import {
  REVISION_FIELDS, applyDecision, buildDecision, checksumOf, commitBlockers,
  decisionIdOf, deliveryIdOf, parseRevisionPackage, recordFieldValue, revisionValue
} from './utils/reconcile';

const STORAGE_KEY = 'sologsb-1020-archive-state-v2';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];
const fieldLabel = (field: FieldKey) => fieldLabels.find(([key]) => key === field)?.[1] ?? field;

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};
const outcomeLabel = (decision: PendingDecision) =>
  decision.outcome === 'conflict' ? '字段冲突' : decision.outcome === 'new-record' ? '新增记录' : '无差异修订';
const deliveryLabel = (delivery: Delivery) =>
  delivery.status === 'receiving' ? '投递中' : delivery.status === 'interrupted' ? '发送中断'
    : delivery.status === 'received' ? '已收讫 · 待入库' : '已入库';

/** 重算匹配时保留已确认 / 已忽略 / 已合并的操作记录，不重新打回待复核 */
const mergeMatches = (previous: MatchCandidate[], fresh: MatchCandidate[]): MatchCandidate[] =>
  fresh.map((candidate) => {
    const old = previous.find((item) => item.id === candidate.id);
    return old ? { ...candidate, status: old.status, reviewedAt: old.reviewedAt } : candidate;
  });

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  // 跨系统对账
  const pkgOpen = useSignal(false);
  const pkgRaw = useSignal('');
  const pkgText = useSignal('');
  const autoInterrupt = useSignal(false);
  const delivering = useSignal(false);
  const interruptRequested = useSignal(false);
  const activeDeliveryId = useSignal('');
  const reviewerName = useSignal('核对员01');
  const pendingFilter = useSignal<'pending' | 'diverged' | 'all'>('pending');
  const showCommitted = useSignal(false);
  const expandedId = useSignal('');
  const timerRef = useSignal<ReturnType<typeof setTimeout> | null>(null);

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    baseVersion: state.baseVersion,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    deliveries: state.deliveries,
    pending: state.pending,
    committedPackageIds: state.committedPackageIds
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.baseVersion = next.baseVersion ?? 'v3';
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
    state.deliveries = next.deliveries ?? [];
    state.pending = next.pending ?? [];
    state.committedPackageIds = next.committedPackageIds ?? [];
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);

  /* ---------------- 修订包投递（可中断、可重投、逐项幂等） ---------------- */

  const parsedPreview = useComputed$(() => {
    const raw = pkgRaw.value.trim();
    if (!raw) return null;
    try {
      return { pkg: parseRevisionPackage(raw), error: '' };
    } catch (error) {
      return { pkg: null as RevisionPackage | null, error: (error as Error).message };
    }
  });

  const activeDelivery = useComputed$(() =>
    state.deliveries.find((delivery) => delivery.id === activeDeliveryId.value) ?? null);

  const blockers = useComputed$(() => commitBlockers(state));
  const pendingUnresolved = useComputed$(() => state.pending.filter((decision) => decision.status === 'pending'));
  const pendingDiverged = useComputed$(() => state.pending.filter((decision) => decision.baselineDiverged && decision.status === 'pending'));

  const visiblePending = useComputed$(() => state.pending
    .filter((decision) => {
      const delivery = state.deliveries.find((item) => item.id === decision.deliveryId);
      if (!showCommitted.value && delivery?.status === 'committed') return false;
      if (pendingFilter.value === 'pending') return decision.status === 'pending';
      if (pendingFilter.value === 'diverged') return decision.baselineDiverged;
      return true;
    })
    .sort((a, b) => Number(b.baselineDiverged) - Number(a.baselineDiverged) || Number(a.status === 'pending') - Number(b.status === 'pending')));

  const upsertDecision = (decision: PendingDecision) => {
    state.pending = [...state.pending.filter((item) => item.id !== decision.id), decision];
  };

  const deliverRevision = $(async (pkgInput: RevisionPackage, simulateInterrupt: boolean) => {
    if (delivering.value) { notify('有修订包正在投递，请等待本次发送结束'); return; }

    const incomingChecksum = checksumOf({ v: pkgInput.baselineVersion, t: pkgInput.targetVersion, items: pkgInput.items });
    const id = deliveryIdOf(pkgInput);
    const existing = state.deliveries.find((delivery) => delivery.id === id);
    const sameIdDifferentContent = !existing && state.deliveries.some((delivery) => delivery.packageId === pkgInput.packageId);

    if (sameIdDifferentContent) {
      notify(`包编号 ${pkgInput.packageId} 已投递过但内容校验和不同，已拒绝；请让中心库更换包编号后再发`);
      return;
    }
    if (existing?.status === 'committed') {
      notify(`修订包 ${pkgInput.packageId} 已入库，本次投递幂等跳过，已处理项不重复应用`);
      commit('重复投递修订包', `包 ${pkgInput.packageId}（校验和 ${incomingChecksum}）已入库，整包幂等跳过`, []);
      return;
    }

    capture();
    const now = new Date().toISOString();
    let delivery: Delivery;
    if (existing) {
      delivery = existing;
      delivery.attempts += 1;
      delivery.status = 'receiving';
      delivery.updatedAt = now;
      commit('重新投递修订包', `包 ${pkgInput.packageId} 第 ${delivery.attempts} 次发送，已处理 ${delivery.processedKeys.length}/${pkgInput.items.length} 项将逐项跳过`, []);
    } else {
      delivery = {
        id,
        packageId: pkgInput.packageId,
        checksum: incomingChecksum,
        origin: pkgInput.origin,
        issuedAt: pkgInput.issuedAt,
        baselineVersion: pkgInput.baselineVersion,
        targetVersion: pkgInput.targetVersion,
        status: 'receiving',
        attempts: 1,
        processedKeys: [],
        items: pkgInput.items,
        startedAt: now,
        updatedAt: now
      };
      state.deliveries = [...state.deliveries, delivery];
      commit('接收离线修订包', `包 ${pkgInput.packageId} 来自 ${pkgInput.origin}，基准 ${pkgInput.baselineVersion} → ${pkgInput.targetVersion}，共 ${pkgInput.items.length} 项；本地基准 ${state.baseVersion}`, []);
    }
    activeDeliveryId.value = delivery.id;
    delivering.value = true;
    interruptRequested.value = false;

    // 模拟离线传输的分包发送：勾选“发送中断”时在首个未处理项处理到一半后停下
    const total = pkgInput.items.length;
    const alreadyDone = delivery.processedKeys.length;
    const stopAfter = simulateInterrupt ? alreadyDone + Math.max(1, Math.ceil((total - alreadyDone) / 2)) : total;
    let processedThisAttempt = 0;

    const step = () => {
      const current = state.deliveries.find((item) => item.id === delivery.id);
      if (!current) { delivering.value = false; return; }

      if (interruptRequested.value || current.processedKeys.length >= stopAfter) {
        current.status = 'interrupted';
        current.updatedAt = new Date().toISOString();
        delivering.value = false;
        commit('修订包发送中断', `包 ${current.packageId} 已处理 ${current.processedKeys.length}/${total} 项，台账保留；同一份包可重新投递，已处理项不会重复应用`, []);
        notify(`发送中断：已处理 ${current.processedKeys.length}/${total} 项，可在投递台账中重新投递`);
        return;
      }

      const item = current.items.find((entry) => !current.processedKeys.includes(entry.key));
      if (!item) {
        current.status = 'received';
        current.updatedAt = new Date().toISOString();
        current.finishedAt = current.updatedAt;
        delivering.value = false;
        const outcomes = state.pending
          .filter((decision) => decision.packageId === current.packageId)
          .reduce<Record<string, number>>((acc, decision) => {
            acc[decision.outcome] = (acc[decision.outcome] ?? 0) + 1;
            return acc;
          }, {});
        commit('修订包投递完成', `包 ${current.packageId} 本次新处理 ${processedThisAttempt} 项；新增 ${outcomes['new-record'] ?? 0}、无差异 ${outcomes['auto-revision'] ?? 0}、冲突 ${outcomes['conflict'] ?? 0}；未决结论处理完才能入库`, []);
        notify(`修订包收讫：冲突 ${outcomes['conflict'] ?? 0} 项、待确认新增 ${outcomes['new-record'] ?? 0} 项`);
        return;
      }

      const { decision } = buildDecision(state, current, item);
      upsertDecision(decision);
      current.processedKeys = [...current.processedKeys, item.key];
      current.updatedAt = new Date().toISOString();
      processedThisAttempt += 1;
      timerRef.value = setTimeout(step, 190);
    };

    timerRef.value = setTimeout(step, 120);
  });

  const startFromModal = $(() => {
    const preview = parsedPreview.value;
    if (!preview?.pkg) return;
    deliverRevision(preview.pkg, autoInterrupt.value);
  });

  const redeliver = $((delivery: Delivery) => {
    if (delivering.value) { notify('请等待当前投递结束'); return; }
    if (delivery.status === 'committed') return;
    const pkg: RevisionPackage = {
      packageId: delivery.packageId,
      origin: delivery.origin,
      issuedAt: delivery.issuedAt,
      baselineVersion: delivery.baselineVersion,
      targetVersion: delivery.targetVersion,
      items: delivery.items
    };
    pkgOpen.value = false;
    deliverRevision(pkg, false);
  });

  const requestInterrupt = $(() => { interruptRequested.value = true; });

  /* ---------------- 核对员逐字段选择 ---------------- */

  const setChoice = $((decisionId: string, field: FieldKey | '__accept__', source: string) => {
    const decision = state.pending.find((item) => item.id === decisionId);
    if (!decision) return;
    if (field === '__accept__') {
      decision.choices = { ...decision.choices, __accept__: source === 'accepted' };
    } else {
      decision.choices = { ...decision.choices, [field]: source as PendingDecision['choices'][FieldKey] };
    }
  });

  const isResolvable = (decision: PendingDecision) => {
    if (decision.status === 'resolved') return true;
    if (decision.outcome === 'conflict') {
      return decision.conflicts.every((conflict) => decision.choices[conflict.field] !== undefined);
    }
    return decision.choices.__accept__ !== undefined;
  };

  const resolveDecision = $((id: string) => {
    const decision = state.pending.find((item) => item.id === id);
    if (!decision || !isResolvable(decision)) return;
    capture();
    decision.status = 'resolved';
    decision.reviewer = reviewerName.value.trim() || '匿名核对员';
    decision.decidedAt = new Date().toISOString();
    if (decision.outcome === 'conflict') {
      const picks = decision.conflicts.map((conflict) =>
        `${fieldLabel(conflict.field)}：${decision.choices[conflict.field] === 'revision' ? '采用中心库修订'
          : decision.choices[conflict.field] === 'combine' ? '两侧拼接' : '保留本地'}`);
      commit('记录核对结论', `[${decision.packageId}] ${decision.title}（${decision.identifier}）逐字段选择——${picks.join('；')}${decision.baselineDiverged ? '；该结论存在基准偏离，已按核对员选择处理' : ''}`, decision.recordId ? [decision.recordId] : []);
    } else {
      commit('确认对账结论', `[${decision.packageId}] ${decision.title}（${decision.identifier}）：${decision.outcome === 'new-record' ? '确认采用中心库新增记录' : '基准偏离包中的无差异修订，确认保留本地并标记来源'}`, decision.recordId ? [decision.recordId] : []);
    }
    notify('核对结论已记录，全部未决处理完即可入库');
  });

  const reopenDecision = $((id: string) => {
    const decision = state.pending.find((item) => item.id === id);
    if (!decision) return;
    const delivery = state.deliveries.find((item) => item.id === decision.deliveryId);
    if (delivery?.status === 'committed') { notify('该结论已随包入库，结论记录保留备查，不能再改'); return; }
    capture();
    decision.status = 'pending';
    decision.decidedAt = undefined;
    commit('撤回核对结论', `[${decision.packageId}] ${decision.title} 重新退回未决，入库闸门再次关闭`, decision.recordId ? [decision.recordId] : []);
  });

  /* ---------------- 入库 ---------------- */

  const commitToStore = $(() => {
    if (blockers.value.length) return;
    capture();
    const openPackageIds = new Set(state.deliveries
      .filter((delivery) => delivery.status === 'received')
      .map((delivery) => delivery.packageId));
    const resolved = state.pending.filter(
      (decision) => decision.status === 'resolved' && openPackageIds.has(decision.packageId)
    );
    if (!resolved.length) return;
    let records = state.records;
    resolved.forEach((decision) => {
      records = applyDecision({ ...state, records }, decision);
    });
    state.records = records;
    const packageIds = [...new Set(resolved.map((decision) => decision.packageId))];
    const targetVersion = state.deliveries
      .filter((delivery) => delivery.status === 'received')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.targetVersion;
    state.deliveries.forEach((delivery) => {
      if (delivery.status === 'received') {
        delivery.status = 'committed';
        delivery.updatedAt = new Date().toISOString();
      }
    });
    packageIds.forEach((id) => { if (!state.committedPackageIds.includes(id)) state.committedPackageIds.push(id); });
    if (targetVersion) state.baseVersion = targetVersion;
    // 新增记录参与匹配，但已确认 / 已忽略的匹配不被冲掉
    state.matches = mergeMatches(state.matches, computeMatches(state.records));
    const recordIds = resolved.flatMap((decision) => decision.recordId ? [decision.recordId] : []);
    commit('修订结果入库', `包 ${packageIds.join('、')} 共应用 ${resolved.length} 条对账结论；逐字段写入来源，基准版本推进至 ${state.baseVersion}；原有逐字段选择与已确认匹配均保留`, recordIds);
    notify(`已入库：${resolved.length} 条结论已应用，本地基准推进到 ${state.baseVersion}`);
    expandedId.value = '';
  });

  /* ---------------- 原有匹配 / 合并 / 导入 ---------------- */

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    capture();
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    capture();
    ids.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = new Date().toISOString();
    });
    commit('批量复核', `${ids.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}`, ids.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    }));
    selectedMatchIds.value = [];
    notify(`已批量处理 ${ids.length} 条匹配`);
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => { choices[field] = 'A'; });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    const provenance = {} as ArchiveRecord['provenance'];
    const now = new Date().toISOString();
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
      provenance![field] = { source: source === 'combine' ? 'combine' : 'local', at: now };
    });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      baseVersion: left.baseVersion,
      provenance,
      updatedAt: now
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    state.matches.forEach((item) => {
      if (item.id === match.id) item.status = 'merged';
      else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    state.merges.unshift({
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      chosen: { ...choices },
      values,
      mergedAt: now
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段，字段来源已逐字段保留`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed',
        baseVersion: state.baseVersion,
        provenance: Object.fromEntries(REVISION_FIELDS.map((field) => [field, { source: 'local' as const, at: new Date().toISOString() }]))
      };
      state.records.push(record);
    });
    state.matches = mergeMatches(state.matches, computeMatches(state.records));
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录，已确认匹配保持不变`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    pkgText.value = file.name;
    pkgRaw.value = await file.text();
  });

  const importLegacyFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), baseVersion: state.baseVersion, records: state.records, matches: state.matches, merges: state.merges, deliveries: state.deliveries, pending: state.pending, audit: state.audit }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  const loadSample = $(async (which: 'aligned' | 'diverged') => {
    pkgText.value = which === 'aligned' ? '示例修订包 CR-2026-09-V3（基准一致）.json' : '示例修订包 CR-2026-10-V2REPLAY（基准偏离）.json';
    pkgRaw.value = JSON.stringify(which === 'aligned' ? samplePackageAligned : samplePackageDiverged, null, 2);
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) restore(raw);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => snapshot());
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?') { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => {
      window.removeEventListener('keydown', handler);
      if (timerRef.value) clearTimeout(timerRef.value);
    });
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · 基准 ${state.baseVersion} · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button light" onClick$={() => { pkgRaw.value = ''; pkgText.value = ''; autoInterrupt.value = false; pkgOpen.value = true; }}>接收修订包</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button ghost" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>中心库离线修订逐项入账、字段带来源；同名记录两边不一致时由核对员逐字段选择，未处理完不入库。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{pendingUnresolved.value.length}</strong><span>未决结论</span></div>
          <div class={pendingDiverged.value.length ? 'danger' : ''}><strong>{pendingDiverged.value.length}</strong><span>基准偏离</span></div>
        </div>
      </div>

      {/* 跨系统对账 */}
      <section class="recon-wrap">
        <div class="recon-head">
          <div>
            <span class="eyebrow">00 / CROSS-SYSTEM LEDGER</span>
            <h3>中心库修订 · 跨系统对账</h3>
            <p>修订包保留字段来源，本地核对结论保留操作记录；发送中断后同一份包可重新投递，已处理项不重复应用。</p>
          </div>
          <div class="recon-head-actions">
            <label class="reviewer-box">核对员
              <input class="input" value={reviewerName.value} onInput$={(event) => { reviewerName.value = (event.target as HTMLInputElement).value; }} />
            </label>
            <button class="button primary" disabled={!!blockers.value.length} onClick$={commitToStore}>
              入库（{state.pending.filter((decision) => decision.status === 'resolved' && state.deliveries.some((delivery) => delivery.packageId === decision.packageId && delivery.status === 'received')).length} 条待应用）
            </button>
          </div>
        </div>

        {blockers.value.length > 0 && <div class="blocker-banner">
          <strong>入库闸门已关闭</strong>
          {blockers.value.map((text) => <p key={text}>· {text}</p>)}
        </div>}

        <div class="recon-grid">
          <article class="panel ledger-panel">
            <div class="panel-heading"><div><span class="eyebrow">DELIVERY</span><h3>修订包投递台账</h3></div><span>{state.deliveries.length} 份</span></div>
            <div class="ledger-list">
              {state.deliveries.map((delivery) => {
                const pct = Math.round((delivery.processedKeys.length / Math.max(1, delivery.items.length)) * 100);
                return <div class={`ledger-card ${delivery.status}`} key={delivery.id}>
                  <div class="ledger-top">
                    <strong>{delivery.packageId}</strong>
                    <span class={`delivery-status ${delivery.status}`}>{deliveryLabel(delivery)}</span>
                  </div>
                  <div class="ledger-meta"><span>{delivery.origin}</span><span>第 {delivery.attempts} 次投递</span></div>
                  <div class="version-line">基准 {delivery.baselineVersion} → {delivery.targetVersion}
                    {state.baseVersion !== delivery.baselineVersion && <em class="drift-tag">包基准偏离本地 {state.baseVersion}</em>}
                  </div>
                  <div class="progress"><i style={{ width: `${pct}%` }} /></div>
                  <div class="ledger-foot">
                    <span>{delivery.processedKeys.length}/{delivery.items.length} 项已处理 · 校验和 {delivery.checksum}</span>
                    {(delivery.status === 'interrupted' || delivery.status === 'receiving') &&
                      <button class="button small primary" disabled={delivering.value} onClick$={() => redeliver(delivery)}>重新投递</button>}
                    {delivery.status === 'received' &&
                      <button class="button small ghost" disabled={delivering.value} onClick$={() => redeliver(delivery)}>幂等重投</button>}
                    {delivery.status === 'committed' && <span class="committed-note">已入库 · 记录保留</span>}
                  </div>
                </div>;
              })}
              {!state.deliveries.length && <div class="empty-state">还没有收到中心库修订包。<br />点击右上角“接收修订包”，可载入示例包体验中断重投。</div>}
            </div>
          </article>

          <article class="panel pending-panel">
            <div class="panel-heading">
              <div><span class="eyebrow">REVIEWER QUEUE</span><h3>未决对账结论</h3></div>
              <label class="show-committed"><input type="checkbox" checked={showCommitted.value} onChange$={() => showCommitted.value = !showCommitted.value} /> 显示已入库</label>
            </div>
            <div class="toolbar-row pending-toolbar">
              {([['pending', `未处理 ${pendingUnresolved.value.length}`], ['diverged', `基准偏离 ${pendingDiverged.value.length}`], ['all', '全部结论']] as const).map(([key, label]) =>
                <button key={key} class={`button small ${pendingFilter.value === key ? 'primary' : 'ghost'}`} onClick$={() => pendingFilter.value = key}>{label}</button>
              )}
            </div>
            <div class="pending-list">
              {visiblePending.value.map((decision) => {
                const delivery = state.deliveries.find((item) => item.id === decision.deliveryId);
                const item = delivery?.items.find((entry) => entry.key === decision.itemKey);
                const expanded = expandedId.value === decision.id;
                const committed = delivery?.status === 'committed';
                return <div class={`decision-card ${decision.status === 'pending' ? 'pending' : 'resolved'} ${decision.baselineDiverged ? 'drifted' : ''}`} key={decision.id}>
                  <div class="decision-head" onClick$={() => expandedId.value = expanded ? '' : decision.id}>
                    <span class={`outcome ${decision.outcome}`}>{outcomeLabel(decision)}</span>
                    <strong>{decision.title}</strong>
                    <code>{decision.identifier}</code>
                    {decision.baselineDiverged && <span class="drift-badge">基准偏离</span>}
                    <span class={`decision-state ${decision.status}`}>{committed ? '已入库' : decision.status === 'pending' ? '待核对' : '已选择'}</span>
                    <i class="expand-mark">{expanded ? '−' : '+'}</i>
                  </div>
                  {expanded && item && <div class="decision-body">
                    <div class="decision-note">
                      <span>{decision.packageId} · {decision.itemKey}</span>
                      {decision.note && <p>中心库说明：{decision.note}</p>}
                      {decision.baselineDiverged && <p class="drift-note">该结论基于 {delivery?.baselineVersion} 制作，本地当前基准为 {state.baseVersion}，请核对后再决定。</p>}
                    </div>

                    {decision.outcome === 'conflict' && <>
                      <div class="conflict-grid conflict-head"><span>字段</span><span>本地现值</span><span>中心库基准</span><span>中心库修订</span><span>核对员选择</span></div>
                      {decision.conflicts.map((conflict) => <div class={`conflict-grid conflict-row ${conflict.baselineDrifted ? 'field-drifted' : ''}`} key={conflict.field}>
                        <span class="conflict-field">{fieldLabel(conflict.field)}{conflict.baselineDrifted && <em>已偏离基准</em>}</span>
                        <span class="local-val">{conflict.localValue || '—'}</span>
                        <span class="baseline-val">{conflict.baselineValue ?? '—'}</span>
                        <span class="revision-val">{conflict.revisionValue || '—'}</span>
                        <span class="choice-group">
                          <label><input type="radio" name={`choice-${decision.id}-${conflict.field}`} checked={decision.choices[conflict.field] === 'store'} onChange$={() => setChoice(decision.id, conflict.field, 'store')} disabled={committed} /> 保留本地</label>
                          <label><input type="radio" name={`choice-${decision.id}-${conflict.field}`} checked={decision.choices[conflict.field] === 'revision'} onChange$={() => setChoice(decision.id, conflict.field, 'revision')} disabled={committed} /> 采用修订</label>
                          <label><input type="radio" name={`choice-${decision.id}-${conflict.field}`} checked={decision.choices[conflict.field] === 'combine'} onChange$={() => setChoice(decision.id, conflict.field, 'combine')} disabled={committed} /> 拼接</label>
                        </span>
                      </div>)}
                    </>}

                    {decision.outcome !== 'conflict' && <div class="new-record-grid">
                      <div><span>字段</span><span>中心库修订值</span></div>
                      {REVISION_FIELDS.map((field) => {
                        const value = revisionValue(item, field);
                        if (value === undefined) return null;
                        return <div key={field}><span>{fieldLabel(field)}</span><span>{value || '—'}</span></div>;
                      })}
                      {!committed && <label class="accept-line">
                        <input type="radio" name={`accept-${decision.id}`} checked={decision.choices.__accept__ !== undefined} onChange$={() => setChoice(decision.id, '__accept__', 'accepted')} />
                        {decision.outcome === 'new-record' ? '确认采用中心库新增记录（字段来源标记为中心库）' : '确认基准偏离包结论：保留本地现值，仅对齐来源标记'}
                      </label>}
                    </div>}

                    {decision.status === 'resolved' && <div class="resolved-line">
                      {decision.reviewer} 于 {decision.decidedAt ? new Date(decision.decidedAt).toLocaleString('zh-CN') : ''} 完成选择
                      {!committed && <button class="button small ghost" onClick$={() => reopenDecision(decision.id)}>撤回为未决</button>}
                    </div>}
                    {!committed && decision.status === 'pending' && <div class="resolve-actions">
                      <button class="button small primary" disabled={!isResolvable(decision)} onClick$={() => resolveDecision(decision.id)}>
                        {isResolvable(decision) ? '确认核对结论' : '请先为每个冲突字段做出选择'}
                      </button>
                    </div>}
                  </div>}
                </div>;
              })}
              {!visiblePending.value.length && <div class="empty-state">当前筛选下没有对账结论。<br />收到修订包后，同名记录两边不一致的条目会挂在这里等待核对。</div>}
            </div>
          </article>

          <article class="panel gate-panel">
            <div class="panel-heading"><div><span class="eyebrow">COMMIT GATE</span><h3>入库闸门</h3></div></div>
            <div class="gate-body">
              <div class="version-box">
                <div><span>本地库基准</span><strong>{state.baseVersion}</strong></div>
                <div class="gate-arrow">→</div>
                <div><span>待入目标基准</span><strong>
                  {state.deliveries.filter((delivery) => delivery.status === 'received').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.targetVersion ?? '—'}
                </strong></div>
              </div>
              <ul class="gate-rules">
                <li class={blockers.value.some((text) => text.includes('投递')) ? 'blocking' : 'ok'}>所有修订包完成投递（中断可重投，台账去重）</li>
                <li class={pendingUnresolved.value.length ? 'blocking' : 'ok'}>同名记录不一致项已由核对员逐字段选择</li>
                <li class={pendingDiverged.value.length ? 'blocking' : 'ok'}>基准版本偏离的结论已全部核对</li>
              </ul>
              <div class="gate-counts">
                <span>未决 <strong class={pendingUnresolved.value.length ? 'hot' : ''}>{pendingUnresolved.value.length}</strong></span>
                <span>基准偏离 <strong class={pendingDiverged.value.length ? 'hot' : ''}>{pendingDiverged.value.length}</strong></span>
                <span>已入库包 <strong>{state.committedPackageIds.length}</strong></span>
              </div>
              <button class="button primary wide" disabled={!!blockers.value.length} onClick$={commitToStore}>应用已决结论并入库</button>
              <p class="gate-note">入库按条应用：只改包携带且核对员选定的字段，逐字段写入来源；未携带字段、既有逐字段选择与已确认匹配一律保留。</p>
            </div>
          </article>
        </div>
      </section>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => {
              const provEntries = Object.values(record.provenance ?? {});
              const centerCount = provEntries.filter((entry) => entry?.source === 'center').length;
              const combineCount = provEntries.filter((entry) => entry?.source === 'combine').length;
              const tip = Object.entries(record.provenance ?? {})
                .map(([field, prov]) => `${fieldLabel(field as FieldKey)}：${prov?.source === 'center' ? `中心库 ${prov.packageId ?? ''}` : prov?.source === 'combine' ? '两侧拼接' : '本地'}${prov?.reviewer ? `（${prov.reviewer}）` : ''}`)
                .join('\n');
              return (
                <div class="table-row" key={record.id} title={`基准 ${record.baseVersion ?? '—'}\n${tip}`}>
                  <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                  <strong>{record.title}</strong>
                  <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                  <code>{record.identifier}
                    <span class="prov-badges">
                      {centerCount > 0 && <i class="prov-center" title="含中心库修订字段">库{centerCount}</i>}
                      {combineCount > 0 && <i class="prov-combine" title="含拼接字段">拼{combineCount}</i>}
                    </span>
                  </code>
                  <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
                </div>
              );
            })}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId)!;
                const right = recordById(state, activeMatch.value!.rightId)!;
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做（含对账操作）</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>跨系统保护规则</h3></div></div>
          <p>中心库离线修订不再整包覆盖。修订包逐条目、逐字段保留来源；本地核对结论与操作记录独立保存。</p>
          <div class="rule-row"><span>1</span><p>同名记录两边不一致时挂入未决队列，核对员逐字段选择保留本地 / 采用修订 / 拼接。</p></div>
          <div class="rule-row"><span>2</span><p>投递台账记录包校验和与已处理条目；中断后同一份包重投自动续传，已处理项跳过，已入库包幂等。</p></div>
          <div class="rule-row"><span>3</span><p>包基准版本偏离本地（或字段基准值已被本地改过）时，结论用三方对比突出显示，全部核对完才能入库。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      {/* 接收修订包 */}
      <Modal.Root bind:show={pkgOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">OFFLINE REVISION PACKAGE</span><Modal.Title>接收中心库离线修订包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">
            修订包以分包方式投递，可随时中断；再次发送同一份包时，投递台账会跳过已处理条目。入库前，同名记录的不一致字段必须由核对员逐字段选择。
          </Modal.Description>
          <div class="import-controls">
            <button class="button small ghost" onClick$={() => loadSample('aligned')}>载入示例包 · 基准一致 v3</button>
            <button class="button small ghost" onClick$={() => loadSample('diverged')}>载入示例包 · 基准偏离 v2</button>
            <label class="file-button">选择包文件<input type="file" accept=".json" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={pkgRaw.value} onInput$={(event) => pkgRaw.value = (event.target as HTMLTextAreaElement).value} placeholder='{"packageId":"CR-...","baselineVersion":"v3","targetVersion":"v3.1","items":[...]}' />
          {pkgText.value && <div class="file-name">已读取：{pkgText.value}</div>}
          {parsedPreview.value?.error && <div class="parse-error">无法解析：{parsedPreview.value.error}</div>}
          {parsedPreview.value?.pkg && <div class="pkg-preview">
            <div><span>包编号</span><strong>{parsedPreview.value.pkg.packageId}</strong></div>
            <div><span>来源</span><strong>{parsedPreview.value.pkg.origin}</strong></div>
            <div><span>版本路径</span><strong>{parsedPreview.value.pkg.baselineVersion} → {parsedPreview.value.pkg.targetVersion}</strong></div>
            <div><span>条目数</span><strong>{parsedPreview.value.pkg.items.length}</strong></div>
            <div><span>本地基准</span><strong class={state.baseVersion !== parsedPreview.value.pkg.baselineVersion ? 'hot' : ''}>{state.baseVersion}{state.baseVersion !== parsedPreview.value.pkg.baselineVersion ? '（与包基准不一致）' : ''}</strong></div>
            <div><span>校验和</span><strong>{checksumOf({ v: parsedPreview.value.pkg.baselineVersion, t: parsedPreview.value.pkg.targetVersion, items: parsedPreview.value.pkg.items })}</strong></div>
          </div>}
          {activeDelivery.value && <div class="delivery-progress">
            <div class="progress"><i style={{ width: `${Math.round((activeDelivery.value.processedKeys.length / Math.max(1, activeDelivery.value.items.length)) * 100)}%` }} /></div>
            <p>{deliveryLabel(activeDelivery.value)} · 已处理 {activeDelivery.value.processedKeys.length}/{activeDelivery.value.items.length} 项
              {activeDelivery.value.attempts > 1 && ` · 第 ${activeDelivery.value.attempts} 次投递（已处理项自动跳过）`}</p>
            {delivering.value && <button class="button small danger" onClick$={requestInterrupt}>模拟发送中断</button>}
          </div>}
          <label class="interrupt-toggle"><input type="checkbox" checked={autoInterrupt.value} onChange$={() => autoInterrupt.value = !autoInterrupt.value} disabled={delivering.value} /> 本次发送在处理到一半时模拟中断（用于演示重新投递）</label>
          <Modal.Footer class="modal-footer">
            <Modal.Close class="button ghost">关闭</Modal.Close>
            <button class="button primary" disabled={!parsedPreview.value?.pkg || delivering.value} onClick$={startFromModal}>
              {delivering.value ? '正在投递…' : (state.deliveries.find((delivery) => parsedPreview.value?.pkg && delivery.id === deliveryIdOf(parsedPreview.value.pkg))?.processedKeys.length ? '继续投递（幂等续传）' : '开始投递')}
            </button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importLegacyFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹中。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
