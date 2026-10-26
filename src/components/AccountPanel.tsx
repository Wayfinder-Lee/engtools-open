import { useEffect, useRef, useState } from 'react';
import type { Session } from '../types';
import { apiRedeem, apiMe } from '../services/api';
import { SITE } from '../data/site';
import { track } from '../utils/analytics';
import { Icon } from './icons';
import './AccountPanel.css';

/**
 * 顶栏账号区：剩余额度 + 额度充值（兑换码 / 淘宝购买）。
 * 购买入口开关与链接在 src/data/site.ts 统一配置；更新日志与隐私协议入口在左侧边栏底部。
 */

let _openRecharge: (() => void) | null = null;

/** 供额度引导卡等处打开充值下拉（如 CostGate 的「去充值」）。 */
export function openRechargePanel() {
  _openRecharge?.();
}

/** 兑换码字母数字位数上限（ENGT 前缀 + 16 位码体；显示长度 23，含 3 条横线）。 */
const CODE_CHARS_MAX = 20;

/**
 * 兑换码输入规范化：NFKC 全角转半角（中文输入法按出的字母/横线）→ 大写 →
 * 剔除非字母数字 → 每 4 位自动补横线。
 * 粘贴带横线/小写/空格的完整码同样归位（受控输入 onChange 覆盖粘贴场景）。
 * Web 无法强制手机调出英文键盘，全角归一 + 自动大写即等效结果。
 */
function formatCode(raw: string): string {
  const chars = raw.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_CHARS_MAX);
  return chars.replace(/(.{4})(?=.)/g, '$1-');
}

interface Props {
  session: Session;
  /** 额度变化时通知父组件更新（兑换、刷新后） */
  onQuotaChange: (quota: number) => void;
}

export default function AccountPanel({ session, onQuotaChange }: Props) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    _openRecharge = () => setOpen(true);
    return () => { _openRecharge = null; };
  }, []);

  // 点击外部 / 按 Esc 关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleRedeem = async () => {
    const c = code.trim().toUpperCase();
    if (!c) { setMsg({ type: 'err', text: '请输入兑换码' }); return; }
    setLoading(true); setMsg(null);
    try {
      const { credits, quota } = await apiRedeem(session.token, c);
      onQuotaChange(quota);
      track('redeem_success');
      setCode('');
      setMsg({ type: 'ok', text: `兑换成功，+${credits} 额度` });
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '兑换失败' });
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    try {
      const { quota } = await apiMe(session.token);
      onQuotaChange(quota);
    } catch { /* 忽略刷新失败 */ }
  };

  const low = session.quota < SITE.lowQuotaThreshold;

  return (
    <div className="account-cluster" ref={wrapRef}>
      <div
        className={`quota-chip ${low ? 'low' : ''}`}
        title={`1 额度 ≈ 一次生成（具体标价见各工具按钮）。余额低于 ${SITE.lowQuotaThreshold} 时此处的数字会变色提醒。`}
      >
        <span className="quota-label">剩余额度</span>
        <span className="quota-value">{session.quota}</span>
        <button className="quota-refresh" onClick={handleRefresh} title="刷新额度"><Icon name="refresh" size={14} /></button>
      </div>
      <div className="recharge-wrap">
        <button
          className="recharge-btn"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          额度充值
        </button>
        {open && (
          <div className="recharge-pop">
            <div className="redeem-row">
              <input
                className="redeem-input"
                value={code}
                onChange={(e) => setCode(formatCode(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    // 中文输入法组合中的 Enter 是「确认候选词」，不触发兑换
                    if (!e.nativeEvent.isComposing) handleRedeem();
                    return;
                  }
                  if (e.key !== 'Backspace' || !code) return;
                  // 光标紧贴自动插入的横线时，连横线前的码字符一起删——
                  // 否则横线被删掉后 formatter 立刻补回，用户这一下退格等于白按
                  const el = e.currentTarget;
                  const start = el.selectionStart;
                  if (start == null || start !== el.selectionEnd || start < 2 || code[start - 1] !== '-') return;
                  e.preventDefault();
                  setCode(formatCode(code.slice(0, start - 2) + code.slice(start)));
                  requestAnimationFrame(() => el.setSelectionRange(start - 2, start - 2));
                }}
                placeholder="输入或粘贴兑换码"
                disabled={loading}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="redeem-btn" onClick={handleRedeem} disabled={loading}>
                {loading ? '兑换中…' : '兑换'}
              </button>
            </div>
            {SITE.purchaseEnabled ? (
              <div className="buy-box">
                {SITE.purchaseQr && (
                  <div className="buy-qr-wrap">
                    <img
                      className="buy-qr"
                      src={SITE.purchaseQr}
                      alt="淘宝扫码购买兑换码"
                      width={92}
                      height={92}
                    />
                    <span className="buy-qr-tip">请用淘宝扫码</span>
                  </div>
                )}
                <div className="buy-info">
                  <span className="buy-title">淘宝下单 · 自动发货</span>
                  <span className="buy-note">付款后兑换码自动发送，回来输入即到账</span>
                  <a
                    className="buy-link"
                    href={SITE.purchaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => track('purchase_click')}
                  >
                    打开淘宝商品页 →
                  </a>
                </div>
              </div>
            ) : (
              <span className="buy-closed">在线购买暂未开放（认证办理中），兑换码请联系管理员获取</span>
            )}
            {msg && <span className={`redeem-msg ${msg.type}`}>{msg.text}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
