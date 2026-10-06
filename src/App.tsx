import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, ConflictResolution, FieldKey,
  MatchCandidate, PendingConflict, RecordGroup
} from './types';
import { fieldValue, recomputeMatchesPreserving } from './utils/matching';
import {
  commitConflict, isConflictReady, parseRevisionPackage, receivePackage
} from './utils/reconciliation';
import { seedState } from './data/seed';
import { samplePackageCurrent, samplePackageDiverged } from './data/samplePackages';

const STORAGE_KEY = 'sologsb-1020-archive-state-v2';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];
const fieldLabel = (field: FieldKey) => fieldLabels.find(([key]) => key === field)?.[1] ?? field;
const originLabel = (origin?: 'local' | 'package' | 'reviewer') =>
  origin === 'package' ? '修订包' : origin === 'reviewer' ? '核对员' : '本地';

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
  const receiveOpen = useSignal(false);
  const receiveError = useSignal('');
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const receiveRaw = useSignal('');
  const receiveText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    repoVersion: state.repoVersion,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    conflicts: state.conflicts,
    deliveries: state.deliveries
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.repoVersion = next.repoVersion ?? 0;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
    state.conflicts = next.conflicts ?? [];
    state.deliveries = next.deliveries ?? [];
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const commit = (action: string, detail: string, recordIds: string[] = [], packageId?: string) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds, packageId });
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
  const conflictCount = useComputed$(() => state.conflicts.filter((conflict) => conflict.state === 'pending').length);
  const pendingConflicts = useComputed$(() => state.conflicts.filter((conflict) => conflict.state === 'pending'));
  const committedConflicts = useComputed$(() => state.conflicts.filter((conflict) => conflict.state === 'committed'));
  const diverged = useComputed$(() => state.deliveries.some(
    (delivery) => delivery.status !== 'committed' && delivery.baseVersion !== state.repoVersion
  ));

  const deliveryOf = (packageId: string) => state.deliveries.find((delivery) => delivery.packageId === packageId);
  const deliveryPending = (packageId: string) =>
    state.conflicts.filter((conflict) => conflict.packageId === packageId && conflict.state === 'pending').length;

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配，操作记录已保留' : '已忽略此项匹配');
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

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    const left = match ? recordById(state, match.leftId) : undefined;
    const right = match ? recordById(state, match.rightId) : undefined;
    if (!match || !left || !right) {
      notify('该匹配关联的记录已不存在，无法合并');
      return;
    }
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => { choices[field] = fieldValue(left, field) === fieldValue(right, field) ? 'A' : 'A'; });
    mergeOpen.value = true;
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const fieldOrigins: ArchiveRecord['fieldOrigins'] = {};
    fieldLabels.forEach(([field]) => { fieldOrigins[field] = 'local'; });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      fieldOrigins,
      status: 'merged',
      updatedAt: new Date().toISOString()
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
      mergedAt: new Date().toISOString()
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id]);
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
        fieldOrigins: {}
      };
      fieldLabels.forEach(([field]) => { record.fieldOrigins![field] = 'local'; });
      state.records.push(record);
    });
    // 重新计算候选时保留已确认 / 已忽略 / 已合并的操作记录，不被新导入冲掉
    state.matches = recomputeMatchesPreserving(state.records, state.matches);
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录；已有复核结论原样保留`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配，已确认匹配未受影响`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  /** 接收中心库离线修订包（支持中断后同包重投，已处理项不重复应用） */
  const ingestRevision = $(() => {
    receiveError.value = '';
    let pkg;
    try {
      pkg = parseRevisionPackage(receiveRaw.value);
    } catch (error) {
      receiveError.value = error instanceof Error ? error.message : '修订包解析失败';
      return;
    }
    capture();
    const now = new Date().toISOString();
    const existing = state.deliveries.find((delivery) => delivery.packageId === pkg!.packageId);
    const result = receivePackage(pkg, {
      records: state.records,
      matches: state.matches,
      conflicts: state.conflicts,
      processed: existing ? existing.appliedItems.map((item) => ({ recordId: item.recordId, op: item.op })) : [],
      repoVersion: state.repoVersion,
      now,
      uuid: () => crypto.randomUUID(),
      newRecordGroup: 'C'
    });

    state.records = result.records;
    state.matches = result.matches;
    state.conflicts = result.conflicts;
    result.auditDrafts.forEach((draft) => {
      state.audit.unshift({ id: crypto.randomUUID(), at: now, ...draft });
    });
    const drafts = result.appliedDrafts.map((draft) => ({ packageId: pkg.packageId, at: now, ...draft }));
    const pending = state.conflicts.filter((conflict) => conflict.packageId === pkg.packageId && conflict.state === 'pending').length;

    if (existing) {
      existing.appliedItems = [...existing.appliedItems, ...drafts];
      existing.status = pending ? 'in-progress' : 'committed';
      if (!pending) existing.completedAt = now;
    } else {
      state.deliveries.unshift({
        packageId: pkg.packageId,
        source: pkg.source,
        baseVersion: pkg.baseVersion,
        issuedAt: pkg.issuedAt,
        receivedAt: now,
        status: pending ? 'in-progress' : 'committed',
        total: pkg.items.length,
        appliedItems: drafts,
        conflictIds: state.conflicts
          .filter((conflict) => conflict.packageId === pkg.packageId)
          .map((conflict) => conflict.id),
        completedAt: pending ? undefined : now
      });
    }

    if (!pending) {
      if (pkg.baseVersion > state.repoVersion) state.repoVersion = pkg.baseVersion;
      commit('修订包处理完毕', `《${pkg.source}》全部 ${pkg.items.length} 项已处理，本地基准对齐至 r${state.repoVersion}`, [], pkg.packageId);
    } else {
      const parts: string[] = [];
      const counts = result.appliedDrafts.reduce<Record<string, number>>((acc, draft) => {
        acc[draft.outcome] = (acc[draft.outcome] ?? 0) + 1;
        return acc;
      }, {});
      if (counts.created) parts.push(`新增 ${counts.created}`);
      if (counts.deleted) parts.push(`删除 ${counts.deleted}`);
      if (counts.unchanged) parts.push(`无变化 ${counts.unchanged}`);
      if (result.skippedProcessed) parts.push(`重投去重 ${result.skippedProcessed}`);
      commit('接收修订包', `《${pkg.source}》接收 ${pkg.items.length} 项（${parts.join('、') || '全部已处理'}），${pending} 条冲突挂起待裁决`, [], pkg.packageId);
    }

    receiveRaw.value = '';
    receiveText.value = '';
    receiveOpen.value = false;
    panelTab.value = 0;
    if (pending) {
      notify(result.baselineDiverged
        ? `修订包已接收，${pending} 条未决冲突挂起；警告：包基准 r${pkg.baseVersion} 偏离本地 r${state.repoVersion}`
        : `修订包已接收，${pending} 条同名记录不一致，裁决前不会入库`);
    } else {
      notify(result.skippedProcessed
        ? `同一份包重新投递完成，${result.skippedProcessed} 个已处理项未重复应用`
        : '修订包全部项目已处理，无未决冲突');
    }
  });

  const setResolution = $((conflictId: string, field: FieldKey, resolution: ConflictResolution) => {
    const conflict = state.conflicts.find((item) => item.id === conflictId);
    if (conflict && conflict.state === 'pending') conflict.resolutions[field] = resolution;
  });

  const setDeleteResolution = $((conflictId: string, value: boolean) => {
    const conflict = state.conflicts.find((item) => item.id === conflictId);
    if (conflict && conflict.state === 'pending') conflict.deleteResolution = value;
  });

  /** 核对员裁决后把单条未决冲突入库；未裁决齐字段时禁止入库 */
  const commitOne = $((conflictId: string) => {
    const conflict = state.conflicts.find((item) => item.id === conflictId);
    if (!conflict || !isConflictReady(conflict)) {
      notify('仍有字段未选择保留来源，暂不能入库');
      return;
    }
    capture();
    const now = new Date().toISOString();
    const pendingAfter = state.conflicts.filter(
      (item) => item.packageId === conflict.packageId && item.state === 'pending' && item.id !== conflict.id
    ).length;
    const result = commitConflict(state.records, state.matches, conflict, now, pendingAfter);
    state.records = result.records;
    state.matches = result.matches;
    state.conflicts = state.conflicts.map((item) =>
      item.id === conflict.id ? { ...item, state: 'committed', resolvedAt: now } : item);
    commit(result.auditDraft.action, result.auditDraft.detail, result.auditDraft.recordIds, result.auditDraft.packageId);

    const delivery = deliveryOf(conflict.packageId);
    if (result.packageComplete && delivery) {
      delivery.status = 'committed';
      delivery.completedAt = now;
      if (delivery.baseVersion > state.repoVersion) {
        state.repoVersion = delivery.baseVersion;
        commit('基准版本对齐', `《${delivery.source}》未决项全部入库，本地基准对齐至 r${state.repoVersion}`, [], delivery.packageId);
      }
    }
    notify('裁决已入库，字段来源与操作记录已保留');
  });

  const receiveFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    receiveRaw.value = await file.text();
    receiveText.value = file.name;
    receiveError.value = '';
  });

  const loadSample = $((which: 'current' | 'diverged') => {
    const pkg = which === 'current' ? samplePackageCurrent : samplePackageDiverged;
    receiveRaw.value = JSON.stringify(pkg, null, 2);
    receiveText.value = `${pkg.packageId}.json`;
    receiveError.value = '';
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      repoVersion: state.repoVersion,
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      conflicts: state.conflicts,
      deliveries: state.deliveries,
      audit: state.audit
    }, null, 2)], { type: 'application/json' });
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

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('sologsb-1020-archive-state-v1');
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
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · 核对 r${state.revision} · 基准 r${state.repoVersion}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button light" onClick$={() => { receiveError.value = ''; receiveOpen.value = true; }}>接收修订包</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button ghost" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>中心库修订逐字段保留来源，本地核对结论保留操作记录；同名记录不一致时由核对员裁决，未决项不入库。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class={conflictCount.value ? 'danger' : ''}><strong>{conflictCount.value}</strong><span>未决对账项</span></div>
        </div>
      </div>

      {conflictCount.value > 0 && (
        <div class={`reconcile-banner ${diverged.value ? 'diverged' : ''}`}>
          <strong>跨系统对账：{conflictCount.value} 条同名记录的中心库修订与本地核对结论不一致</strong>
          <span>冲突项已挂起，核对员逐字段选择来源前不会入库；字段来源与操作记录均保留。</span>
          {diverged.value && <em>基准版本偏离：修订包基于更早/更晚的基准快照，未决结果已按包基准标出，请核对后再裁决。</em>}
        </div>
      )}

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
                    <div><small>A · {left?.group ?? '—'}</small><strong>{left?.title ?? '（记录已删除）'}</strong><span>{left ? `${parseDate(left.date)} · ${left.people.join('、')}` : '关联记录已被修订包移除'}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group ?? '—'}</small><strong>{right?.title ?? '（记录已删除）'}</strong><span>{right ? `${parseDate(right.date)} · ${right.people.join('、')}` : '关联记录已被修订包移除'}</span></div>
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
              <option value="all">A + B + 库</option><option value="A">A 组</option><option value="B">B 组</option><option value="C">中心库新增</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => {
              const origins = Array.from(new Set(Object.values(record.fieldOrigins ?? {})));
              return (
                <div class="table-row" key={record.id} title={origins.length ? `字段来源：${origins.map(originLabel).join('、')}` : '本地核对记录'}>
                  <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                  <strong>{record.title}</strong>
                  <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                  <code>{record.identifier}{record.fromPackageId && <em class="origin-dot" title={`来自修订包 ${record.fromPackageId}`}>包</em>}</code>
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
                const left = recordById(state, activeMatch.value!.leftId);
                const right = recordById(state, activeMatch.value!.rightId);
                if (!left || !right) return <div class="empty-state">该匹配关联的记录已被修订包移除，操作记录仍保留在审计轨迹中。</div>;
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
                const left = state.records.find((record) => record.id === merge.leftId);
                const right = state.records.find((record) => record.id === merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel conflicts-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">03 / CROSS-SYSTEM</span><h3>未决对账 · 逐字段裁决</h3></div>
            <span class={conflictCount.value ? 'pending-pill' : ''}>{conflictCount.value ? `${conflictCount.value} 项未入库` : '全部已入库'}</span>
          </div>
          <div class="conflict-list">
            {pendingConflicts.value.map((conflict) => {
              const record = recordById(state, conflict.recordId);
              const delivery = deliveryOf(conflict.packageId);
              const isDiverged = !!delivery && delivery.baseVersion !== state.repoVersion;
              const ready = isConflictReady(conflict);
              return (
                <div class="conflict-card" key={conflict.id}>
                  <div class="conflict-head">
                    <strong>{record?.title ?? conflict.recordId}</strong>
                    <code>{conflict.recordId}</code>
                    <span class="pkg-tag">{conflict.packageId}</span>
                    {isDiverged && <span class="diverge-tag">基准偏离 r{delivery?.baseVersion} ≠ 本地 r{state.repoVersion}</span>}
                  </div>
                  {conflict.reason && <p class="conflict-reason">{conflict.reason}</p>}
                  {conflict.kind === 'update' ? <>
                    <div class="conflict-field-head"><span>不一致字段</span><span>本地核对结论</span><span>中心库修订（保留来源）</span><span>核对员裁决</span></div>
                    {conflict.differingFields.map((field) => (
                      <div class="conflict-field-row" key={field}>
                        <span class="cf-label">{fieldLabel(field)}</span>
                        <span class="cf-local">{conflict.localFields[field] || '—'}</span>
                        <span class="cf-pkg">{conflict.packageFields[field] || '—'}</span>
                        <span class="cf-choice">
                          <label class={conflict.resolutions[field] === 'package' ? 'chosen' : ''}>
                            <input type="radio" name={`cf-${conflict.id}-${field}`} checked={conflict.resolutions[field] === 'package'} onChange$={() => setResolution(conflict.id, field, 'package')} />采用修订包
                          </label>
                          <label class={conflict.resolutions[field] === 'local' ? 'chosen' : ''}>
                            <input type="radio" name={`cf-${conflict.id}-${field}`} checked={conflict.resolutions[field] === 'local'} onChange$={() => setResolution(conflict.id, field, 'local')} />保留本地
                          </label>
                          <label class={conflict.resolutions[field] === 'combine' ? 'chosen' : ''}>
                            <input type="radio" name={`cf-${conflict.id}-${field}`} checked={conflict.resolutions[field] === 'combine'} onChange$={() => setResolution(conflict.id, field, 'combine')} />拼接
                          </label>
                        </span>
                      </div>
                    ))}
                    <div class="conflict-foot">
                      <small>其余字段两侧一致，入库只写入选定字段，禁止整包覆盖；已确认匹配不受影响。</small>
                      <button class="button primary small" disabled={!ready} onClick$={() => commitOne(conflict.id)}>
                        {ready ? '裁决入库' : `还有 ${conflict.differingFields.filter((field) => !conflict.resolutions[field]).length} 个字段待选`}
                      </button>
                    </div>
                  </> : <>
                    <div class="delete-conflict">
                      <p>中心库要求删除该记录，但本地存在已确认 / 已合并的关联匹配，必须由核对员决定。</p>
                      <div class="delete-options">
                        <button class={`button small danger ${conflict.deleteResolution === true ? 'selected' : ''}`} onClick$={() => setDeleteResolution(conflict.id, true)}>按包删除（断开建议匹配）</button>
                        <button class={`button small ghost ${conflict.deleteResolution === false ? 'selected' : ''}`} onClick$={() => setDeleteResolution(conflict.id, false)}>保留本地记录</button>
                        <button class="button small primary" disabled={!ready} onClick$={() => commitOne(conflict.id)}>确认裁决</button>
                      </div>
                    </div>
                  </>}
                </div>
              );
            })}
            {!pendingConflicts.value.length && <div class="empty-state">没有未决冲突。中心库修订与本地核对结论一致，或全部冲突已完成裁决入库。</div>}
            {committedConflicts.value.length > 0 && (
              <details class="committed-log">
                <summary>已裁决入库 {committedConflicts.value.length} 项（字段来源与操作已记录）</summary>
                <ul>
                  {committedConflicts.value.map((conflict) => (
                    <li key={conflict.id}>{conflict.recordId} · {conflict.kind === 'delete' ? (conflict.deleteResolution ? '按包删除' : '保留本地') : '逐字段入库'} · {conflict.resolvedAt ? new Date(conflict.resolvedAt).toLocaleString('zh-CN') : ''}</li>
                  ))}
                </ul>
              </details>
            )}
            <div class="reconcile-rules">
              <strong>对账保护规则</strong>
              <p>① 修订包只按字段合入，绝不整包覆盖；每个字段最终来源标记为本地 / 修订包 / 核对员。② 同名记录任一字段不一致即挂起，核对员逐字段选择前禁止入库。③ 同一份包中断后可重复投递，已处理项按「记录编号 + 操作」去重，不重复应用，已做的选择保留。④ 已确认 / 已合并匹配与本地审计操作记录不被新包冲掉。⑤ 包基准与本地基准不一致时，未决项以「基准偏离」红标展示。</p>
            </div>
          </div>
        </article>

        <article class="panel delivery-panel">
          <div class="panel-heading"><div><span class="eyebrow">04 / DELIVERY</span><h3>修订包投递台账</h3></div><span>本地基准 r{state.repoVersion}</span></div>
          <div class="delivery-list">
            {state.deliveries.map((delivery) => {
              const pending = deliveryPending(delivery.packageId);
              const counts = delivery.appliedItems.reduce<Record<string, number>>((acc, item) => {
                acc[item.outcome] = (acc[item.outcome] ?? 0) + 1;
                return acc;
              }, {});
              const isDiverged = delivery.status !== 'committed' && delivery.baseVersion !== state.repoVersion;
              return (
                <div class={`delivery-card ${delivery.status === 'committed' ? 'done' : ''} ${isDiverged ? 'diverged' : ''}`} key={delivery.packageId}>
                  <div class="delivery-head"><strong>{delivery.packageId}</strong><span class={`status ${delivery.status === 'committed' ? 'confirmed' : 'suggested'}`}>{delivery.status === 'committed' ? '已处理完毕' : `处理中 · ${pending} 未决`}</span></div>
                  <p>{delivery.source}</p>
                  <div class="delivery-meta">
                    <span>包基准 r{delivery.baseVersion}</span>
                    <span>共 {delivery.total} 项</span>
                    {isDiverged && <span class="diverge-tag">基准偏离</span>}
                  </div>
                  <div class="delivery-chips">
                    {counts.created ? <em class="chip created">新增 {counts.created}</em> : null}
                    {counts.deleted ? <em class="chip deleted">删除 {counts.deleted}</em> : null}
                    {counts.unchanged ? <em class="chip unchanged">无变化 {counts.unchanged}</em> : null}
                    {counts.conflict ? <em class="chip conflict">冲突 {counts.conflict}</em> : null}
                    {counts.missing ? <em class="chip missing">本地无此项 {counts.missing}</em> : null}
                  </div>
                  <small>接收于 {new Date(delivery.receivedAt).toLocaleString('zh-CN')}{delivery.completedAt ? ` · 完成于 ${new Date(delivery.completedAt).toLocaleString('zh-CN')}` : ''}</small>
                </div>
              );
            })}
            {!state.deliveries.length && <div class="empty-state">尚未接收中心库修订包。中断后可重复投递同一份包，已处理项不会重复应用。</div>}
          </div>
        </article>

        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">05 / TRACE</span><h3>处理记录（操作审计）</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 10).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}{entry.packageId ? <em class="audit-pkg">{entry.packageId}</em> : null}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。重新导入不会冲掉已确认匹配与逐字段选择。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={receiveOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel receive-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">REVISION PACKAGE</span><Modal.Title>接收中心库离线修订包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">
            修订包逐字段合入，不做整包覆盖：同名记录两边不一致时自动挂起，由核对员在「未决对账」中逐字段选择后才能入库。
            发送中断后重新投递同一份包即可，已处理项按编号去重、不会重复应用，已做的裁决选择也会保留。
          </Modal.Description>
          <div class="import-controls">
            <button class="button ghost small" onClick$={() => loadSample('current')}>载入示例包（基准一致）</button>
            <button class="button ghost small" onClick$={() => loadSample('diverged')}>载入示例包（基准偏离）</button>
            <label class="file-button">选择包文件<input type="file" accept=".json" onChange$={(event, element) => receiveFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea package-textarea" value={receiveRaw.value} onInput$={(event) => { receiveRaw.value = (event.target as HTMLTextAreaElement).value; receiveError.value = ''; }} placeholder='{"packageId":"CR-2026-...","baseVersion":0,"items":[{"recordId":"a-001","op":"upsert","fields":{ ... }}]}' />
          {receiveText.value && <div class="file-name">已读取：{receiveText.value}</div>}
          {receiveError.value && <div class="receive-error">{receiveError.value}</div>}
          <Modal.Footer class="modal-footer">
            <Modal.Close class="button ghost">取消</Modal.Close>
            <button class="button primary" disabled={!receiveRaw.value.trim()} onClick$={ingestRevision}>投递修订包</button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId);
            const right = recordById(state, activeMatch.value!.rightId);
            if (!left || !right) return <Modal.Description class="modal-description">关联记录已被修订包移除，无法合并。</Modal.Description>;
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
