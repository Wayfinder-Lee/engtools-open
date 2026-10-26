import type { ModuleKey, SavedItem } from '../types';

const MAX_ITEMS = 20;

function key(module: ModuleKey): string {
  return `vb_history_${module}`;
}

function todayName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Autosave${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function readAll<T>(module: ModuleKey): SavedItem<T>[] {
  try {
    const raw = localStorage.getItem(key(module));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll<T>(module: ModuleKey, items: SavedItem<T>[]): boolean {
  try {
    // Enforce max items
    const trimmed = items.slice(-MAX_ITEMS);
    localStorage.setItem(key(module), JSON.stringify(trimmed));
    return true;
  } catch {
    // W6：QuotaExceeded 不再静默吞掉——返回 false 由调用方提示用户（否则「保存」可能实际已丢）
    return false;
  }
}

/** Auto-save: overwrites today's autosave entry. Returns false when storage is full. */
export function autoSave<T>(module: ModuleKey, data: T, autoTitle?: string): boolean {
  const items = readAll<T>(module);
  const name = todayName();
  const idx = items.findIndex((i) => i.name === name);
  const item: SavedItem<T> = {
    id: crypto.randomUUID(),
    name,
    savedAt: new Date().toISOString(),
    data,
  };
  // 覆盖今天的条目时保留已有标题（LLM 标题是异步补写的，通常晚于首次 autoSave 到达；
  // 调用方显式传 autoTitle 时以传入值为准）
  const title = autoTitle ?? (idx >= 0 ? items[idx].autoTitle : undefined);
  if (title) item.autoTitle = title;
  if (idx >= 0) {
    items[idx] = item;
  } else {
    items.push(item);
  }
  return writeAll(module, items);
}

/** 给今天的 autosave 条目补写/更新 LLM 存档标题（autoSave 落盘后异步调用；当天无条目则丢弃）。 */
export function setTodayAutosaveTitle(module: ModuleKey, title: string): void {
  const items = readAll(module);
  const name = todayName();
  const idx = items.findIndex((i) => i.name === name);
  if (idx < 0) return;
  items[idx] = { ...items[idx], autoTitle: title };
  writeAll(module, items);
}

/** Manual save: creates a new named entry. Returns false when storage is full. */
export function manualSave<T>(module: ModuleKey, name: string, data: T): boolean {
  const items = readAll<T>(module);
  items.push({
    id: crypto.randomUUID(),
    name,
    savedAt: new Date().toISOString(),
    data,
  });
  return writeAll(module, items);
}

/** Load all history for a module, newest first. */
export function loadHistory<T>(module: ModuleKey): SavedItem<T>[] {
  const items = readAll<T>(module);
  return items.slice().reverse(); // newest first
}

/** Get a single item by id. */
export function getItem<T>(module: ModuleKey, id: string): SavedItem<T> | null {
  const items = readAll<T>(module);
  return items.find((i) => i.id === id) ?? null;
}

/** Delete an item by id. */
export function deleteItem(module: ModuleKey, id: string): void {
  const items = readAll(module);
  writeAll(module, items.filter((i) => i.id !== id));
}

/** Get today's autosave if it exists. */
export function getTodayAutosave<T>(module: ModuleKey): SavedItem<T> | null {
  const name = todayName();
  const items = readAll<T>(module);
  return items.find((i) => i.name === name) ?? null;
}

// ─── M7：全量备份（导出/导入 .json）──────────────────

const ALL_MODULES: ModuleKey[] = ['vocab', 'practical', 'continuation', 'handwriting', 'copybook', 'exampaper'];

/** 导出全部模块的历史记录（跨设备迁移用；文件含学生信息，调用方须提示妥善保管）。 */
export function exportAll(): { app: 'engtools'; kind: 'history-backup'; exportedAt: string; modules: Partial<Record<ModuleKey, SavedItem<unknown>[]>> } {
  const modules: Partial<Record<ModuleKey, SavedItem<unknown>[]>> = {};
  for (const m of ALL_MODULES) modules[m] = readAll(m);
  return { app: 'engtools', kind: 'history-backup', exportedAt: new Date().toISOString(), modules };
}

/** 导入备份：按模块 + id 去重合并（不覆盖现有记录）。返回新增条数；格式不符返回 null。 */
export function importAll(data: unknown): { added: number } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { app?: string; kind?: string; modules?: Record<string, unknown> };
  if (d.app !== 'engtools' || d.kind !== 'history-backup' || typeof d.modules !== 'object') return null;
  let added = 0;
  for (const m of ALL_MODULES) {
    const incoming = d.modules[m];
    if (!Array.isArray(incoming)) continue;
    const existing = readAll(m);
    const seen = new Set(existing.map((i) => i.id));
    for (const raw of incoming) {
      const item = raw as SavedItem<unknown>;
      if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
      existing.push(item);
      seen.add(item.id);
      added += 1;
    }
    writeAll(m, existing);
  }
  return { added };
}
