import type { ApiConfig, ModuleKey } from '../types';
import { generateAutoTitle } from '../services/llm';
import { setTodayAutosaveTitle } from './history';
import { getEffectiveModel } from './model';

/** 每模块记录上次请求的原文签名：同一段材料不重复请求（失败也记，避免每次生成都重试免费小调用） */
const lastRequested = new Map<ModuleKey, string>();

const MIN_SOURCE_LEN = 20;
const SOURCE_CLIP = 600;

/**
 * 为主结果生成自动存档标题并写进今天的 Autosave 条目（显示在「Autosave+日期」之后）。
 * 免费辅助 op（auto_title：登录/游客走服务端转发 0 额度，key 模式用当前自选模型）。
 * fire-and-forget：生成约需几秒，失败静默——绝不影响主流程，标题晚一点出现无妨。
 * 在各模块「主结果生成成功 + autoSave 落盘」之后调用。
 */
export async function refreshAutoTitle(module: ModuleKey, apiConfig: ApiConfig, model: string, sourceText: string): Promise<void> {
  const text = sourceText.trim();
  if (text.length < MIN_SOURCE_LEN) return; // 太短起不出有信息量的标题（如字帖自定义短语）
  const sig = text.slice(0, SOURCE_CLIP);
  if (lastRequested.get(module) === sig) return;
  lastRequested.set(module, sig);
  try {
    const title = await generateAutoTitle(apiConfig, getEffectiveModel('auto_title', model), sig);
    setTodayAutosaveTitle(module, title);
  } catch { /* 免费辅助：静默失败，保持原 Autosave 名 */ }
}
