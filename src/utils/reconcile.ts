import type {
  ArchiveRecord, ArchiveState, Delivery, FieldConflict, FieldKey, FieldSource,
  PendingDecision, RevisionField, RevisionItem, RevisionPackage
} from '../types';

export const REVISION_FIELDS: FieldKey[] = [
  'title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'
];

export const normalize = (value: string) =>
  value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');

export const revisionValue = (item: RevisionItem, field: FieldKey): string | undefined => {
  const value = item[field] as RevisionField | undefined;
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.join('、') : String(value);
};

const baselineValue = (item: RevisionItem, field: FieldKey): string | undefined => {
  const value = item.baseline?.[field];
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.join('、') : String(value);
};

export const recordFieldValue = (record: ArchiveRecord, field: FieldKey): string => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value ?? '');
};

/** 简易校验和：同一份包内容一致；内容被改动会被发现 */
export const checksumOf = (payload: unknown) => {
  const text = JSON.stringify(payload);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `ck-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

/** 按编号优先、标题兜底定位同名本地记录 */
export const findLocalRecord = (state: Pick<ArchiveState, 'records'>, item: RevisionItem): ArchiveRecord | undefined => {
  const identifier = (item.matchIdentifier ?? item.identifier ?? '').trim();
  if (identifier) {
    const byId = state.records.find((record) => record.identifier.trim() === identifier);
    if (byId) return byId;
  }
  const title = (item.matchTitle ?? revisionValue(item, 'title') ?? '').trim();
  if (title) {
    return state.records.find((record) => normalize(record.title) === normalize(title));
  }
  return undefined;
};

/** 结论 ID 由包 + 条目确定：重复投递不会制造重复结论 */
export const decisionIdOf = (packageId: string, itemKey: string) => `dec-${packageId}__${itemKey}`;

/** 投递台账 ID 由包 + 校验和确定 */
export const deliveryIdOf = (pkg: RevisionPackage) => `dlv-${pkg.packageId}__${checksumOf({ v: pkg.baselineVersion, t: pkg.targetVersion, items: pkg.items })}`;

export interface BuildDecisionResult {
  decision: PendingDecision;
  conflictFields: FieldKey[];
}

/**
 * 逐条处理修订包条目，生成对账结论：
 * - 本地无同名记录      → new-record（新增，字段来源=中心库）
 * - 有同名且各字段一致 → auto-revision（可直接应用）
 * - 有同名但字段不一致 → conflict（未决，核对员逐字段选择）
 * 基准值与本地当前值不一致的字段会标记 baselineDrifted。
 */
export const buildDecision = (
  state: Pick<ArchiveState, 'records' | 'baseVersion'>,
  delivery: Pick<Delivery, 'id' | 'packageId' | 'baselineVersion'>,
  item: RevisionItem
): BuildDecisionResult => {
  const local = findLocalRecord(state, item);
  const itemTitle = revisionValue(item, 'title') ?? item.matchTitle ?? item.key;
  const itemIdentifier = item.matchIdentifier ?? item.identifier ?? '';
  const packageVersionDiverged = state.baseVersion !== delivery.baselineVersion;

  if (!local) {
    return {
      conflictFields: [],
      decision: {
        id: decisionIdOf(delivery.packageId, item.key),
        packageId: delivery.packageId,
        deliveryId: delivery.id,
        itemKey: item.key,
        identifier: itemIdentifier,
        title: itemTitle,
        outcome: 'new-record',
        baselineDiverged: packageVersionDiverged,
        status: packageVersionDiverged ? 'pending' : 'resolved',
        note: item.note,
        conflicts: [],
        choices: {},
        reviewer: packageVersionDiverged ? undefined : '系统（新增）',
        decidedAt: packageVersionDiverged ? undefined : new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    };
  }

  const conflicts: FieldConflict[] = [];
  REVISION_FIELDS.forEach((field) => {
    const incoming = revisionValue(item, field);
    if (incoming === undefined) return; // 包未携带的字段：保留本地，不动
    const localValue = recordFieldValue(local, field);
    if (incoming === localValue) return;
    const base = baselineValue(item, field);
    const baselineDrifted = base !== undefined && base !== localValue;
    conflicts.push({ field, localValue, revisionValue: incoming, baselineValue: base, baselineDrifted });
  });

  if (!conflicts.length) {
    return {
      conflictFields: [],
      decision: {
        id: decisionIdOf(delivery.packageId, item.key),
        packageId: delivery.packageId,
        deliveryId: delivery.id,
        itemKey: item.key,
        recordId: local.id,
        identifier: local.identifier,
        title: local.title,
        outcome: 'auto-revision',
        baselineDiverged: packageVersionDiverged,
        // 基准版本偏离时，即使字段无差异也挂起，把未决结果显示给核对员确认
        status: packageVersionDiverged ? 'pending' : 'resolved',
        note: item.note,
        conflicts: [],
        choices: {},
        reviewer: packageVersionDiverged ? undefined : '系统（无差异）',
        decidedAt: packageVersionDiverged ? undefined : new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    };
  }

  const anyFieldDrift = conflicts.some((conflict) => conflict.baselineDrifted);
  return {
    conflictFields: conflicts.map((conflict) => conflict.field),
    decision: {
      id: decisionIdOf(delivery.packageId, item.key),
      packageId: delivery.packageId,
      deliveryId: delivery.id,
      itemKey: item.key,
      recordId: local.id,
      identifier: local.identifier,
      title: local.title,
      outcome: 'conflict',
      baselineDiverged: packageVersionDiverged || anyFieldDrift,
      status: 'pending',
      note: item.note,
      conflicts,
      choices: {},
      createdAt: new Date().toISOString()
    }
  };
};

export const pendingUnresolved = (state: Pick<ArchiveState, 'pending'>) =>
  state.pending.filter((decision) => decision.status === 'pending');

export const blockingDeliveries = (state: ArchiveState): Delivery[] =>
  state.deliveries.filter((delivery) => delivery.status === 'receiving' || delivery.status === 'interrupted');

/** 入库闸门：投递未完成 / 还有未决结论时一律不能入库 */
export const commitBlockers = (state: ArchiveState): string[] => {
  const blockers: string[] = [];
  const unfinished = state.deliveries.filter((delivery) => delivery.status === 'receiving' || delivery.status === 'interrupted');
  if (unfinished.length) {
    blockers.push(`有 ${unfinished.length} 份修订包尚未完成投递（可能在发送中断后等待重新投递）`);
  }
  const unresolved = pendingUnresolved(state);
  if (unresolved.length) {
    const drifted = unresolved.filter((decision) => decision.baselineDiverged).length;
    blockers.push(
      drifted
        ? `有 ${unresolved.length} 条未决对账结论（其中 ${drifted} 条存在基准版本偏离），须核对员逐条选择后才能入库`
        : `有 ${unresolved.length} 条同名记录两边不一致，须核对员逐字段选择后才能入库`
    );
  }
  return blockers;
};

const splitList = (value: string) => value.split(/[；、,，]/).map((part) => part.trim()).filter(Boolean);

/** 把一条已决结论应用到本地库记录上；逐字段更新并写来源，不碰未携带 / 未冲突的字段 */
export const applyDecision = (state: ArchiveState, decision: PendingDecision): ArchiveRecord[] => {
  const delivery = state.deliveries.find((item) => item.id === decision.deliveryId);
  const now = new Date().toISOString();

  if (decision.outcome === 'new-record') {
    const item = delivery?.items.find((entry) => entry.key === decision.itemKey);
    if (!item) return state.records;
    const base: ArchiveRecord = {
      id: `rec-${decision.packageId}-${decision.itemKey}`,
      group: 'A',
      title: '', date: '', people: [], places: [], identifier: '', medium: '', extent: '', rights: '', notes: '',
      updatedAt: now,
      status: 'unreviewed'
    };
    const provenance = {} as Partial<Record<FieldKey, { source: 'center'; packageId: string; itemKey: string; reviewer?: string; at: string }>>;
    REVISION_FIELDS.forEach((field) => {
      const value = revisionValue(item, field);
      if (value === undefined) return;
      (base[field] as string | string[]) = (field === 'people' || field === 'places') ? splitList(value) : value;
      provenance[field] = { source: 'center', packageId: decision.packageId, itemKey: decision.itemKey, reviewer: decision.reviewer, at: now };
    });
    return [...state.records, { ...base, baseVersion: delivery?.targetVersion, provenance }];
  }

  const local = state.records.find((record) => record.id === decision.recordId);
  if (!local) return state.records;
  const item = delivery?.items.find((entry) => entry.key === decision.itemKey);
  if (!item) return state.records;

  const next: ArchiveRecord = {
    ...local,
    people: [...local.people],
    places: [...local.places],
    provenance: { ...(local.provenance ?? {}) }
  };

  if (decision.outcome === 'auto-revision') {
    // 无差异修订：仅补齐包携带且本地相同的字段来源，不覆盖任何内容
    REVISION_FIELDS.forEach((field) => {
      const incoming = revisionValue(item, field);
      if (incoming === undefined) return;
      next.provenance![field] = {
        source: 'center', packageId: decision.packageId, itemKey: decision.itemKey, reviewer: decision.reviewer, at: now
      };
    });
  } else {
    decision.conflicts.forEach((conflict) => {
      const choice: FieldSource = decision.choices[conflict.field] ?? 'store';
      if (choice === 'store') {
        next.provenance![conflict.field] = {
          source: 'local', packageId: decision.packageId, itemKey: decision.itemKey, reviewer: decision.reviewer, at: now
        };
        return;
      }
      const value = choice === 'combine'
        ? (conflict.localValue ? `${conflict.localValue}；${conflict.revisionValue}` : conflict.revisionValue)
        : conflict.revisionValue;
      (next[conflict.field] as string | string[]) =
        (conflict.field === 'people' || conflict.field === 'places') ? splitList(value) : value;
      next.provenance![conflict.field] = {
        source: choice === 'combine' ? 'combine' : 'center',
        packageId: decision.packageId, itemKey: decision.itemKey, reviewer: decision.reviewer, at: now
      };
    });
  }

  next.updatedAt = now;
  return state.records.map((record) => (record.id === next.id ? next : record));
};

/** 全部已决后入库：应用结论、推进基准版本、保留对账记录（不删除 pending/delivery） */
export const commitRevisions = (state: ArchiveState): { records: ArchiveRecord[]; baseVersion: string; applied: PendingDecision[] } | null => {
  if (commitBlockers(state).length) return null;
  // 只应用尚未提交的包（received）的结论，避免已入库结论重复应用（尤其新增记录）
  const openPackageIds = new Set(state.deliveries
    .filter((delivery) => delivery.status === 'received')
    .map((delivery) => delivery.packageId));
  const applied = state.pending.filter((decision) => decision.status === 'resolved' && openPackageIds.has(decision.packageId));
  if (!applied.length) return null;
  let records = state.records;
  const working: Pick<ArchiveState, 'records'> = { records };
  applied.forEach((decision) => {
    working.records = applyDecision({ ...state, records: working.records }, decision);
  });
  records = working.records;
  const latest = state.deliveries
    .filter((delivery) => delivery.status === 'received')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return { records, baseVersion: latest?.targetVersion ?? state.baseVersion, applied };
};

export const parseRevisionPackage = (raw: string): RevisionPackage => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('不是合法的 JSON 修订包');
  }
  const pkg = parsed as Partial<RevisionPackage>;
  if (!pkg || typeof pkg !== 'object') throw new Error('修订包结构无效');
  if (!pkg.packageId || typeof pkg.packageId !== 'string') throw new Error('缺少包编号 packageId');
  if (!pkg.baselineVersion || !pkg.targetVersion) throw new Error('缺少基准版本 baselineVersion / targetVersion');
  if (!Array.isArray(pkg.items) || !pkg.items.length) throw new Error('修订包内没有任何条目');
  pkg.items.forEach((item, index) => {
    if (!item.key) throw new Error(`第 ${index + 1} 条条目缺少 key`);
  });
  const keys = new Set(pkg.items.map((item) => item.key));
  if (keys.size !== pkg.items.length) throw new Error('修订包条目 key 存在重复');
  return pkg as RevisionPackage;
};
