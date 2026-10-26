import { useCallback, useEffect, useState } from 'react';
import type { ModuleKey, Session, Stage } from '../types';
import { apiUsageSummary } from '../services/api';
import type { UsageSummary } from '../services/api';
import type { SidebarTab } from './Sidebar';
import { Icon } from './icons';
import UsageDashboard from './UsageDashboard';
import RecentPanel from './RecentPanel';
import './UsageStats.css';

/**
 * 主页 tab：登录用户落地的使用看板 + 工具卡（数据统计与最近生成之间的快捷入口，
 * 标签/图标/顺序与侧栏同源——App 传入 visibleTabs）+ 「最近生成」面板（跨模块
 * vb_history_*，支持直达恢复与直接导出）。游客 / 自带 key 用户显示注册引导（无服务端流水可看）。
 */

interface Props {
  session: Session | null;
  stage: Stage;
  /** 工具卡数据源 = 侧栏 visibleTabs（已按学段过滤/改名），保证两处入口同词同序 */
  tools: SidebarTab[];
  /** 打开「我的账户」并直落额度明细分区（App 注入） */
  onOpenLedger: () => void;
  /** 「最近生成 → 打开」：登记交接并切到目标工具 tab（App 注入，含 junior 续写守卫） */
  onOpenItem: (module: ModuleKey, id: string) => void;
  /** 工具卡点击 → 切到对应 tab（App 注入，复用侧栏选择逻辑） */
  onOpenTool: (tab: SidebarTab['key']) => void;
}

/** 各工具一句话说明（输入 → 产出），标签由侧栏 TABS 同源下发 */
const TOOL_DESC: Record<string, string> = {
  vocab: '粘贴试卷原文，提取核心词汇，一键导出词条学案与自测卷',
  wordbank: '管理跨工具共享词库，多选生成检测题、默写卷与字帖内容',
  practical: '输入作文题目，生成范文精讲、话题词汇句式、模板与听写的成套学案',
  continuation: '粘贴故事原文，生成续写范文与人物、情节、十句法精讲',
  handwriting: '拍照收集学生作文，人手一份个性化学案，附班级讲评报告',
  exampaper: '上传试卷 Word，AI 解析重排，导出规整试卷',
  copybook: '输入词句生成四线三格字帖，打印即练',
  audio: '波形剪辑拼接、变速不变调，支持一键合成朗读语音',
};

export default function HomeTab({ session, stage, tools, onOpenLedger, onOpenItem, onOpenTool }: Props) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(!!session);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setErr('');
    try {
      setSummary(await apiUsageSummary(session.token));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '统计加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  // 工具卡 = 侧栏工具（去掉主页），学段过滤/改名已由 App 的 visibleTabs 完成
  const toolCards = tools.filter((t) => t.key !== 'home');

  return (
    <div className="home-tab">
      {err && (
        <div className="us-error-card">
          <p>{err}</p>
          <button type="button" className="us-mini-btn" onClick={load} disabled={loading}>重试</button>
        </div>
      )}

      {session ? (
        <>
          <div className="us-toolbar">
            <button type="button" className="us-mini-btn" onClick={load} disabled={loading}>
              {loading ? '刷新中…' : '刷新统计'}
            </button>
          </div>
          <UsageDashboard summary={summary} loading={loading} onOpenLedger={onOpenLedger} />
        </>
      ) : (
        <div className="us-guest-card">
          <h4>使用看板需要登录</h4>
          <p>看板展示你的额度使用明细：各工具生成统计、每日消费热力图与趋势。回到首页注册 / 登录后即可查看。</p>
        </div>
      )}

      {/* 工具卡：一句话说明每个工具是什么（侧栏只承担「认出并进入」，主页承担「解释」） */}
      <section className="us-section">
        <div className="us-section-head">
          <h4 className="us-h4">教学工具</h4>
        </div>
        <div className="ht-tools">
          {toolCards.map((t) => (
            <button key={t.key} type="button" className="ht-tool" onClick={() => onOpenTool(t.key)}>
              <span className="ht-tool-icon"><Icon name={t.icon} size={20} /></span>
              <span className="ht-tool-text">
                <span className="ht-tool-name">{t.label}</span>
                <span className="ht-tool-desc">{TOOL_DESC[t.key]}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* 「最近生成」：跨模块最近记录，直达恢复 / 直接导出 */}
      <RecentPanel stage={stage} onOpenItem={onOpenItem} />
    </div>
  );
}
