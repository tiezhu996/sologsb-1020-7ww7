import type { RevisionPackage } from '../types';

/**
 * 示例包 A：基准 v3，与本地库当前基准一致。
 * 涵盖：自动修订（无差异）、字段冲突待选择、全新记录、本地已偏离基准字段四种情形。
 */
export const samplePackageAligned: RevisionPackage = {
  packageId: 'CR-2026-09-V3',
  origin: '中心库·离线修订通道',
  issuedAt: '2026-09-28T02:00:00.000Z',
  baselineVersion: 'v3',
  targetVersion: 'v3.1',
  items: [
    {
      key: 'item-01',
      matchIdentifier: 'OH-LXZ-2019-01',
      title: '李秀珍口述史访谈',
      date: '2019-04-12',
      people: ['李秀珍', '周明远'],
      places: ['临河县', '河口村'],
      identifier: 'OH-LXZ-2019-01',
      medium: '数字录音（中心库复核版）',
      extent: '02:14:38',
      rights: '研究者授权',
      notes: '访谈共三个音频文件',
      baseline: {
        medium: '数字录音',
        extent: '02:14:38',
        notes: '访谈共三个音频文件'
      },
      note: '载体描述按中心库规范更新'
    },
    {
      key: 'item-02',
      matchIdentifier: 'OH-ZHL-2020-04',
      title: '张惠兰与县立女子中学',
      date: '2020-11-08',
      people: ['张惠兰'],
      places: ['临河县', '县立女子中学'],
      identifier: 'OH-ZHL-2020-04',
      rights: '研究者授权（授权书已补登 2026-08）',
      notes: '授权文件已归档，编号 R-2026-114',
      baseline: {
        rights: '未签授权文件',
        places: ['临河县'],
        notes: '需补充授权确认'
      },
      note: '授权状态变更；本地可能已做过核对处理'
    },
    {
      key: 'item-03',
      matchIdentifier: 'OH-YQF-2018-A',
      title: '赤水河盐运档案访谈（上）',
      date: '2018-02-15',
      people: ['杨启富'],
      places: ['赤水镇'],
      identifier: 'OH-YQF-2018-A',
      medium: '数字录音',
      extent: '01:10:00',
      rights: '研究者授权',
      notes: '',
      baseline: {
        title: '赤水河盐运档案访谈（上）',
        date: '2018-02-15',
        people: ['杨启富'],
        places: ['赤水镇'],
        identifier: 'OH-YQF-2018-A',
        medium: '数字录音',
        extent: '01:10:00',
        rights: '研究者授权'
      },
      note: '例行复核，无内容变更'
    },
    {
      key: 'item-04',
      title: '织锦艺人梁素芬口述',
      date: '2010-03-27',
      people: ['梁素芬', '访谈整理：何立群'],
      places: ['锦屏乡', '老街染坊'],
      identifier: 'OH-LSF-2010-02',
      medium: '数字录音',
      extent: '01:32:09',
      rights: '家属授权',
      notes: '新征集，本地库尚无同名记录',
      note: '中心库新征集条目'
    },
    {
      key: 'item-05',
      matchIdentifier: 'MS-HYL-2013',
      title: '女书传人何玉莲唱本',
      date: '2013-05-18',
      people: ['何玉莲'],
      places: ['上江乡'],
      identifier: 'MS-HYL-2013',
      extent: '42页',
      notes: '第12页已由家属提供补页扫描（2026-07 补入）',
      baseline: {
        extent: '42页',
        notes: '缺第12页'
      },
      note: '缺页状态更新：基准值仍是“缺第12页”，如本地已登记补页请核对员确认'
    }
  ]
};

/** 示例包 B：基准 v2 —— 本地已经在 v3，整包属于基准版本偏离，所有结论默认挂起 */
export const samplePackageDiverged: RevisionPackage = {
  packageId: 'CR-2026-10-V2REPLAY',
  origin: '中心库·离线修订通道（补发）',
  issuedAt: '2026-10-02T06:30:00.000Z',
  baselineVersion: 'v2',
  targetVersion: 'v2.1',
  items: [
    {
      key: 'item-01',
      matchIdentifier: 'OH-LXZ-2019-01',
      title: '李秀珍口述史访谈',
      date: '2019-04-12',
      people: ['李秀珍', '周明远'],
      places: ['临河县', '河口村'],
      identifier: 'OH-LXZ-2019-01',
      rights: '仅限研究使用',
      baseline: { rights: '研究者授权' },
      note: '这是基于旧基准 v2 的补发包，入库前请核对每一条结论'
    },
    {
      key: 'item-02',
      matchIdentifier: 'CRAFT-CGS-2015',
      title: '木版年画艺人陈桂生',
      date: '2015-06-21',
      people: ['陈桂生'],
      places: ['桃花乡'],
      identifier: 'CRAFT-CGS-2015',
      medium: 'DV录像',
      extent: '86分钟',
      rights: 'CC BY-NC 4.0',
      notes: '记录了套色过程',
      baseline: {
        title: '木版年画艺人陈桂生',
        date: '2015-06-21',
        people: ['陈桂生'],
        places: ['桃花乡'],
        identifier: 'CRAFT-CGS-2015',
        medium: 'DV录像',
        extent: '86分钟',
        rights: 'CC BY-NC 4.0',
        notes: '记录了套色过程'
      },
      note: '字段本身无差异，但包基准版本已偏离，仍需确认'
    },
    {
      key: 'item-03',
      title: '失传达斡尔族民歌采录（乌珠尔）',
      date: '2009-08-16',
      people: ['鄂文芳'],
      places: ['莫力达瓦', '腾克镇'],
      identifier: 'OH-EWF-2009-07',
      medium: '盒式磁带转存',
      extent: '00:48:55',
      rights: '公版',
      notes: '基准偏离包中的新增条目，同样需要核对员确认后才能入库'
    }
  ]
};
