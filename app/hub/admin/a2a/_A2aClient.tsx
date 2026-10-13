'use client';

/**
 * /hub/admin/a2a — кто приходит из ИИ (решение владельца 12.10: «я бы хотел
 * видеть в админ-хабе A2A, хотя бы кто заходит из ИИ»).
 *
 * Три двери одним экраном: журнал A2A (кто, сколько, диалоги, текст или
 * инструмент, исходы, версии, последние запросы), клиенты MCP (кто подключался)
 * и чтение визиток и манифестов обходчиками. Под журналом A2A — журнал общения
 * (решение владельца 13.10): что агент спросил у Кузьмича и что тот ответил. Каждый блок читается отдельно и
 * отказ чтения показывается отказом, а не пустой таблицей (§4.0); пустой
 * журнал показывается с датой, с которой он ведётся.
 *
 * Данные — GET /api/admin/analytics/a2a. Сторож: tests/unit/a2a-journal-admin.test.ts.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, MessagesSquare, RefreshCw } from 'lucide-react';

type Block<T> = ({ ok: true } & T) | { ok: false; error: string };
type AgentKind = 'external' | 'registry' | 'probe' | 'self';

interface AgentRow {
  agent: string; ua_family: string; kind: AgentKind; is_self: boolean;
  requests: number; sends: number; text_sends: number; tool_sends: number;
  completed: number; rejected: number; failed: number; protocol_errors: number; card_reads: number;
  dialogs: number; caller_days: number; versions: string[]; bindings: string[];
  first_seen: string; last_seen: string;
}
interface DayRow { day: string; requests: number; agents: number }
interface ToolRow { tool: string; calls: number; completed: number; rejected: number; failed: number; agents: number }
interface RecentRow {
  at: string; binding: string; op: string; version: string; version_declared: boolean; ok: boolean;
  error_code: string | null; input: string | null; tool: string | null; state: string | null;
  duration_ms: number | null; agent: string; ua_family: string; is_self: boolean; kind: AgentKind;
}
interface A2aBlock {
  since: string | null; total_all_time: number; total_window: number; recent_limit: number;
  by_agent: AgentRow[]; by_day: DayRow[]; by_tool: ToolRow[]; recent: RecentRow[];
}
interface DialogItem {
  at: string; agent: string; kind: AgentKind; dialog: string | null; turn: number;
  question: string; answer: string; state: string; duration_ms: number | null;
}
interface DialogsBlock { since: string | null; total: number; retention_days: number; limit: number; items: DialogItem[] }
interface McpClientRow { client: string; kind: string; origin: 'probe' | 'external'; caller_days: number; days: number; first_seen: string | null; last_seen: string | null }
interface McpBlock { clients: McpClientRow[] }
interface EntryRow { family: string; vendor: string | null; hits: number; paths: number; last_day: string }
interface EntriesBlock { since: string | null; total_all_time: number; total_window: number; by_family: EntryRow[] }
interface Payload {
  success: true; window_days: number; generated_at: string;
  a2a: Block<A2aBlock>; mcp: Block<McpBlock>; entries: Block<EntriesBlock>;
  /** Нет у старой сборки сервера — тогда карточка журнала общения не рисуется. */
  dialogs?: Block<DialogsBlock>;
  degraded: string[]; note: string;
}

const WINDOWS = [7, 30, 90] as const;

const KIND_LABEL: Record<AgentKind, string> = {
  external: 'внешний',
  registry: 'проверка реестра A2A',
  probe: 'проверка',
  self: 'свой',
};

const STATE_LABEL: Record<string, string> = { completed: 'выполнено', rejected: 'отказ', failed: 'сбой' };

function kindClass(kind: AgentKind): string {
  if (kind === 'external') return 'text-[var(--success)]';
  if (kind === 'self') return 'text-[var(--text-muted)]';
  return 'text-[var(--text-secondary)]';
}

