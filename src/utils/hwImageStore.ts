/**
 * 个性化学案学生手写图的 IndexedDB 本地存档。
 *
 * 为什么不用 localStorage：历史记录（vb_history_handwriting）只有 ~5MB 配额，
 * 一个班 40+ 张 1600px JPEG（每张 100-300KB base64）必然爆 QuotaExceeded——
 * 所以历史快照始终排除 imageDataUrl（轻元数据进 localStorage），图片本体按
 * 学生 id 存 IDB（配额宽松、按 origin 隔离），载入历史时异步取回合并展示。
 *
 * 键 = StudentSheet.id：随快照持久化且恢复时保留，同日 autosave 覆盖换 uuid
 * 也不影响（学生 id 不变），多条历史引用同一份图片自然去重。
 *
 * 生命周期：上传/扫码 OCR 成功即写；挂载时 sweepHwImages 对照现有历史条目
 * 清孤儿（保留 24h 内新写入的——覆盖「已上传但尚未生成触发快照」的工作区图片
 * 不被误清），另有 MAX_RECORDS 硬上限按时间淘汰兜底。IDB 不可用（隐私模式等）
 * 时全部静默降级：内存图片照常用，只是不持久化。
 */

const DB_NAME = 'engtools';
const DB_VERSION = 2;
const STORE = 'hw-images';
/** savedAt 索引：清扫用 openKeyCursor 只解键（id+时间戳）不解值——getAll 会把
 *  全部图片 dataUrl（上限 1000 条 × 150-300KB）反序列化进内存，挂载清扫不可承受 */
const SAVED_AT_IDX = 'by-savedAt';
/** 硬上限（≈20 条历史 × 50 生），超限按 savedAt 淘汰最旧 */
const MAX_RECORDS = 1000;
/** 孤儿清扫的新鲜度宽限：24h 内写入的记录不删 */
const FRESH_MS = 24 * 60 * 60 * 1000;

interface HwImageRecord {
  id: string;
  dataUrl: string;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const tx = req.transaction; // 升级事务挂在 request 上（req.result.transaction 是 DB 的方法）
        if (!tx) return;
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex(SAVED_AT_IDX, 'savedAt');
        } else if (!tx.objectStore(STORE).indexNames.contains(SAVED_AT_IDX)) {
          tx.objectStore(STORE).createIndex(SAVED_AT_IDX, 'savedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    // 打开失败不 memo（下次重试），成功则长期复用同一连接
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

/** 写入/覆盖一张手写图（fire-and-forget 用，失败静默） */
export async function putHwImage(id: string, dataUrl: string): Promise<void> {
  try {
    const db = await openDb();
    const rec: HwImageRecord = { id, dataUrl, savedAt: Date.now() };
    await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec));
  } catch { /* 降级：仅本次会话内存可见 */ }
}

/** 批量取回：单事务并发 get，返回 id → dataUrl（缺图的学生不在结果里） */
export async function getHwImages(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const entries = await Promise.all(ids.map(async (id) => {
      const rec = await reqAsPromise(store.get(id)) as HwImageRecord | undefined;
      return rec ? [id, rec.dataUrl] as const : null;
    }));
    for (const e of entries) if (e) out.set(e[0], e[1]);
  } catch { /* 降级：无图可合 */ }
  return out;
}

/** 清扫孤儿：删除「不在 liveIds 中且写入超过 24h」的记录；再按 MAX_RECORDS 淘汰最旧。
 *  走 savedAt 索引的键游标（只解出 id+时间戳，不反序列化图片本体），挂载可承受 */
export async function sweepHwImages(liveIds: ReadonlySet<string>): Promise<void> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const deadline = Date.now() - FRESH_MS;
    const stale: string[] = [];
    const kept: string[] = []; // 游标按 savedAt 升序（旧→新）追加
    await new Promise<void>((resolve, reject) => {
      const cur = store.index(SAVED_AT_IDX).openKeyCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(); return; }
        const id = String(c.primaryKey);
        if (!liveIds.has(id) && Number(c.key) < deadline) stale.push(id);
        else kept.push(id);
        c.continue();
      };
      cur.onerror = () => reject(cur.error ?? new Error('sweep cursor failed'));
    });
    // 剩余仍超硬上限：kept 已旧→新有序，砍掉最旧的溢出部分
    const excess = kept.length > MAX_RECORDS ? kept.slice(0, kept.length - MAX_RECORDS) : [];
    const doomed = [...stale, ...excess];
    if (doomed.length > 0) {
      await Promise.all(doomed.map((id) => reqAsPromise(store.delete(id))));
    }
  } catch { /* 清扫失败不影响主流程 */ }
}
