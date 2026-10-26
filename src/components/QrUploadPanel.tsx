import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeMuTask, createMuTask, deleteMuPhoto, getMuPhotoData, getMuTask, getMuToken,
  muConflictData,
  type MuDesktopTask, type MuPhotoMeta,
} from '../services/mupload';
import { BLUR_THRESHOLD, BRIGHT_THRESHOLD } from '../m/quality';
import { Icon } from './icons';
import './QrUploadPanel.css';

/**
 * 扫码拍照上传（个性化学案 · 第②步内嵌）。
 * 老师在电脑端出二维码 → 自己的手机逐本拍 → 照片轮询出现在这里 → 勾选「识别所选」
 * 走现有 OCR 流水。任何设备扫码均可上传（2026-09-27 起不再单设备绑定）。
 *
 * 轮询用 setTimeout 链（上响应回来再排下一次，防弱网堆积）+ visibilitychange 暂停。
 * 二维码不给倒计时（免得老师紧张）：到期前静默自动续期（非破坏，同 tokenSeq），
 * token 只存内存，页面刷新恢复后由续期逻辑自动补取。
 * taskId 存 localStorage(hw_qr_task)：刷新页面经 GET /api/m/task 恢复面板；
 * 恢复失败（404/过期）明示「上次任务已结束」，不静默回 idle。
 */

const TASK_KEY = 'hw_qr_task';
const POLL_MS = 2500;
/** 到期剩多久时开始静默续期（须 > 续期 tick 间隔，失败还有下一轮机会）。 */
const RENEW_AHEAD_MS = 2 * 60 * 1000;
const RENEW_TICK_MS = 15 * 1000;

type Phase =
  | { kind: 'idle' }
  | { kind: 'gone'; which: 'expired' | 'closed' } // 恢复时发现上次任务已结束
  | { kind: 'active' };

interface Props {
  /** 识别进行中（禁用「识别所选」防重复扣费） */
  importBusy?: boolean;
  /** 勾选照片点「识别所选」→ 交给父组件走 OCR 流水（按 seq 升序）。
   *  返回 false = 父组件的额度确认被取消（此时不清空本地勾选）；其余视为已受理。 */
  onImport: (photos: { photoId: string; seq: number }[], tid: string) => void | boolean | Promise<boolean>;
}

