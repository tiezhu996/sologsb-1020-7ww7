import type { RevisionPackage } from '../types';

/**
 * 演示修订包 1：基准与本地一致（baseVersion = 0）。
 * - 对 a-001 / b-003 / b-005 下发与本地逐字段不一致的修订 → 挂起冲突，裁决前不入库
 * - a-007 与本地逐项一致 → 记为 unchanged，不触碰记录
 * - 下发一条本地不存在的新记录 c-101 → 自动新增，字段来源标记为修订包
 * - 重复投递本包时，已处理项按编号去重，冲突选择保留
 */
export const samplePackageCurrent: RevisionPackage = {
  packageId: 'CR-2026-1006-A',
  source: '中心库批次 2026-10-06',
  baseVersion: 0,
  issuedAt: '2026-10-06T01:00:00.000Z',
  items: [
    {
      recordId: 'a-001',
      op: 'upsert',
      reason: '中心库按题名规范与时长核订',
      fields: {
        title: '李秀珍口述史访谈记录（核订题名）',
        medium: 'WAV 数字录音',
        extent: '02:14:41',
        notes: '访谈共三个音频文件，第三段开头有 3 秒空白'
      }
    },
    {
      recordId: 'b-003',
      op: 'upsert',
      reason: '授权状态更新并补权利说明',
      fields: {
        rights: '已签署研究使用授权书',
        notes: '授权书扫描件已归档，内容涉及女子中学创建'
      }
    },
    {
      recordId: 'b-005',
      op: 'upsert',
      reason: '中心库在已有备注上追加采访批次说明（与本地不一致，需裁决）',
      fields: {
        notes: '元数据人员补充了地点“盐仓”；与 OH-2018-049 同批采访'
      }
    },
    {
      recordId: 'a-007',
      op: 'upsert',
      reason: '中心库重发的核验快照，与本地逐项一致（演示重投/无变化去重）',
      fields: {
        title: '铁路建设者赵春生采访',
        date: '2021-07-09',
        people: ['赵春生'],
        places: ['北岭市'],
        identifier: 'OH-ZCS-2021'
      }
    },
    {
      recordId: 'c-101',
      op: 'upsert',
      reason: '中心库新增的口述史采集记录',
      fields: {
        title: '临河县供销社职工座谈记录',
        date: '2022-03-19',
        people: ['马文斌', '孙丽华'],
        places: ['临河县', '供销社旧址'],
        identifier: 'OH-CRB-2022-014',
        medium: '数字录音',
        extent: '01:38:09',
        rights: '研究者授权',
        notes: '座谈由县档案馆组织'
      }
    }
  ]
};

/**
 * 演示修订包 2：基准偏离（baseVersion = 3，本地基准尚未到达）。
 * 未决冲突必须照常显示，并以“基准偏离”警示核对员：裁决基于过期快照。
 */
export const samplePackageDiverged: RevisionPackage = {
  packageId: 'CR-2026-1006-B',
  source: '中心库回灌批次（旧通道补发）',
  baseVersion: 3,
  issuedAt: '2026-10-05T22:30:00.000Z',
  items: [
    {
      recordId: 'a-004',
      op: 'upsert',
      reason: '老通道补发的年画工艺核订，注意与现行版本可能偏离',
      fields: {
        title: '木版年画艺人陈桂生访谈全录',
        date: '2015-06-21',
        medium: 'MiniDV 录像',
        extent: '87分钟'
      }
    },
    {
      recordId: 'b-008',
      op: 'delete',
      reason: '中心库旧清单认为该扫描件应并入 MANU-HYL 主记录'
    }
  ]
};
