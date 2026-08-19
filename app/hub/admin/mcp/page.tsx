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

interface DayRow { day: string; calls: number; errors: number; caller_days: number }
interface ErrorRow { kind: string; d30: number }
interface ClientRow {
  client: string;
  /** Откуда известно имя: представился сам, опознан по заголовку или никак. */
  kind: string;
  calls: number;
  caller_days: number;
  last_seen: string | null;
}

interface McpData {
  by_tool_30d: ToolRow[];
  daily_14d: DayRow[];
  errors_by_kind_30d: ErrorRow[];
  by_client_30d: ClientRow[];
  window_note: string;
}

/** Человеческое имя рода ошибки: коды журнала наружу не объясняют себя. */
const ERROR_KIND_LABELS: Record<string, string> = {
  rate_limited: 'Превышен лимит запросов',
  execution: 'Инструмент упал при выполнении',
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

  const maxDaily = data ? Math.max(...data.daily_14d.map(d => d.calls), 1) : 1;
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
        а канал внешний.
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
              {totals && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Вызовов за 7 дней', value: totals.calls7 },
                    { label: 'Вызовов за 30 дней', value: totals.calls30 },
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
                <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Динамика, 14 дней</p>
                {data.daily_14d.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">За две недели вызовов не было.</p>
                ) : (
                  <div className="flex items-end gap-1 h-24">
                    {data.daily_14d.map(d => (
                      <div key={d.day} className="flex-1 flex flex-col items-center gap-1" title={`${d.day}: ${d.calls} вызовов, ошибок ${d.errors}`}>
                        <div className="w-full rounded-t transition-all duration-200"
                          style={{
                            height: `${Math.max((d.calls / maxDaily) * 100, 3)}%`,
                            background: d.errors > 0 ? 'var(--warning)' : 'var(--ocean)',
                          }} />
                        <span className="text-[10px] text-[var(--text-muted)]">{fmtDay(d.day)}</span>
                      </div>
                    ))}
                  </div>
                )}
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
                      <li key={`${c.client}:${c.kind}`} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-[var(--text-secondary)] truncate">
                          {c.client}
                          <span className="text-[10px] text-[var(--text-muted)] ml-2">{c.kind}</span>
                        </span>
                        <span className="text-[var(--text-primary)] font-medium shrink-0">{c.calls}</span>
                      </li>
                    ))}
                  </ul>
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
            </>
          )}

          <p className="text-xs text-[var(--text-muted)] max-w-2xl">{data.window_note}</p>
        </>
      )}
    </div>
  );
}
