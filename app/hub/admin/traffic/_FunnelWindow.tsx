'use client';

/**
 * Воронка за день / вчера / 7 / 30 суток / любой прошлый день — и по суткам.
 *
 * Владелец 29.09: «хочу смотреть не только аналитику за 7 дней, но и за день».
 * Цифры считает `lib/analytics/funnel-window` (тот же модуль, что у крон-
 * переписи), сутки — камчатские.
 *
 * Правила экрана:
 *  - нет данных (`null`) — «нет данных», а не 0: ноль — факт о туристах,
 *    «не смог сосчитать» — факт о нас (§4.0);
 *  - процентов между шагами нет: «просмотры тура» — события, «визиты» — люди,
 *    и их отношение — не конверсия;
 *  - на нескольких сутках «визиты» — человеко-дни, и экран так и пишет;
 *  - сутки ещё идут — об этом сказано словами.
 */

import React, { useEffect, useState } from 'react';
import { CalendarDays, RefreshCw, Filter, TriangleAlert } from 'lucide-react';
import { internalHref } from '@/lib/analytics/traffic-links';
import { fmtKamchatka, kamchatkaDate, ruShort } from '@/lib/analytics/kamchatka-day';
// Подписи статусов заявок — те же, что в CRM: второй словарь разошёлся бы с первым.
import { STATUS_META } from '@/app/hub/admin/leads/_LeadsClient';

type Range = 'today' | 'yesterday' | '7d' | '30d';
type Selection = { range: Range } | { date: string };

interface Counts {
  visits: number | null; tour_views: number | null; booking_starts: number | null;
  leads: number | null; bookings: number | null; paid: number | null;
}
interface Report {
  window: {
    kind: 'day' | 'rolling'; label: string; date: string | null; days: number | null;
    partial: boolean; visitor_unit: 'people' | 'visitor_days';
  };
  counts: Counts;
  bot_views: number | null;
  verdict: { title: string; severity: string; suggestion: string } | null;
  verdict_state: 'unknown' | 'broken_link' | 'insufficient_sample' | 'no_broken_link';
  unknown_inputs: string[];
  insufficient_sample: string | null;
  failed_measures: Array<{ measure: string; error: string | null }>;
  liveness: {
    views_last_at: string | null; views_rows_total: number | null;
    beacon_last_at: string | null; beacon_rows_total: number | null;
  };
  top_paths: Array<{ path: string; views: number; visitors: number }> | null;
  tour_entry_edges: Array<{ from_path: string | null; views: number }> | null;
  leads_by_status: Array<{ status: string | null; n: number }> | null;
  bookings_by_status: Array<{ booking_status: string | null; n: number }> | null;
}
interface DayRow extends Counts { date: string; partial: boolean }
interface Payload {
  generated_at: string;
  report: Report;
  daily: DayRow[];
  daily_failed: Array<{ measure: string; error: string }>;
}

const RANGES: Array<{ id: Range; label: string }> = [
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
];

/** Число или честное «нет данных». */
function num(v: number | null): string {
  return v === null ? 'нет данных' : v.toLocaleString('ru-RU');
}

function cell(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('ru-RU');
}

/**
 * Статус заявки словами CRM. Незнакомый остаётся как есть: придуманный перевод
 * назвал бы не то состояние; пустой — «без статуса», а не «новая».
 */
function leadStatusLabel(status: string | null): string {
  if (!status) return 'без статуса';
  const meta = (STATUS_META as Record<string, { label: string } | undefined>)[status];
  return meta ? meta.label : status;
}

function queryOf(sel: Selection): string {
  return 'range' in sel ? `range=${sel.range}` : `date=${encodeURIComponent(sel.date)}`;
}

