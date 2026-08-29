'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, GitPullRequest, Activity, ShieldX, Zap, Clock,
  CheckCircle2, XCircle, AlertTriangle, CircleDashed, ChevronDown, ChevronUp,
  ExternalLink, HelpCircle, Search, Wrench, LifeBuoy, LineChart, Radar, Cpu,
  Newspaper, Lightbulb, MessageCircle, BrainCircuit, type LucideIcon,
} from 'lucide-react';

// Кокпит Volcano OS (P3) — ТОЛЬКО ПРОСМОТР. Ни одной кнопки действия здесь
// нет и не будет: merge/reject agent-PR человек делает в GitHub, задачи
// двигает kernel. Панель отвечает на три вопроса владельца: жива ли система,
// что она делала за сутки и что ждёт моего решения. Источник —
// /api/admin/volcano (agent_tasks + agent_events, read-only SELECT).

interface TaskRow {
  id: string;
  parent_task_id: string | null;
  trace_id: string;
  principal: string;
  capability: string;
  resource_type: string | null;
  resource_id: string | null;
  risk: string;
  state: string;
  attempt: number;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  task_id: string;
  trace_id: string;
  seq: number;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

interface AgentEffectRow {
  id: string;
  task_id: string;
  effect_key: string;
  status: string;
  external_ref: string | null;
  details: Record<string, unknown>;
  created_at: string;
  committed_at: string | null;
}

interface EvoStageStatus {
  key: string;
  ok: boolean;
}

interface Overview {
  summary: {
    states: Record<string, number>;
    active: number;
    created_24h: number;
    policy_denied_24h: number;
    awaiting_merge: number;
    last_evo_run: TaskRow | null;
    stuck_effects: number;
  };
  awaiting_merge: TaskRow[];
  tasks: TaskRow[];
  events: EventRow[];
  stuck_effects: AgentEffectRow[];
  evo_stages: EvoStageStatus[];
  generated_at: string;
}

// ── Состав эволюции: кто подключён к evo.run (29.08, консолидация) ─────────
// Список стадий — структурный факт кода (lib/agents/orchestrator.ts), не из
// БД: меняется вместе с кодом, не с каждым прогоном. Живой ok/статус —
// ИЗ данных (evo_stages в ответе API), не выдуман.
const EVO_STAGES: ReadonlyArray<{ key: string; label: string; description: string; icon: LucideIcon }> = [
  { key: 'scan', label: 'Growth Scan', description: 'Ищет находки в коде и данных платформы', icon: Search },
  { key: 'evolution', label: 'Evolution Loop', description: 'Применяет детерминированные фиксы, пишет в БД', icon: Wrench },
  { key: 'rescue', label: 'Rescue', description: 'Погодные угрозы турам и отток операторов', icon: LifeBuoy },
  { key: 'evolver', label: 'Evolver Analysis', description: 'Анализ логов и паттернов отказов', icon: LineChart },
  { key: 'intel', label: 'Intel Bridge', description: 'Дайджест разведки → находки категории intel', icon: Radar },
  { key: 'models', label: 'Model Watcher', description: 'Следит за моделями сильнее текущей', icon: Cpu },
  { key: 'scoutDigest', label: 'Scout Digest', description: 'RSS → AI-синтез → дайджест в Telegram', icon: Newspaper },
  { key: 'scoutInnovator', label: 'Scout Innovator', description: 'Тренды → предложения → GitHub Issues', icon: Lightbulb },
  { key: 'industryIntel', label: 'Industry Intel', description: 'Отраслевые TG-каналы → market intelligence', icon: MessageCircle },
  { key: 'memoryReflector', label: 'Memory Reflector', description: 'Эпизодические сигналы → устойчивые инсайты', icon: BrainCircuit },
];

interface TaskDetail {
  task: TaskRow;
  events: EventRow[];
  trace_tasks: TaskRow[];
}

// ── Словарь состояний: цвет и имя по-русски, без выдумывания ────────────────

const STATE_META: Record<string, { label: string; icon: LucideIcon; cls: string }> = {
  proposed:          { label: 'предложена',    icon: CircleDashed,  cls: 'text-[var(--text-secondary)]' },
  awaiting_approval: { label: 'ждёт одобрения (legacy)', icon: Clock, cls: 'text-[var(--warning)]' },
  queued:            { label: 'в очереди',     icon: Clock,         cls: 'text-[var(--ocean)]' },
  running:           { label: 'выполняется',   icon: Activity,      cls: 'text-[var(--ocean)]' },
  awaiting_merge:    { label: 'ждёт merge',    icon: GitPullRequest, cls: 'text-[var(--warning)]' },
  succeeded:         { label: 'успех',         icon: CheckCircle2,  cls: 'text-[var(--success)]' },
  failed_retryable:  { label: 'провал (повторится)', icon: AlertTriangle, cls: 'text-[var(--warning)]' },
  failed_terminal:   { label: 'провал',        icon: XCircle,       cls: 'text-[var(--danger)]' },
  cancelled:         { label: 'снята',         icon: XCircle,       cls: 'text-[var(--text-muted)]' },
  rejected:          { label: 'отклонена',     icon: ShieldX,       cls: 'text-[var(--danger)]' },
};

function StateBadge({ state }: { state: string }) {
  const meta = STATE_META[state] ?? { label: state, icon: CircleDashed, cls: 'text-[var(--text-muted)]' };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${meta.cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {meta.label}
    </span>
  );
}

/** github_pr-ресурс вида owner/repo#123 → ссылка на PR; прочее — null. */
export function prUrlFromResource(resourceType: string | null, resourceId: string | null): string | null {
  if (resourceType !== 'github_pr' || !resourceId) return null;
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(resourceId);
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : null;
}

function fmtTime(iso: string): string {
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// ── Панель ──────────────────────────────────────────────────────────────────

export default function VolcanoClient() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/admin/volcano');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as Overview);
      setError(null);
    } catch (err) {
      // Отказ загрузки — состояние, не пустота: панель обязана сказать
      // «не смогла прочитать», а не рисовать нули (§4.0).
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const openDetail = useCallback(async (taskId: string) => {
    if (openTask === taskId) { setOpenTask(null); setDetail(null); return; }
    setOpenTask(taskId);
    setDetail(null);
    setDetailError(null);
    try {
      const res = await fetch(`/api/admin/volcano?task_id=${taskId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail(await res.json() as TaskDetail);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  }, [openTask]);

  return (
    <div className="ds-page p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="ds-h1">Работа Volcano OS</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Только просмотр: задачи и события ядра. Решения по agent-PR принимаются в GitHub.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="ds-btn ds-btn-secondary inline-flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      </div>

      {error && (
        <div className="ds-card p-4 border border-[var(--danger)] text-[var(--danger)] text-sm">
          Панель не смогла прочитать состояние ядра: {error}. Это отказ чтения, а не «задач нет».
        </div>
      )}

      {!data && !error && (
        <div className="ds-card p-6 text-sm text-[var(--text-secondary)]">Загрузка…</div>
      )}

      {data && (
        <>
          {/* ── Сводка ── */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <SummaryCard icon={Activity} label="Активно сейчас" value={String(data.summary.active)} />
            <SummaryCard icon={Zap} label="Задач за 24 часа" value={String(data.summary.created_24h)} />
            <SummaryCard
              icon={GitPullRequest}
              label="Ждут решения"
              value={String(data.summary.awaiting_merge)}
              highlight={data.summary.awaiting_merge > 0}
            />
            <SummaryCard
              icon={ShieldX}
              label="Отказов policy за 24ч"
              value={String(data.summary.policy_denied_24h)}
              highlight={data.summary.policy_denied_24h > 0}
            />
            <SummaryCard
              icon={HelpCircle}
              label="Зависших эффектов"
              value={String(data.summary.stuck_effects)}
              highlight={data.summary.stuck_effects > 0}
            />
          </div>

          {/* ── Последняя эволюция ── */}
          <section className="ds-card p-4">
            <h2 className="ds-h2 mb-2">Последний прогон Evo</h2>
            {data.summary.last_evo_run ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <StateBadge state={data.summary.last_evo_run.state} />
                <span className="text-[var(--text-secondary)]">{fmtTime(data.summary.last_evo_run.created_at)}</span>
                <span className="text-[var(--text-primary)]">{data.summary.last_evo_run.summary ?? 'без итога'}</span>
                <button
                  type="button"
                  onClick={() => void openDetail(data.summary.last_evo_run!.id)}
                  className="text-[var(--ocean)] hover:underline"
                >
                  подробности
                </button>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">
                Прогонов Evo через ядро ещё не было — это «не было», а не сбой панели.
              </p>
            )}
          </section>

          {/* ── Состав эволюции (29.08) ── */}
          <section className="fx-dark-panel rounded-2xl p-5">
            <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1 mb-1">
              <h2 className="ds-h2 fx-dark-panel">Состав эволюции</h2>
              <span className="text-xs fx-dark-muted">
                {data.summary.last_evo_run
                  ? `по последнему прогону · ${fmtTime(data.summary.last_evo_run.created_at)}`
                  : 'прогонов ещё не было'}
              </span>
            </div>
            <p className="text-sm mb-4 fx-dark-muted">
              10 агентов на одном пульсе — расписание владельца на cron-job.org (4×/сутки),
              не свои отдельные кроны.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {EVO_STAGES.map((stage) => {
                const status = data.evo_stages.find((s) => s.key === stage.key);
                const Icon = stage.icon;
                return (
                  <div key={stage.key} className="fx-glass rounded-2xl p-3.5 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Icon className="w-4 h-4 fx-dark-ocean" />
                      {status === undefined ? (
                        <CircleDashed className="w-3.5 h-3.5 fx-dark-dim" />
                      ) : status.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 fx-dark-danger" />
                      )}
                    </div>
                    <div className="text-sm font-medium fx-dark-panel">{stage.label}</div>
                    <div className="text-xs leading-snug fx-dark-muted">{stage.description}</div>
                    <div className="text-[11px] mt-auto pt-1 fx-dark-dim">
                      {status === undefined
                        ? 'нет данных с последнего прогона'
                        : status.ok ? 'стадия прошла' : 'стадия упала'}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── Ждут моего решения ── */}
          <section className="ds-card p-4">
            <h2 className="ds-h2 mb-3">Ждут моего решения</h2>
            {data.awaiting_merge.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">
                Нет agent-PR, ожидающих merge. Решений от вас сейчас не требуется.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.awaiting_merge.map((t) => {
                  const url = prUrlFromResource(t.resource_type, t.resource_id);
                  return (
                    <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm border-b border-[var(--border)] last:border-0 pb-2 last:pb-0">
                      <GitPullRequest className="w-4 h-4 text-[var(--warning)]" />
                      <span className="text-[var(--text-primary)]">{t.summary ?? t.resource_id ?? shortId(t.id)}</span>
                      <span className="text-[var(--text-muted)] text-xs">{fmtTime(t.updated_at)}</span>
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--ocean)] hover:underline">
                          Открыть PR <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)] text-xs">ссылка на PR не распознана: {t.resource_id ?? 'ресурс пуст'}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Зависшие эффекты (P3) ── */}
          <section className="ds-card p-4">
            <h2 className="ds-h2 mb-3">Зависшие эффекты</h2>
            {data.stuck_effects.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">
                Нет эффектов в состоянии pending дольше 15 минут.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.stuck_effects.map((ef) => (
                  <li key={ef.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm border-b border-[var(--border)] last:border-0 pb-2 last:pb-0">
                    <HelpCircle className="w-4 h-4 text-[var(--warning)]" />
                    <span className="text-[var(--text-primary)]">{ef.effect_key}</span>
                    <span className="text-[var(--text-muted)] text-xs">заведён {fmtTime(ef.created_at)}</span>
                    <button
                      type="button"
                      onClick={() => void openDetail(ef.task_id)}
                      className="text-[var(--ocean)] hover:underline text-xs"
                    >
                      задача {shortId(ef.task_id)}
                    </button>
                    <span className="text-[var(--text-muted)] text-xs">
                      не знаем, дошёл ли внешний вызов — попытка либо ещё идёт, либо упала между вызовом и записью
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Задачи ── */}
          <section className="ds-card p-4">
            <h2 className="ds-h2 mb-3">Последние задачи ядра</h2>
            {data.tasks.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">Задач в ядре ещё нет.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-[var(--text-muted)] border-b border-[var(--border)]">
                      <th className="py-2 pr-3">Что</th>
                      <th className="py-2 pr-3">Кто</th>
                      <th className="py-2 pr-3">Состояние</th>
                      <th className="py-2 pr-3">Итог</th>
                      <th className="py-2 pr-3">Обновлена</th>
                      <th className="py-2" aria-label="раскрыть" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.tasks.map((t) => (
                      <TaskLine
                        key={t.id}
                        task={t}
                        open={openTask === t.id}
                        detail={openTask === t.id ? detail : null}
                        detailError={openTask === t.id ? detailError : null}
                        onToggle={() => void openDetail(t.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Лента событий ── */}
          <section className="ds-card p-4">
            <h2 className="ds-h2 mb-3">Лента событий</h2>
            {data.events.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">Событий ещё нет.</p>
            ) : (
              <ul className="space-y-1 text-xs font-mono">
                {data.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-2 text-[var(--text-secondary)]">
                    <span className="text-[var(--text-muted)]">{fmtTime(e.created_at)}</span>
                    <span className="text-[var(--text-primary)]">{e.event_type}</span>
                    {e.from_state && e.to_state && (
                      <span>{e.from_state} → {e.to_state}</span>
                    )}
                    <span>{e.actor}</span>
                    <button
                      type="button"
                      onClick={() => void openDetail(e.task_id)}
                      className="text-[var(--ocean)] hover:underline"
                    >
                      задача {shortId(e.task_id)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-[var(--text-muted)]">
            Снимок: {fmtTime(data.generated_at)} · автообновление каждые 30 секунд
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, highlight }: {
  icon: LucideIcon; label: string; value: string; highlight?: boolean;
}) {
  return (
    <div className={`ds-card p-4 ${highlight ? 'border border-[var(--warning)]' : ''}`}>
      <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <div className="text-2xl font-bold text-[var(--text-primary)] mt-1">{value}</div>
    </div>
  );
}

function TaskLine({ task, open, detail, detailError, onToggle }: {
  task: TaskRow;
  open: boolean;
  detail: TaskDetail | null;
  detailError: string | null;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <>
      <tr className="border-b border-[var(--border)] last:border-0 align-top">
        <td className="py-2 pr-3 text-[var(--text-primary)]">{task.capability}</td>
        <td className="py-2 pr-3 text-[var(--text-secondary)]">{task.principal}</td>
        <td className="py-2 pr-3"><StateBadge state={task.state} /></td>
        <td className="py-2 pr-3 text-[var(--text-secondary)] max-w-[24rem] truncate">{task.summary ?? '—'}</td>
        <td className="py-2 pr-3 text-[var(--text-muted)] whitespace-nowrap">{fmtTime(task.updated_at)}</td>
        <td className="py-2">
          <button type="button" onClick={onToggle} className="text-[var(--ocean)]" aria-label="цепочка событий">
            <Chevron className="w-4 h-4" />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-[var(--border)] last:border-0">
          <td colSpan={6} className="py-2 pl-4 bg-[var(--bg-hover)] rounded-lg">
            {detailError && (
              <p className="text-xs text-[var(--danger)]">Цепочка не прочитана: {detailError}</p>
            )}
            {!detail && !detailError && <p className="text-xs text-[var(--text-secondary)]">Загрузка цепочки…</p>}
            {detail && (
              <div className="space-y-2 text-xs">
                <div className="text-[var(--text-muted)]">
                  id {detail.task.id} · trace {detail.task.trace_id} · попытка {detail.task.attempt}
                  {detail.task.resource_id && <> · ресурс {detail.task.resource_type}:{detail.task.resource_id}</>}
                </div>
                <ol className="space-y-1 font-mono">
                  {detail.events.map((e) => (
                    <li key={e.seq} className="text-[var(--text-secondary)]">
                      <span className="text-[var(--text-muted)]">#{e.seq}</span>{' '}
                      <span className="text-[var(--text-primary)]">{e.event_type}</span>
                      {e.from_state && e.to_state && <> {e.from_state} → {e.to_state}</>}
                      {' · '}{e.actor}{' · '}{fmtTime(e.created_at)}
                      {Object.keys(e.details).length > 0 && (
                        <span className="text-[var(--text-muted)]"> · {JSON.stringify(e.details).slice(0, 160)}</span>
                      )}
                    </li>
                  ))}
                </ol>
                {detail.trace_tasks.length > 0 && (
                  <div className="text-[var(--text-secondary)]">
                    В том же trace: {detail.trace_tasks.map((t) => `${t.capability} (${STATE_META[t.state]?.label ?? t.state})`).join(', ')}
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
