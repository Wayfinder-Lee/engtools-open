import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ApiConfig, ModuleKey, Session, Stage } from './types';
import { STAGE_OPTIONS } from './types';
import { loadApiConfig, saveApiConfig, clearApiConfig, loadStage, saveStage } from './utils/storage';
import { openHistoryItem } from './utils/historyHandoff';
import { loadSession, saveSession, clearSession, updateStoredQuota, isGuestMode, setGuestMode, loadGuestQuota, saveGuestQuota } from './utils/session';
import { apiMe, apiGuestMe } from './services/api';
import ApiConfigPanel from './components/ApiConfig';
import AccountPanel from './components/AccountPanel';
import VocabExtractor from './components/VocabExtractor';
import PracticalWriting from './components/PracticalWriting';
import ContinuationWriting from './components/ContinuationWriting';
import HomePage from './components/HomePage';
import HandwritingWorksheet from './components/HandwritingWorksheet';
import Copybook from './components/Copybook';
import ExamPaper from './components/ExamPaper';
import AudioEditor from './components/AudioEditor';
import WordBank from './components/WordBank';
import FloatingActions from './components/FloatingActions';
import InfoModalHost from './components/InfoModal';
import HomeTab from './components/HomeTab';
import VerifyBanner from './components/VerifyBanner';
import Sidebar, { type SidebarTab } from './components/Sidebar';
import { Icon, type IconName } from './components/icons';
import AccountModal from './components/AccountModal';
import type { AccountSection } from './components/AccountModal';
import ThemeToggle from './components/ThemeToggle';
import './App.css';

export type Tab = 'home' | 'vocab' | 'practical' | 'continuation' | 'handwriting' | 'copybook' | 'exampaper' | 'wordbank' | 'audio';

/** 窄屏分流提示（W9）：生成类工具建议电脑使用，手机可先兑换/查历史 */
function MobileHint({ show }: { show: boolean }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('vb_mobile_hint_dismissed') === '1');
  if (!show || dismissed) return null;
  return (
    <div className="mobile-hint" role="note">
      <span><Icon name="phone" size={14} /> 生成类工具建议在电脑上使用；手机上可先兑换额度、查看历史记录。</span>
      <button
        aria-label="关闭提示"
        onClick={() => { setDismissed(true); localStorage.setItem('vb_mobile_hint_dismissed', '1'); }}
      >✕</button>
    </div>
  );
}

// 侧栏按「教学环节」分组（NN/g：组名承载类目、条目名只说差异，扫读成本从 8 项降为 4 个组标）。
// group 顺序即 TABS 顺序，必须把同组的项排在一起；label 砍掉「制作/助手」等零信息后缀，区分词前置。
const TABS: { key: Tab; label: string; icon: IconName; group?: string }[] = [
  { key: 'home', label: '主页', icon: 'home' },
  { key: 'vocab', label: '试卷词汇提取', icon: 'vocab', group: '词汇教学' },
  { key: 'wordbank', label: '词汇学案', icon: 'wordbank', group: '词汇教学' },
  { key: 'practical', label: '应用文学案', icon: 'practical', group: '写作教学' },
  { key: 'continuation', label: '读后续写学案', icon: 'continuation', group: '写作教学' },
  { key: 'handwriting', label: '书面表达批改', icon: 'handwriting', group: '写作教学' },
  { key: 'exampaper', label: '试卷排版', icon: 'exampaper', group: '试卷整理' },
  { key: 'copybook', label: '衡水体字帖', icon: 'copybook', group: '课堂素材' },
  { key: 'audio', label: '听力音频剪辑', icon: 'audio', group: '课堂素材' },
];

