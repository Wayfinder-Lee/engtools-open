import { useMemo, useState } from 'react';
import type { UsageSummary } from '../services/api';
import {
  buildHeatmapWeeks, buildMonthStrip, buildWeekStrip, featureTiles, heatLevel, heatmapMonths, weekStripMonths,
} from '../utils/usageStats';
import type { HeatGran, StripCell } from '../utils/usageStats';
import './UsageStats.css';

/**
 * 使用看板内容（主页 tab）：KPI 行 + 生成统计瓦片 + 消费热力图（日/周/月三粒度，默认日）。
 * 纯展示组件：数据由 HomeTab 拉取后传入；颜色全部来自 index.css 的 --us-* token。
 */

const GRANS = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
] as const;

interface Props {
  summary: UsageSummary | null;
  loading: boolean;
  onOpenLedger: () => void;
}

export default function UsageDashboard({ summary, loading, onOpenLedger }: Props) {
  const [gran, setGran] = useState<HeatGran>('day');

  const daily = summary?.daily || {};
  const weeks = useMemo(() => buildHeatmapWeeks(daily, 52), [daily]);
  const dayMonths = useMemo(() => heatmapMonths(weeks), [weeks]);
  const weekStrip = useMemo(() => (gran === 'week' ? buildWeekStrip(daily, 52) : []), [gran, daily]);
  const weekMonths = useMemo(() => (gran === 'week' ? weekStripMonths(weekStrip) : []), [gran, weekStrip]);
  const monthStrip = useMemo(() => (gran === 'month' ? buildMonthStrip(daily) : []), [gran, daily]);
  const tiles = useMemo(() => (summary ? featureTiles(summary) : []), [summary]);

  if (loading && !summary) {
    return <div className="us-loading">统计加载中…</div>;
  }
  if (!summary) return null;

  const kpis = [
    { key: 'quota', label: '当前额度', value: summary.quota },
    { key: 'month', label: '本月已用', value: summary.monthSpent },
    { key: 'total', label: '累计已用', value: summary.totalSpent },
    { key: 'gained', label: '累计充值', value: summary.totalGained },
  ];

  const renderStrip = (strip: StripCell[]) => (
    <div className="us-heat-strip">
      {strip.map((cell) => (
        <div
          key={cell.key}
          className={`us-heat-cell us-heat-l${heatLevel(cell.cost, gran)}`}
          title={cell.tooltip}
        />
      ))}
    </div>
  );

  return (
    <div className="us-dash">
      {/* KPI 行 */}
      <div className="us-kpis">
        {kpis.map((k) => (
          <div key={k.key} className={`us-tile ${k.key === 'quota' ? 'us-tile-hero' : ''}`}>
            <span className="us-tile-label">{k.label}</span>
            <span className="us-tile-value">{k.value.toLocaleString('zh-CN')}</span>
          </div>
        ))}
      </div>

      {/* 生成统计 */}
      <section className="us-section">
        <h4 className="us-h4">生成统计</h4>
        <div className="us-ftiles">
          {tiles.map((t) => (
            <div key={t.key} className="us-ftile" title={t.hint ? `${t.label}（${t.hint}）` : t.label}>
              <span className="us-ftile-label">
                {t.label}
                {t.hint && <em className="us-ftile-hint">{t.hint}</em>}
              </span>
              <span className="us-ftile-value">
                {t.value.toLocaleString('zh-CN')}
                {t.unit && <i className="us-ftile-unit">{t.unit}</i>}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 消费热力图：日（52 周 × 7 天）/ 周（每周一格）/ 月（每月一格），默认日 */}
      <section className="us-section">
        <div className="us-section-head">
          <h4 className="us-h4">额度消费热力图</h4>
          <div className="us-seg" role="group" aria-label="热力图粒度">
            {GRANS.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`us-seg-btn ${gran === g.key ? 'active' : ''}`}
                onClick={() => setGran(g.key)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {gran === 'day' && (
          <div className="us-heat">
            <div className="us-heat-head">
              <span className="us-heat-corner" aria-hidden />
              <div className="us-heat-months">
                {dayMonths.map((m) => (
                  <span key={`${m.label}-${m.col}`} style={{ gridColumn: m.col + 1 }}>{m.label}</span>
                ))}
              </div>
            </div>
            <div className="us-heat-body">
              <div className="us-heat-wd" aria-hidden>
                <span>一</span><span /><span>三</span><span /><span>五</span>
              </div>
              <div className="us-heat-scroll">
                <div className="us-heat-grid">
                  {weeks.flatMap((w, ci) => w.days.map((cell, ri) => (cell ? (
                    <div
                      key={cell.day}
                      className={`us-heat-cell us-heat-l${heatLevel(cell.cost, 'day')}`}
                      title={cell.cost > 0 ? `${cell.day} · ${cell.cost} 额度` : `${cell.day} · 无消费`}
                      style={{ gridColumn: ci + 1, gridRow: ri + 1 }}
                    />
                  ) : (
                    <div key={`f-${ci}-${ri}`} className="us-heat-cell us-heat-future" style={{ gridColumn: ci + 1, gridRow: ri + 1 }} />
                  ))))}
                </div>
              </div>
            </div>
          </div>
        )}

        {gran === 'week' && (
          <div className="us-heat">
            <div className="us-heat-head">
              <span className="us-heat-corner" aria-hidden />
              <div className="us-heat-months">
                {weekMonths.map((m) => (
                  <span key={`${m.label}-${m.col}`} style={{ gridColumn: m.col + 1 }}>{m.label}</span>
                ))}
              </div>
            </div>
            <div className="us-heat-body">
              <span className="us-heat-corner" aria-hidden />
              <div className="us-heat-scroll">
                {renderStrip(weekStrip)}
              </div>
            </div>
          </div>
        )}

        {gran === 'month' && (
          <div className="us-heat">
            <div className="us-heat-month-strip">
              {monthStrip.map((cell) => (
                <div key={cell.key} className="us-heat-month-slot">
                  <div
                    className={`us-heat-cell us-heat-cell-wide us-heat-l${heatLevel(cell.cost, 'month')}`}
                    title={cell.tooltip}
                  />
                  <span className="us-heat-month-label">{cell.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="us-heat-foot">
          <span className="us-heat-legend-label">少</span>
          {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`us-heat-cell us-heat-l${l}`} aria-hidden />)}
          <span className="us-heat-legend-label">多</span>
          <span className="us-heat-note">统计扣费额度（上海时区）；查词等免费操作不计入</span>
        </div>
      </section>

      {summary.partial && <p className="us-note">数据量较大，统计可能不完整。</p>}

      <div className="us-ledger-row">
        <button type="button" className="us-ledger-link" onClick={onOpenLedger}>
          查看额度明细 →
        </button>
      </div>
    </div>
  );
}
