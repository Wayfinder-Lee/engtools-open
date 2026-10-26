import { useState, useRef, useCallback, useEffect } from 'react';
import type { Session } from '../../types';
import { apiLogin, apiRegister, apiSendVerifyCode, apiResetPassword } from '../../services/api';
import { track } from '../../utils/analytics';
import './AuthCard.css';

interface Props {
  onLogin: (session: Session) => void;
}

type Mode = 'login' | 'register' | 'forgot' | 'reset';

export default function AuthCard({ onLogin }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [sendCountdown, setSendCountdown] = useState(0);
  const sendCountdownRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Clear countdown interval on unmount
  useEffect(() => () => clearInterval(sendCountdownRef.current), []);

  const startCountdown = useCallback(() => {
    setSendCountdown(60);
    sendCountdownRef.current = setInterval(() => {
      setSendCountdown((prev) => {
        if (prev <= 1) { clearInterval(sendCountdownRef.current); return 0; }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const handleSendCode = useCallback(async () => {
    const e = email.trim();
    if (!e) { setError('请先输入邮箱'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setError('邮箱格式不正确'); return; }
    setError('');
    try {
      await apiSendVerifyCode(e, mode === 'reset' || mode === 'forgot' ? 'reset' : 'register');
      startCountdown();
      if (mode === 'forgot') { setMode('reset'); setError(''); }
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    }
  }, [email, mode, startCountdown]);

  const handleSubmit = async () => {
    const e = email.trim();
    if (!e || !password) { setError('请输入邮箱和密码'); return; }
    if ((mode === 'register' || mode === 'reset') && password.length < 6) { setError('密码至少 6 位'); return; }
    if (mode === 'register' && password !== confirmPassword) { setError('两次密码不一致'); return; }
    if ((mode === 'reset') && !verifyCode.trim()) { setError('请输入验证码'); return; }
    setError(''); setSuccessMsg(''); setLoading(true);
    try {
      if (mode === 'login') {
        const session = await apiLogin(e, password);
        track('auth_success', 'login');
        onLogin(session);
      } else if (mode === 'register') {
        const session = await apiRegister(e, password);
        track('auth_success', 'register');
        onLogin(session);
      } else if (mode === 'reset') {
        await apiResetPassword(e, verifyCode.trim(), password);
        setSuccessMsg('密码已重置，请登录');
        setMode('login');
        setPassword(''); setConfirmPassword(''); setVerifyCode('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const switchTo = (m: Mode) => { setMode(m); setError(''); setSuccessMsg(''); };

  return (
    <div className="auth-card">
      {mode === 'forgot' || mode === 'reset' ? (
        <div className="auth-tabs">
          <span className="auth-tab active">{mode === 'forgot' ? '忘记密码' : '重置密码'}</span>
          <button className="auth-tab-link" onClick={() => switchTo('login')}>← 返回登录</button>
        </div>
      ) : (
        <div className="auth-tabs">
          <button className={`auth-tab ${mode === 'login' ? 'active' : ''}`} onClick={() => switchTo('login')}>登录</button>
          <button className={`auth-tab ${mode === 'register' ? 'active' : ''}`} onClick={() => switchTo('register')}>注册</button>
        </div>
      )}

      <div className="auth-form">
        <input
          type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          className="auth-input" disabled={loading} autoComplete="username"
        />

        {/* 验证码行（忘记密码/重置时显示；注册已改为免验证进入，验证后置） */}
        {(mode === 'forgot' || mode === 'reset') && (
          <div className="verify-row">
            <input
              type="text" value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={mode === 'forgot' ? '先点右边发码' : '6 位验证码'}
              className="auth-input verify-input" disabled={loading || mode === 'forgot'}
              autoComplete="one-time-code" inputMode="numeric"
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
            <button className="send-code-btn" onClick={handleSendCode}
              disabled={sendCountdown > 0 || loading} type="button"
            >
              {sendCountdown > 0 ? `${sendCountdown}s` : '发送验证码'}
            </button>
          </div>
        )}

        {/* 密码（登录/注册/重置都显示；忘记密码模式不显示） */}
        {mode !== 'forgot' && (
          <input
            type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'reset' ? '新密码（至少 6 位）' : mode === 'register' ? '设置密码（至少 6 位）' : '密码'}
            className="auth-input" disabled={loading}
            autoComplete={mode === 'register' || mode === 'reset' ? 'new-password' : 'current-password'}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        )}

        {/* 确认密码（仅注册时） */}
        {mode === 'register' && (
          <input
            type="password" value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="再次输入密码"
            className="auth-input" disabled={loading}
            autoComplete="new-password"
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        )}

        <button className="auth-btn" onClick={handleSubmit} disabled={loading}>
          {loading ? '请稍候…' : mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : mode === 'forgot' ? '下一步' : '重置密码'}
        </button>
        {successMsg && <p className="auth-success">{successMsg}</p>}
        {error && <p className="auth-error">{error}</p>}

        <p className="auth-hint">
          {mode === 'login' && (
            <>没有账号？点上方「<button type="button" className="link-inline" onClick={() => switchTo('register')}>注册</button>」，注册即送全功能免费使用额度。<br />
              <button type="button" className="link-inline" onClick={() => switchTo('forgot')}>忘记密码？</button></>
          )}
          {mode === 'register' && '注册即送体验额度，直接开始使用；进入后验证邮箱可解锁正式赠送额度与兑换。'}
          {mode === 'forgot' && '输入邮箱，点击发送验证码。'}
          {mode === 'reset' && '输入验证码和新密码完成重置。'}
        </p>
      </div>
    </div>
  );
}
