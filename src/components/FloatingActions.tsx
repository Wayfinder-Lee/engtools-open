import { useState, useEffect, useCallback } from 'react';
import './FloatingActions.css';

// ── Callback registry ──────────────────────────────

let _onSave: (() => void) | null = null;
let _onHistory: (() => void) | null = null;

/** Active component registers its handlers here. Pass null to unregister. */
export function setFabCallbacks(onSave: (() => void) | null, onHistory: (() => void) | null) {
  _onSave = onSave;
  _onHistory = onHistory;
}

// ── Component ──────────────────────────────────────

interface Props { show: boolean; docActions?: boolean; }

export default function FloatingActions({ show, docActions = true }: Props) {
  const [showTop, setShowTop] = useState(false);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > window.innerHeight);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  if (!show) return null;

  return (
    <div className="fab-container">
      {showTop && (
        <button className="fab-btn" onClick={scrollTop} title="回到顶部" aria-label="回到顶部">
          <svg viewBox="0 0 24 24"><path d="M12 4l-8 8h5v8h6v-8h5z" /></svg>
          <span className="fab-label">回到顶部</span>
        </button>
      )}
      {docActions && (
        <>
          <button className="fab-btn" onClick={() => _onSave?.()} title="保存结果" aria-label="保存结果">
            <svg viewBox="0 0 24 24"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zM12 19a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z" /></svg>
            <span className="fab-label">保存结果</span>
          </button>
          <button className="fab-btn" onClick={() => _onHistory?.()} title="历史记录" aria-label="历史记录">
            <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm0 2v5.5l3.5 2-1 1.7L10 12V6h2z" /></svg>
            <span className="fab-label">历史记录</span>
          </button>
        </>
      )}
    </div>
  );
}
