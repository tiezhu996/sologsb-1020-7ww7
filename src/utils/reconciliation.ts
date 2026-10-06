import type {
  ArchiveRecord,
  AuditEntry,
  FieldKey,
  MatchCandidate,
  PendingConflict,
  RevisionItem,
  RevisionPackage
} from '../types';

export const FIELD_KEYS: FieldKey[] = ['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'];

export const fieldText = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.join('、') : (value ?? '').trim();

const equalField = (local: string | string[] | undefined, incoming: string | string[] | undefined): boolean => {
  if (Array.isArray(local) || Array.isArray(incoming)) {
    const a = (Array.isArray(local) ? local : fieldText(local).split(/[；、,，]/)).map((item) => item.trim()).filter(Boolean);
    const b = (Array.isArray(incoming) ? incoming : fieldText(incoming).split(/[；、,，]/)).map((item) => item.trim()).filter(Boolean);
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return (local ?? '').trim() === (incoming ?? '').trim();
};

/** 找出本地记录与修订项之间不一致的字段 */
export function differingFields(record: ArchiveRecord, item: RevisionItem): FieldKey[] {
  const fields = item.fields ?? {};
  return FIELD_KEYS.filter((field) => field in fields && !equalField(record[field], fields[field]));
}

export interface AppliedDraft {
  recordId: string;
  op: RevisionItem['op'];
  outcome: 'created' | 'unchanged' | 'deleted' | 'conflict' | 'missing';
}

export interface ReceiveResult {
  records: ArchiveRecord[];
  conflicts: PendingConflict[];
  matches: MatchCandidate[];
  auditDrafts: Array<Omit<AuditEntry, 'id' | 'at'>>;
  appliedDrafts: AppliedDraft[];
  /** 本次重投时跳过的、之前已经处理过的项数 */
  skippedProcessed: number;
  /** 基准版本是否偏离（包基准 ≠ 本地当前基准） */
  baselineDiverged: boolean;
}

interface ReceiveContext {
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  conflicts: PendingConflict[];
  /** 此前已处理台账，用于重投去重 */
  processed: Array<{ recordId: string; op: RevisionItem['op'] }>;
  repoVersion: number;
  now: string;
  uuid: () => string;
  /** 新增记录的分组（中心库下发的新记录不直接进入 A/B 匹配） */
  newRecordGroup: ArchiveRecord['group'];
}

/**
 * 接收（可能是中断后重投的）修订包：
 * - 修订项逐字段处理，绝不整包覆盖本地记录；
 * - 同名记录任一字段不一致即挂起为冲突，核对员未裁决前不入库；
 * - 已处理项按 (recordId, op) 去重，重投不重复应用；
 * - 已确认 / 已合并的匹配关系原样保留（删除时触发冲突而非直接删）。
 */
export function receivePackage(pkg: RevisionPackage, ctx: ReceiveContext): ReceiveResult {
  const records: ArchiveRecord[] = ctx.records.map((record) => ({
    ...record,
    people: [...record.people],
    places: [...record.places],
    fieldOrigins: { ...(record.fieldOrigins ?? {}) }
  }));
  let matches = ctx.matches.map((match) => ({ ...match }));
  const conflicts = [...ctx.conflicts];
  const auditDrafts: ReceiveResult['auditDrafts'] = [];
  const appliedDrafts: AppliedDraft[] = [];

  let skippedProcessed = 0;
  let created = 0;
  let deleted = 0;
  let conflictRaised = 0;

  pkg.items.forEach((item) => {
    const already = ctx.processed.some((entry) => entry.recordId === item.recordId && entry.op === item.op);
    if (already) { skippedProcessed += 1; return; }

    const index = records.findIndex((entry) => entry.id === item.recordId);

    if (item.op === 'delete') {
      if (index < 0) {
        appliedDrafts.push({ recordId: item.recordId, op: 'delete', outcome: 'missing' });
        return;
      }
      const linked = matches.some(
        (match) => (match.leftId === item.recordId || match.rightId === item.recordId)
          && (match.status === 'confirmed' || match.status === 'merged')
      );
      if (linked) {
        pushDeleteConflict(conflicts, records[index], pkg, item, ctx);
        conflictRaised += 1;
        appliedDrafts.push({ recordId: item.recordId, op: 'delete', outcome: 'conflict' });
      } else {
        records.splice(index, 1);
        matches = matches.filter((match) => match.leftId !== item.recordId && match.rightId !== item.recordId);
        deleted += 1;
        appliedDrafts.push({ recordId: item.recordId, op: 'delete', outcome: 'deleted' });
      }
      return;
    }

    if (index < 0) {
      records.push(createRecord(item, pkg, ctx));
      created += 1;
      appliedDrafts.push({ recordId: item.recordId, op: 'upsert', outcome: 'created' });
      return;
    }

    const record = records[index];
    const differing = differingFields(record, item);
    if (!differing.length) {
      appliedDrafts.push({ recordId: item.recordId, op: 'upsert', outcome: 'unchanged' });
      return;
    }

    // 同包同记录已有未决冲突（中断后重投）：刷新两侧快照，但保留核对员已做的选择
    const existing = conflicts.find(
      (conflict) => conflict.packageId === pkg.packageId && conflict.recordId === record.id && conflict.state === 'pending'
    );
    if (existing) {
      existing.localFields = snapshotFields(record);
      existing.packageFields = packageSnapshot(item);
      existing.differingFields = differing;
      return;
    }
    conflicts.push({
      id: ctx.uuid(),
      packageId: pkg.packageId,
      recordId: record.id,
      kind: 'update',
      differingFields: differing,
      localFields: snapshotFields(record),
      packageFields: packageSnapshot(item),
      resolutions: {},
      state: 'pending',
      createdAt: ctx.now,
      reason: item.reason
    });
    conflictRaised += 1;
    appliedDrafts.push({ recordId: item.recordId, op: 'upsert', outcome: 'conflict' });
  });

  if (created) auditDrafts.push({
    action: '修订包新增记录',
    detail: `《${pkg.source}》写入 ${created} 条中心库新记录，字段来源标记为“修订包”`,
    recordIds: appliedDrafts.filter((draft) => draft.outcome === 'created').map((draft) => draft.recordId),
    packageId: pkg.packageId
  });
  if (deleted) auditDrafts.push({
    action: '修订包删除记录',
    detail: `《${pkg.source}》删除 ${deleted} 条无确认关联的本地记录`,
    recordIds: appliedDrafts.filter((draft) => draft.outcome === 'deleted').map((draft) => draft.recordId),
    packageId: pkg.packageId
  });
  if (conflictRaised) auditDrafts.push({
    action: '挂起字段冲突',
    detail: `${conflictRaised} 条同名记录与本地核对结论不一致，已挂起等待核对员逐字段裁决，未决项暂不入库`,
    recordIds: conflicts
      .filter((conflict) => conflict.packageId === pkg.packageId && conflict.state === 'pending')
      .map((conflict) => conflict.recordId),
    packageId: pkg.packageId
  });
  if (skippedProcessed) auditDrafts.push({
    action: '重投去重',
    detail: `检测到同一份包重复投递，${skippedProcessed} 个已处理项未重复应用`,
    recordIds: [],
    packageId: pkg.packageId
  });

  return {
    records,
    conflicts,
    matches,
    auditDrafts,
    appliedDrafts,
    skippedProcessed,
    baselineDiverged: pkg.baseVersion !== ctx.repoVersion
  };
}

function pushDeleteConflict(
  conflicts: PendingConflict[],
  record: ArchiveRecord,
  pkg: RevisionPackage,
  item: RevisionItem,
  ctx: ReceiveContext
) {
  const existing = conflicts.find(
    (conflict) => conflict.packageId === pkg.packageId && conflict.recordId === record.id && conflict.state === 'pending'
  );
  if (existing) return;
  conflicts.push({
    id: ctx.uuid(),
    packageId: pkg.packageId,
    recordId: record.id,
    kind: 'delete',
    differingFields: [],
    localFields: snapshotFields(record),
    packageFields: {},
    resolutions: {},
    state: 'pending',
    createdAt: ctx.now,
    reason: item.reason
  });
}

function snapshotFields(record: ArchiveRecord): PendingConflict['localFields'] {
  const snapshot: PendingConflict['localFields'] = {};
  FIELD_KEYS.forEach((field) => { snapshot[field] = fieldText(record[field] as string | string[]); });
  return snapshot;
}

function packageSnapshot(item: RevisionItem): PendingConflict['packageFields'] {
  const snapshot: PendingConflict['packageFields'] = {};
  (Object.keys(item.fields ?? {}) as FieldKey[]).forEach((field) => {
    snapshot[field] = fieldText(item.fields?.[field]);
  });
  return snapshot;
}

function createRecord(item: RevisionItem, pkg: RevisionPackage, ctx: ReceiveContext): ArchiveRecord {
  const fields = item.fields ?? {};
  const record: ArchiveRecord = {
    id: item.recordId,
    group: ctx.newRecordGroup,
    title: fieldText(fields.title) || '未命名记录',
    date: fieldText(fields.date),
    people: Array.isArray(fields.people) ? fields.people : fieldText(fields.people).split(/[；、,，]/).map((part) => part.trim()).filter(Boolean),
    places: Array.isArray(fields.places) ? fields.places : fieldText(fields.places).split(/[；、,，]/).map((part) => part.trim()).filter(Boolean),
    identifier: fieldText(fields.identifier),
    medium: fieldText(fields.medium),
    extent: fieldText(fields.extent),
    rights: fieldText(fields.rights),
    notes: fieldText(fields.notes),
    updatedAt: ctx.now,
    status: 'unreviewed',
    fieldOrigins: {},
    fromPackageId: pkg.packageId
  };
  (Object.keys(fields) as FieldKey[]).forEach((field) => { record.fieldOrigins![field] = 'package'; });
  return record;
}

export interface CommitResult {
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  auditDraft: Omit<AuditEntry, 'id' | 'at'>;
  /** 包内全部修订项（含此前自动处理与冲突）是否已处理完毕 */
  packageComplete: boolean;
}

/**
 * 核对员裁决后，把单条冲突入库：
 * - 逐字段应用选择，不触碰未涉及字段；
 * - 已确认 / 已合并的匹配原样保留；
 * - 每个字段的最终来源写入 fieldOrigins。
 */
export function commitConflict(
  records: ArchiveRecord[],
  matches: MatchCandidate[],
  conflict: PendingConflict,
  now: string,
  pendingCountAfterCommit: number
): CommitResult {
  const nextRecords = records.map((record) => ({
    ...record,
    people: [...record.people],
    places: [...record.places],
    fieldOrigins: { ...(record.fieldOrigins ?? {}) }
  }));
  let nextMatches = matches;

  if (conflict.kind === 'delete' && conflict.deleteResolution === true) {
    const index = nextRecords.findIndex((entry) => entry.id === conflict.recordId);
    if (index >= 0) nextRecords.splice(index, 1);
    // 建议匹配断开为忽略；核对员已确认 / 已合并的操作事实原样保留（审计里可查到悬空原因）
    nextMatches = matches.map((match) => {
      if (match.leftId !== conflict.recordId && match.rightId !== conflict.recordId) return match;
      if (match.status === 'suggested') return { ...match, status: 'rejected' as const, reviewedAt: now };
      return match;
    });
  } else if (conflict.kind === 'update') {
    const record = nextRecords.find((entry) => entry.id === conflict.recordId);
    if (record) {
      conflict.differingFields.forEach((field) => {
        const choice = conflict.resolutions[field] ?? 'package';
        const packageValue = conflict.packageFields[field] ?? '';
        const localValue = conflict.localFields[field] ?? '';
        if (choice === 'local') {
          applyField(record, field, localValue);
          record.fieldOrigins![field] = 'local';
        } else if (choice === 'combine') {
          applyField(record, field, [localValue, packageValue].filter(Boolean).join('；'));
          record.fieldOrigins![field] = 'reviewer';
        } else {
          applyField(record, field, packageValue);
          record.fieldOrigins![field] = 'package';
        }
      });
      record.updatedAt = now;
      record.fromPackageId = conflict.packageId;
    }
  }

  const packageChoices = conflict.differingFields.filter((field) => conflict.resolutions[field] === 'package').length;
  const localChoices = conflict.differingFields.filter((field) => conflict.resolutions[field] === 'local').length;
  const combineChoices = conflict.differingFields.filter((field) => conflict.resolutions[field] === 'combine').length;
  const detail = conflict.kind === 'delete'
    ? (conflict.deleteResolution ? '按中心库要求删除，关联建议匹配已断开，确认/合并事实保留' : '核对员保留本地记录，未执行中心库删除指令')
    : `${conflict.recordId} 逐字段入库：采用修订包 ${packageChoices} 项、保留本地 ${localChoices} 项、双来源拼接 ${combineChoices} 项，字段来源已记录`;

  return {
    records: nextRecords,
    matches: nextMatches,
    packageComplete: pendingCountAfterCommit === 0,
    auditDraft: {
      action: conflict.kind === 'delete' ? '裁决删除冲突' : '冲突裁决入库',
      detail,
      recordIds: [conflict.recordId],
      packageId: conflict.packageId
    }
  };
}

function applyField(record: ArchiveRecord, field: FieldKey, value: string) {
  if (field === 'people' || field === 'places') {
    record[field] = value.split(/[；、,，]/).map((part) => part.trim()).filter(Boolean) as never;
  } else {
    (record as unknown as Record<string, string>)[field] = value;
  }
}

/** 冲突是否已完成裁决（未裁决不允许入库） */
export function isConflictReady(conflict: PendingConflict): boolean {
  if (conflict.state !== 'pending') return false;
  if (conflict.kind === 'delete') return conflict.deleteResolution !== undefined;
  return conflict.differingFields.every((field) => conflict.resolutions[field] !== undefined);
}

/** 校验并解析修订包 JSON，结构不合法时抛出错误 */
export function parseRevisionPackage(raw: string): RevisionPackage {
  const parsed = JSON.parse(raw) as Partial<RevisionPackage>;
  if (!parsed || typeof parsed !== 'object') throw new Error('修订包不是合法对象');
  if (!parsed.packageId || typeof parsed.packageId !== 'string') throw new Error('缺少 packageId');
  if (typeof parsed.baseVersion !== 'number') throw new Error('缺少 baseVersion');
  if (!Array.isArray(parsed.items)) throw new Error('缺少 items 修订项列表');
  parsed.items.forEach((item, index) => {
    if (!item || !item.recordId || (item.op !== 'upsert' && item.op !== 'delete')) {
      throw new Error(`第 ${index + 1} 条修订项缺少 recordId 或 op 非法`);
    }
  });
  return { source: '中心库', issuedAt: new Date().toISOString(), ...parsed } as RevisionPackage;
}
