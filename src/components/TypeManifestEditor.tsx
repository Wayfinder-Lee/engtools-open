/**
 * 题型清单编辑器：解析前点选本卷包含的大题题型与顺序（软先验，
 * 供大纲切块与逐块解析 prompt 参考，并供题型比对守卫使用）。
 * 左列题型池（默认 + 备选 + 自定义输入，自定义记忆到 localStorage），
 * 右列已选题型（指针拖拽排序 + ▲▼ + ✕）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { Stage } from '../types';
import { defaultManifest, loadCustomTypes, manifestPalette, rememberCustomType } from '../utils/examManifest';
import './TypeManifestEditor.css';

interface Props {
  stage: Stage;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export default function TypeManifestEditor({ stage, value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(true);
  const [customInput, setCustomInput] = useState('');
  const [customs, setCustoms] = useState<string[]>(() => loadCustomTypes());
  const [dragActive, setDragActive] = useState(false);
  const listId = useId();
  /** 拖拽起始下标；pointer capture 在拖拽手柄上，move/up 事件都从手柄走 */
  const dragFrom = useRef<number | null>(null);
  /** 拖拽指针归属：多点触控（教室一体机/平板）下第二根手指不得劫持或复位第一根的拖拽 */
  const activePointer = useRef<number | null>(null);
  const chipRefs = useRef<(HTMLDivElement | null)[]>([]);

  const palette = manifestPalette(stage, customs);
  const selectedSet = new Set(value);
  const pool = palette.filter((t) => !selectedSet.has(t));
  const stageDefault = defaultManifest(stage);
  const isDefault = value.length === stageDefault.length && value.every((t, i) => t === stageDefault[i]);
  const summary = value.length === 0
    ? '未选择（自由识别）'
    : isDefault ? `已选 ${value.length} 项（${stage === 'junior' ? '中考' : '高考'}默认）` : `已选 ${value.length} 项`;

  const addType = (t: string) => {
    if (disabled || !t || value.includes(t)) return;
    onChange([...value, t]);
  };
  const addCustom = () => {
    const t = customInput.trim();
    if (!t || disabled) return;
    if (!palette.includes(t) && !customs.includes(t)) {
      setCustoms((prev) => [...prev, t]);
      rememberCustomType(t);
    }
    addType(t);
    setCustomInput('');
  };
  const move = (i: number, dir: -1 | 1) => {
    if (disabled) return;
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i: number) => {
    if (disabled) return;
    onChange(value.filter((_, j) => j !== i));
  };

  // 指针拖拽排序：capture 挂在整块 chip 上（换位时 React 只移动 DOM 不重建，capture 大概率存活；
  // 万一因 DOM 重排丢失，指针在块内移动仍能继续驱动排序）；move 时按指针 Y 找目标位，实时换位
  const onHandleDown = (e: React.PointerEvent<HTMLSpanElement>, i: number) => {
    if (disabled || value.length < 2) return;
    if (e.button !== 0) return; // 仅主键起拖：右键/中键按下不是拖拽意图
    if (activePointer.current !== null && activePointer.current !== e.pointerId) return; // 已有指针在拖
    const chip = chipRefs.current[i];
    if (!chip) return;
    e.preventDefault();
    chip.setPointerCapture(e.pointerId);
    activePointer.current = e.pointerId;
    dragFrom.current = i;
    setDragActive(true);
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.buttons === 0) return; // 拖拽中途转禁用/无按键悬停都不得改序
    if (activePointer.current !== e.pointerId) return;
    const from = dragFrom.current;
    if (from === null || from >= value.length) return;
    const chips = chipRefs.current;
    // 拖出列表底部时钳到末位：chips 尾部可能有已删除元素的陈旧 null 槽，不能裸取 chips.length-1
    let target = Math.min(chips.length - 1, value.length - 1);
    for (let j = 0; j < chips.length; j++) {
      const r = chips[j]?.getBoundingClientRect();
      if (r && e.clientY < r.top + r.height / 2) { target = j; break; }
    }
    if (target !== from) {
      const next = [...value];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      onChange(next);
      dragFrom.current = target;
    }
  };
  const resetDrag = () => {
    dragFrom.current = null;
    activePointer.current = null;
    setDragActive(false);
  };
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== null && activePointer.current !== e.pointerId) return;
    resetDrag();
  };

  // 拖拽兜底：capture 意外丢失（DOM 重排/标签页切换）时，全局 pointerup/pointercancel 仍能复位拖拽态
  useEffect(() => {
    if (!dragActive) return;
    const stop = (e: PointerEvent) => { if (activePointer.current === e.pointerId) resetDrag(); };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragActive]);

  // 删除元素后 React 只把对应 ref 槽置 null、不缩数组：按当前长度截掉尾部陈旧槽
  useEffect(() => { chipRefs.current.length = value.length; }, [value]);

  return (
    <div className={`tme-card ${disabled ? 'tme-disabled' : ''}`}>
      <button type="button" className={`tme-header ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)}
        aria-expanded={open} disabled={disabled}>
        <span className="tme-caret">▶</span>
        <span className="tme-title">题型清单（辅助识别）</span>
        <span className="tme-summary">{summary}</span>
      </button>
      {open && (
        <div className="tme-body">
          <div className="tme-col">
            <div className="tme-col-label">题型栏（点击加入右侧）</div>
            <div className="tme-pool">
              {pool.map((t) => (
                <button key={t} type="button" className="tme-pool-chip" disabled={disabled}
                  onClick={() => addType(t)}>+ {t}</button>
              ))}
              {pool.length === 0 && <span className="tme-pool-empty">题型已全部加入右侧</span>}
            </div>
            <div className="tme-custom-row">
              <input className="tme-custom-input" list={listId} value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  // isComposing 拦大多数输入法选字确认；keyCode 229 兜底 Safari（其 compositionend 先于 keydown）
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                placeholder="手动输入其他题型…"
                disabled={disabled} />
              <datalist id={listId}>
                {palette.map((t) => <option key={t} value={t} />)}
              </datalist>
              <button type="button" className="tme-mini" onClick={addCustom}
                disabled={disabled || !customInput.trim()}>添加</button>
            </div>
          </div>
          <div className="tme-col">
            <div className="tme-col-label">已选题型（拖拽 ⠿ 或 ▲▼ 排序，顺序即卷面顺序）</div>
            <div className="tme-list">
              {/* key 用题型名（清单无重复）：换位时 DOM 节点移动而非重建，拖拽手柄的 pointer capture 不中断 */}
              {value.map((t, i) => (
                <div key={t} ref={(el) => { chipRefs.current[i] = el; }}
                  className={`tme-chip ${dragActive ? 'tme-chip-live' : ''}`}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  onPointerCancel={onHandleUp}>
                  <span className="tme-grip" title="拖拽排序"
                    onPointerDown={(e) => onHandleDown(e, i)}>⠿</span>
                  <span className="tme-idx">{i + 1}</span>
                  <span className="tme-name">{t}</span>
                  <span className="tme-ops">
                    <button type="button" className="tme-op" onClick={() => move(i, -1)} disabled={disabled || i === 0}>▲</button>
                    <button type="button" className="tme-op" onClick={() => move(i, 1)} disabled={disabled || i === value.length - 1}>▼</button>
                    <button type="button" className="tme-op" onClick={() => remove(i)} disabled={disabled}>✕</button>
                  </span>
                </div>
              ))}
              {value.length === 0 && (
                <span className="tme-empty">空清单 = 不提供题型先验，按原文自由识别</span>
              )}
            </div>
            <div className="tme-footer">
              <button type="button" className="tme-mini" onClick={() => onChange(defaultManifest(stage))} disabled={disabled}>
                恢复默认
              </button>
              <button type="button" className="tme-mini" onClick={() => onChange([])} disabled={disabled || value.length === 0}>
                清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
