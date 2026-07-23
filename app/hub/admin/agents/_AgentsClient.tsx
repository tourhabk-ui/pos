'use client';

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  RefreshCw, CheckCircle2, AlertTriangle, Clock, Play, Bot, Zap, Send, AlertCircle,
  GitBranch, X, Copy, Check, Loader2, Radio, DownloadCloud,
  type LucideIcon,
} from 'lucide-react';

// Дашборд фоновых агентов в эталонном «туристском» формате (как «Модели
// эволюции»): playfair-хедер, StatChip-строка сводки, секции-карточки с
// icon-circle, Loader2. Данные — из живых API. Расписания сверены с
// .github/workflows/cron-*.yml (источник правды): дашборд не должен врать
// про то, когда агент реально запускается.

interface AgentDef {
  id: string;
  name: string;
  description: string;
  schedule: string;
}

// Расписания — из cron-*.yml, НЕ из памяти. Меняешь workflow — обнови здесь.
const AGENTS: AgentDef[] = [
  {
    id: 'watchdog',
    name: 'Watchdog',
    description: 'Единственный сторож операционной безопасности: SOS-таймаут, брони без подтверждения, лиды, мёртвый сейсмо-крон. Алерты в Telegram.',
    schedule: 'каждые 30 мин',
  },
  {
    id: 'rescue',
    name: 'Rescue',
    description: 'Погодные угрозы ближайшим турам + отток операторов (>7 дней без броней). SOS и брони — у Watchdog, не дублирует.',
    schedule: 'каждые 30 мин · :15/:45',
  },
  {
    id: 'editor',
    name: 'Editor',
    description: 'Туры с описанием <300 символов → AI переписывает → route_description_cache.',
    schedule: 'ежедневно · 22:00 UTC (off-peak)',
  },
  {
    id: 'scout-digest',
    name: 'Scout Digest',
    description: 'RSS (Habr, RATA, Tourprom, Kamgov) → AI-синтез → дайджест в Telegram.',
    schedule: 'ежедневно · 07:00 UTC',
  },
  {
    id: 'intelligence',
    name: 'Intelligence Monitor',
    description: 'Сбор AI/тревел/конкурентных сигналов из RSS и поиска → Brain.',
    schedule: 'каждые 6 ч · 3/9/15/21 UTC',
  },
  {
    id: 'scout',
    name: 'Scout-Innovator',
    description: 'Читает Brain → платформу → 2-3 конкретных предложения → Telegram.',
    schedule: 'ежедневно · 08:00 UTC',
  },
  {
    id: 'evo',
    name: 'Evo System',
    description: 'Growth Scan + Evolution Loop + intel-bridge + model-watcher. Находки → GitHub Issues (метка evo).',
    schedule: '3× в сутки · 17/20/23 UTC (off-peak)',
  },
];

interface RunSummary {
  agent_id: string;
  status: string;
  started_at: string;
}

interface RunRow {
  id: string;
  agent_id: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  items_processed: number | null;
  errors_count: number;
  error_msg: string | null;
}

interface TriggerState {
  loading: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
}

// ── Общие примитивы (в стиле «Модели эволюции») ────────────────────────────

function StatChip({ icon: Icon, label, value, tone = 'ocean' }: {
  icon: LucideIcon; label: string; value: string; tone?: 'ocean' | 'success' | 'danger';
}) {
  const color = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--ocean)';
  return (
    <div className="flex items-center gap-2.5 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-2.5">
      <span className="flex items-center justify-center w-9 h-9 rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}>
        <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} style={{ color }} />
      </span>
      <div>
        <div className="ds-label">{label}</div>
        <div className="text-sm font-bold text-[var(--text-primary)]">{value}</div>
      </div>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle, action }: {
  icon: LucideIcon; title: string; subtitle?: string; action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
      <div className="flex items-center gap-3">
        <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10">
          <Icon className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
        </span>
        <div>
          <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)]">{title}</h2>
          {subtitle && <p className="ds-label">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={spinning}
      className="ds-btn ds-btn-secondary inline-flex items-center gap-2 disabled:opacity-60"
    >
      <RefreshCw className={`w-4 h-4 ${spinning ? 'animate-spin' : ''}`} /> Обновить
    </button>
  );
}

