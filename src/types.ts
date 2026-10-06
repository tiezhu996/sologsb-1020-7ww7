export type RecordGroup = 'A' | 'B' | 'C';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';
/** 字段取值来源：本地核对记录、中心库修订包，或核对员人工裁决 */
export type FieldOrigin = 'local' | 'package' | 'reviewer';
export type RevisionOp = 'upsert' | 'delete';

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
  /** 每个字段的来源标记，保证中心库字段与本地核对结论都可追溯 */
  fieldOrigins?: Partial<Record<FieldKey, FieldOrigin>>;
  /** 最近一次影响该记录的修订包编号 */
  fromPackageId?: string;
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
  packageId?: string;
  before?: string;
  after?: string;
}

/** 中心库离线修订包里的单条修订项，字段级保留来源 */
export interface RevisionItem {
  recordId: string;
  op: RevisionOp;
  /** 中心库给出的字段值（upsert 时存在），不与本地记录整包覆盖 */
  fields?: Partial<Record<FieldKey, string | string[]>>;
  /** 中心库修订说明，进入审计轨迹 */
  reason?: string;
}

/** 中心库 → 资料室的离线修订包 */
export interface RevisionPackage {
  packageId: string;
  source: string;
  /** 包内容所基于的资料室版本号 */
  baseVersion: number;
  issuedAt: string;
  items: RevisionItem[];
}

export type ConflictResolution = 'package' | 'local' | 'combine';
export type ConflictKind = 'update' | 'delete';
export type ConflictState = 'pending' | 'resolved' | 'committed' | 'skipped';

/** 同名记录两边不一致时挂起的未决项，核对员逐条裁决后才能入库 */
export interface PendingConflict {
  id: string;
  packageId: string;
  recordId: string;
  kind: ConflictKind;
  differingFields: FieldKey[];
  /** 冲突时刻两侧快照，包重投或界面重渲染都不丢选择 */
  localFields: Partial<Record<FieldKey, string>>;
  packageFields: Partial<Record<FieldKey, string>>;
  resolutions: Partial<Record<FieldKey, ConflictResolution>>;
  /** delete 冲突：true = 按包删除，false = 保留本地 */
  deleteResolution?: boolean;
  state: ConflictState;
  createdAt: string;
  resolvedAt?: string;
  reason?: string;
}

/** 已处理修订项台账：同一份包中断后重投，已处理项不重复应用 */
export interface AppliedItem {
  packageId: string;
  recordId: string;
  op: RevisionOp;
  outcome: 'created' | 'updated' | 'unchanged' | 'deleted' | 'conflict' | 'skipped-delete' | 'missing';
  at: string;
}

export type PackageStatus = 'received' | 'in-progress' | 'committed';

export interface DeliveryState {
  packageId: string;
  source: string;
  baseVersion: number;
  issuedAt: string;
  receivedAt: string;
  status: PackageStatus;
  total: number;
  appliedItems: AppliedItem[];
  conflictIds: string[];
  completedAt?: string;
}

export interface ArchiveState {
  revision: number;
  /** 本地核对结论所在基准版本（中心库修订包据此判断是否偏离） */
  repoVersion: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  conflicts: PendingConflict[];
  deliveries: DeliveryState[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
