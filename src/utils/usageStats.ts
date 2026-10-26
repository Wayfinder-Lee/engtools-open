import type { UsageRow, UsageSummary } from '../services/api';
import { opLabel } from './model';

/**
 * 使用统计的纯函数工具：热力图矩阵、日/周/月卷积、看板瓦片、明细 CSV。
 * 日桶以服务端 summary.daily（上海日）为唯一权威，客户端只做 日→周/月 卷积。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 毫秒 → 上海日 'YYYY-MM-DD'（与服务端 usageSummary 同口径）。 */
export function shanghaiDayStr(ms: number): string {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → UTC 午夜的 Date（避免本地时区漂移，仅做日历运算用）。 */
function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'M/D'（刻度/标签用）。 */
function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

// ─── 热力图 ─────────────────────────────────────────

export interface HeatCell { day: string; cost: number }
/** 一列 = 一周（周一..周日）；null = 未来日期（透明占位）。 */
export interface HeatWeek { days: (HeatCell | null)[] }

/** 热力图聚合粒度：日（52周×7天）/ 周（每周一格）/ 月（每月一格）。 */
export type HeatGran = 'day' | 'week' | 'month';

const GRAN_MULT: Record<HeatGran, number> = { day: 1, week: 7, month: 30 };

/** 消费档位（按粒度缩放：日 0/1-4/5-14/15-29/≥30，周/月阈值 ×7/×30）。 */
export function heatLevel(cost: number, gran: HeatGran = 'day'): 0 | 1 | 2 | 3 | 4 {
  const c = cost / GRAN_MULT[gran];
  if (c <= 0) return 0;
  if (c < 5) return 1;
  if (c < 15) return 2;
  if (c < 30) return 3;
  return 4;
}

/** 近 N 周热力图矩阵（本周为最后一列，周一起始，未来日期为 null）。 */
export function buildHeatmapWeeks(daily: Record<string, number>, weeks = 52): HeatWeek[] {
  const today = parseDay(shanghaiDayStr(Date.now()));
  // 今天是周几（0=周一…6=周日）
  const dow = (today.getUTCDay() + 6) % 7;
  const start = addDays(today, -((weeks - 1) * 7) - dow);
  const out: HeatWeek[] = [];
  for (let w = 0; w < weeks; w += 1) {
    const days: (HeatCell | null)[] = [];
    for (let d = 0; d < 7; d += 1) {
      const date = addDays(start, w * 7 + d);
      if (date > today) { days.push(null); continue; }
      const key = dayStr(date);
      days.push({ day: key, cost: daily[key] || 0 });
    }
    out.push({ days });
  }
  return out;
}

/** 热力图顶部月份标签：一列的周四所在月份与前一列不同时，在该列打标签。 */
export function heatmapMonths(heatWeeks: HeatWeek[]): { col: number; label: string }[] {
  const labels: { col: number; label: string }[] = [];
  let prev = '';
  heatWeeks.forEach((week, col) => {
    const thursday = week.days[3]; // 周四代表该列所在月
    if (!thursday) return;
    const month = thursday.day.slice(0, 7);
    if (month !== prev) {
      labels.push({ col, label: `${Number(month.slice(5, 7))}月` });
      prev = month;
    }
  });
  return labels;
}

// ─── 周/月条带（热力图的周/月粒度视图） ────────────

export interface StripCell {
  key: string;
  cost: number;
  tooltip: string;
  /** 仅月视图：'N月' */
  label?: string;
}

/** 周条带：与日视图同窗口（近 N 周），每格 = 一周合计。 */
export function buildWeekStrip(daily: Record<string, number>, weeks = 52): StripCell[] {
  return buildHeatmapWeeks(daily, weeks).map((w) => {
    const days = w.days.filter((c): c is HeatCell => c !== null);
    const cost = days.reduce((s, c) => s + c.cost, 0);
    const first = days[0];
    const last = days[days.length - 1];
    const range = first && last && first.day !== last.day
      ? `${shortDay(first.day)}–${shortDay(last.day)}`
      : (first ? shortDay(first.day) : '');
    return { key: first ? first.day : '', cost, tooltip: `${range} · ${cost} 额度` };
  });
}

/** 月条带：近 12 个自然月（含本月；服务端 daily 覆盖约 400 天，足够）。 */
export function buildMonthStrip(daily: Record<string, number>): StripCell[] {
  const byMonth = new Map<string, number>();
  for (const key of Object.keys(daily)) {
    const m = key.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) || 0) + (daily[key] || 0));
  }
  const thisMonth = shanghaiDayStr(Date.now()).slice(0, 7);
  const [ty, tm] = thisMonth.split('-').map(Number);
  const out: StripCell[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const cost = byMonth.get(m) || 0;
    out.push({ key: m, cost, tooltip: `${m} · ${cost} 额度`, label: `${d.getUTCMonth() + 1}月` });
  }
  return out;
}

