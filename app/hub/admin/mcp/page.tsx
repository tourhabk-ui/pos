'use client';

/**
 * Запросы через MCP — четвёртый канал, который до сих пор был невидим.
 *
 * Журнал вызовов заведён миграцией 861, пишется из `lib/mcp/call-log.ts`,
 * срез для админки написан в `/api/admin/analytics/mcp`. Не хватало ровно
 * одного звена: страницы. Владелец 17.08: «я в админке не вижу запросы через
 * MCP, хотя это обсуждалось и реализовывалось» — и он прав, данные копились
 * в таблицу, посмотреть их можно было только запросом руками.
 *
 * Что здесь ЕСТЬ и чего сознательно НЕТ.
 *
 * Аргументы вызовов не пишутся и показать их нельзя: в них уходят имена,
 * телефоны и даты туристов, а MCP зовут снаружи (152-ФЗ, см. комментарий
 * миграции 861). Поэтому страница отвечает на вопросы «зовут ли», «что
 * зовут», «ломается ли», «сколько занимает» — и молчит о содержании.
 *
 * `caller_days` — человеко-дни, а не люди: хеш вызывающего суточный, тот же
 * приём, что в page_views. Подписано прямо на экране, потому что «уникальных
 * вызывающих: 40» читается как сорок клиентов, а это может быть один за сорок
 * дней. Число, которое понимают неверно, хуже отсутствующего.
 *
 * Пустая таблица — это состояние «канал молчит», а не поломка страницы, и
 * названо словами: тишина в MCP значит, что нас не зовут, и знать об этом
 * важнее, чем видеть пустую сетку.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, AlertTriangle } from 'lucide-react';

interface ToolRow {
  tool: string;
  calls_7d: number;
  errors_7d: number;
  calls_30d: number;
  errors_30d: number;
  avg_ms: number | null;
  max_ms: number | null;
  caller_days_30d: number;
}

/** Род вызова: откуда он на самом деле (решение владельца 02.10). */
const ORIGIN_LABELS: Record<string, string> = { self: 'свой', probe: 'проверка', external: 'внешний' };

/** Камчатские сутки: calls/errors/caller_days — внешние; self и probe — рядом, чтобы видеть, чей всплеск. */
interface DayRow { day: string; calls: number; errors: number; caller_days: number; self: number; probe: number }
interface ErrorRow { kind: string; d30: number }
interface UnknownToolRow { requested_tool: string; d30: number; last_seen: string }
/** Ошибка с причиной (1143): код и главный аргумент; error_code пуст у строк до миграции. */
interface ErrorDetailRow { tool: string; error_kind: string | null; error_code: string | null; arg_key: string | null; arg_value: string | null; n: number; last_at: string }
interface ClientRow {
  client: string;
  /** Откуда известно имя: представился сам, опознан по заголовку или никак. */
  kind: string;
  /** external — внешний спрос; self — метка владельца; probe — смоук, пробы, curl. */
  origin?: 'external' | 'self' | 'probe' | string;
  calls: number;
  caller_days: number;
  last_seen: string | null;
}

interface McpData {
  by_tool_30d: ToolRow[];
  /** 30 камчатских суток подряд, тихие дни — нулями; последняя строка — сегодня (неполные сутки). */
  daily_30d: DayRow[];
  errors_by_kind_30d: ErrorRow[];
  /** Имена несуществующих инструментов, которые просили (миграция 1141); до неё поля нет — массив пуст. */
  unknown_tools_30d?: UnknownToolRow[];
  /** Ошибки с причиной и аргументом (миграция 1143); до неё — пустой код. */
  errors_detail_30d?: ErrorDetailRow[];
  by_client_30d: ClientRow[];
  /** Внешние / свои / проверки за 30 дней (02.10). self_since — с какого дня метка владельца ставилась. */
  origins_30d?: { external: number; self: number; probe: number; self_since: string | null };
  window_note: string;
}

/** Человеческое имя рода ошибки: коды журнала наружу не объясняют себя. */
const ERROR_KIND_LABELS: Record<string, string> = {
  rate_limited: 'Превышен лимит запросов',
  execution: 'Инструмент упал при выполнении (наш сбой)',
  refused: 'Отказ по входу: телефон, согласие, пустая заявка, не те аргументы',
  unknown_tool: 'Запрошен несуществующий инструмент',
};

function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

