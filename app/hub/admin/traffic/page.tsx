'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Footprints, RefreshCw, ExternalLink, ArrowRight, Bot, TriangleAlert, Layers } from 'lucide-react';

interface TrafficData {
  totals: {
    today: { hits: number; uniques: number };
    week: { hits: number; visitorDays: number };
    month: { hits: number; visitorDays: number };
  };
  bots: { month_hits: number };
  daily: Array<{ day: string; hits: number; uniques: number }>;
  top_paths: Array<{ path: string; hits: number }>;
  top_referrers: Array<{ referrer: string; hits: number }>;
  edges: Array<{ from: string; to: string; hits: number }>;
  pages: Array<{ path: string; views: number; medianMs: number | null; exits: number }>;
  sessions: { total: number; onePage: number; avgDepth: number | null };
  not_found: Array<{ path: string; hits: number }>;
  uniques_since: string | null;
}

function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/** Время на странице: секунды до минуты, дальше м:сс. Прочерк — если не досказано. */
function fmtDwell(ms: number | null): string {
  if (ms == null) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} с`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
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

  const maxDailyHits = data ? Math.max(...data.daily.map(d => d.hits), 1) : 1;
  const maxPathHits = data ? Math.max(...data.top_paths.map(p => p.hits), 1) : 1;
  const maxEdgeHits = data ? Math.max(...data.edges.map(e => e.hits), 1) : 1;

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Footprints className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Посещаемость и поведение</h1>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        Первичный счётчик платформы (page_views), только люди — краулеры
        помечаются и вынесены отдельной строкой. Уникальные — по суточному хэшу,
        сырые IP не хранятся. За неделю и месяц это <b>человеко-дни</b>, а не
        разные люди: хэш меняется каждые сутки, длинный профиль не строится
        намеренно. Пути /hub/admin и служебные не учитываются.
        {data?.uniques_since && (
          <> Уникальные считаются с {fmtDate(data.uniques_since)} (раньше хэш не
          писался, ретроактивно посчитать нельзя — только просмотры).</>
        )}
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
            {[
              { label: 'Сегодня', hits: data.totals.today.hits, sub: `${data.totals.today.uniques.toLocaleString('ru-RU')} уникальных` },
              { label: '7 дней', hits: data.totals.week.hits, sub: `${data.totals.week.visitorDays.toLocaleString('ru-RU')} человеко-дней` },
              { label: '30 дней', hits: data.totals.month.hits, sub: `${data.totals.month.visitorDays.toLocaleString('ru-RU')} человеко-дней` },
            ].map(k => (
              <div key={k.label} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
                <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">{k.label}</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold font-mono text-[var(--text-primary)]">{k.hits.toLocaleString('ru-RU')}</span>
                  <span className="text-xs text-[var(--text-secondary)]">просмотров</span>
                </div>
                <p className="text-xs text-[var(--ocean)] mt-0.5">{k.sub}</p>
              </div>
            ))}
          </div>

          {/* Роботы и глубина визита — два вопроса к любому счётчику */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3 flex items-center gap-3">
              <Bot className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-[var(--text-primary)]">
                  <span className="font-mono font-semibold">{data.bots.month_hits.toLocaleString('ru-RU')}</span> просмотров за 30 дней — краулеры
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {pct(data.bots.month_hits, data.bots.month_hits + data.totals.month.hits)}% всего трафика. В цифры выше не входят
                </p>
              </div>
            </div>
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3 flex items-center gap-3">
              <Layers className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-[var(--text-primary)]">
                  Глубина визита{' '}
                  <span className="font-mono font-semibold">{data.sessions.avgDepth ?? '—'}</span> страниц
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {data.sessions.total > 0
                    ? `${pct(data.sessions.onePage, data.sessions.total)}% визитов — одна страница и уход (${data.sessions.total.toLocaleString('ru-RU')} визитов)`
                    : 'Визиты копятся с момента деплоя счётчика поведения'}
                </p>
              </div>
            </div>
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

          {/* Карта внутренних переходов */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Карта переходов · 30 дней</p>
            {data.edges.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                Переходы копятся с момента деплоя: у прежних записей не было визита и предыдущего пути.
              </p>
            ) : (
              <div className="space-y-1.5">
                {data.edges.map(e => (
                  <div key={`${e.from}->${e.to}`} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[var(--text-muted)] flex-1 truncate text-right" title={e.from}>{e.from}</span>
                    <ArrowRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                    <span className="text-xs font-mono text-[var(--text-secondary)] flex-1 truncate" title={e.to}>{e.to}</span>
                    <div className="w-16 h-3.5 bg-[var(--bg-hover)] rounded overflow-hidden shrink-0">
                      <div className="h-full bg-[var(--ocean)] rounded" style={{ width: `${(e.hits / maxEdgeHits) * 100}%` }} />
                    </div>
                    <span className="text-xs font-mono text-[var(--text-primary)] w-10 text-right shrink-0">{e.hits}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Поведение на странице */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">Поведение на странице · 30 дней</p>
            <p className="text-[11px] text-[var(--text-muted)] mb-3">
              Время — медиана видимой вкладки, не среднее: одна забытая вкладка сдвигает среднее в выдумку.
              Уход — визит закончился на этой странице.
            </p>
            {data.pages.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Данных пока мало — нужно хотя бы три просмотра страницы.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th className="text-left font-medium pb-2">Страница</th>
                      <th className="text-right font-medium pb-2">Просмотры</th>
                      <th className="text-right font-medium pb-2">Время</th>
                      <th className="text-right font-medium pb-2">Уход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pages.map(p => (
                      <tr key={p.path} className="border-t border-[var(--border)]">
                        <td className="py-1.5 pr-3 font-mono text-[var(--text-secondary)] max-w-0 truncate" title={p.path}>{p.path}</td>
                        <td className="py-1.5 text-right font-mono text-[var(--text-primary)] tabular-nums">{p.views}</td>
                        <td className="py-1.5 text-right font-mono text-[var(--text-primary)] tabular-nums">{fmtDwell(p.medianMs)}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums" style={{ color: pct(p.exits, p.views) >= 70 ? 'var(--warning)' : 'var(--text-primary)' }}>
                          {pct(p.exits, p.views)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Ошибки поведения */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <TriangleAlert className="w-3.5 h-3.5 text-[var(--warning)]" />
              <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Не найдено · 30 дней</p>
            </div>
            {data.not_found.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Заходов на несуществующие адреса не зафиксировано.</p>
            ) : (
              <div className="space-y-1.5">
                {data.not_found.map(n => (
                  <div key={n.path} className="flex items-center gap-3">
                    <span className="text-xs font-mono text-[var(--text-secondary)] flex-1 truncate" title={n.path}>{n.path}</span>
                    <span className="text-xs font-mono text-[var(--text-primary)] shrink-0">{n.hits}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
