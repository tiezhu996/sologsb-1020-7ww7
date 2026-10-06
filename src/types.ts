export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

/** 字段值的最终来源：本地库 / 中心库修订 / 两侧拼接 */
export type ProvenanceSource = 'local' | 'center' | 'combine';
/** 未决字段核对员的选择：保留本地 / 采用修订 / 拼接 */
export type FieldSource = 'store' | 'revision' | 'combine';

export interface FieldProvenance {
  source: ProvenanceSource;
  /** 中心库修订包编号（来自修订时记录） */
  packageId?: string;
  /** 包内条目键 */
  itemKey?: string;
  /** 做选择的核对员 */
  reviewer?: string;
  at: string;
}

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
  /** 该记录最近一次对齐到的基准版本 */
  baseVersion?: string;
  /** 逐字段来源，用于追溯“这个值从哪来、谁选的” */
  provenance?: Partial<Record<FieldKey, FieldProvenance>>;
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

/* ---------------- 中心库离线修订包 ---------------- */

export type RevisionField = string | string[];

/** 修订包内的单条修订（按编号 / 标题定位同名本地记录） */
export interface RevisionItem {
  key: string;
  /** 定位本地同名记录用的编号（缺省时用条目自身 identifier） */
  matchIdentifier?: string;
  /** 定位本地同名记录用的标题（缺省时用条目自身 title） */
  matchTitle?: string;
  title?: string;
  date?: string;
  people?: string[];
  places?: string[];
  identifier?: string;
  medium?: string;
  extent?: string;
  rights?: string;
  notes?: string;
  /** 中心库制作该修订时所依据的字段基准值，用于检测本地是否已偏离基准 */
  baseline?: Partial<Record<FieldKey, RevisionField>>;
  /** 中心库附的修订说明 */
  note?: string;
}

export interface RevisionPackage {
  packageId: string;
  origin: string;
  issuedAt: string;
  /** 中心库制作本包时依据的基准版本 */
  baselineVersion: string;
  /** 应用后期望本地库到达的版本 */
  targetVersion: string;
  items: RevisionItem[];
  checksum?: string;
}

export type DeliveryStatus = 'receiving' | 'interrupted' | 'received' | 'committed';

/** 一次修订包投递（中断重投共用同一条台账） */
export interface Delivery {
  id: string;
  packageId: string;
  checksum: string;
  origin: string;
  issuedAt: string;
  baselineVersion: string;
  targetVersion: string;
  status: DeliveryStatus;
  attempts: number;
  /** 已处理条目键台账：重新投递时逐项跳过，保证不重复应用 */
  processedKeys: string[];
  /** 携带包条目，中断后无需原始文件即可继续投递 */
  items: RevisionItem[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type PendingOutcome = 'new-record' | 'auto-revision' | 'conflict';

export interface FieldConflict {
  field: FieldKey;
  localValue: string;
  revisionValue: string;
  /** 中心库基准值（存在且与本地不同说明本地已偏离基准） */
  baselineValue?: string;
  baselineDrifted: boolean;
}

/** 一条修订条目的对账结论（未决 / 已决，入库时统一应用） */
export interface PendingDecision {
  id: string;
  packageId: string;
  deliveryId: string;
  itemKey: string;
  recordId?: string;
  identifier: string;
  title: string;
  outcome: PendingOutcome;
  /** 包基准版本或字段基准值与本地不一致 */
  baselineDiverged: boolean;
  status: 'pending' | 'resolved';
  note?: string;
  conflicts: FieldConflict[];
  /** 非冲突结论（新增 / 无差异）的整体确认标记 */
  choices: Partial<Record<FieldKey, FieldSource>> & { __accept__?: boolean };
  reviewer?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface ArchiveState {
  revision: number;
  /** 本地库当前基准版本 */
  baseVersion: string;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  deliveries: Delivery[];
  pending: PendingDecision[];
  committedPackageIds: string[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