export default function FunnelWindow() {
  const [sel, setSel] = useState<Selection>({ range: 'today' });
  // «Обновить» — тот же запрос ещё раз: меняется только счётчик.
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{ key: string; error: string | null } | null>(null);
  // Последний удавшийся ответ остаётся на экране, пока грузится следующий.
  const [data, setData] = useState<Payload | null>(null);

  const query = queryOf(sel);
  const key = `${query}#${nonce}`;
  // Загрузка — не отдельное состояние, а «ответа на ТЕКУЩИЙ ключ ещё нет»: так
  // ответ на прежний выбор не может затереть новый и не нужен счётчик гонки.
  const settled = result?.key === key;
  const loading = !settled;
  const error = settled ? result.error : null;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/analytics/funnel-window?${query}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success) {
          setData(json.data as Payload);
          setResult({ key: `${query}#${nonce}`, error: null });
        } else {
          setResult({ key: `${query}#${nonce}`, error: json.error ?? 'Не удалось прочитать воронку' });
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ key: `${query}#${nonce}`, error: 'Не удалось прочитать воронку' });
      });
    return () => { cancelled = true; };
  }, [query, nonce]);

  const today = kamchatkaDate(new Date());
  const activeRange = 'range' in sel ? sel.range : null;
  const activeDate = 'date' in sel ? sel.date : null;
  const r = data?.report;

  const steps: Array<{ key: keyof Counts; label: string; hint: string }> = r ? [
    { key: 'visits', label: 'Визиты', hint: r.window.visitor_unit === 'people' ? 'люди (суточный хэш)' : 'человеко-дни, не разные люди' },
    { key: 'tour_views', label: 'Просмотры туров', hint: 'открытий карточки тура' },
    { key: 'booking_starts', label: 'Начали бронь', hint: 'первое касание формы' },
    { key: 'leads', label: 'Заявки', hint: 'оставили контакт' },
    { key: 'bookings', label: 'Брони', hint: 'создано в системе' },
    { key: 'paid', label: 'Оплаты', hint: 'оплачено' },
  ] : [];

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-[var(--ocean)]" />
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Воронка за период</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Период" className="flex rounded-md border border-[var(--border)] overflow-hidden">
            {RANGES.map((x) => (
              <button
                key={x.id}
                type="button"
                aria-pressed={activeRange === x.id}
                onClick={() => setSel({ range: x.id })}
                className={`px-2.5 py-1.5 text-xs transition-colors ${
                  activeRange === x.id
                    ? 'bg-[var(--accent)] text-[var(--bg-card)]'
                    : 'bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {x.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <CalendarDays className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <span>День</span>
            <input
              type="date"
              value={activeDate ?? ''}
              max={today}
              aria-label="Выбрать день"
              onChange={(e) => { if (e.target.value) setSel({ date: e.target.value }); }}
              className="px-2 py-1 text-xs bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border)] rounded-md"
            />
          </label>
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Обновить
          </button>
        </div>
      </div>

      {error ? (
        <div className="border border-[var(--danger)]/30 rounded-lg p-4 text-center" role="alert">
          <p className="text-[var(--danger)] text-sm mb-2">{error}</p>
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="px-3 py-1.5 border border-[var(--danger)]/30 text-[var(--danger)] rounded-md text-xs hover:bg-[var(--bg-hover)] transition-colors"
          >
            Повторить
          </button>
        </div>
      ) : loading && !data ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 bg-[var(--bg-hover)] rounded-lg animate-pulse" />
          ))}
        </div>
      ) : r && data && (
        <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <p className="text-sm font-semibold text-[var(--text-primary)]">{r.window.label}</p>
          <p className="text-[11px] text-[var(--text-muted)] mb-3">
            {r.window.partial && 'Сутки ещё не закончились — цифры вырастут. '}
            Обновлено {fmtKamchatka(data.generated_at) ?? '—'} по Камчатке.
          </p>

          {r.failed_measures.length > 0 && (
            <div className="flex items-start gap-2 border border-[var(--warning)]/40 rounded-lg px-3 py-2 mb-3" role="status">
              <TriangleAlert className="w-3.5 h-3.5 text-[var(--warning)] mt-0.5 shrink-0" />
              <p className="text-xs text-[var(--text-secondary)]">
                Не удалось сосчитать: {r.failed_measures.map((m) => m.measure).join(', ')}. Эти клетки показаны как «нет данных», а не нулём.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {steps.map((s) => {
              const v = r.counts[s.key];
              return (
                <div key={s.key} className="border border-[var(--border)] rounded-lg px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{s.label}</p>
                  <p className={`font-mono font-semibold tabular-nums ${v === null ? 'text-sm text-[var(--text-muted)] pt-1.5' : 'text-xl text-[var(--text-primary)]'}`}>
                    {num(v)}
                  </p>
                  <p className="text-[10px] text-[var(--text-muted)]">{s.hint}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-3 space-y-1">
            <p className="text-xs text-[var(--text-secondary)]">
              {r.verdict_state === 'broken_link' && r.verdict
                ? `${r.verdict.title}. ${r.verdict.suggestion}`
                : r.verdict_state === 'insufficient_sample'
                  ? `Оценка воронки: ${(r.insufficient_sample ?? 'наблюдений слишком мало, чтобы судить').replace(/[.\s]+$/, '')}.${r.window.kind === 'day' ? ' На одних сутках это обычное дело — смотрите неделю.' : ''}`
                  : r.verdict_state === 'unknown'
                    ? `Не смог оценить воронку: не сосчитано ${r.unknown_inputs.join(', ')}.`
                    : `Сломанного звена не видно. За окно: заявок ${num(r.counts.leads)}, броней ${num(r.counts.bookings)}, оплат ${num(r.counts.paid)}${(r.counts.bookings ?? 0) === 0 ? ' — до брони в системе поток пока не дошёл' : ''}.`}
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              {r.bot_views !== null && `Краулеры: ${r.bot_views.toLocaleString('ru-RU')} просмотров — в цифры выше не входят. `}
              Последний просмотр записан: {fmtKamchatka(r.liveness.views_last_at) ?? 'нет данных'}
              {'; '}
              последнее касание формы брони: {fmtKamchatka(r.liveness.beacon_last_at) ?? 'нет данных'}.
            </p>
          </div>

          {(r.leads_by_status?.length || r.bookings_by_status?.length) ? (
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              {r.leads_by_status && r.leads_by_status.length > 0 && (
                <>Заявки по статусам: {r.leads_by_status.map((x) => `${leadStatusLabel(x.status)} — ${x.n}`).join(', ')}. </>
              )}
              {r.bookings_by_status && r.bookings_by_status.length > 0 && (
                <>Брони по статусам: {r.bookings_by_status.map((x) => `${x.booking_status ?? 'без статуса'} — ${x.n}`).join(', ')}.</>
              )}
            </p>
          ) : null}
        </div>
      )}

      {data && (
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">По дням · 14 суток по Камчатке</p>
          {data.daily_failed.length > 0 && (
            <p className="text-[11px] text-[var(--warning)] mb-2">
              Не сосчитано: {data.daily_failed.map((m) => m.measure).join(', ')} — прочерк вместо нуля.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  <th className="text-left font-medium pb-2">День</th>
                  <th className="text-right font-medium pb-2">Визиты</th>
                  <th className="text-right font-medium pb-2">Просм. туров</th>
                  <th className="text-right font-medium pb-2">Начали бронь</th>
                  <th className="text-right font-medium pb-2">Заявки</th>
                  <th className="text-right font-medium pb-2">Брони</th>
                  <th className="text-right font-medium pb-2">Оплаты</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => {
                  const on = activeDate === d.date || (d.partial && activeRange === 'today');
                  return (
                    <tr key={d.date} className={`border-t border-[var(--border)] ${on ? 'bg-[var(--bg-hover)]' : ''}`}>
                      <td className="py-1.5 pr-3">
                        <button
                          type="button"
                          onClick={() => setSel(d.partial ? { range: 'today' } : { date: d.date })}
                          aria-label={`Показать воронку за ${ruShort(d.date)}`}
                          className="font-mono text-[var(--text-secondary)] hover:text-[var(--ocean)] hover:underline underline-offset-2"
                        >
                          {ruShort(d.date)}
                        </button>
                        {d.partial && <span className="text-[var(--text-muted)]"> · идёт</span>}
                      </td>
                      {([d.visits, d.tour_views, d.booking_starts, d.leads, d.bookings, d.paid] as Array<number | null>).map((v, i) => (
                        <td
                          key={i}
                          title={v === null ? 'не сосчитано' : undefined}
                          className={`py-1.5 text-right font-mono tabular-nums ${v === null ? 'text-[var(--text-muted)]' : v === 0 ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}
                        >
                          {cell(v)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] mt-2">
            Нажмите на дату — воронка откроется за эти сутки. Визиты по дням — люди (суточный хэш), поэтому суммировать столбец нельзя: один человек в два дня даст двух.
          </p>
        </div>
      )}

      {r && (r.top_paths?.length || r.tour_entry_edges?.length) ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Куда ходили · {r.window.label}</p>
            <div className="space-y-1">
              {(r.top_paths ?? []).slice(0, 10).map((p) => {
                const href = internalHref(p.path);
                return (
                  <div key={p.path} className="flex items-center gap-3">
                    {href
                      ? <a href={href} target="_blank" rel="noopener" className="text-xs font-mono text-[var(--text-secondary)] flex-1 truncate hover:text-[var(--ocean)] hover:underline underline-offset-2" title={p.path}>{p.path}</a>
                      : <span className="text-xs font-mono text-[var(--text-secondary)] flex-1 truncate" title={p.path}>{p.path}</span>}
                    <span className="text-xs font-mono text-[var(--text-primary)] w-10 text-right shrink-0 tabular-nums">{p.views}</span>
                    <span className="text-xs font-mono text-[var(--ocean)] w-10 text-right shrink-0 tabular-nums">{p.visitors}</span>
                  </div>
                );
              })}
              <p className="text-[10px] text-[var(--text-muted)] text-right">просмотры · люди</p>
            </div>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Откуда пришли в карточку тура</p>
            {(r.tour_entry_edges ?? []).length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">За этот период в карточки туров не заходили.</p>
            ) : (
              <div className="space-y-1">
                {(r.tour_entry_edges ?? []).slice(0, 10).map((e, i) => (
                  <div key={`${e.from_path ?? 'direct'}-${i}`} className="flex items-center gap-3">
                    <span className="text-xs font-mono text-[var(--text-secondary)] flex-1 truncate" title={e.from_path ?? undefined}>
                      {e.from_path ?? 'напрямую или без источника'}
                    </span>
                    <span className="text-xs font-mono text-[var(--text-primary)] w-10 text-right shrink-0 tabular-nums">{e.views}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
