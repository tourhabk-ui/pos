'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Footprints, RefreshCw, ExternalLink } from 'lucide-react';

interface Totals { hits: number; uniques: number }
interface TrafficData {
  totals: { today: Totals; week: Totals; month: Totals };
  daily: Array<{ day: string; hits: number; uniques: number }>;
  top_paths: Array<{ path: string; hits: number }>;
  top_referrers: Array<{ referrer: string; hits: number }>;
}

export default function AdminTrafficPage() {
  const [data, setData] = useState<TrafficData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/analytics/traffic');
      const json = await res.json();
      if (json.success) setData(json.data);
      else setError(json.error ?? 'Ошибка загрузки');
    } catch {
      setError('Ошибка загрузки посещаемости');
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const kpis = data ? [
    { label: 'Сегодня', hits: data.totals.today.hits, uniques: data.totals.today.uniques },
    { label: '7 дней', hits: data.totals.week.hits, uniques: data.totals.week.uniques },
    { label: '30 дней', hits: data.totals.month.hits, uniques: data.totals.month.uniques },
  ] : [];

  const maxDailyHits = data ? Math.max(...data.daily.map(d => d.hits), 1) : 1;
  const maxPathHits = data ? Math.max(...data.top_paths.map(p => p.hits), 1) : 1;

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Footprints className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Посещаемость</h1>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        Первичный счётчик платформы (page_views). Уникальные — по суточному хэшу,
        сырые IP не хранятся. Пути /hub/admin и служебные не учитываются.
      </p>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="bg-[var(--bg-card)] border border-[var(--danger)]/30 rounded-lg p-6 text-center">
          <p className="text-[var(--danger)] text-sm mb-3">{error}</p>
          <button
            onClick={fetchData}
            className="px-3 py-1.5 border border-[var(--danger)]/30 text-[var(--danger)] rounded-md text-xs transition-colors hover:bg-[var(--bg-hover)]"
          >
            Повторить
          </button>
        </div>
      ) : data && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-3 gap-3">
            {kpis.map(k => (
              <div key={k.label} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
                <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">{k.label}</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold font-mono text-[var(--text-primary)]">{k.hits.toLocaleString('ru-RU')}</span>
                  <span className="text-xs text-[var(--text-secondary)]">просмотров</span>
                </div>
                <p className="text-xs text-[var(--ocean)] mt-0.5">{k.uniques.toLocaleString('ru-RU')} уникальных</p>
              </div>
            ))}
          </div>

          {/* По дням */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">14 дней</p>
            {data.daily.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Пока нет данных — счётчик копит с момента деплоя.</p>
            ) : (
              <div className="space-y-1.5">
                {data.daily.map(d => (
                  <div key={d.day} className="flex items-center gap-3">
                    <span className="text-xs font-mono text-[var(--text-secondary)] w-20 shrink-0">{d.day.slice(5)}</span>
                    <div className="flex-1 h-4 bg-[var(--bg-hover)] rounded overflow-hidden">
                      <div className="h-full bg-[var(--ocean)] rounded" style={{ width: `${(d.hits / maxDailyHits) * 100}%` }} />
                    </div>
                    <span className="text-xs font-mono text-[var(--text-primary)] w-12 text-right shrink-0">{d.hits}</span>
                    <span className="text-xs font-mono text-[var(--ocean)] w-12 text-right shrink-0">{d.uniques}</span>
                  </div>
                ))}
                <div className="flex justify-end gap-3 pt-1 text-[10px] text-[var(--text-muted)]">
                  <span>просмотры</span>
                  <span className="text-[var(--ocean)]">уникальные</span>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Топ страниц */}
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Топ страниц · 30 дней</p>
              {data.top_paths.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">Нет данных.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.top_paths.map(p => (
                    <div key={p.path} className="flex items-center gap-3">
                      <span className="text-xs font-mono text-[var(--text-secondary)] flex-1 truncate" title={p.path}>{p.path}</span>
                      <div className="w-24 h-3.5 bg-[var(--bg-hover)] rounded overflow-hidden shrink-0">
                        <div className="h-full bg-[var(--accent)] rounded" style={{ width: `${(p.hits / maxPathHits) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono text-[var(--text-primary)] w-10 text-right shrink-0">{p.hits}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Источники */}
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Источники переходов · 30 дней</p>
              {data.top_referrers.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Внешних переходов пока не зафиксировано (прямые заходы реферера не передают).
                </p>
              ) : (
                <div className="space-y-1.5">
                  {data.top_referrers.map(r => (
                    <div key={r.referrer} className="flex items-center gap-2">
                      <ExternalLink className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                      <span className="text-xs text-[var(--text-secondary)] flex-1 truncate" title={r.referrer}>{r.referrer}</span>
                      <span className="text-xs font-mono text-[var(--text-primary)] shrink-0">{r.hits}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
