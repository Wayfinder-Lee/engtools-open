import type { ModuleKey, SavedItem } from '../types';
import { getItem } from './history';

/**
 * 跨 tab 历史交接：主页「最近生成 → 打开」登记待恢复记录，App 切到目标工具 tab，
 * 工具挂载时取走并 restoreState。仿 wordbank.ts 的 pendingCopybookText 先例。
 * pending 不随 tab 切换清理：只被匹配模块的消费取走，或被下一次登记覆盖。
 */

let pending: { module: ModuleKey; id: string } | null = null;

/** 登记待恢复记录（随后应立即切到该模块的 tab）。 */
export function openHistoryItem(module: ModuleKey, id: string): void {
  pending = { module, id };
}

/** 目标工具挂载时调用：取走交给本模块的记录（现读 localStorage，记录已被删则得 null）。 */
export function takeHistoryHandoff(module: ModuleKey): SavedItem<unknown> | null {
  if (!pending || pending.module !== module) return null;
  const { id } = pending;
  pending = null;
  return getItem<unknown>(module, id);
}
