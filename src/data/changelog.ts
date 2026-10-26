/** 应用内更新日志（W5）：每条写「用户获得了什么」，付费用户的价值感知渠道。 */

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '2.4.0',
    date: '2026-10-23',
    items: [
      '全新「听力音频剪辑」：导入音频拖选即剪、可插静音与模板音频，变速不变调，导出 MP3——听力材料制作一站完成',
      '听力剪辑新增「合成语音」：输入文字即可生成男 / 女声播报（三档语速），一键插入时间线',
      '界面改版：全新左侧边栏导航，主页常驻、可图钉固定；「更新日志」「隐私与协议」入口移至侧栏底部',
      '个性化学案：学生名单整批先入列（识别期间即可见），学案卡片支持删除、按备注重新生成',
      '保存的历史自动起名：「最近生成」按标题展示，一眼认出每份学案',
    ],
  },
  {
    version: '2.3.0',
    date: '2026-10-16',
    items: [
      '全新「主页」：登录后一进来就是使用看板——余额、本月/累计消耗、各工具生成统计一目了然',
      '额度消费热力图：日 / 周 / 月三种粒度切换，哪天用了多少额度一眼看清',
      '「最近生成」：最近 10 条学案在主页一键打开（自动恢复）或直接导出 Word / PDF / PPT / CSV，不必再进工具翻历史记录',
      '「我的账户」新增「额度明细」：每笔充值、赠送、使用都有流水可查，支持筛选与导出 CSV',
      '历史兑换码自动补入明细，老账户的充值记录也能看到',
    ],
  },
  {
    version: '2.2.0',
    date: '2026-09-20',
    items: [
      '生成按钮直接标注消耗额度，余额不足提前提醒，不再被弹窗打断',
      '常见报错翻译成中文，失败后可一键重试、一键反馈',
      '各工具新增「用示例试一试」，新用户几分钟就能看到第一份成品',
      '新增隐私与数据说明、用户协议、更新日志与反馈入口',
      '试卷原文自动保存，浏览器存储空间不足时会明确提示',
      '手机上可以顺畅完成注册、兑换额度、查看历史',
    ],
  },
];

const SEEN_KEY = 'vb_changelog_seen';

export function latestVersion(): string {
  return CHANGELOG[0]?.version ?? '';
}

/** 是否有未读更新（侧栏「更新日志」红点用）。 */
export function hasUnseenChangelog(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== latestVersion();
  } catch {
    return true;
  }
}

export function markChangelogSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, latestVersion());
  } catch {
    // ignore
  }
}
