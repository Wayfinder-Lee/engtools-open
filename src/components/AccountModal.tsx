import { useState } from 'react';
import type { Session, Stage } from '../types';
import { STAGE_OPTIONS } from '../types';
import { apiChangePassword, apiDeleteAccount } from '../services/api';
import { SITE } from '../data/site';
import { track } from '../utils/analytics';
import UsageLedger from './UsageLedger';
import './AccountModal.css';

/**
 * 「我的账户」弹窗（风格对齐「隐私与数据说明」浮窗：左侧导航 + 右侧内容）。
 * 账户信息 / 额度明细 / 默认学段 / 修改密码 / 注销账号。
 */

export type AccountSection = 'profile' | 'ledger' | 'stage' | 'password' | 'danger';
type Section = AccountSection;

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'profile', label: '账户信息' },
  { key: 'ledger', label: '额度明细' },
  { key: 'stage', label: '默认学段' },
  { key: 'password', label: '修改密码' },
  { key: 'danger', label: '注销账号' },
];

interface Props {
  session: Session;
  /** 当前学段（默认学段设置的现状） */
  stage: Stage;
  /** 打开时直落的分区（看板「查看额度明细」入口用）；缺省账户信息 */
  initialSection?: AccountSection;
  onStageChange: (s: Stage) => void;
  /** 注销成功后由父组件清理本地状态并回到落地页 */
  onAccountDeleted: () => void;
  onClose: () => void;
}

export default function AccountModal({ session, stage, initialSection, onStageChange, onAccountDeleted, onClose }: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? 'profile');

  // 修改密码表单
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // 注销
  const [deleting, setDeleting] = useState(false);

  const handleChangePassword = async () => {
    if (pwdLoading) return;
    if (!oldPwd) { setPwdMsg({ type: 'err', text: '请输入当前密码' }); return; }
    if (newPwd.length < 6) { setPwdMsg({ type: 'err', text: '新密码至少 6 位' }); return; }
    if (newPwd !== confirmPwd) { setPwdMsg({ type: 'err', text: '两次输入的新密码不一致' }); return; }
    setPwdLoading(true); setPwdMsg(null);
    try {
      await apiChangePassword(session.token, oldPwd, newPwd);
      setPwdMsg({ type: 'ok', text: '密码已修改，下次登录请使用新密码' });
      setOldPwd(''); setNewPwd(''); setConfirmPwd('');
      track('password_changed');
    } catch (err) {
      setPwdMsg({ type: 'err', text: err instanceof Error ? err.message : '修改失败' });
    } finally { setPwdLoading(false); }
  };

  const handleDeleteAccount = async () => {
    if (deleting) return;
    if (!window.confirm('注销将删除账号与剩余额度，且不可恢复。确定继续？')) return;
    setDeleting(true);
    try {
      await apiDeleteAccount(session.token);
      track('account_deleted');
      onAccountDeleted();
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      window.alert(/失败 \(\d+\)|404|不存在/.test(m) ? '服务端暂不支持在线注销，请通过「反馈与联系」人工处理' : (m || '注销失败，请稍后重试'));
      setDeleting(false);
    }
  };

  return (
    <div className="info-overlay" onClick={onClose}>
      <div className="info-modal am-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="我的账户">
        <div className="info-side">
          {SECTIONS.map((s) => (
            <button key={s.key} className={`info-nav-item ${section === s.key ? 'active' : ''}`} onClick={() => setSection(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="info-body">
          <div className="info-body-head">
            <h3>{SECTIONS.find((x) => x.key === section)?.label}</h3>
            <button className="info-close" onClick={onClose} aria-label="关闭">✕</button>
          </div>

          {section === 'profile' && (
            <div className="info-prose">
              <table className="am-table">
                <tbody>
                  <tr><th>登录邮箱</th><td>{session.email}</td></tr>
                  <tr><th>当前额度</th><td><strong>{session.quota}</strong>（顶栏「额度充值」可兑换）</td></tr>
                  <tr><th>邮箱验证</th><td>{session.emailVerified ? '✅ 已验证' : '⚠️ 未验证——验证后解锁兑换与正式赠送额度（见顶栏横幅）'}</td></tr>
                </tbody>
              </table>
              <p className="am-note">你的学案历史与词库仅保存在本机浏览器；「历史记录 → 导出备份」可跨设备迁移。</p>
            </div>
          )}

          {section === 'ledger' && (
            <div className="info-prose">
              <UsageLedger session={session} />
            </div>
          )}

          {section === 'stage' && (
            <div className="info-prose">
              <p>设置打开网站时默认使用的学段（生成内容会按学段标准输出）：</p>
              <div className="stage-switch am-stage-switch" role="group" aria-label="默认学段">
                {STAGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={`stage-btn ${stage === opt.value ? 'active' : ''}`}
                    onClick={() => onStageChange(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="am-note">{stage === 'junior'
                ? '初中模式：隐藏读后续写，词汇锚定课标三级（约 1600 词），书面表达按中考标准生成。'
                : '高中模式：六大工具全量可用，词汇按高考标准、写作按高考应用文/读后续写生成。'}（保存在本设备）</p>
            </div>
          )}

          {section === 'password' && (
            <div className="info-prose">
              <div className="am-form">
                <label>当前密码</label>
                <input type="password" value={oldPwd} autoComplete="current-password"
                  onChange={(e) => setOldPwd(e.target.value)} placeholder="输入当前密码" />
                <label>新密码（至少 6 位）</label>
                <input type="password" value={newPwd} autoComplete="new-password"
                  onChange={(e) => setNewPwd(e.target.value)} placeholder="设置新密码" />
                <label>确认新密码</label>
                <input type="password" value={confirmPwd} autoComplete="new-password"
                  onChange={(e) => setConfirmPwd(e.target.value)} placeholder="再次输入新密码"
                  onKeyDown={(e) => e.key === 'Enter' && handleChangePassword()} />
                <button className="am-btn" onClick={handleChangePassword} disabled={pwdLoading}>
                  {pwdLoading ? '提交中…' : '修改密码'}
                </button>
                {pwdMsg && <p className={`am-msg ${pwdMsg.type}`}>{pwdMsg.text}</p>}
              </div>
            </div>
          )}

          {section === 'danger' && (
            <div className="info-prose">
              <p><strong>注销账号不可恢复。</strong>将删除账号记录与剩余额度；本机的学案历史与词库不受影响，但你需自行保管。</p>
              <p className="am-note">如有额度纠纷或需要导出数据，请先通过「反馈与联系」（{SITE.feedbackEmail || SITE.feedbackHint}）联系我们。</p>
              <button className="am-btn am-btn-danger" onClick={handleDeleteAccount} disabled={deleting}>
                {deleting ? '注销中…' : '永久注销账号'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