function StatusDot({ status }: { status?: string }) {
  const color = !status
    ? 'var(--text-muted)'
    : status === 'success'
    ? 'var(--success)'
    : status === 'partial'
    ? 'var(--warning)'
    : 'var(--danger)';
  return <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: color }} />;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'success'
      ? 'text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_12%,transparent)]'
      : status === 'partial'
      ? 'text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]'
      : 'text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]';
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {status === 'success' ? 'OK' : status === 'partial' ? 'частично' : 'ошибка'}
    </span>
  );
}

function formatDuration(ms: number | null) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}мс`;
  return `${(ms / 1000).toFixed(1)}с`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Главный клиент ─────────────────────────────────────────────────────────

export default function AgentsClient() {
  const [summary, setSummary] = useState<Record<string, RunSummary>>({});
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [triggers, setTriggers] = useState<Record<string, TriggerState>>({});

  const loadHistory = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/admin/agents/runs?limit=30');
      if (!res.ok) return;
      const data = await res.json() as { runs: RunRow[]; summary: RunSummary[] };
      setRuns(data.runs);
      const map: Record<string, RunSummary> = {};
      for (const s of data.summary) map[s.agent_id] = s;
      setSummary(map);
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    const interval = setInterval(() => void loadHistory(), 30_000);
    return () => clearInterval(interval);
  }, [loadHistory]);

  async function triggerAgent(agentId: string) {
    setTriggers(prev => ({ ...prev, [agentId]: { loading: true, result: null, error: null } }));
    try {
      const res = await fetch('/api/admin/agents/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId }),
      });
      const data = await res.json() as { ok: boolean; result?: Record<string, unknown>; error?: string };
      if (!data.ok) throw new Error(data.error ?? 'Ошибка');
      setTriggers(prev => ({ ...prev, [agentId]: { loading: false, result: data.result ?? {}, error: null } }));
      void loadHistory();
    } catch (err) {
      setTriggers(prev => ({
        ...prev,
        [agentId]: { loading: false, result: null, error: err instanceof Error ? err.message : 'Ошибка' },
      }));
    }
  }

  // Сводка по последнему запуску каждого агента
  const ran = AGENTS.map(a => summary[a.id]).filter(Boolean) as RunSummary[];
  const okCount = ran.filter(s => s.status === 'success').length;
  const issueCount = ran.filter(s => s.status !== 'success').length;
  const lastActivity = ran.length
    ? ran.reduce((max, s) => (s.started_at > max ? s.started_at : max), ran[0].started_at)
    : null;

  return (
    <div className="max-w-5xl lg:max-w-6xl mx-auto px-4 py-6 lg:py-8 space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">AI и автоматизации</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Фоновые агенты платформы: мониторинг, контент, разведка, эволюция. Статус обновляется каждые 30 секунд.
          </p>
        </div>
        <RefreshButton onClick={() => void loadHistory()} spinning={refreshing} />
      </header>

      {/* Сводка */}
      <div className="flex flex-wrap gap-2.5">
        <StatChip icon={Zap} label="Агентов" value={String(AGENTS.length)} />
        <StatChip icon={CheckCircle2} label="Успешных" value={`${okCount} из ${ran.length || AGENTS.length}`} tone="success" />
        {issueCount > 0 && <StatChip icon={AlertTriangle} label="С ошибкой" value={String(issueCount)} tone="danger" />}
        <StatChip icon={Clock} label="Последняя активность" value={lastActivity ? formatTime(lastActivity) : '—'} />
      </div>

      {/* Кузьмич */}
      <section className="ds-card">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--accent)]/10 flex-shrink-0">
              <Bot className="w-[22px] h-[22px] text-[var(--accent)]" strokeWidth={1.75} />
            </span>
            <div>
              <p className="ds-label">Основной AI</p>
              <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)]">Кузьмич</h2>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                AI-консьерж для туристов и операторов. Telegram, MAX, web, виджет.
              </p>
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <a href="/kuzmich" className="ds-btn ds-btn-secondary text-sm">Открыть</a>
            <a href="/hub/admin/ai-analytics" className="ds-btn ds-btn-secondary text-sm">Аналитика</a>
          </div>
        </div>
      </section>

      {/* Фоновые агенты */}
      <section className="ds-card">
        <SectionHeader icon={Zap} title="Фоновые агенты" subtitle="Расписание из cron-workflow" />
        <div className="space-y-3">
          {AGENTS.map(agent => {
            const last = summary[agent.id];
            const trig = triggers[agent.id];
            return (
              <div key={agent.id} className="rounded-lg bg-[var(--bg-card)] border border-[var(--border)] p-4">
                <div className="flex items-start gap-4 justify-between">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="mt-1.5"><StatusDot status={last?.status} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="font-semibold text-[var(--text-primary)]">{agent.name}</span>
                        <span className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-0.5 rounded-full">
                          {agent.schedule}
                        </span>
                        {last && <StatusBadge status={last.status} />}
                      </div>
                      <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{agent.description}</p>
                      {last && (
                        <p className="text-xs text-[var(--text-muted)] mt-1.5">
                          Последний запуск: {formatTime(last.started_at)}
                        </p>
                      )}
                      {trig?.result && (
                        <div className="mt-2 text-xs bg-[var(--bg-hover)] rounded-lg p-2.5 font-mono text-[var(--text-secondary)] space-y-0.5">
                          {Object.entries(trig.result).map(([k, v]) => (
                            <div key={k}>{k}: <span className="text-[var(--text-primary)]">{String(v)}</span></div>
                          ))}
                        </div>
                      )}
                      {trig?.error && (
                        <div className="flex items-center gap-1.5 text-xs text-[var(--danger)] mt-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                          {trig.error}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => void triggerAgent(agent.id)}
                    disabled={trig?.loading}
                    className="ds-btn ds-btn-secondary text-sm flex items-center gap-1.5 flex-shrink-0 disabled:opacity-60"
                  >
                    {trig?.loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    {trig?.loading ? 'Запуск…' : 'Запустить'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* История запусков */}
      <section className="ds-card">
        <SectionHeader icon={Clock} title="История запусков" subtitle="Последние 30 запусков" />
        {loading ? (
          <div className="flex items-center justify-center py-14">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : runs.length === 0 ? (
          <div className="text-center py-12 text-sm text-[var(--text-secondary)]">
            История пуста — запусков ещё не было.
          </div>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                  <th className="text-left px-3 py-2.5 font-medium">Агент</th>
                  <th className="text-left px-3 py-2.5 font-medium">Статус</th>
                  <th className="text-left px-3 py-2.5 font-medium">Время</th>
                  <th className="text-left px-3 py-2.5 font-medium">Длит.</th>
                  <th className="text-left px-3 py-2.5 font-medium">Записей</th>
                  <th className="text-left px-3 py-2.5 font-medium">Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-hover)]">
                    <td className="px-3 py-2.5 font-medium text-[var(--text-primary)]">{run.agent_id}</td>
                    <td className="px-3 py-2.5"><StatusBadge status={run.status} /></td>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)] text-xs">{formatTime(run.started_at)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)] text-xs">{formatDuration(run.duration_ms)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)] text-xs">{run.items_processed ?? '—'}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {run.error_msg ? (
                        <span className="text-[var(--danger)] truncate max-w-[220px] block" title={run.error_msg}>
                          {run.error_msg.slice(0, 60)}{run.error_msg.length > 60 ? '…' : ''}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <EvoIssuesSection />
      <ChannelPostsSection />
      <ImportRoutesSection />
    </div>
  );
}

// ── Evo — Очередь проблем ──────────────────────────────────────────────────

interface EvoIssue {
  id: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file_path: string | null;
  title: string;
  description: string | null;
  suggestion: string | null;
  status: string;
  created_at: string;
}

interface EvoLogEntry {
  id: string;
  issue_id: string | null;
  action: string;
  status: string;
  diff_summary: string | null;
  created_at: string;
  issue_title: string | null;
  issue_file: string | null;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
  high: 'text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]',
  medium: 'text-[var(--ocean)] bg-[color-mix(in_srgb,var(--ocean)_12%,transparent)]',
  low: 'text-[var(--text-muted)] bg-[var(--bg-hover)]',
};

const CATEGORY_LABELS: Record<string, string> = {
  dead_code: 'мёртвый код',
  security: 'безопасность',
  performance: 'производит.',
  bug: 'баг',
  tech_debt: 'tech debt',
  ux: 'UX',
  intel: 'разведка',
  add_index: 'индекс БД',
};

function EvoIssuesSection() {
  const [tab, setTab] = useState<'issues' | 'log'>('issues');
  const [issues, setIssues] = useState<EvoIssue[]>([]);
  const [log, setLog] = useState<EvoLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/evo/issues');
      if (!res.ok) return;
      const data = await res.json() as { issues: EvoIssue[]; log: EvoLogEntry[] };
      setIssues(data.issues);
      setLog(data.log);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function patchIssue(id: string, status: string) {
    setUpdating(id);
    try {
      await fetch('/api/admin/evo/issues', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'issue', id, status }),
      });
      setIssues(prev => prev.filter(i => i.id !== id));
    } finally {
      setUpdating(null);
    }
  }

  async function patchLog(id: string, status: string) {
    setUpdating(id);
    try {
      await fetch('/api/admin/evo/issues', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'log', id, status }),
      });
      setLog(prev => prev.filter(l => l.id !== id));
    } finally {
      setUpdating(null);
    }
  }

  async function copyDiff(id: string, text: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  const pendingCount = issues.length;
  const logCount = log.length;

  return (
    <section className="ds-card">
      <SectionHeader
        icon={GitBranch}
        title="Evo — очередь проблем"
        subtitle="Находки эволюции и предложенные фиксы"
        action={
          <button
            onClick={() => { setLoading(true); void load(); }}
            className="text-xs text-[var(--text-muted)] flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Обновить
          </button>
        }
      />

      {/* Табы */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab('issues')}
          className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors ${
            tab === 'issues'
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-secondary)] bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          Проблемы {pendingCount > 0 && <span className="ml-1 opacity-80">({pendingCount})</span>}
        </button>
        <button
          onClick={() => setTab('log')}
          className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors ${
            tab === 'log'
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-secondary)] bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          Фиксы {logCount > 0 && <span className="ml-1 opacity-80">({logCount})</span>}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : tab === 'issues' ? (
        issues.length === 0 ? (
          <div className="text-center py-10 text-sm text-[var(--text-secondary)]">
            Нет открытых проблем — всё чисто.
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--border)] overflow-hidden">
            {issues.map((issue, idx) => (
              <div key={issue.id} className={`p-4 ${idx < issues.length - 1 ? 'border-b border-[var(--border)]' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className="flex flex-col gap-1 flex-shrink-0 pt-0.5">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full text-center ${SEVERITY_STYLES[issue.severity] ?? SEVERITY_STYLES.low}`}>
                      {issue.severity}
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-0.5 rounded-full text-center">
                      {CATEGORY_LABELS[issue.category] ?? issue.category}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-[var(--text-primary)] leading-snug">{issue.title}</p>
                    {issue.file_path && (
                      <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5 truncate">{issue.file_path}</p>
                    )}
                    {issue.suggestion && (
                      <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">{issue.suggestion}</p>
                    )}
                    {issue.status === 'suggested' && (
                      <span className="text-xs text-[var(--ocean)] mt-1 inline-block">evo предложил фикс</span>
                    )}
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => void patchIssue(issue.id, 'ignored')}
                      disabled={updating === issue.id}
                      className="text-xs px-2.5 py-1 rounded-lg bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
                    >
                      Игнор
                    </button>
                    <button
                      onClick={() => void patchIssue(issue.id, 'rejected')}
                      disabled={updating === issue.id}
                      className="text-xs px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      <X className="w-3 h-3" /> Отклонить
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        log.length === 0 ? (
          <div className="text-center py-10 text-sm text-[var(--text-secondary)]">
            Нет ожидающих фиксов — Evolution Loop ещё не сгенерировал дифы.
          </div>
        ) : (
          <div className="space-y-2">
            {log.map(entry => (
              <div key={entry.id} className="rounded-lg border border-[var(--border)] p-4 space-y-2">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-[var(--text-primary)]">{entry.issue_title ?? entry.action}</p>
                    {entry.issue_file && (
                      <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5 truncate">{entry.issue_file}</p>
                    )}
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">действие: {entry.action}</p>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    {entry.diff_summary && (
                      <button
                        onClick={() => setExpandedDiff(expandedDiff === entry.id ? null : entry.id)}
                        className="text-xs px-2.5 py-1 rounded-lg bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                      >
                        {expandedDiff === entry.id ? 'Скрыть' : 'Диф'}
                      </button>
                    )}
                    <button
                      onClick={() => void patchLog(entry.id, 'merged')}
                      disabled={updating === entry.id}
                      className="text-xs px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)] hover:bg-[color-mix(in_srgb,var(--success)_22%,transparent)] transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3 h-3" /> Применён
                    </button>
                    <button
                      onClick={() => void patchLog(entry.id, 'rejected')}
                      disabled={updating === entry.id}
                      className="text-xs px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      <X className="w-3 h-3" /> Отклонить
                    </button>
                  </div>
                </div>
                {expandedDiff === entry.id && entry.diff_summary && (
                  <div className="relative">
                    <pre className="text-xs font-mono bg-[var(--bg-hover)] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap text-[var(--text-secondary)] max-h-64 overflow-y-auto leading-relaxed">
                      {entry.diff_summary}
                    </pre>
                    <button
                      onClick={() => void copyDiff(entry.id, entry.diff_summary!)}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                      title="Скопировать диф"
                    >
                      {copied === entry.id ? <Check className="w-3 h-3 text-[var(--success)]" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </section>
  );
}

// ── Публикации в каналы ────────────────────────────────────────────────────

function ChannelPostsSection() {
  const POSTS = [
    { id: 'kuzmich_route', label: 'Маршрут', desc: 'AI выбирает маршрут → генерирует описание → публикует в TG + MAX' },
    { id: 'tip', label: 'Совет Кузьмича', desc: 'Полезный совет туристам о Камчатке → TG + MAX' },
    { id: 'sezon', label: 'Сезонный пост', desc: 'Актуальное время года → TG + MAX' },
    { id: 'ai_news', label: 'AI-новость', desc: 'Тестовый пост → TELEGRAM_AI_CHANNEL_ID' },
  ] as const;

  const [states, setStates] = useState<Record<string, { loading: boolean; ok?: boolean; error?: string }>>({});

  async function trigger(id: string) {
    setStates(p => ({ ...p, [id]: { loading: true } }));
    try {
      const res = await fetch('/api/admin/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: id }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      setStates(p => ({ ...p, [id]: { loading: false, ok: data.ok, error: data.error } }));
    } catch (err) {
      setStates(p => ({ ...p, [id]: { loading: false, ok: false, error: err instanceof Error ? err.message : 'Ошибка' } }));
    }
  }

  return (
    <section className="ds-card">
      <SectionHeader icon={Radio} title="Публикации в каналы" subtitle="Ручной запуск постов в Telegram / MAX" />
      <div className="space-y-3">
        {POSTS.map(p => {
          const s = states[p.id];
          return (
            <div key={p.id} className="rounded-lg border border-[var(--border)] p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-[var(--text-primary)] text-sm">{p.label}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">{p.desc}</p>
                  {s?.ok === true && (
                    <p className="text-xs text-[var(--success)] flex items-center gap-1 mt-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Опубликовано
                    </p>
                  )}
                  {s?.error && (
                    <p className="text-xs text-[var(--danger)] flex items-center gap-1 mt-1">
                      <AlertCircle className="w-3.5 h-3.5" /> {s.error}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => void trigger(p.id)}
                  disabled={s?.loading}
                  className="ds-btn ds-btn-secondary text-sm flex items-center gap-1.5 flex-shrink-0 disabled:opacity-60"
                >
                  {s?.loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {s?.loading ? 'Публикую…' : 'Опубликовать'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Импорт маршрутов ───────────────────────────────────────────────────────

function ImportRoutesSection() {
  const [state, setState] = useState<{ loading: boolean; result: string | null; error: string | null }>({
    loading: false, result: null, error: null,
  });

  async function run() {
    setState({ loading: true, result: null, error: null });
    try {
      const res = await fetch('/api/admin/import/visitkamchatka', { method: 'POST' });
      const data = await res.json() as { ok: boolean; inserted?: number; updated?: number; total?: number; error?: string };
      if (data.ok) {
        setState({ loading: false, result: `Импортировано: ${data.inserted} новых, ${data.updated} обновлено (всего ${data.total})`, error: null });
      } else {
        setState({ loading: false, result: null, error: data.error ?? 'Ошибка' });
      }
    } catch (e) {
      setState({ loading: false, result: null, error: e instanceof Error ? e.message : 'Ошибка сети' });
    }
  }

  return (
    <section className="ds-card">
      <SectionHeader icon={DownloadCloud} title="Импорт маршрутов" subtitle="visitkamchatka.ru → kamchatka_routes" />
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-[var(--text-secondary)] flex-1 min-w-[240px]">
          134 официальных паспорта маршрутов Камчатки → kamchatka_routes + Кузьмич.
        </p>
        <button onClick={run} disabled={state.loading} className="ds-btn ds-btn-primary text-sm disabled:opacity-60">
          {state.loading ? 'Импортирую…' : 'Запустить импорт'}
        </button>
      </div>
      {state.result && (
        <div className="text-sm text-[var(--success)] bg-[var(--success)]/10 rounded-lg px-3 py-2 mt-3">{state.result}</div>
      )}
      {state.error && (
        <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2 mt-3">{state.error}</div>
      )}
    </section>
  );
}
