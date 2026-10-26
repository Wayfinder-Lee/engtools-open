import { useCallback, useEffect, useRef, useState } from 'react';
import './StageFlow.css';

// ─── Types ──────────────────────────────────────────

/** 阶段条目：done = 已完成（✓），busy = 进行中，ready = 可用（如「可导出」） */
export interface FlowStageInfo {
  id: string;
  label: string;
  done?: boolean;
  busy?: boolean;
  ready?: boolean;
  /** 状态小字，如「已识别 3/5」 */
  sub?: string;
}

/** 目录条目：depth 0 = 阶段，depth 1 = 阶段内条目（如学生）；parentId 指向所属阶段锚点 */
export interface TocEntry {
  id: string;
  label: string;
  depth?: 0 | 1;
  parentId?: string;
  status?: 'done' | 'busy' | 'error';
  statusText?: string;
}

// ─── useScrollspy ───────────────────────────────────

/**
 * 滚动联动高亮（IntersectionObserver 顶部带方案）：
 * 观察视口内 [topOffset, 30vh] 的横向带，取「ids 顺序（= 文档顺序）中
 * 最后一个与该带相交的锚点」为激活项。用 IO 而非 scroll 监听，是因为
 * 本页布局会在不滚动时变化（阶段收起/展开、学生卡片流式加入），
 * IO 会在相交状态变化时自动回调。ids 必须只含当前已渲染的锚点
 * （阶段收起时其子锚点不渲染，应由调用方过滤掉）。
 */
export function useScrollspy(ids: string[], topOffset = 104): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const key = ids.join('|');
  useEffect(() => {
    const list = key ? key.split('|') : [];
    if (list.length === 0) {
      activeRef.current = null;
      setActiveId(prev => (prev === null ? prev : null));
      return;
    }
    const els = list
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const visible = new Set<string>();
    const pick = () => {
      let next: string | null = null;
      for (const id of list) if (visible.has(id)) next = id;
      // 带内无任何锚点（落在间隙）时保留上一次激活项
      if (next && next !== activeRef.current) {
        activeRef.current = next;
        setActiveId(next);
      }
    };
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      pick();
    }, { rootMargin: `-${topOffset}px 0px -70% 0px`, threshold: 0 });
    els.forEach(el => io.observe(el));
    // observe 后 IO 会异步上报初始状态，pick 随之执行
    return () => io.disconnect();
  }, [key, topOffset]);
  return activeId;
}

// ─── useStageFlow：阶段展开/收起 + 锚点滚动原语 ──────

/**
 * 各阶段展开状态的共享原语。跳转语义（如先展开所属阶段、打开 <details>）
 * 由页面组合这些原语实现；setOpenStages 一并暴露给「前进时收起前面阶段」
 * 这类自定义集合操作。
 */
export function useStageFlow<S extends string>(initialOpen: S[]) {
  const [openStages, setOpenStages] = useState<Set<S>>(() => new Set(initialOpen));
  const toggleStage = useCallback((id: S) => {
    setOpenStages(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  /** 展开某阶段，不动其他阶段 */
  const openStage = useCallback((id: S) => {
    setOpenStages(prev => { if (prev.has(id)) return prev; const n = new Set(prev); n.add(id); return n; });
  }, []);
  /** 双 rAF 后执行：等 React 提交（阶段展开改变布局）后再滚动到锚点 */
  const scrollToId = useCallback((domId: string) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById(domId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }, []);
  return { openStages, setOpenStages, toggleStage, openStage, scrollToId };
}

// ─── StageStepper：横向 ①→②→③→④ 流程条 ────────────

export function StageStepper({ stages, activeId, onJump }: {
  stages: FlowStageInfo[];
  activeId: string | null;
  onJump: (id: string) => void;
}) {
  return (
    <div className="sf-stepper">
      {stages.map((s, i) => {
        const state = s.busy ? 'busy' : s.done ? 'done' : s.ready ? 'ready' : 'todo';
        const last = i >= stages.length - 1;
        return (
          <div key={s.id} className={`sf-step-group ${last ? 'last' : ''}`}>
            <button type="button" className={`sf-step ${state} ${activeId === s.id ? 'active' : ''}`}
              onClick={() => onJump(s.id)} title={s.sub ? `${s.label} · ${s.sub}` : s.label}>
              <span className="sf-step-num">{s.done ? '✓' : i + 1}</span>
              <span className="sf-step-text">
                <span className="sf-step-label">{s.label}</span>
                {s.sub && <span className="sf-step-sub">{s.sub}</span>}
              </span>
            </button>
            {!last && <span className={`sf-connector ${s.done || s.busy ? 'passed' : ''}`} />}
          </div>
        );
      })}
    </div>
  );
}

// ─── StageCard：单个阶段卡片（可收起，收起时显示摘要） ──

export function StageCard({ anchorId, index, title, done, busy, meta, summary, open, onToggle, children }: {
  anchorId: string;
  index: number;
  title: string;
  done?: boolean;
  busy?: boolean;
  /** 展开时标题右侧的元信息（如「应用文 · 高三」） */
  meta?: string;
  /** 收起时的一行摘要（如「5 名学生 · 已识别 5/5」） */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section id={anchorId} className={`sf-stage ${open ? 'open' : ''} ${done ? 'done' : ''} ${busy ? 'busy' : ''}`}>
      <button type="button" className="sf-stage-header" onClick={onToggle} aria-expanded={open}>
        <span className="sf-stage-num">{done ? '✓' : index}</span>
        <span className="sf-stage-title">{title}</span>
        <span className="sf-stage-meta">{open ? (meta || '') : (summary || '')}</span>
        <span className={`sf-chevron ${open ? 'open' : ''}`}>▾</span>
      </button>
      {open && <div className="sf-stage-body">{children}</div>}
    </section>
  );
}

// ─── StageToc：左侧跟随目录（滚动联动高亮） ──────────

export function StageToc({ title = '流程导航', items, activeId, onJump }: {
  title?: string;
  items: TocEntry[];
  activeId: string | null;
  onJump: (id: string) => void;
}) {
  // 子条目激活时，其所属阶段同时高亮
  const isActive = (it: TocEntry) =>
    activeId === it.id || (activeId != null && items.some(c => c.parentId === it.id && c.id === activeId));
  return (
    <nav className="sf-toc" aria-label="页面目录">
      <div className="sf-toc-title">{title}</div>
      <div className="sf-toc-list">
        {items.map(it => (
          <button key={it.id} type="button"
            className={`sf-toc-item depth-${it.depth ?? 0} ${isActive(it) ? 'active' : ''}`}
            onClick={() => onJump(it.id)}>
            <span className="sf-toc-label">{it.label}</span>
            {it.statusText && <span className={`sf-toc-status ${it.status || ''}`}>{it.statusText}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}
