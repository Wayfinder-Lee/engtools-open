import { useCallback, useEffect, useRef, useState } from 'react';
import { apiMuClaim, apiMuUpload, apiMuVerifySession, type MuTaskView } from './api';
import { analyzeQuality, BLUR_THRESHOLD, BRIGHT_THRESHOLD, compressForUpload, makeThumb } from './quality';

/**
 * 扫码拍照上传 · 手机端。
 * 状态机 boot → claiming → active | expired | refreshed | revoked | closed | needQr | error。
 * 会话存 localStorage（mu_session）；URL ?t= 只在首次 claim 用，成功后即清。
 */

const SESSION_KEY = 'mu_session';
/** 一次多选上限：批量选图会在 webview 里囤大字符串，且产品形态本就逐本拍。 */
const SELECT_LIMIT = 10;
/** 上传并发。 */
const CONCURRENCY = 2;
/** 自动重试时间预算：超过后转为手动。 */
const RETRY_BUDGET_MS = 5 * 60 * 1000;

interface QueueItem {
  photoId: string;
  file: File;
  previewUrl: string;
  status: 'queued' | 'working' | 'done' | 'failed';
  quality?: { blur: number; bright: number };
  err?: string;
  attempts: number;
  firstFailAt?: number;
  nextRetryAt?: number;
}

type Screen =
  | { kind: 'boot' }
  | { kind: 'claiming' }
  | { kind: 'active' }
  | { kind: 'needQr' }
  | { kind: 'terminal'; which: TerminalWhich; detail?: string };

type TerminalWhich = 'expired' | 'refreshed' | 'closed' | 'invalid' | 'missing' | 'full' | 'network';

const TERMINAL_TEXT: Record<TerminalWhich, { icon: string; title: string; body: string }> = {
  expired: { icon: '⏱', title: '任务已过期', body: '这个拍照任务已到期。请在电脑端重新创建任务后，用新手机重新扫码。' },
  refreshed: { icon: '🔄', title: '二维码已被刷新', body: '请在电脑端重新扫码连接。' },
  closed: { icon: '✅', title: '任务已结束', body: '照片已由系统删除，不会留存。请老师在电脑端重新创建任务。' },
  invalid: { icon: '🔗', title: '连接已失效', body: '请用微信重新扫描电脑端显示的二维码。' },
  missing: { icon: '🔍', title: '任务不存在', body: '任务可能已被清理。请老师在电脑端重新创建任务。' },
  full: { icon: '📦', title: '已达照片上限', body: '这个任务的照片数已到上限。请老师在电脑端删除部分照片或结束任务后，再继续拍摄。' },
  network: { icon: '📡', title: '网络异常', body: '无法连接服务器，请检查网络后重试。' },
};

/** 12 位小写 hex，匹配服务端 /^[a-z0-9]{6,32}$/。 */
function newPhotoId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function deviceId(): string {
  let v = localStorage.getItem('mu_device');
  if (!v || !/^[A-Za-z0-9-]{8,64}$/.test(v)) {
    v = `mu-${newPhotoId()}-${Date.now().toString(36)}`;
    localStorage.setItem('mu_device', v);
  }
  return v;
}

function loadSession(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return typeof o.session === 'string' ? o.session : null;
  } catch {
    return null;
  }
}

/** 服务端 409/401 状态 → 终态屏。 */
function terminalFromErr(err: { status?: number; data?: any; message?: string }): Screen {
  const st = err.status;
  const state = err.data?.state;
  const kind = err.data?.kind;
  if (st === 409 && state === 'refreshed') return { kind: 'terminal', which: 'refreshed' };
  if (st === 409 && state === 'closed') return { kind: 'terminal', which: 'closed' };
  if (st === 409 && state === 'expired') return { kind: 'terminal', which: 'expired' };
  if (st === 409 && state === 'revoked') return { kind: 'terminal', which: 'refreshed' };
  if (st === 409 && state === 'full') return { kind: 'terminal', which: 'full' };
  if (st === 404) return { kind: 'terminal', which: 'missing' };
  if (st === 401) return { kind: 'terminal', which: kind === 'expired' ? 'expired' : 'invalid' };
  return { kind: 'terminal', which: 'network', detail: err.message };
}

function remaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return '已到期';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不足 1 分钟';
  if (m < 60) return `剩 ${m} 分钟`;
  return `剩 ${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

export default function MuApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'boot' });
  const [task, setTask] = useState<MuTaskView | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [qualityWarned, setQualityWarned] = useState(false);

  const sessionRef = useRef<string>('');
  const tokenRef = useRef<string>(''); // ?t= 一次性 token（claim 前）
  const inflight = useRef<Set<string>>(new Set());
  const itemsRef = useRef<QueueItem[]>([]);
  const activeRef = useRef(false); // screen === active
  itemsRef.current = items;
  activeRef.current = screen.kind === 'active';

  // 首启：先试恢复会话，再试 ?t= claim，都不行 → 引导扫码
  useEffect(() => {
    let dead = false;
    const gone = () => dead;
    (async () => {
      const url = new URL(window.location.href);
      const t = url.searchParams.get('t') || sessionStorage.getItem('mu_token') || '';
      if (t) {
        tokenRef.current = t;
        sessionStorage.setItem('mu_token', t); // 弱网下首次 claim 失败不丢 token
      }
      const saved = loadSession();
      if (saved) {
        sessionRef.current = saved;
        try {
          const payload = await apiMuVerifySession(saved);
          if (dead) return;
          setTask(payload.task);
          setScreen({ kind: 'active' });
          return;
        } catch (err: any) {
          if (dead) return;
          const sessionDead = err?.status === 401 || (err?.status === 409 && err?.data?.state);
          if (sessionDead) {
            localStorage.removeItem(SESSION_KEY);
            sessionRef.current = '';
            // 会话失效但有码 → 接着走 claim；没码 → needQr
          } else {
            // 网络错误/5xx：会话本身仍有效（24h），删掉它会把弱网首启打成 needQr 死端
            setScreen({ kind: 'terminal', which: 'network', detail: err?.message || '' });
            return;
          }
        }
      }
      if (tokenRef.current) {
        setScreen({ kind: 'claiming' });
        await claimWithRetry(gone);
        return;
      }
      if (!dead) setScreen({ kind: 'needQr' });
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** claim 带退避重试（网络错误/5xx/429 均重试；仅明确 4xx 拒绝进终态）。 */
  const claimWithRetry = useCallback(async (gone: () => boolean) => {
    const delays = [1500, 3000, 5000]; // 末档 5s：吸收函数平台冷启动 502
    for (let i = 0; ; i++) {
      try {
        const r = await apiMuClaim(tokenRef.current, deviceId());
        sessionRef.current = r.session;
        localStorage.setItem(SESSION_KEY, JSON.stringify({ session: r.session }));
        sessionStorage.removeItem('mu_token');
        // 成功后才清 URL（防弱网下首次请求失败即死锁）
        window.history.replaceState(null, '', window.location.pathname);
        setTask(r.task);
        setScreen({ kind: 'active' });
        return;
      } catch (err: any) {
        if (gone()) return;
        // 5xx/429 是基础设施抖动不是会话终态，落入退避（有界）；4xx 才是明确拒绝
        if (err.status && err.status < 500 && err.status !== 429) {
          setScreen(terminalFromErr(err));
          return;
        }
        if (i >= delays.length) {
          setScreen({ kind: 'terminal', which: 'network', detail: err?.message || '' });
          return;
        }
        await new Promise((s) => setTimeout(s, delays[i]));
        if (gone()) return;
      }
    }
  }, []);

  // 离线/在线 + 回前台对账
  const reconcile = useCallback(async () => {
    if (!sessionRef.current || !activeRef.current) return;
    try {
      const payload = await apiMuVerifySession(sessionRef.current);
      setTask(payload.task);
      const serverIds = new Set(payload.photoIds.map((p) => p.photoId));
      setItems((prev) => prev
        .map((it) => {
          if (serverIds.has(it.photoId) && it.status !== 'done') return { ...it, status: 'done' as const };
          if (!serverIds.has(it.photoId) && it.status === 'done') {
            // done 只在 complete=true 落库后标记，所以「服务端没有」的唯一成因就是
            // 老师在桌面端删了它 → 视为权威结果直接移除；回队重传会让删除的照片复活
            if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
            return null;
          }
          return it;
        })
        .filter((x): x is QueueItem => x !== null));
    } catch (err: any) {
      // 只有明确的会话终态才打断拍摄；5xx/429/网络错误保持 active 继续拍
      if (err?.status === 401 || (err?.status === 409 && err?.data?.state)) setScreen(terminalFromErr(err));
    }
  }, []);

  useEffect(() => {
    const on = () => { setOnline(true); reconcile(); };
    const off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === 'visible') reconcile(); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [reconcile]);

  // 调度：并发 ≤2 的单线程 tick（1s）
  useEffect(() => {
    const timer = setInterval(() => {
      if (!activeRef.current || !navigator.onLine) return;
      if (inflight.current.size >= CONCURRENCY) return;
      const now = Date.now();
      const next = itemsRef.current.find((it) =>
        it.status === 'queued' && (!it.nextRetryAt || it.nextRetryAt <= now) && !inflight.current.has(it.photoId));
      if (next) void uploadOne(next.photoId);
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadOne = useCallback(async (photoId: string) => {
    const item = itemsRef.current.find((it) => it.photoId === photoId);
    if (!item || inflight.current.has(photoId)) return;
    inflight.current.add(photoId);
    setItems((prev) => prev.map((it) => (it.photoId === photoId ? { ...it, status: 'working' as const } : it)));
    try {
      const { dataUrl, w, h } = await compressForUpload(item.file);
      const thumb = await makeThumb(dataUrl).catch(() => undefined);
      const r = await apiMuUpload(sessionRef.current, {
        photoId,
        dataUrl,
        w,
        h,
        size: item.file.size,
        quality: item.quality,
        thumb,
      });
      setItems((prev) => prev.map((it) => {
        if (it.photoId !== photoId) return it;
        // 上传成功：清失败账目 + 释放预览原图引用（缩略 <img> 已解码，revoke 后仍能显示）
        if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
        return { ...it, status: 'done' as const, err: undefined, attempts: 0, firstFailAt: undefined };
      }));
      setTask((prev) => (prev ? { ...prev, photoCount: r.photoCount, quota: r.quota } : prev));
    } catch (err: any) {
      if (err.status === 401 || (err.status === 409 && err.data?.state)) {
        setScreen(terminalFromErr(err));
        setItems((prev) => prev.map((it) => (it.photoId === photoId ? { ...it, status: 'failed' as const, err: err.message } : it)));
        return;
      }
      // 400/413 = 数据本身有问题；409 = 明确业务拒绝（上限/已结束，重试无意义）
      const hard = err.status === 400 || err.status === 413 || err.status === 409;
      setItems((prev) => prev.map((it) => {
        if (it.photoId !== photoId) return it;
        const attempts = it.attempts + 1;
        const firstFailAt = it.firstFailAt ?? Date.now();
        if (hard || Date.now() - firstFailAt > RETRY_BUDGET_MS) {
          return { ...it, status: 'failed' as const, attempts, firstFailAt, err: err.message };
        }
        const backoff = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
        return { ...it, status: 'queued' as const, attempts, firstFailAt, nextRetryAt: Date.now() + backoff, err: err.message };
      }));
    } finally {
      inflight.current.delete(photoId);
    }
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => /^image\//.test(f.type));
    if (!list.length) return;
    const batch = list.slice(0, SELECT_LIMIT);
    const newItems: QueueItem[] = batch.map((file) => ({
      photoId: newPhotoId(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'queued',
      attempts: 0,
    }));
    setItems((prev) => [...prev, ...newItems]);
    if (list.length > SELECT_LIMIT) {
      alert(`一次最多加 ${SELECT_LIMIT} 张，已取前 ${SELECT_LIMIT} 张。逐张拍更稳。`);
    }
    // 质量分析逐张后台做，不阻塞
    for (const it of newItems) {
      try {
        const q = await analyzeQuality(it.file);
        setItems((prev) => prev.map((x) => (x.photoId === it.photoId ? { ...x, quality: q } : x)));
        if (q.bright < BRIGHT_THRESHOLD || q.blur < BLUR_THRESHOLD) setQualityWarned(true);
      } catch { /* 分析失败不影响上传 */ }
    }
  }, []);

  const retryItem = useCallback((photoId: string) => {
    setItems((prev) => prev.map((it) => (it.photoId === photoId
      ? { ...it, status: 'queued' as const, attempts: 0, firstFailAt: undefined, nextRetryAt: undefined, err: undefined }
      : it)));
  }, []);

  /** 清除所有：清空本机拍摄列表（仅本地视图，不动电脑端已收到的照片），方便拍下一批。 */
  const clearAll = useCallback(() => {
    const pending = itemsRef.current.filter((it) => it.status !== 'done').length;
    if (pending > 0 && !window.confirm(`有 ${pending} 张照片尚未上传完成，清除后它们将不会上传。确定清除？`)) return;
    setItems((prev) => {
      for (const it of prev) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      return [];
    });
    setQualityWarned(false);
  }, []);

  // 到期检查（active 时每 tick 顺带看一眼）
  useEffect(() => {
    if (screen.kind !== 'active' || !task) return;
    const t = setInterval(() => {
      if (task.expiresAt <= Date.now()) {
        setScreen({ kind: 'terminal', which: 'expired' });
        localStorage.removeItem(SESSION_KEY);
      }
    }, 30000);
    return () => clearInterval(t);
  }, [screen.kind, task]);

  // ---------------------------------------------------------------------------

  if (screen.kind === 'boot' || screen.kind === 'claiming') {
    return (
      <div className="mu-root">
        <div className="mu-terminal">
          <div className="mu-terminal-icon">📷</div>
          <h1>{screen.kind === 'claiming' ? '正在连接任务…' : '加载中…'}</h1>
          <p>保持网络畅通，连接成功后即可拍照上传。</p>
        </div>
      </div>
    );
  }

  if (screen.kind === 'terminal') {
    const t = TERMINAL_TEXT[screen.which];
    return (
      <div className="mu-root">
        <div className="mu-terminal">
          <div className="mu-terminal-icon">{t.icon}</div>
          <h1>{t.title}</h1>
          <p>{t.body}</p>
          {screen.detail ? <p style={{ fontSize: 12 }}>{screen.detail}</p> : null}
        </div>
        <div className="mu-footer">照片仅老师本人可见，任务结束立即删除；未手动结束时最长 24 小时后自动清理</div>
      </div>
    );
  }

  if (screen.kind === 'needQr') {
    return (
      <div className="mu-root">
        <div className="mu-terminal">
          <div className="mu-terminal-icon">🔳</div>
          <h1>请通过二维码进入</h1>
          <p>请用微信扫描电脑端「个性化学案」里显示的二维码打开本页。上传照片无需登录。</p>
        </div>
        <div className="mu-footer">照片仅老师本人可见，任务结束立即删除；未手动结束时最长 24 小时后自动清理</div>
      </div>
    );
  }

  const doneCount = items.filter((it) => it.status === 'done').length;
  const failCount = items.filter((it) => it.status === 'failed').length;
  const pendingCount = items.length - doneCount;

  return (
    <div className="mu-root">
      {task ? (
        <div className="mu-task-card">
          <h1 className="mu-task-label">{task.label || '拍照上传任务'}</h1>
          <div className="mu-task-sub">
            <span>{task.tool === 'handwriting' ? '个性化学案' : task.tool}</span>
            <span>{remaining(task.expiresAt)}</span>
            <span className="mu-chip">电脑端额度约可识别 {task.quota} 张</span>
          </div>
        </div>
      ) : null}

      {!online ? <div className="mu-banner warn">当前离线——拍好的照片会自动排队，网络恢复后继续上传。</div> : null}
      {online && qualityWarned ? (
        <div className="mu-banner warn" onClick={() => setQualityWarned(false)}>
          ⚠️ 有照片可能偏暗或模糊，建议在光线充足处重新拍摄（点按关闭提示）。
        </div>
      ) : null}

      <div className="mu-banner info">
        💡 建议：先用手机<b>自带的相机</b>把作文逐本拍完，再回到本页面点下方按钮，<b>从相册一次性批量选择</b>上传。（在网页里直接拍照，每拍一张都会退回页面，需要重新点按，比较繁琐）
      </div>

      <div className="mu-actions">
        <label>
          <input
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length) void addFiles(e.target.files);
              e.currentTarget.value = '';
            }}
          />
          <span className="mu-btn primary" style={{ display: 'block' }}>从相册批量选择上传</span>
        </label>
      </div>

      {items.length ? (
        <>
          <div className="mu-task-sub" style={{ marginBottom: 8 }}>
            <span>本机已拍 {doneCount} 张</span>
            {pendingCount > 0 ? <span className="mu-chip">{pendingCount} 张待上传，请勿关闭本页</span> : null}
            {failCount ? <span className="mu-chip" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>{failCount} 张失败，点照片重试</span> : null}
            <button
              type="button"
              className="mu-btn-text"
              title="清空本页拍摄记录，开始拍下一批；不影响电脑端已收到的照片"
              onClick={clearAll}
            >
              清除所有
            </button>
          </div>
          <div className="mu-queue">
            {items.map((it, idx) => (
              <div key={it.photoId} className={`mu-item${it.status === 'failed' ? ' failed' : ''}`}>
                <img src={it.previewUrl} alt="" />
                <span className="mu-item-idx">#{idx + 1}</span>
                {it.status === 'working' ? <span className="mu-item-retry"><span className="mu-item-spin" /></span> : null}
                {it.status === 'done' ? <span className="mu-badge" style={{ background: 'var(--success)' }}>✓ 已上传</span> : null}
                {it.status === 'failed' ? (
                  <button type="button" className="mu-item-retry" onClick={() => retryItem(it.photoId)}>
                    <span>↻ 重试</span>
                    {it.err ? <span style={{ fontSize: 10 }}>{it.err.slice(0, 40)}</span> : null}
                  </button>
                ) : null}
                {it.quality && it.status !== 'done' ? (
                  <span className="mu-item-badges">
                    {it.quality.bright < BRIGHT_THRESHOLD ? <span className="mu-badge warn">暗</span> : null}
                    {it.quality.blur < BLUR_THRESHOLD ? <span className="mu-badge warn">糊</span> : null}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
          逐本拍：选中的照片会自动上传，老师的电脑端实时可见，拍完无需其他操作。
        </p>
      )}

      <div className="mu-footer">照片仅老师本人可见，任务结束立即删除；未手动结束时最长 24 小时后自动清理</div>
    </div>
  );
}
