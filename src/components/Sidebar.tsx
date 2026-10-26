/**
 * 左侧导航栏（Sidebar）—— 仿苹果设置的固定侧栏，替代原顶部 tab 胶囊条。
 *
 * 三种形态：
 * - docked（驻留）：主页恒驻；或用户点了图钉固定后在工具页保持展开。
 *   侧栏本身 position: fixed，内容平移由 App.css 的 .app-main-column margin-left
 *   过渡完成 —— 绝不能给内容列加 transform/overflow，否则 sf- 吸顶体系会断。
 * - overlay（浮层）：工具页未固定时，悬停左缘热区 peek、或点 header 的
 *   侧栏按钮显式展开。浮层盖在内容上（带投影），不推内容。
 * - 窄屏（≤768px）：一律浮层抽屉 + 半透明背板，无 docked、不显示图钉。
 *
 * 悬停 peek 是组件局部 state：进出热区不触发 App 重渲染（App 下挂着整棵
 * 工具树，重渲染代价大）。显式 open/close 归 App 管。
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Tab } from '../App';
import { Icon, type IconName } from './icons';
import { openInfoModal, onInfoModalChange, hasUnseenChangelog } from './InfoModal';
import './Sidebar.css';

export interface SidebarTab {
  key: Tab;
  label: string;
  icon: IconName;
  /** 所属教学环节组（主页为空）：侧栏按它插组标，相邻同名组才成组 */
  group?: string;
}

interface Props {
  tabs: SidebarTab[];
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  /** 图钉：固定后进入工具页侧栏也不收起（localStorage 持久化在 App 侧） */
  pinned: boolean;
  onTogglePin: () => void;
  /** 显式展开（浮层）：点 header 侧栏按钮 / 热区单击触发 */
  open: boolean;
  docked: boolean;
  isNarrow: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export default function Sidebar(p: Props) {
  const [hoverPeek, setHoverPeek] = useState(false);
  const timer = useRef<number | null>(null);
  const asideRef = useRef<HTMLElement>(null);

  const visible = p.docked || p.open || hoverPeek;
  const overlay = visible && !p.docked;

  const clearTimer = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const enterHotzone = () => {
    clearTimer();
    setHoverPeek(true);
  };
  const leaveHotzone = () => {
    clearTimer();
    setHoverPeek(false);
  };
  // 离开侧栏本体：peek 延时收起（容错鼠标贴边抖动）；重进即取消
  const leaveAside = () => {
    clearTimer();
    timer.current = window.setTimeout(() => setHoverPeek(false), 200);
  };

  // Escape 关闭浮层（peek 优先收 peek）
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (hoverPeek) setHoverPeek(false);
      else p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, hoverPeek, p]);

  // 「更新日志」红点：弹层打开标记已读后立刻消失（订阅 InfoModal 的状态广播）
  const [, setChangelogTick] = useState(0);
  useEffect(() => onInfoModalChange(() => setChangelogTick((t) => t + 1)), []);

  // 显式展开时把焦点移进导航（键盘可达）；peek / docked 不抢焦点
  useEffect(() => {
    if (p.open) asideRef.current?.focus();
  }, [p.open]);

  // 按连续同名组分段（TABS 已保证同组相邻）：主页无组 = 裸项，其余每组一个同底色棱线分区容器
  const sections: { group?: string; items: SidebarTab[] }[] = [];
  for (const t of p.tabs) {
    const last = sections[sections.length - 1];
    if (last && last.group === t.group) last.items.push(t);
    else sections.push({ group: t.group, items: [t] });
  }

  const renderItem = (t: SidebarTab) => (
    <button
      type="button"
      key={t.key}
      className={`sb-item ${p.activeTab === t.key ? 'active' : ''}`}
      aria-current={p.activeTab === t.key ? 'page' : undefined}
      onClick={() => p.onSelect(t.key)}
    >
      <Icon name={t.icon} size={22} />
      <span className="sb-label">{t.label}</span>
    </button>
  );

  return (
    <>
      {!visible && (
        <div
          className="sb-hotzone"
          aria-hidden="true"
          onMouseEnter={enterHotzone}
          onMouseLeave={leaveHotzone}
          onClick={p.onOpen}
        />
      )}
      {p.isNarrow && overlay && <div className="sb-backdrop" onClick={p.onClose} />}
      <aside
        id="app-sidebar"
        ref={asideRef}
        tabIndex={-1}
        className={[
          'sb',
          visible ? 'sb--open' : '',
          p.docked ? 'sb--docked' : 'sb--overlay',
        ].filter(Boolean).join(' ')}
        onMouseEnter={clearTimer}
        onMouseLeave={leaveAside}
      >
        <div className="sb-head">
          <button type="button" className="sb-brand" onClick={() => p.onSelect('home')} title="回到主页">
            <span className="sb-title">英语教师工具箱</span>
          </button>
          <span className="sb-head-actions">
            {!p.isNarrow && (
              <button
                type="button"
                className={`sb-icon-btn ${p.pinned ? 'active' : ''}`}
                onClick={p.onTogglePin}
                aria-pressed={p.pinned}
                title={p.pinned ? '取消固定：进入工具时侧栏自动收起' : '固定侧栏：进入工具时保持展开'}
              >
                <Icon name={p.pinned ? 'pinFilled' : 'pin'} size={16} />
              </button>
            )}
            {overlay && (
              <button type="button" className="sb-icon-btn" onClick={() => { leaveHotzone(); p.onClose(); }} aria-label="收起导航">
                <Icon name="close" size={16} />
              </button>
            )}
          </span>
        </div>
        <nav className="sb-nav" aria-label="功能导航">
          {sections.map((s, i) => {
            const prev = i > 0 ? sections[i - 1] : undefined;
            if (!s.group) return <Fragment key="home">{s.items.map(renderItem)}</Fragment>;
            return (
              <Fragment key={s.group}>
                {/* 主页与功能板块之间的分割线 */}
                {!prev?.group && <div className="sb-sep" role="separator" aria-hidden="true" />}
                <div className="sb-group" role="group" aria-label={s.group}>
                  <div className="sb-group-label">{s.group}</div>
                  {s.items.map(renderItem)}
                </div>
              </Fragment>
            );
          })}
        </nav>
        <div className="sb-foot">
          <button
            type="button"
            className="sb-item sb-item--info"
            onClick={() => openInfoModal('changelog')}
          >
            <Icon name="history" size={22} />
            <span className="sb-label">
              更新日志
              {hasUnseenChangelog() && <span className="sb-dot" aria-hidden="true" />}
            </span>
          </button>
          <button
            type="button"
            className="sb-item sb-item--info"
            onClick={() => openInfoModal('privacy')}
          >
            <Icon name="shield" size={22} />
            <span className="sb-label">隐私与协议</span>
          </button>
        </div>
      </aside>
    </>
  );
}
