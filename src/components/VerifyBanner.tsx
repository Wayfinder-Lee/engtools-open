import { useEffect, useRef, useState } from 'react';
import type { Session } from '../types';
import { apiSendVerifyCode, apiVerifyEmail } from '../services/api';
import { Icon } from './icons';
import './VerifyBanner.css';

/**
 * 邮箱验证横幅（M6 邮箱验证后置）：未验证账号可正常生成（游客级额度），
 * 验证后补发正式赠送额度并解锁兑换码充值。
 */
interface Props {
  session: Session;
  /** 验证成功：父组件更新额度与 emailVerified */
  onVerified: (quota: number) => void;
}

export default function VerifyBanner({ session, onVerified }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  if (session.emailVerified || dismissed) return null;

  const startCountdown = () => {
    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) { if (timerRef.current) clearInterval(timerRef.current); return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSend = async () => {
    if (countdown > 0) return;
    setLoading(true); setMsg(null);
    try {
      await apiSendVerifyCode(session.email, 'verify');
      startCountdown();
      setMsg({ type: 'ok', text: '验证码已发送，请查收邮箱（含垃圾箱）' });
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '发送失败' });
    } finally { setLoading(false); }
  };

  const handleVerify = async () => {
    if (!code.trim()) { setMsg({ type: 'err', text: '请输入验证码' }); return; }
    setLoading(true); setMsg(null);
    try {
      const { quota } = await apiVerifyEmail(session.token, code.trim());
      setMsg({ type: 'ok', text: '验证成功！' });
      onVerified(quota);
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '验证失败' });
    } finally { setLoading(false); }
  };

  return (
    <div className="verify-banner" role="status">
      <span className="verify-banner-text">
        <Icon name="mail" size={16} /> 邮箱还未验证：验证后解锁正式赠送额度与兑换码充值（当前为体验额度，生成不受影响）。
      </span>
      <div className="verify-banner-actions">
        <input
          className="verify-banner-input"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="6 位验证码"
          inputMode="numeric"
          autoComplete="one-time-code"
          disabled={loading}
          onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
        />
        <button className="verify-banner-btn" onClick={handleSend} disabled={countdown > 0 || loading}>
          {countdown > 0 ? `${countdown}s` : '发送验证码'}
        </button>
        <button className="verify-banner-btn primary" onClick={handleVerify} disabled={loading}>验证</button>
        <button className="verify-banner-close" aria-label="稍后再验证" onClick={() => setDismissed(true)}>✕</button>
      </div>
      {msg && <span className={`verify-banner-msg ${msg.type}`}>{msg.text}</span>}
    </div>
  );
}