export default function QrUploadPanel({ importBusy = false, onImport }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [expanded, setExpanded] = useState(false);
  const [task, setTask] = useState<MuDesktopTask | null>(null);
  const [photos, setPhotos] = useState<MuPhotoMeta[]>([]);
  const [token, setToken] = useState('');
  const [tokenExpiresAt, setTokenExpiresAt] = useState(0);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bigImg, setBigImg] = useState<{ photoId: string; url: string | null } | null>(null);

  const sinceRef = useRef(0);
  const thumbCache = useRef<Map<string, string>>(new Map());
  const bigCache = useRef<Map<string, string>>(new Map());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tidRef = useRef('');
  const activeRef = useRef(false);
  // 任务代数：恢复/beginTask/finishTask/卸载时自增——在途 pollNow 响应回来时代数已变，
  // 不得改写状态（否则旧任务的 closed 响应会删掉新任务的 localStorage 并杀死新轮询链）
  const genRef = useRef(0);
  const inflightRef = useRef(false); // pollNow single-flight：防定时器链与 visibilitychange 补拍并行出双链
  const thumbTried = useRef<Set<string>>(new Set()); // 服务端已尝试、确实无缩略图的行（makeThumb 失败），不再为它回拨 since
  const knownIds = useRef<Set<string>>(new Set()); // 已见过的 photoId：新到的照片自动勾选（只勾一次，手动取消不被下一轮轮询覆盖）

  const stopPolling = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
    activeRef.current = false;
  };

  /** 轮询一次并合并结果（增量协议：photos 全量，thumb 只随新行、单次 ≤12 张最旧优先）。 */
  const pollNow = useCallback(async () => {
    if (!tidRef.current || inflightRef.current) return;
    const gen = genRef.current;
    inflightRef.current = true;
    try {
      const r = await getMuTask(tidRef.current, sinceRef.current);
      if (gen !== genRef.current) return; // 任务已切换/结束：在途响应作废
      if (r.state === 'active' && r.task && r.photos) {
        const prevSince = sinceRef.current;
        for (const p of r.photos) {
          if (p.thumb) {
            thumbCache.current.set(p.photoId, p.thumb);
          } else if (p.seq > prevSince) {
            thumbTried.current.add(p.photoId); // 本轮已向服务端要过、确实没有缩略图
          }
        }
        // since 按「仍缺缩略图且未试过的行」回拨：服务端单次只补 12 张（最旧优先），
        // 落后端 ⌈n/12⌉ 轮收敛；若直接推到 max seq，被截断行的缩略图会永久缺失
        const missing = r.photos.filter((p) => !thumbCache.current.has(p.photoId) && !thumbTried.current.has(p.photoId));
        sinceRef.current = missing.length
          ? Math.min(...missing.map((p) => p.seq)) - 1
          : r.photos.reduce((m, p) => Math.max(m, p.seq), prevSince);
        // 新到的未识别照片默认勾选，老师核对后直接点「识别所选」（恢复任务时首轮全量视为新到）
        const fresh = r.photos.filter((p) => !knownIds.current.has(p.photoId) && !p.imported);
        for (const p of r.photos) knownIds.current.add(p.photoId);
        if (fresh.length) {
          setSelected((prev) => {
            const n = new Set(prev);
            for (const p of fresh) n.add(p.photoId);
            return n;
          });
        }
        setTask(r.task);
        setPhotos(r.photos);
        setError('');
      } else {
        // 已过期/已关闭（或被别处关闭）：照片已由服务端删除
        localStorage.removeItem(TASK_KEY);
        stopPolling();
        setTask(null);
        setPhotos([]);
        setPhase({ kind: 'gone', which: r.state === 'closed' ? 'closed' : 'expired' });
        setExpanded(true);
      }
    } catch (err: any) {
      if (gen !== genRef.current) return;
      if (err?.status === 404) {
        localStorage.removeItem(TASK_KEY);
        stopPolling();
        setPhase({ kind: 'gone', which: 'expired' });
        setExpanded(true);
        return;
      }
      if (err?.status === 401) {
        // 不停轮询会每 2.5s 打一次 401 直到天荒地老；保留 TASK_KEY，重新登录后刷新即可恢复
        stopPolling();
        setError('登录已过期，请重新登录后刷新本页即可恢复任务');
        return;
      }
      setError(err instanceof Error ? err.message : '轮询失败');
    } finally {
      inflightRef.current = false;
    }
  }, []);

  const schedulePoll = useCallback(() => {
    if (!activeRef.current || document.hidden) return; // 隐藏时不排：在途请求的续排也在这里被挡住
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
    pollTimer.current = setTimeout(async () => {
      pollTimer.current = null;
      await pollNow();
      schedulePoll();
    }, POLL_MS);
  }, [pollNow]);

  // 挂载：恢复上次任务（localStorage → 直接交给 pollNow：active 则续上，终态则翻 gone）
  useEffect(() => {
    const saved = localStorage.getItem(TASK_KEY);
    if (!saved) return;
    tidRef.current = saved;
    genRef.current += 1;
    thumbTried.current.clear();
    (async () => {
      activeRef.current = true;
      setPhase({ kind: 'active' });
      setExpanded(true);
      await pollNow(); // 非.active 结果会在此内部清理并切到 gone
      schedulePoll();
    })();
    return () => { genRef.current += 1; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 页面隐藏暂停轮询，回来立即补一拍
  useEffect(() => {
    const onVis = () => {
      if (!activeRef.current) return;
      if (document.hidden) {
        if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
      } else {
        // 先清 pending timer 再补拍：否则会与既有链并行出第二条自续排链，
        // 其中一条的 timer id 被覆盖丢失后永久脱离 stopPolling 管理
        if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
        void pollNow().then(schedulePoll);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [pollNow, schedulePoll]);

  // 二维码静默续期 tick（不给倒计时；15s 一查，到期前 2 分钟自动换新码）。
  // token 只存内存：页面刷新恢复后 token 为空，也由这里补取
  useEffect(() => {
    if (phase.kind !== 'active') return;
    const t = setInterval(() => setNow(Date.now()), RENEW_TICK_MS);
    return () => clearInterval(t);
  }, [phase.kind]);

  const renewingRef = useRef(false);
  useEffect(() => {
    if (phase.kind !== 'active' || !task || renewingRef.current) return;
    const expired = tokenExpiresAt > 0 && tokenExpiresAt - now < RENEW_AHEAD_MS;
    if (token && !expired) return; // 有码且离到期还远：不用动
    renewingRef.current = true;
    getMuToken(tidRef.current)
      .then((r) => {
        setToken(r.token);
        setTokenExpiresAt(Date.now() + r.expiresIn * 1000);
        setError('');
      })
      .catch((err: unknown) => {
        // 静默续期失败不弹错（下一 tick 自动重试）；直到过期才由掩层提示手动「重新出码」
        if (tokenExpiresAt > 0 && tokenExpiresAt <= Date.now()) {
          setError(err instanceof Error ? err.message : '二维码续期失败');
        }
      })
      .finally(() => { renewingRef.current = false; });
  }, [phase.kind, task, token, tokenExpiresAt, now]);

  // token 变化 → 重画二维码（动态 import，主包不含 qrcode）
  useEffect(() => {
    if (!token) { setQrDataUrl(''); return; }
    let dead = false;
    (async () => {
      try {
        const QR = await import('qrcode');
        // ⚠️ 路径必须与部署上传的对象 key 一致（/m/upload.html）：
        // 静态托管下无后缀的 /m/upload 是 404，也不会回落到本页（主站 SPA 不感知此路径）
        const url = `${window.location.origin}/m/upload.html?t=${encodeURIComponent(token)}`;
        const dataUrl = await QR.toDataURL(url, { margin: 2, width: 520, errorCorrectionLevel: 'M' });
        if (!dead) setQrDataUrl(dataUrl);
      } catch {
        if (!dead) setQrDataUrl('');
      }
    })();
    return () => { dead = true; };
  }, [token]);

  const beginTask = useCallback((r: { taskId: string; token: string; expiresIn: number; task: MuDesktopTask }) => {
    genRef.current += 1; // 旧任务（若有）的在途轮询响应就此作废
    localStorage.setItem(TASK_KEY, r.taskId);
    tidRef.current = r.taskId;
    sinceRef.current = 0;
    thumbCache.current.clear();
    thumbTried.current.clear();
    knownIds.current.clear();
    bigCache.current.clear();
    setPhotos([]);
    setSelected(new Set());
    setTask(r.task);
    setToken(r.token);
    setTokenExpiresAt(Date.now() + r.expiresIn * 1000);
    setPhase({ kind: 'active' });
    setExpanded(true);
    setNotice('');
    activeRef.current = true;
    schedulePoll();
  }, [schedulePoll]);

  /** 展开入口 → 建任务（409 = 已有进行中任务，确认后 force 建新删旧）。 */
  const startTask = useCallback(async () => {
    setError('');
    try {
      beginTask(await createMuTask(''));
    } catch (err: any) {
      if (err?.status === 409) {
        const d = muConflictData(err);
        const txt = `您已有一个进行中的扫码任务（${d.photoCount ?? 0} 张照片，其中 ${d.unimportedCount ?? 0} 张未识别）。创建新任务会删除旧任务的全部照片，继续？`;
        if (window.confirm(txt)) {
          try {
            beginTask(await createMuTask('', true));
          } catch (e2: any) {
            setError(e2 instanceof Error ? e2.message : '创建失败');
          }
        }
      } else {
        setError(err?.status === 401 ? '扫码上传需要登录后使用' : err instanceof Error ? err.message : '创建失败');
      }
    }
  }, [beginTask]);

  /** 15 分钟倒计时归零 → 非破坏性续期（同 tokenSeq，不断开手机）。 */
  const renewToken = useCallback(async () => {
    try {
      const r = await getMuToken(tidRef.current);
      setToken(r.token);
      setTokenExpiresAt(Date.now() + r.expiresIn * 1000);
      setError('');
    } catch (err: any) {
      setError(err instanceof Error ? err.message : '续期失败');
    }
  }, []);

  /** 清除所有：照片即焚并结束任务。有未识别照片时服务端 409 → 二次确认后 force。 */
  const finishTask = useCallback(async () => {
    try {
      await closeMuTask(tidRef.current);
    } catch (err: any) {
      if (err?.status !== 409) {
        setError(err instanceof Error ? err.message : '结束失败');
        return;
      }
      const n = muConflictData(err).unimportedCount ?? 0;
      if (!window.confirm(`还有 ${n} 张照片未识别，清除会立即删除它们并结束本次扫码任务。确定清除？`)) return;
      try {
        await closeMuTask(tidRef.current, true);
      } catch (e2: any) {
        setError(e2 instanceof Error ? e2.message : '结束失败');
        return;
      }
    }
    localStorage.removeItem(TASK_KEY);
    genRef.current += 1;
    stopPolling();
    thumbCache.current.clear();
    thumbTried.current.clear();
    bigCache.current.clear();
    setTask(null);
    setPhotos([]);
    setToken('');
    setSelected(new Set());
    setBigImg(null);
    setPhase({ kind: 'idle' });
    setExpanded(false);
    setNotice('任务已结束，服务器上的照片已删除。');
  }, []);

  const removePhoto = useCallback(async (photoId: string) => {
    if (!window.confirm('删除这张照片？')) return;
    try {
      await deleteMuPhoto(tidRef.current, photoId);
      setPhotos((prev) => prev.filter((p) => p.photoId !== photoId));
      setSelected((prev) => { const n = new Set(prev); n.delete(photoId); return n; });
      bigCache.current.delete(photoId);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  }, []);

  const openBig = useCallback(async (photoId: string) => {
    setBigImg({ photoId, url: bigCache.current.get(photoId) ?? null });
    try {
      if (!bigCache.current.has(photoId)) {
        const { dataUrl } = await getMuPhotoData(tidRef.current, photoId);
        if (bigCache.current.size >= 16) bigCache.current.clear(); // 内存缓存封顶
        bigCache.current.set(photoId, dataUrl);
      }
      setBigImg((cur) => (cur && cur.photoId === photoId ? { photoId, url: bigCache.current.get(photoId) ?? null } : cur));
    } catch {
      setBigImg((cur) => (cur && cur.photoId === photoId ? { photoId, url: null } : cur));
    }
  }, []);

  const toggleSelected = useCallback((photoId: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(photoId)) n.delete(photoId); else n.add(photoId);
      return n;
    });
  }, []);

  const importSelected = useCallback(() => {
    if (!task) return;
    const ordered = photos
      .filter((p) => selected.has(p.photoId) && !p.imported)
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({ photoId: p.photoId, seq: p.seq }));
    if (!ordered.length) return;
    // onImport 可能弹额度确认卡（确认前就同步挂起）；确认通过/受理才清空勾选，
    // 取消则保留——否则大额批量取消后要逐张重勾
    void Promise.resolve(onImport(ordered, task.taskId)).then((ok) => {
      if (ok !== false) setSelected(new Set());
    });
  }, [task, photos, selected, onImport]);

  // ─── 渲染 ───────────────────────────────────────

  if (phase.kind === 'gone') {
    return (
      <div className="qr-wrap">
        <div className="qr-gone">
          上次扫码任务已结束，服务器上的照片已删除。可重新扫码开启一个新任务。
          <button className="qr-btn qr-btn-sm" onClick={() => { setPhase({ kind: 'idle' }); setExpanded(false); }}>知道了</button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'idle' && !expanded) {
    return (
      <div className="qr-wrap">
        <button type="button" className="qr-entry" onClick={startTask} title="用手机拍照，照片直接传到电脑端">
          <Icon name="phone" size={16} /> 扫码拍照上传——用您自己的手机逐本拍摄学生作文，照片直接出现在这里（手机免登录）
        </button>
        {notice ? <div className="qr-notice">{notice}</div> : null}
        {error ? <div className="qr-error">{error}</div> : null}
      </div>
    );
  }

  if (phase.kind === 'idle' || !task) {
    // 恢复路径 phase 已是 active 而 task 尚为 null，也会落到这里——文案按场景区分，
    // 且必须把 error 渲染出来（否则非 404 恢复失败会被假 loading 永久吞掉）
    return (
      <div className="qr-wrap">
        <div className="qr-loading">{tidRef.current ? '正在恢复上次任务…' : '正在创建扫码任务…'}</div>
        {error ? <div className="qr-error">{error}</div> : null}
      </div>
    );
  }

  const tokenAlive = tokenExpiresAt > now;
  const display = [...photos].sort((a, b) => b.seq - a.seq); // seq 降序（最新在最前）
  const selectedCount = photos.filter((p) => selected.has(p.photoId) && !p.imported).length;
  const unimportedCount = photos.filter((p) => !p.imported).length;

  return (
    <div className="qr-wrap qr-active">
      <div className="qr-body">
        {/* 左：二维码 */}
        <div className="qr-left">
          <div className={`qr-img-box${tokenAlive ? '' : ' qr-expired'}`}>
            {qrDataUrl
              ? <img src={qrDataUrl} alt="扫码上传二维码" />
              : <div className="qr-loading">生成二维码…</div>}
            {!tokenAlive ? <div className="qr-expired-mask"><span>二维码已过期</span></div> : null}
          </div>
          <div className="qr-count">
            {tokenAlive
              ? <>手机扫码即可上传（二维码到期会自动更换，已连接的手机不受影响）</>
              : <>二维码已过期，请点「重新出码」（已连接的手机不受影响）</>}
          </div>
          {!tokenAlive
            ? (
              <div className="qr-left-btns">
                <button type="button" className="qr-btn qr-btn-sm" onClick={renewToken}>重新出码</button>
              </div>
            )
            : null}
          <div className="qr-hint">用微信扫一扫，或把此页投屏后用手机扫码。换手机（或多部手机）时，用新手机重新扫一次码即可。</div>
        </div>

        {/* 右：已收到的照片 */}
        <div className="qr-right">
          <div className="qr-right-head">
            <span className="qr-count-label">已收到 <b>{photos.length}</b> 张</span>
            {unimportedCount > 0 ? <span className="qr-dim">未识别 {unimportedCount}</span> : null}
            <span className="qr-spacer" />
            <button
              type="button"
              className="qr-btn qr-btn-sm"
              title="网络不佳没刷出新照片时，点此手动拉取一次"
              onClick={() => void pollNow()}
            >
              刷新接收
            </button>
            <button
              type="button"
              className="qr-btn qr-btn-primary qr-btn-sm"
              disabled={selectedCount === 0 || importBusy}
              onClick={importSelected}
            >
              识别所选{selectedCount > 0 ? `（${selectedCount} 张）` : ''}
            </button>
            <button type="button" className="qr-btn qr-btn-sm" onClick={finishTask}>清除所有</button>
          </div>

          {photos.length === 0 ? (
            <div className="qr-empty">等待照片…<br /><span>手机端每拍一张，2–3 秒内会出现在这里。</span></div>
          ) : (
            <div className="qr-grid">
              {display.map((p) => {
                const qBadges: string[] = [];
                if (p.bright && p.bright < BRIGHT_THRESHOLD) qBadges.push('暗');
                if (p.blur && p.blur < BLUR_THRESHOLD) qBadges.push('糊');
                const isSel = selected.has(p.photoId);
                return (
                  <div key={p.photoId} className={`qr-thumb${isSel ? ' sel' : ''}`}>
                    {thumbCache.current.get(p.photoId)
                      ? <img src={thumbCache.current.get(p.photoId)} alt={`第 ${p.seq} 张`} loading="lazy" />
                      : <div className="qr-thumb-loading">…</div>}
                    <span className="qr-seq">#{p.seq}</span>
                    {p.imported ? <span className="qr-imported" title="已识别导入">✓</span> : null}
                    {qBadges.length ? <span className="qr-quality">{qBadges.join(' ')}</span> : null}
                    <div className="qr-thumb-ops">
                      <button type="button" className="qr-op" title="查看大图" onClick={() => openBig(p.photoId)}><Icon name="eye" size={14} /></button>
                      <button type="button" className="qr-op" title={isSel ? '取消勾选' : '勾选识别'} onClick={() => toggleSelected(p.photoId)}>{isSel ? '☑' : '☐'}</button>
                      <button type="button" className="qr-op" title="删除" onClick={() => removePhoto(p.photoId)}><Icon name="trash" size={14} /></button>
                    </div>
                    <div className="qr-thumb-meta">{p.w}×{p.h}</div>
                  </div>
                );
              })}
            </div>
          )}
          {error ? <div className="qr-error">{error}</div> : null}
        </div>
      </div>

      {bigImg ? (
        <div className="qr-overlay" onClick={() => setBigImg(null)}>
          <div className="qr-overlay-body" onClick={(e) => e.stopPropagation()}>
            {bigImg.url
              ? <img src={bigImg.url} alt="照片大图" />
              : <div className="qr-loading">{bigImg.url === null ? '照片加载失败' : '加载中…'}</div>}
            {(() => {
              const p = photos.find((x) => x.photoId === bigImg.photoId);
              return p ? <div className="qr-overlay-meta">#{p.seq} · {p.w}×{p.h} · {Math.round(p.size / 1024)}KB{p.bright ? ` · 亮度 ${p.bright}` : ''}{p.blur ? ` · 清晰度 ${p.blur}` : ''}</div> : null;
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
