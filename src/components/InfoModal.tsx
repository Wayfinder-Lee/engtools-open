import { useEffect, useState } from 'react';
import { SITE } from '../data/site';
import { CHANGELOG, hasUnseenChangelog, markChangelogSeen } from '../data/changelog';
import './InfoModal.css';

/**
 * 站级信息弹层（W5 信任与沟通基础设施）：隐私与数据说明 / 用户协议 / 更新日志 / 反馈。
 * 无路由，落地页与登录态页脚各挂一个 <InfoModalHost />，任意处 openInfoModal(section) 打开。
 */

export type InfoSection = 'privacy' | 'terms' | 'changelog' | 'feedback';

let _open: ((s: InfoSection) => void) | null = null;

/** 任意位置打开信息弹层（如错误条上的「反馈此问题」）。 */
export function openInfoModal(section: InfoSection = 'privacy') {
  _open?.(section);
}

/** 当前是否有未读更新（侧栏红点用）。 */
export { hasUnseenChangelog };

// ── 弹层状态变更广播（侧栏「更新日志」红点即时消失用）──

const _changeListeners = new Set<() => void>();
function notifyChange() { _changeListeners.forEach((cb) => cb()); }

/** 订阅弹层状态变化（打开更新日志会标记已读），返回退订函数。 */
export function onInfoModalChange(cb: () => void): () => void {
  _changeListeners.add(cb);
  return () => { _changeListeners.delete(cb); };
}

const SECTIONS: { key: InfoSection; label: string }[] = [
  { key: 'privacy', label: '隐私与数据说明' },
  { key: 'terms', label: '用户协议' },
  { key: 'changelog', label: '更新日志' },
  { key: 'feedback', label: '反馈与联系' },
];

function PrivacyContent() {
  return (
    <div className="info-prose">
      <p><strong>最后更新：2026-09-22。</strong>本站面向教师提供备课材料生成工具，遵循最小化收集原则，说明如下：</p>
      <h4>1. 账号信息</h4>
      <p>注册仅需邮箱与密码。密码以加密哈希形式保存，本站无法看到原文；不收集真实姓名、手机号。</p>
      <h4>2. 你粘贴 / 上传的内容</h4>
      <p>试卷文本、作文题干等仅用于生成你请求的材料，<strong>不用于广告、不对外提供</strong>。生成结果（词汇表、学案、排版试卷）仅保存在<strong>你自己浏览器的本机存储</strong>中，本站服务器不保存。</p>
      <h4>3. 手写照片（个性化学案 / 试卷视觉识别）</h4>
      <p>仅当你主动上传（含「扫码拍照上传」）时才发生。照片经本站服务器转发至具备视觉能力的模型服务商处理，<strong>属于跨境传输</strong>；照片只用于当次识别，本站不将其用于其他用途、不做公开展示。通过「扫码拍照上传」的照片会在本站服务器<strong>临时保存</strong>：仅登录的任务创建者本人可查看，点「完成并清理」立即删除，未手动结束时最长 24 小时后自动清除；任务本身不与任何学生姓名关联。上传前请确认已获得学生（或家长）同意，必要时可先遮挡姓名再拍摄。</p>
      <h4>4. 本机存储与统计</h4>
      <p>登录状态、历史记录等保存在浏览器 localStorage，清除浏览器数据即消失。本站使用匿名事件统计（如「注册完成」「首次导出」次数）用于改进产品，<strong>统计不含任何你输入的内容</strong>。</p>
      <h4>5. 注销账号</h4>
      <p>可随时在顶栏「额度充值」面板选择「注销账号」，账号与关联数据将被删除且不可恢复；如入口不可用，请通过「反馈与联系」人工处理。</p>
    </div>
  );
}

function TermsContent() {
  return (
    <div className="info-prose">
      <p><strong>最后更新：2026-09-20。</strong>注册或使用本站即表示你同意以下条款：</p>
      <h4>1. 额度</h4>
      <p>「额度」是本站生成功能的站内计费单位，按次消耗，具体标价见各工具生成按钮。注册赠送的免费额度与兑换码充值的额度均<strong>仅限本站使用、不可转让、不可提现</strong>。生成失败的部分自动退回，不重复扣费。</p>
      <h4>2. 兑换码与购买</h4>
      <p>兑换码通过淘宝商品页购买（自动发货），价格、发货与售后规则以淘宝商品页展示为准；付款后凭收到的兑换码在本站「额度充值」输入即可到账。</p>
      <h4>3. 使用规范</h4>
      <p>本站生成的内容供教学备课使用，AI 生成结果可能存在错误，<strong>请在分发给学生前人工核对</strong>。不得利用本站生成违反法律法规或侵犯他人权利的内容。上传含他人（含学生）个人信息的材料前，请确认已获得对方或监护人同意。</p>
      <h4>4. 服务可用性</h4>
      <p>本站依赖第三方模型服务，偶有限流或不可用属正常情况。因不可抗力导致的服务中断，本站在能力范围内补偿受影响的付费额度。</p>
      <h4>5. 条款变更</h4>
      <p>条款如有重大变更，将通过站内更新日志公告。</p>
    </div>
  );
}

function ChangelogContent() {
  return (
    <div className="info-prose">
      {CHANGELOG.map((entry) => (
        <div key={entry.version} className="info-changelog-entry">
          <h4>{entry.version} <span className="info-changelog-date">{entry.date}</span></h4>
          <ul>
            {entry.items.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function FeedbackContent() {
  return (
    <div className="info-prose">
      <p>遇到报错、额度异常，或想要新功能？欢迎反馈：</p>
      <ul>
        {SITE.feedbackEmail && (
          <li>邮箱：<a href={`mailto:${SITE.feedbackEmail}`}>{SITE.feedbackEmail}</a>（说明使用的工具与大概操作步骤即可）</li>
        )}
        {!SITE.feedbackEmail && <li>{SITE.feedbackHint}</li>}
        <li>报错时可以点错误条上的「反馈此问题」，会自动带上所在工具与错误类型（不含你的输入内容）。</li>
      </ul>
    </div>
  );
}

export default function InfoModalHost() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<InfoSection>('privacy');
  const [, setTick] = useState(0);

  useEffect(() => {
    _open = (s: InfoSection) => { setSection(s); setOpen(true); };
    return () => { _open = null; };
  }, []);

  // 打开更新日志即清除红点（写存储后广播给订阅方——侧栏红点立刻消失）
  useEffect(() => {
    if (open && section === 'changelog') {
      markChangelogSeen();
      setTick((t) => t + 1);
      notifyChange();
    }
  }, [open, section]);

  if (!open) return null;

  return (
    <div className="info-overlay" onClick={() => setOpen(false)}>
      <div className="info-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="站点信息">
        <div className="info-side">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={`info-nav-item ${section === s.key ? 'active' : ''}`}
              onClick={() => setSection(s.key)}
            >
              {s.label}
              {s.key === 'changelog' && hasUnseenChangelog() && <span className="info-dot" />}
            </button>
          ))}
        </div>
        <div className="info-body">
          <div className="info-body-head">
            <h3>{SECTIONS.find((s) => s.key === section)?.label}</h3>
            <button className="info-close" onClick={() => setOpen(false)} aria-label="关闭">✕</button>
          </div>
          {section === 'privacy' && <PrivacyContent />}
          {section === 'terms' && <TermsContent />}
          {section === 'changelog' && <ChangelogContent />}
          {section === 'feedback' && <FeedbackContent />}
        </div>
      </div>
    </div>
  );
}