function ErrorCard({ title, error, consequence }: { title: string; error: string; consequence: string }) {
  return (
    <div className="ds-card border-[var(--danger)]">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} aria-hidden />
        <div>
          <h2 className="ds-h2 text-[var(--danger)]">{title}</h2>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">{error}</p>
          <p className="text-[var(--text-muted)] mt-1 text-sm">{consequence}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Одна реплика разговора: вопрос агента целиком, ответ Кузьмича — свёрнутым
 * (ответы длинные, а глазами сперва ищут, ЧТО спрашивают). Ключ диалога —
 * 8 знаков hash: реплики одного разговора узнаются по нему.
 */
function DialogEntry({ d }: { d: DialogItem }) {
  return (
    <li className="border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
      <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
        {d.at} · <span className="font-medium text-[var(--text-primary)]">{d.agent}</span>{' '}
        <span className={kindClass(d.kind)}>· {KIND_LABEL[d.kind]}</span>
        {d.dialog ? ` · разговор ${d.dialog}, реплика ${d.turn}` : ''}
        {' · '}
        <span className={d.state === 'completed' ? '' : 'text-[var(--warning)]'}>{STATE_LABEL[d.state] ?? d.state}</span>
        {d.duration_ms !== null ? ` · ${d.duration_ms} мс` : ''}
      </p>
      <p className="mt-1 text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">
        <span className="text-[var(--text-muted)]">Вопрос: </span>{d.question}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-[var(--ocean)]">Ответ Кузьмича</summary>
        <p className="mt-1 text-sm text-[var(--text-secondary)] whitespace-pre-wrap break-words">{d.answer}</p>
      </details>
    </li>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-2 py-1 font-medium text-[var(--text-muted)] ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function Td({ children, right = false, muted = false }: { children: React.ReactNode; right?: boolean; muted?: boolean }) {
  return <td className={`px-2 py-1 ${right ? 'text-right tabular-nums' : ''} ${muted ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{children}</td>;
}

export default function A2aClient() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Состояние «грузится» ставится в обработчиках (кнопка, смена окна), а не в
  // эффекте; сама загрузка — внутри эффекта, без синхронного setState в его
  // теле (react-hooks/set-state-in-effect). Повтор — счётчиком tick.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/analytics/a2a?days=${days}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
        if (cancelled) return;
        setError(null);
        setData(json as Payload);
      } catch (e) {
        // Отказ загрузки называется отказом, а не пустой страницей.
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось загрузить срез');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [days, tick]);

  const refresh = (): void => { setLoading(true); setTick((t) => t + 1); };
  const changeDays = (w: number): void => { setLoading(true); setDays(w); };

  const a2a = data?.a2a;
  const maxDay = a2a?.ok ? Math.max(1, ...a2a.by_day.map((d) => d.requests)) : 1;

  return (
    <div className="ds-page">
      <div className="ds-section">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="ds-h1 flex items-center gap-2">
              <Bot className="w-6 h-6 text-[var(--text-muted)]" aria-hidden />
              A2A: кто приходит из ИИ
            </h1>
            <p className="text-[var(--text-secondary)] mt-2 max-w-2xl">
              Три двери для агентов: протокол A2A (<code>/api/a2a</code>, <code>/api/a2a/v1</code>), MCP (<code>/api/mcp</code>)
              и визитки с манифестами (robots, llms.txt, карточки, OpenAPI). Агент называется так, как он
              представился в заголовке: это имя программы, не строка целиком. Сырые User-Agent, IP, тексты вопросов
              и аргументы инструментов не хранятся нигде.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-[var(--border)] overflow-hidden" role="group" aria-label="Окно">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => changeDays(w)}
                  aria-pressed={days === w}
                  className={`px-2.5 py-1.5 text-xs transition-colors ${days === w ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
                >
                  {w} дн.
                </button>
              ))}
            </div>
            <button type="button" onClick={refresh} className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
              <RefreshCw className="w-4 h-4" aria-hidden />
              Обновить
            </button>
          </div>
        </div>
      </div>

      {loading && (
        <div className="ds-section grid gap-3">
          {[0, 1, 2].map((i) => <div key={i} className="ds-skeleton h-16 rounded-lg" />)}
        </div>
      )}

      {error && !loading && (
        <div className="ds-section">
          <ErrorCard title="Срез не загрузился" error={error} consequence="Это отказ загрузки, а не «никто не приходил»: кто заходит, сейчас неизвестно." />
        </div>
      )}

      {data && !loading && !error && (
        <>
          {/* ── A2A ─────────────────────────────────────────────────────── */}
          <div className="ds-section space-y-3">
            <h2 className="ds-h2">По A2A, {data.window_days} дн.</h2>
            {!a2a || !a2a.ok ? (
              <ErrorCard
                title="Журнал A2A не прочитался"
                error={a2a ? a2a.error : 'блока нет в ответе'}
                consequence="Это отказ чтения, а не «никто не приходил»: журнал пишется при каждом запросе, но прочитать его сейчас не удалось."
              />
            ) : a2a.total_all_time === 0 ? (
              <div className="ds-card">
                <p className="font-medium text-[var(--text-primary)]">Журнал пуст</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">
                  Он заведён этим деплоем и пишет каждый запрос к <code>/api/a2a</code> и <code>/api/a2a/v1</code>, включая
                  чтение визитки. Значит, с момента деплоя по A2A ещё никто не приходил. Реестр a2aregistry.org шлёт
                  проверку раз в сутки — первая строка, скорее всего, будет от него.
                </p>
              </div>
            ) : a2a.total_window === 0 ? (
              <div className="ds-card">
                <p className="font-medium text-[var(--text-primary)]">За {data.window_days} дн. — ни одного запроса</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">
                  Журнал ведётся с {a2a.since}; всего записей {a2a.total_all_time}. Расширьте окно, чтобы увидеть прежние.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="ds-card">
                    <p className="text-xs text-[var(--text-muted)]">Запросов за окно</p>
                    <p className="text-2xl font-semibold text-[var(--text-primary)]">{a2a.total_window}</p>
                  </div>
                  <div className="ds-card">
                    <p className="text-xs text-[var(--text-muted)]">Агентов (самоназваний)</p>
                    <p className="text-2xl font-semibold text-[var(--text-primary)]">{a2a.by_agent.length}</p>
                  </div>
                  <div className="ds-card">
                    <p className="text-xs text-[var(--text-muted)]">Внешних агентов</p>
                    <p className="text-2xl font-semibold text-[var(--text-primary)]">{a2a.by_agent.filter((r) => r.kind === 'external').length}</p>
                  </div>
                  <div className="ds-card">
                    <p className="text-xs text-[var(--text-muted)]">Журнал ведётся с</p>
                    <p className="text-2xl font-semibold text-[var(--text-primary)]">{a2a.since ?? '—'}</p>
                  </div>
                </div>

                <div className="ds-card overflow-x-auto">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Кто приходит</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <Th>Агент</Th><Th>Кто это</Th><Th right>Запросов</Th><Th right>Диалогов</Th>
                        <Th right>Текст / инстр.</Th><Th right>Вып. / отказ / сбой</Th><Th right>Ошибок протокола</Th>
                        <Th>Версии</Th><Th>Первый раз</Th><Th>Последний раз</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {a2a.by_agent.map((r) => (
                        <tr key={`${r.agent}:${r.ua_family}:${r.is_self}`} className="border-t border-[var(--border)]">
                          <Td><span className="font-medium">{r.agent}</span> <span className="text-[var(--text-muted)]">({r.ua_family})</span></Td>
                          <Td><span className={kindClass(r.kind)}>{KIND_LABEL[r.kind]}</span></Td>
                          <Td right>{r.requests}{r.card_reads > 0 && <span className="text-[var(--text-muted)]"> (визитка {r.card_reads})</span>}</Td>
                          <Td right>{r.dialogs}</Td>
                          <Td right>{r.text_sends} / {r.tool_sends}</Td>
                          <Td right>{r.completed} / {r.rejected} / {r.failed}</Td>
                          <Td right muted>{r.protocol_errors}</Td>
                          <Td muted>{r.versions.join(', ')} · {r.bindings.join(', ')}</Td>
                          <Td muted>{r.first_seen}</Td>
                          <Td muted>{r.last_seen}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-[var(--text-muted)] mt-2">
                    «Диалоги» — разные contextId (считаются по хэшу). «Отказ» — задача rejected: нет согласия, нет мест,
                    лимит, несуществующий инструмент; «сбой» — failed, на нашей стороне. Ошибки протокола — ответы
                    с ошибкой A2A/JSON-RPC (неверные params, неизвестный метод, неподдерживаемая версия).
                  </p>
                </div>

                <div className="grid md:grid-cols-2 gap-3">
                  <div className="ds-card">
                    <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">По дням (камчатские сутки)</p>
                    <ul className="space-y-1">
                      {a2a.by_day.map((d) => (
                        <li key={d.day} className="flex items-center gap-2 text-xs">
                          <span className="w-20 shrink-0 text-[var(--text-muted)] tabular-nums">{d.day.slice(5)}</span>
                          <span className="flex-1 h-2 rounded bg-[var(--bg-hover)] overflow-hidden">
                            <span className="block h-2 bg-[var(--ocean)]" style={{ width: `${Math.round((d.requests / maxDay) * 100)}%` }} />
                          </span>
                          <span className="w-24 shrink-0 text-right text-[var(--text-secondary)] tabular-nums">{d.requests} · {d.agents} аг.</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="ds-card overflow-x-auto">
                    <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Инструменты через A2A</p>
                    {a2a.by_tool.length === 0 ? (
                      <p className="text-xs text-[var(--text-muted)]">За окно инструменты через DataPart не звали — только текст или визитка.</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead><tr><Th>Инструмент</Th><Th right>Вызовов</Th><Th right>Вып. / отказ / сбой</Th><Th right>Агентов</Th></tr></thead>
                        <tbody>
                          {a2a.by_tool.map((t) => (
                            <tr key={t.tool} className="border-t border-[var(--border)]">
                              <Td><code>{t.tool}</code></Td>
                              <Td right>{t.calls}</Td>
                              <Td right>{t.completed} / {t.rejected} / {t.failed}</Td>
                              <Td right muted>{t.agents}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                <div className="ds-card overflow-x-auto">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Последние запросы (до {a2a.recent_limit}, без привязки к окну)</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <Th>Когда</Th><Th>Агент</Th><Th>Биндинг</Th><Th>Операция</Th><Th>Версия</Th>
                        <Th>Вход</Th><Th>Исход</Th><Th right>мс</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {a2a.recent.map((r, i) => (
                        <tr key={`${r.at}:${i}`} className="border-t border-[var(--border)]">
                          <Td muted>{r.at}</Td>
                          <Td><span className="font-medium">{r.agent}</span> <span className={`${kindClass(r.kind)}`}>· {KIND_LABEL[r.kind]}</span></Td>
                          <Td muted>{r.binding}</Td>
                          <Td>{r.op}</Td>
                          <Td muted>{r.version}{r.version_declared ? '' : ' (по умолчанию)'}</Td>
                          <Td>{r.input === 'tool' ? <code>{r.tool}</code> : (r.input === 'text' ? 'текст' : '—')}</Td>
                          <Td>
                            {r.ok
                              ? (r.state ? STATE_LABEL[r.state] ?? r.state : 'ответ')
                              : <span className="text-[var(--warning)]">ошибка: {r.error_code ?? '?'}</span>}
                          </Td>
                          <Td right muted>{r.duration_ms ?? '—'}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* ── Журнал общения A2A ──────────────────────────────────────── */}
          {data.dialogs && (
            <div className="ds-section space-y-3">
              <h2 className="ds-h2 flex items-center gap-2">
                <MessagesSquare className="w-5 h-5 text-[var(--ocean)]" aria-hidden />
                Журнал общения A2A
              </h2>
              {!data.dialogs.ok ? (
                <ErrorCard title="Журнал общения не прочитался" error={data.dialogs.error} consequence="Это отказ чтения a2a_dialogs, а не «агенты ничего не спрашивали»." />
              ) : data.dialogs.items.length === 0 ? (
                <div className="ds-card">
                  <p className="text-sm text-[var(--text-secondary)]">
                    {data.dialogs.since
                      ? `Разговоров за ${data.dialogs.retention_days} сут. нет.`
                      : 'Журнал общения заведён 13.10; с тех пор ни один агент не задал Кузьмичу вопроса текстом.'}
                  </p>
                </div>
              ) : (
                <div className="ds-card">
                  <p className="text-[10px] text-[var(--text-muted)] mb-3">
                    Последние {data.dialogs.items.length} из {data.dialogs.total} реплик (ведётся с {data.dialogs.since}).
                    Телефоны и почты вычищены до записи, текст хранится {data.dialogs.retention_days} суток.
                    Вызовы инструментов без текста — в «Последних запросах» выше.
                  </p>
                  <ul className="space-y-3">
                    {data.dialogs.items.map((d, i) => <DialogEntry key={`${d.at}:${i}`} d={d} />)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* ── MCP ─────────────────────────────────────────────────────── */}
          <div className="ds-section space-y-3">
            <h2 className="ds-h2">По MCP, {data.window_days} дн.</h2>
            {!data.mcp.ok ? (
              <ErrorCard title="Клиенты MCP не прочитались" error={data.mcp.error} consequence="Это отказ чтения mcp_clients, а не «никто не подключался»." />
            ) : data.mcp.clients.length === 0 ? (
              <div className="ds-card">
                <p className="text-sm text-[var(--text-secondary)]">За {data.window_days} дн. рукопожатий и вызовов MCP не было.</p>
              </div>
            ) : (
              <div className="ds-card overflow-x-auto">
                <p className="text-[10px] text-[var(--text-muted)] mb-2">
                  Клиент называет себя сам при подключении («представился»); заголовок — запасной ответ, когда рукопожатия не было.
                  Подробный срез вызовов — <a className="underline" style={{ color: 'var(--ocean)' }} href="/hub/admin/mcp">Запросы через MCP</a>.
                </p>
                <table className="w-full text-xs">
                  <thead><tr><Th>Клиент</Th><Th>Откуда имя</Th><Th>Кто это</Th><Th right>Дней</Th><Th right>Клиенто-дней</Th><Th>Первый раз</Th><Th>Последний раз</Th></tr></thead>
                  <tbody>
                    {data.mcp.clients.map((c) => (
                      <tr key={`${c.client}:${c.kind}`} className="border-t border-[var(--border)]">
                        <Td><span className="font-medium">{c.client}</span></Td>
                        <Td muted>{c.kind}</Td>
                        <Td><span className={kindClass(c.origin)}>{KIND_LABEL[c.origin]}</span></Td>
                        <Td right>{c.days}</Td>
                        <Td right muted>{c.caller_days}</Td>
                        <Td muted>{c.first_seen ?? '—'}</Td>
                        <Td muted>{c.last_seen ?? '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Визитки и манифесты ─────────────────────────────────────── */}
          <div className="ds-section space-y-3">
            <h2 className="ds-h2">Кто читает визитки и манифесты, {data.window_days} дн.</h2>
            {!data.entries.ok ? (
              <ErrorCard title="Счётчик входов не прочитался" error={data.entries.error} consequence="Это отказ чтения agent_entry_hits, а не «никто не читает»." />
            ) : data.entries.total_window === 0 ? (
              <div className="ds-card">
                <p className="text-sm text-[var(--text-secondary)]">
                  {data.entries.since
                    ? `За ${data.window_days} дн. ни одного запроса к входам; счётчик ведётся с ${data.entries.since}.`
                    : 'Счётчик ещё ничего не видел: таблица пуста — считать он начал с этого деплоя.'}
                </p>
              </div>
            ) : (
              <div className="ds-card overflow-x-auto">
                <p className="text-[10px] text-[var(--text-muted)] mb-2">
                  Входы: robots.txt, llms.txt, манифест MCP, визитки A2A, карточка сервера, AI Catalog, OpenAPI, каталог API.
                  Семейство — по самоназванию обходчика; вызовы инструментов сюда не входят.
                </p>
                <table className="w-full text-xs">
                  <thead><tr><Th>Семейство</Th><Th>Вендор</Th><Th right>Запросов</Th><Th right>Входов</Th><Th>Последний день</Th></tr></thead>
                  <tbody>
                    {data.entries.by_family.map((f) => (
                      <tr key={f.family} className="border-t border-[var(--border)]">
                        <Td><span className="font-medium">{f.family}</span></Td>
                        <Td muted>{f.vendor ?? '—'}</Td>
                        <Td right>{f.hits}</Td>
                        <Td right muted>{f.paths}</Td>
                        <Td muted>{f.last_day}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="ds-section text-[10px] text-[var(--text-muted)]">{data.note}</p>
        </>
      )}
    </div>
  );
}
