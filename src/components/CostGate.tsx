import { useCallback, useEffect, useRef, useState } from 'react';
import { SITE } from '../data/site';
import { isGuestMode, exitGuestMode } from '../utils/session';
import { openRechargePanel } from './AccountPanel';
import './CostGate.css';

/**
 * 额度确认门（W4 额度透明化）。生成动作前统一走 confirmSpend()：
 * - 自带 Key 模式（quota == null）：不扣站内额度，直接放行；
 * - 余额不足：弹「兑换引导卡」，不放行（替代原来点了才报 402 的死路体验）；
 * - cost ≤ smallCostThreshold：按钮上已常驻标价，直接放行，不再弹窗打断；
 * - 大额（如整班批量的个性化学案）：弹轻量确认卡（非 window.confirm，可排版、显示余额）。
 */

interface SpendRequest {
  cost: number;
  what: string;
  note?: string;
  insufficient: boolean;
  resolve: (ok: boolean) => void;
}

export function useCostGate(quota: number | null | undefined) {
  const [pending, setPending] = useState<SpendRequest | null>(null);
  const quotaRef = useRef(quota);
  quotaRef.current = quota ?? null;
  const guest = isGuestMode();

  useEffect(() => () => {
    // 卸载时未决请求按取消处理，避免调用方 await 悬挂
    setPending((p) => { p?.resolve(false); return null; });
  }, []);

  const confirmSpend = useCallback((cost: number, what: string, note?: string): Promise<boolean> => {
    const q = quotaRef.current;
    if (q == null) return Promise.resolve(true); // 自带 Key：不消耗站内额度
    const insufficient = q < cost;
    if (!insufficient && cost <= SITE.smallCostThreshold) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setPending({ cost, what, note, insufficient, resolve }));
  }, []);

  const costDialog = pending && (
    <div className="costgate-overlay" onClick={() => { pending.resolve(false); setPending(null); }}>
      <div className="costgate-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="额度确认">
        {pending.insufficient ? (
          <>
            <h4>额度不足</h4>
            {guest ? (
              <>
                <p className="costgate-what">{pending.what}需要 <strong>{pending.cost} 额度</strong>，本机体验额度已用完。</p>
                <p className="costgate-note">免费注册一个账号即可继续使用：注册再送体验额度，验证邮箱后解锁正式赠送额度与兑换。</p>
                <div className="costgate-actions">
                  <button className="costgate-btn" onClick={() => { pending.resolve(false); setPending(null); }}>知道了</button>
                  <button className="costgate-btn primary" onClick={() => { pending.resolve(false); setPending(null); exitGuestMode(); }}>
                    免费注册
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="costgate-what">{pending.what}需要 <strong>{pending.cost} 额度</strong>，当前余额 <strong>{quotaRef.current}</strong>。</p>
                {pending.note && <p className="costgate-note">{pending.note}</p>}
                <p className="costgate-note">
                  {SITE.purchaseEnabled
                    ? '可点顶栏「额度充值」前往购买，或输入兑换码充值。'
                    : '可点顶栏「额度充值」输入兑换码充值（在线购买暂未开放，兑换码请联系管理员获取）。'}
                </p>
                <div className="costgate-actions">
                  <button className="costgate-btn" onClick={() => { pending.resolve(false); setPending(null); }}>知道了</button>
                  <button className="costgate-btn primary" onClick={() => { pending.resolve(false); setPending(null); openRechargePanel(); }}>
                    去充值
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <h4>确认生成</h4>
            <p className="costgate-what">{pending.what}</p>
            <div className="costgate-rows">
              <span>本次预计消耗 <strong>{pending.cost} 额度</strong></span>
              <span>当前余额 <strong>{quotaRef.current}</strong>（失败自动退回）</span>
            </div>
            {pending.note && <p className="costgate-note">{pending.note}</p>}
            <div className="costgate-actions">
              <button className="costgate-btn" onClick={() => { pending.resolve(false); setPending(null); }}>取消</button>
              <button className="costgate-btn primary" onClick={() => { pending.resolve(true); setPending(null); }}>确定生成</button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return { confirmSpend, costDialog };
}