export default function AdminMcpPage() {
  const [data, setData] = useState<McpData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/analytics/mcp');
      const json = await res.json();
      // Срез отвечает данными без обёртки success — ошибку опознаём по полю
      // error и по коду ответа, а не по её отсутствию.
      if (!res.ok || json.error) setError(typeof json.error === 'string' ? json.error : 'Не удалось загрузить срез MCP');
      else setData(json as McpData);
    } catch {
      setError('Не удалось загрузить срез MCP — похоже, связь');
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totals = data
    ? data.by_tool_30d.reduce(
        (acc, r) => ({
          calls7: acc.calls7 + r.calls_7d,
          calls30: acc.calls30 + r.calls_30d,
          errors30: acc.errors30 + r.errors_30d,
        }),
        { calls7: 0, calls30: 0, errors30: 0 },
      )
    : null;

  const days = data?.daily_30d ?? [];
  const maxDaily = Math.max(...days.map(d => d.calls + d.self + d.probe), 1);
  const today = days.length > 0 ? days[days.length - 1] : null;
  const yesterday = days.length > 1 ? days[days.length - 2] : null;
  const silent = data !== null && data.by_tool_30d.length === 0;

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Plug className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Запросы через MCP</h1>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>

      <p className="text-xs text-[var(--text-muted)] max-w-2xl">
        Журнал фактов вызова инструментов внешними клиентами: что звали, чем кончилось,
        сколько заняло. Аргументы не пишутся — в них уходят имена и телефоны туристов,
        а канал внешний. Таблицы ниже — только внешние вызовы: свои (метка владельца в
        адресе коннектора) и проверки (смоук деплоя, пробы, curl) вынесены отдельными числами.
      </p>

      {loading && (
        <div className="ds-skeleton h-24 rounded-lg" />
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
          <p className="text-xs text-[var(--text-secondary)]">{error}</p>
        </div>
      )}

      {data && !loading && (
        <>
          {silent ? (
            <div className="p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
              <p className="text-sm font-medium text-[var(--text-primary)]">Канал молчит</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 max-w-xl">
                За 30 дней ни одного вызова. Это не поломка страницы: журнал пишется при
                каждом обращении к <code>/api/mcp</code>. Пустая таблица значит, что
                внешние клиенты нас не зовут.
              </p>
            </div>
          ) : (
            <>
              {today && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Внешних сегодня', value: today.calls, sub: `ошибок ${today.errors} · человеко-дней ${today.caller_days}` },
                    { label: 'Внешних вчера', value: yesterday?.calls ?? 0, sub: `ошибок ${yesterday?.errors ?? 0} · человеко-дней ${yesterday?.caller_days ?? 0}` },
                    { label: 'Сегодня своих / проверок', value: `${today.self} / ${today.probe}`, sub: 'в число внешних не входят' },
                  ].map(k => (
                    <div key={k.label} className="p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                      <p className="text-xs text-[var(--text-muted)]">{k.label}</p>
                      <p className="text-xl font-semibold text-[var(--text-primary)] mt-0.5">{k.value}</p>
                      <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{k.sub}</p>
                    </div>
                  ))}
                  <p className="col-span-3 text-[10px] text-[var(--text-muted)]">
                    Сутки камчатские (UTC+12): «сегодня» — с полуночи по Камчатке до этой минуты, сутки ещё не закончились.
                  </p>
                </div>
              )}

              {data.origins_30d && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Внешних за 30 дней', value: data.origins_30d.external },
                    { label: 'Своих (метка владельца)', value: data.origins_30d.self },
                    { label: 'Проверок (смоук, пробы, curl)', value: data.origins_30d.probe },
                  ].map(k => (
                    <div key={k.label} className="p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                      <p className="text-xs text-[var(--text-muted)]">{k.label}</p>
                      <p className="text-xl font-semibold text-[var(--text-primary)] mt-0.5">{k.value}</p>
                    </div>
                  ))}
                  <p className="col-span-3 text-[10px] text-[var(--text-muted)]">
                    {data.origins_30d.self_since
                      ? <>Метка «свой» ставится с {data.origins_30d.self_since}: вызовы раньше этого дня в числе внешних неотличимы от своих.</>
                      : <>Метка «свой» ещё ни разу не ставилась: свои вызовы пока сидят в числе внешних. Нужны MCP_SELF_TAG в env и ?self=&lt;метка&gt; в адресе коннектора.</>}
                  </p>
                </div>
              )}

              {totals && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Внешних за 7 дней', value: totals.calls7 },
                    { label: 'Внешних за 30 дней', value: totals.calls30 },
                    { label: 'Из них с ошибкой', value: totals.errors30 },
                  ].map(k => (
                    <div key={k.label} className="p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                      <p className="text-xs text-[var(--text-muted)]">{k.label}</p>
                      <p className="text-xl font-semibold text-[var(--text-primary)] mt-0.5">{k.value}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
                <p className="px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] border-b border-[var(--border)]">
                  По инструментам, 30 дней
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[var(--text-muted)]">
                        <th className="px-3 py-2 font-medium">Инструмент</th>
                        <th className="px-3 py-2 font-medium text-right">7 дн.</th>
                        <th className="px-3 py-2 font-medium text-right">30 дн.</th>
                        <th className="px-3 py-2 font-medium text-right">Ошибок</th>
                        <th className="px-3 py-2 font-medium text-right">Среднее</th>
                        <th className="px-3 py-2 font-medium text-right">Худшее</th>
                        <th className="px-3 py-2 font-medium text-right">Человеко-дней</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_tool_30d.map(r => (
                        <tr key={r.tool} className="border-t border-[var(--border)]">
                          <td className="px-3 py-2 text-[var(--text-primary)] font-medium">{r.tool}</td>
                          <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{r.calls_7d}</td>
                          <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{r.calls_30d}</td>
                          <td className="px-3 py-2 text-right"
                            style={{ color: r.errors_30d > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                            {r.errors_30d}
                          </td>
                          <td className="px-3 py-2 text-right text-[var(--text-secondary)]">
                            {r.avg_ms === null ? '—' : `${r.avg_ms} мс`}
                          </td>
                          <td className="px-3 py-2 text-right text-[var(--text-secondary)]">
                            {r.max_ms === null ? '—' : `${r.max_ms} мс`}
                          </td>
                          <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{r.caller_days_30d}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
                <p className="text-xs font-semibold text-[var(--text-secondary)] mb-1">Динамика по дням, 30 дней</p>
                <div className="flex flex-wrap gap-3 mb-2 text-[10px] text-[var(--text-muted)]">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: 'var(--ocean)' }} />внешние</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: 'var(--danger)' }} />из них с ошибкой</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: 'var(--accent)' }} />свои</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: 'var(--text-muted)' }} />проверки</span>
                </div>
                {days.every(d => d.calls + d.self + d.probe === 0) ? (
                  <p className="text-xs text-[var(--text-muted)]">За 30 дней вызовов не было.</p>
                ) : (
                  <>
                    <div className="flex items-end gap-px h-28">
                      {days.map((d, i) => {
                        const total = d.calls + d.self + d.probe;
                        const pct = (n: number) => `${(n / maxDaily) * 100}%`;
                        return (
                          <div
                            key={d.day}
                            className="flex-1 h-full flex flex-col justify-end"
                            title={`${fmtDay(d.day)}${i === days.length - 1 ? ' (сегодня, неполные сутки)' : ''}: внешних ${d.calls}, ошибок ${d.errors}, своих ${d.self}, проверок ${d.probe}`}
                          >
                            {total === 0 && <div className="w-full h-px bg-[var(--border)]" />}
                            <div className="w-full" style={{ height: pct(d.probe), background: 'var(--text-muted)', opacity: 0.5 }} />
                            <div className="w-full" style={{ height: pct(d.self), background: 'var(--accent)' }} />
                            <div className="w-full" style={{ height: pct(d.calls - d.errors), background: 'var(--ocean)' }} />
                            <div className="w-full rounded-b-sm" style={{ height: pct(d.errors), background: 'var(--danger)' }} />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between mt-1 text-[10px] text-[var(--text-muted)]">
                      <span>{days.length > 0 ? fmtDay(days[0].day) : ''}</span>
                      <span>{days.length > 15 ? fmtDay(days[15].day) : ''}</span>
                      <span>сегодня</span>
                    </div>
                  </>
                )}
                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[var(--text-muted)]">
                        <th className="px-2 py-1 font-medium">День</th>
                        <th className="px-2 py-1 font-medium text-right">Внешних</th>
                        <th className="px-2 py-1 font-medium text-right">Ошибок</th>
                        <th className="px-2 py-1 font-medium text-right">Чел.-дней</th>
                        <th className="px-2 py-1 font-medium text-right">Своих</th>
                        <th className="px-2 py-1 font-medium text-right">Проверок</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...days].reverse().slice(0, 14).map((d, i) => (
                        <tr key={d.day} className="border-t border-[var(--border)]">
                          <td className="px-2 py-1 text-[var(--text-secondary)]">{i === 0 ? `${fmtDay(d.day)}, сегодня` : fmtDay(d.day)}</td>
                          <td className="px-2 py-1 text-right text-[var(--text-primary)]">{d.calls}</td>
                          <td className="px-2 py-1 text-right" style={{ color: d.errors > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{d.errors}</td>
                          <td className="px-2 py-1 text-right text-[var(--text-secondary)]">{d.caller_days}</td>
                          <td className="px-2 py-1 text-right text-[var(--text-secondary)]">{d.self}</td>
                          <td className="px-2 py-1 text-right text-[var(--text-muted)]">{d.probe}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">Таблица — последние 14 дней; весь месяц — на графике.</p>
                </div>
              </div>

              {(data.by_client_30d ?? []).length > 0 && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-1">Кто звал, 30 дней</p>
                  {/*
                    Имя приходит из самопредставления клиента при рукопожатии
                    MCP — это имя ПРОГРАММЫ, не человека. Откуда оно известно,
                    сказано прямо: «представился» и «по заголовку» — разной
                    надёжности ответы, и путать их нельзя.
                  */}
                  <p className="text-[10px] text-[var(--text-muted)] mb-2">
                    Клиент называет себя сам при подключении. Заголовок — запасной ответ, когда рукопожатия не было.
                  </p>
                  <ul className="space-y-1">
                    {data.by_client_30d.map(c => (
                      <li key={`${c.client}:${c.kind}:${c.origin ?? ''}`} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-[var(--text-secondary)] truncate">
                          {c.client}
                          <span className="text-[10px] text-[var(--text-muted)] ml-2">{c.kind}</span>
                          {c.origin && c.origin !== 'external' && (
                            <span className="text-[10px] ml-2" style={{ color: 'var(--warning)' }}>
                              {ORIGIN_LABELS[c.origin] ?? c.origin}
                            </span>
                          )}
                        </span>
                        <span className="text-[var(--text-primary)] font-medium shrink-0">{c.calls}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(data.errors_detail_30d ?? []).length > 0 && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
                  <p className="px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] border-b border-[var(--border)]">
                    Ошибки с причиной, 30 дней
                  </p>
                  <p className="px-3 pt-2 text-[10px] text-[var(--text-muted)]">
                    Код причины и главный аргумент пишутся с миграции 1143; у строк раньше неё
                    причина пуста. Значение аргумента есть только у читающих инструментов и
                    никогда не бывает телефоном или именем.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[var(--text-muted)]">
                          <th className="px-3 py-2 font-medium">Инструмент</th>
                          <th className="px-3 py-2 font-medium">Род</th>
                          <th className="px-3 py-2 font-medium">Причина</th>
                          <th className="px-3 py-2 font-medium">Аргумент</th>
                          <th className="px-3 py-2 font-medium text-right">Раз</th>
                          <th className="px-3 py-2 font-medium text-right">Последний</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.errors_detail_30d ?? []).map((e, i) => (
                          <tr key={i} className="border-t border-[var(--border)]">
                            <td className="px-3 py-2 text-[var(--text-primary)] font-medium">{e.tool}</td>
                            <td className="px-3 py-2 text-[var(--text-secondary)]">{e.error_kind ? (ERROR_KIND_LABELS[e.error_kind] ?? e.error_kind) : '—'}</td>
                            <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">{e.error_code ?? <span className="text-[var(--text-muted)]">не записана</span>}</td>
                            <td className="px-3 py-2 text-[var(--text-secondary)]">
                              {e.arg_key ? <>{e.arg_key}{e.arg_value ? <span className="text-[var(--text-muted)]"> = {e.arg_value}</span> : null}</> : '—'}
                            </td>
                            <td className="px-3 py-2 text-right text-[var(--text-primary)] font-medium">{e.n}</td>
                            <td className="px-3 py-2 text-right text-[var(--text-muted)]">{e.last_at}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {data.errors_by_kind_30d.length > 0 && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Ошибки по роду, 30 дней</p>
                  <ul className="space-y-1">
                    {data.errors_by_kind_30d.map(e => (
                      <li key={e.kind} className="flex items-baseline justify-between text-xs">
                        <span className="text-[var(--text-secondary)]">
                          {ERROR_KIND_LABELS[e.kind] ?? e.kind}
                        </span>
                        <span className="text-[var(--text-primary)] font-medium">{e.d30}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(data.unknown_tools_30d ?? []).length > 0 && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-1">Какие несуществующие инструменты просили, 30 дней</p>
                  <p className="text-[11px] text-[var(--text-muted)] mb-2">
                    Имя из запроса клиента, если похоже на идентификатор. Чаще всего это старое имя из чужого каталога или llms.txt — повод для алиаса или правки описания.
                  </p>
                  <ul className="space-y-1">
                    {(data.unknown_tools_30d ?? []).map(u => (
                      <li key={u.requested_tool} className="flex items-baseline justify-between text-xs gap-3">
                        <span className="font-mono text-[var(--text-secondary)] truncate">{u.requested_tool}</span>
                        <span className="text-[var(--text-muted)] shrink-0">{u.last_seen}</span>
                        <span className="text-[var(--text-primary)] font-medium shrink-0">{u.d30}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <p className="text-xs text-[var(--text-muted)] max-w-2xl">{data.window_note}</p>
        </>
      )}
    </div>
  );
}