/** 周条带的月份标签：某格所在月份与前一格不同时打标。 */
export function weekStripMonths(strip: StripCell[]): { col: number; label: string }[] {
  const labels: { col: number; label: string }[] = [];
  let prev = '';
  strip.forEach((cell, col) => {
    const month = cell.key.slice(0, 7);
    if (month && month !== prev) {
      labels.push({ col, label: `${Number(month.slice(5, 7))}月` });
      prev = month;
    }
  });
  return labels;
}

// ─── 看板瓦片 ───────────────────────────────────────

export interface FeatureTile {
  key: string;
  label: string;
  value: number;
  unit?: string;
  hint?: string;
}

/** 「生成统计」瓦片数据。零值照常展示（0 是正常态）。 */
export function featureTiles(s: UsageSummary): FeatureTile[] {
  return [
    { key: 'practical', label: '书面表达学案', value: s.ops.practical || 0, unit: '篇' },
    { key: 'worksheet', label: '个性化学案', value: s.ops.worksheet || 0, unit: '份' },
    { key: 'class_report', label: '讲评报告', value: s.ops.class_report || 0, unit: '次' },
    { key: 'copybook', label: '字帖内容', value: s.ops.copybook || 0, unit: '次' },
    { key: 'exampaper', label: '试卷排版', value: s.statTotals.exampaper_done || 0, unit: '份' },
    { key: 'vocab_words', label: '词库单词', value: s.statTotals.vocab_words || 0, unit: '词' },
    { key: 'word', label: '查词', value: s.ops.word || 0, unit: '次', hint: '免费' },
  ];
}

// ─── 明细展示辅助 ───────────────────────────────────

/** 'YYYY-MM-DD HH:mm'（本地时区，明细表格用）。 */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 明细「变动」列文本。 */
export function deltaText(row: UsageRow): { text: string; positive: boolean } {
  if (row.gain > 0) return { text: `+${row.gain} 额度`, positive: true };
  if (row.cost > 0) return { text: `−${row.cost} 额度`, positive: false };
  // stat 行：展示上报数量
  const unit = row.op === 'vocab_words' ? '词' : row.op === 'exampaper_done' ? '份' : '次';
  return { text: `${row.count ?? 0} ${unit}`, positive: true };
}

const KIND_TEXT: Record<UsageRow['kind'], string> = {
  llm: '使用',
  redeem: '充值',
  grant: '赠送',
  unlock: '解锁',
  stat: '统计',
};

/** CSV 转义：含逗号/引号/换行的字段加引号，内部引号翻倍。 */
function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 明细导出 CSV（﻿ BOM 保 Excel 中文）。导出的是已加载范围。 */
export function csvFromRows(rows: UsageRow[]): string {
  const head = ['时间', '类型', '项目', '变动', '说明'];
  const lines = rows.map((r) => [
    formatDateTime(r.createdAt),
    KIND_TEXT[r.kind] || r.kind,
    opLabel(r.op),
    deltaText(r).text,
    r.meta || '',
  ].map(csvField).join(','));
  return `﻿${head.join(',')}\n${lines.join('\n')}`;
}