function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [apiConfig, setApiConfig] = useState<ApiConfig>(loadApiConfig());
  // 自带 key 模式（开发者后门）：无需登录即可进入
  const [selfMode, setSelfMode] = useState(false);
  // M6 游客模式：免注册体验，按 IP 计体验额度
  const [guest, setGuest] = useState(() => !loadSession() && isGuestMode());
  const [guestQuota, setGuestQuota] = useState<number | null>(() => (isGuestMode() ? loadGuestQuota() : null));
  // 登录用户默认落「主页」看板；游客/自带 key 保持词汇提取
  const [activeTab, setActiveTab] = useState<Tab>(() => (loadSession() ? 'home' : 'vocab'));
  const [showApiConfig, setShowApiConfig] = useState(false);
  // 学段切换：初中模式隐藏读后续写，prompt 全部按中考标准生成
  const [stage, setStage] = useState<Stage>(loadStage);

  const handleStageChange = useCallback((s: Stage) => {
    setStage(s);
    saveStage(s);
    // 初中没有读后续写：切到初中时若停留在该 tab 则回到词汇提取
    if (s === 'junior') setActiveTab((t) => (t === 'continuation' ? 'vocab' : t));
  }, []);

  const inApp = !!session || selfMode || guest;
  /** 传给各工具的余额：登录用 session 额度，游客用体验额度；null = 自带 Key */
  const effectiveQuota = session ? session.quota : (guest ? guestQuota : null);
  // 「我的账户」弹窗（accountSection 支持从看板直落「额度明细」分区）
  const [showAccount, setShowAccount] = useState(false);
  const [accountSection, setAccountSection] = useState<AccountSection>('profile');
  const openAccount = useCallback((section: AccountSection) => {
    setAccountSection(section);
    setShowAccount(true);
  }, []);

  /** 主页「最近生成 → 打开」：登记交接并切到目标工具 tab。junior 无续写 tab，
   *  先守卫再登记——防止被拦后残留 pending，切回 senior 手动打开续写时静默消费旧记录 */
  const openHistoryFromHome = useCallback((module: ModuleKey, id: string) => {
    if (module === 'continuation' && stage === 'junior') return;
    openHistoryItem(module, id);
    setActiveTab(module as Tab);
  }, [stage]);
  // 窄屏检测（W9）：手机 = 生成工具降级提示 + 分流文案
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 左侧导航：图钉固定后进入工具页也保持展开；主页恒驻；窄屏一律浮层抽屉不 docked
  const [sidebarPinned, setSidebarPinned] = useState(
    () => localStorage.getItem('vocab_builder_sidebar_pinned') === '1',
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const docked = !isNarrow && (activeTab === 'home' || sidebarPinned);

  const togglePin = useCallback(() => {
    setSidebarPinned((prev) => {
      const next = !prev;
      localStorage.setItem('vocab_builder_sidebar_pinned', next ? '1' : '0');
      return next;
    });
    // 工具页取消固定 → 侧栏滑走（主页恒驻不受影响）
    if (sidebarPinned && activeTab !== 'home' && !isNarrow) setSidebarOpen(false);
  }, [sidebarPinned, activeTab, isNarrow]);

  const handleSidebarSelect = useCallback((tab: Tab) => {
    setActiveTab(tab);
    // 浮层里点选即消费关闭；docked（主页 / 已固定）不受影响
    setSidebarOpen(false);
  }, []);

  // junior 隐藏读后续写 + 书面表达改名（原顶部 tab-bar 的过滤逻辑，单一真源迁到此处）
  const visibleTabs: SidebarTab[] = useMemo(
    () =>
      TABS.filter((t) => !(stage === 'junior' && t.key === 'continuation')).map((t) => ({
        ...t,
        label: stage === 'junior' && t.key === 'practical' ? '书面表达学案' : t.label,
      })),
    [stage],
  );

  // 更新额度（兑换 / 刷新后）
  const handleQuotaChange = useCallback((quota: number) => {
    setSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, quota };
      saveSession(next);
      return next;
    });
  }, []);

  // 退出登录
  const handleLogout = useCallback(() => {
    clearSession();
    clearApiConfig();
    setSession(null);
    setApiConfig({ endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: '' });
    setSelfMode(false);
    setShowApiConfig(false);
    setGuestMode(false);
    setGuest(false);
    setGuestQuota(null);
  }, []);

  // 拉取最新额度；token 失效则登出
  const refreshQuota = useCallback(async () => {
    const s = loadSession();
    if (!s) return;
    try {
      const { quota, emailVerified } = await apiMe(s.token);
      updateStoredQuota(quota, emailVerified);
      setSession((prev) => (prev ? { ...prev, quota, emailVerified: emailVerified ?? prev.emailVerified } : prev));
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status?: number }).status === 401) {
        handleLogout();
      }
    }
  }, [handleLogout]);

  // 登录后 + 定时 + 窗口聚焦时刷新额度
  useEffect(() => {
    if (!session) return;
    refreshQuota();
    const timer = window.setInterval(refreshQuota, 30000);
    window.addEventListener('focus', refreshQuota);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshQuota);
    };
    // 仅依赖是否登录；refreshQuota 稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!session]);

  // 落地页登录/注册成功（session null → 有值）→ 自动进入「主页」看板；刷新恢复的会话不重复切
  const hadSessionRef = useRef(!!session);
  useEffect(() => {
    if (session && !hadSessionRef.current) {
      hadSessionRef.current = true;
      setActiveTab('home');
    } else if (!session) {
      hadSessionRef.current = false;
    }
  }, [session]);

  // 游客额度：登录后立刻拉 + 定时 + 窗口聚焦（与登录态额度同节奏）
  const refreshGuestQuota = useCallback(async () => {
    try {
      const { quota } = await apiGuestMe();
      saveGuestQuota(quota);
      setGuestQuota(quota);
    } catch { /* 忽略刷新失败 */ }
  }, []);

  useEffect(() => {
    if (!guest) return;
    refreshGuestQuota();
    const timer = window.setInterval(refreshGuestQuota, 30000);
    window.addEventListener('focus', refreshGuestQuota);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshGuestQuota);
    };
  }, [guest, refreshGuestQuota]);

  /** 落地页「免费试用」：进入游客模式 */
  const handleGuest = useCallback(() => {
    setGuestMode(true);
    setGuest(true);
    setGuestQuota(loadGuestQuota());
  }, []);

  const handleLogin = (s: Session) => {
    saveSession(s);
    setSession(s);
    setSelfMode(false);
    // 登录/注册成功即退出游客模式
    setGuestMode(false);
    setGuest(false);
  };

  const handleOwnApi = () => {
    setSelfMode(true);
    setShowApiConfig(true);
  };

  const handleSaveConfig = (config: ApiConfig) => {
    setApiConfig(config);
    saveApiConfig(config);
    setShowApiConfig(false);
  };

  if (!inApp) {
    return <HomePage onLogin={handleLogin} onOwnApi={handleOwnApi} onGuest={handleGuest} />;
  }

  return (
    <div className={`app ${docked ? 'app--sb-docked' : ''}`}>
      <Sidebar
        tabs={visibleTabs}
        activeTab={activeTab}
        onSelect={handleSidebarSelect}
        pinned={sidebarPinned}
        onTogglePin={togglePin}
        open={sidebarOpen}
        docked={docked}
        isNarrow={isNarrow}
        onOpen={() => setSidebarOpen(true)}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="app-main-column">
        <header className="app-header">
          <div className="header-brand">
            {!docked && (
              <button
                type="button"
                className="sb-toggle"
                onClick={() => setSidebarOpen(true)}
                aria-expanded={sidebarOpen}
                aria-controls="app-sidebar"
                title="打开导航"
              >
                <Icon name="sidebar" size={20} />
              </button>
            )}
            <h1>
              <button type="button" className="brand-home" onClick={() => setActiveTab('home')} title="回到主页">
                🛠️ English Teacher's Toolkit
              </button>
            </h1>
          </div>
          <span className="app-subtitle">
            {session ? `${session.email} · ` : guest ? '游客体验 · ' : '自带 API · '}英语教学材料准备工具箱
          </span>
          <div className="header-right">
            <div className="stage-switch" role="group" aria-label="学段切换">
              {STAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`stage-btn ${stage === opt.value ? 'active' : ''}`}
                  onClick={() => handleStageChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <ThemeToggle />
            {session && (
              <>
                <AccountPanel session={session} onQuotaChange={handleQuotaChange} />
                <button className="btn-logout" onClick={() => openAccount('profile')} title="账户信息 / 额度明细 / 修改密码">
                  我的账户
                </button>
              </>
            )}
            {guest && (
              <div className="quota-chip" title="免注册体验额度（按设备网络计），注册后可获得正式额度">
                <span className="quota-label">体验额度</span>
                <span className="quota-value">{guestQuota ?? '…'}</span>
              </div>
            )}
            <button className="btn-logout" onClick={handleLogout} title={guest ? '退出体验' : '退出登录'}>
              {guest ? '退出体验' : '退出'}
            </button>
          </div>
        </header>

        <div className="app-body">
          {selfMode && !session && (
            <ApiConfigPanel config={apiConfig} onSave={handleSaveConfig} forceOpen={showApiConfig} />
          )}

          <MobileHint show={inApp && isNarrow} />

          {session && (
            <VerifyBanner
              session={session}
              onVerified={(quota) => {
                const s = loadSession();
                if (s) {
                  const next = { ...s, quota, emailVerified: true };
                  saveSession(next);
                  setSession(next);
                }
              }}
            />
          )}

          <main className="tab-content">
            {activeTab === 'home' && (
              <HomeTab
                session={session}
                stage={stage}
                tools={visibleTabs}
                onOpenLedger={() => openAccount('ledger')}
                onOpenItem={openHistoryFromHome}
                onOpenTool={handleSidebarSelect}
              />
            )}
            {activeTab === 'vocab' && <VocabExtractor apiConfig={apiConfig} stage={stage} quota={effectiveQuota} />}
            {activeTab === 'practical' && <PracticalWriting apiConfig={apiConfig} stage={stage} quota={effectiveQuota} />}
            {activeTab === 'continuation' && stage === 'senior' && <ContinuationWriting apiConfig={apiConfig} quota={effectiveQuota} />}
            {activeTab === 'handwriting' && <HandwritingWorksheet apiConfig={apiConfig} stage={stage} quota={effectiveQuota} />}
            {activeTab === 'copybook' && <Copybook apiConfig={apiConfig} stage={stage} quota={effectiveQuota} />}
            {activeTab === 'exampaper' && <ExamPaper apiConfig={apiConfig} stage={stage} quota={effectiveQuota} />}
            {activeTab === 'wordbank' && (
              <WordBank apiConfig={apiConfig} stage={stage} quota={effectiveQuota} onGoCopybook={() => setActiveTab('copybook')} />
            )}
            {activeTab === 'audio' && <AudioEditor />}
          </main>
        </div>
      </div>

      <FloatingActions show={inApp} docActions={activeTab !== 'home' && activeTab !== 'wordbank' && activeTab !== 'audio'} />
      <InfoModalHost />
      {showAccount && session && (
        <AccountModal
          session={session}
          stage={stage}
          initialSection={accountSection}
          onStageChange={handleStageChange}
          onAccountDeleted={handleLogout}
          onClose={() => setShowAccount(false)}
        />
      )}
    </div>
  );
}

export default App;
