/**
 * 听力剪辑 · 本地会话自动保存（IndexedDB）
 *
 * 数据库 engtools-audio / store session，单条记录 key='current'。存原始音频 Blob
 * （File 即 Blob，结构化克隆直存，不转 base64）+ 时间线片段数组；解码相关信息
 * 不存，恢复时重新 decodeAudioData 重建波形。组件挂载时读记录询问是否恢复，
 * 时间线变化防抖写回，清空即删记录。
 *
 * 所有操作失败一律静默降级（隐私模式 / 存储被逐出时自动保存不可用，不影响剪辑本体）。
 */
import type { EditSegment } from './audioEdit';

export interface StoredAudioSource {
  /** 对应 segments 里的 sourceId */
  id: string;
  /** 显示名（文件名 / 模板名） */
  name: string;
  /** 原始音频文件，恢复时重新解码 */
  blob: Blob;
}

export interface AudioSessionRecord {
  /** 保存时间（epoch ms） */
  savedAt: number;
  /** 时间线总时长（秒），仅用于恢复提示文案 */
  duration: number;
  /** 时间线片段（拼接后绝对时间，秒） */
  segments: EditSegment[];
  sources: StoredAudioSource[];
}

const DB_NAME = 'engtools-audio';
const STORE_NAME = 'session';
const KEY = 'current';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** 读当前会话记录；无记录 / 记录为空 / 失败均返回 null */
export async function loadAudioSession(): Promise<AudioSessionRecord | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const rec = (await requestToPromise(tx.objectStore(STORE_NAME).get(KEY))) as
      | AudioSessionRecord
      | undefined;
    db.close();
    return rec && Array.isArray(rec.segments) && rec.segments.length > 0 ? rec : null;
  } catch {
    db.close();
    return null;
  }
}

/** 写会话记录；segments 为空视为「已清空」，删除记录。失败静默。 */
export async function saveAudioSession(rec: AudioSessionRecord): Promise<void> {
  if (rec.segments.length === 0) return clearAudioSession();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(rec, KEY);
    await txDone(tx);
  } catch {
    // 静默：自动保存失败不影响剪辑
  } finally {
    db.close();
  }
}

/** 删除会话记录。失败静默。 */
export async function clearAudioSession(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(KEY);
    await txDone(tx);
  } catch {
    // 静默
  } finally {
    db.close();
  }
}
