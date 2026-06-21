'use client';

import { useEffect, useState, useCallback } from 'react';
import { Protected } from '@/components/auth/Protected';
import {
  Building2, Search, Loader2, CheckCircle2, XCircle,
  Clock, Phone, Mail, Calendar, ChevronDown, ChevronUp,
  Send, Pencil, Check, Globe, Copy, Database, RefreshCw, Play,
} from 'lucide-react';

type ProfileStatus = 'pending' | 'approved' | 'rejected';

interface OperatorRow {
  id: string;
  company_name: string;
  category: string;
  description: string;
  profile_status: ProfileStatus;
  applied_at: string | null;
  is_verified: boolean;
  is_public: boolean;
  profile_review_comment: string | null;
  email: string;
  contact_name: string;
  registered_at: string;
  application_id: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  inn: string | null;
  application_status: string | null;
  reviewed_at: string | null;
  telegram_chat_id: string | null;
  slug: string | null;
  widget_enabled: boolean;
  widget_domains: string[];
}

const TAB_LABELS: Record<string, string> = {
  pending:  'На проверке',
  approved: 'Одобрены',
  rejected: 'Отклонены',
  all:      'Все',
};

const STATUS_CLS: Record<ProfileStatus, string> = {
  pending:  'bg-[var(--warning)]/15 text-[var(--warning)]',
  approved: 'bg-[var(--success)]/15 text-[var(--success)]',
  rejected: 'bg-[var(--danger)]/10  text-[var(--danger)]',
};

function formatDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const CATEGORY_LABELS: Record<string, string> = {
  operator: 'Туроператор',
  guide:    'Гид',
  transfer: 'Трансфер',
  hotel:    'Отель',
  rent:     'Аренда',
  fishing:  'Рыбалка',
};

function RejectModal({
  name,
  onConfirm,
  onCancel,
}: { name: string; onConfirm: (comment: string) => void; onCancel: () => void }) {
  const [comment, setComment] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl w-full max-w-md p-6 shadow-xl">
        <h3 className="font-semibold text-[var(--text-primary)] mb-1">Отклонить заявку</h3>
        <p className="text-sm text-[var(--text-secondary)] mb-4">{name}</p>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="Причина отказа (будет отправлена на email оператора)"
          rows={3}
          className="w-full px-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none"
        />
        <div className="flex gap-2 mt-4 justify-end">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            Отмена
          </button>
          <button
            onClick={() => onConfirm(comment)}
            className="px-4 py-2 text-sm bg-[var(--danger)] text-white rounded-lg hover:bg-[var(--danger)]/90 transition-colors"
          >
            Отклонить
          </button>
        </div>
      </div>
    </div>
  );
}

function OperatorCard({
  op,
  onApprove,
  onReject,
  acting,
}: {
  op: OperatorRow;
  onApprove: (id: string) => void;
  onReject: (id: string, name: string) => void;
  acting: string | null;
}) {
  const [expanded, setExpanded] = useState(op.profile_status === 'pending');
  const [tgEdit, setTgEdit] = useState(false);
  const [tgValue, setTgValue] = useState(op.telegram_chat_id ?? '');
  const [tgSaving, setTgSaving] = useState(false);

  const [widgetEnabled, setWidgetEnabled] = useState(op.widget_enabled ?? false);
  const [widgetDomains, setWidgetDomains] = useState((op.widget_domains ?? []).join('\n'));
  const [widgetEditing, setWidgetEditing] = useState(false);
  const [widgetSaving, setWidgetSaving] = useState(false);
  const [widgetCopied, setWidgetCopied] = useState(false);

  async function saveTelegram() {
    setTgSaving(true);
    try {
      await fetch(`/api/admin/operators/${op.id}/contacts`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_chat_id: tgValue.trim() || null }),
      });
      setTgEdit(false);
    } finally {
      setTgSaving(false);
    }
  }

  async function toggleWidget() {
    const next = !widgetEnabled;
    setWidgetEnabled(next);
    await fetch(`/api/admin/operators/${op.id}/widget`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widget_enabled: next }),
    });
  }

  async function saveWidgetDomains() {
    setWidgetSaving(true);
    try {
      const domains = widgetDomains.split('\n').map(d => d.trim()).filter(Boolean);
      await fetch(`/api/admin/operators/${op.id}/widget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widget_domains: domains }),
      });
      setWidgetEditing(false);
    } finally {
      setWidgetSaving(false);
    }
  }

  function copyEmbed() {
    if (!op.slug) return;
    const code = `<script src="https://tourhab.ru/api/widget/lead.js?partner=${op.slug}" defer></script>`;
    navigator.clipboard.writeText(code).catch(() => {});
    setWidgetCopied(true);
    setTimeout(() => setWidgetCopied(false), 2000);
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Building2 className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          <div className="min-w-0">
            <p className="font-medium text-[var(--text-primary)] truncate">{op.company_name}</p>
            <p className="text-xs text-[var(--text-muted)]">
              {CATEGORY_LABELS[op.category] ?? op.category} · {op.contact_name}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_CLS[op.profile_status]}`}>
            {TAB_LABELS[op.profile_status]}
          </span>
          {expanded ? <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-[var(--border)]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 text-sm">
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Mail className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <a href={`mailto:${op.email}`} className="hover:text-[var(--accent)] transition-colors truncate">{op.email}</a>
            </div>
            {op.contact_phone && (
              <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                <Phone className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                <a href={`tel:${op.contact_phone}`} className="hover:text-[var(--accent)] transition-colors">{op.contact_phone}</a>
              </div>
            )}
            {op.inn && (
              <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                <span className="text-[var(--text-muted)] text-xs">ИНН:</span>
                <span>{op.inn}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Calendar className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span>Подано: {formatDate(op.applied_at ?? op.registered_at)}</span>
            </div>
          </div>

          {op.description && (
            <p className="mt-3 text-sm text-[var(--text-secondary)] line-clamp-3">{op.description}</p>
          )}

          {op.profile_review_comment && (
            <div className="mt-3 px-3 py-2 bg-[var(--danger)]/5 border border-[var(--danger)]/15 rounded-lg">
              <p className="text-xs text-[var(--danger)]"><b>Причина отказа:</b> {op.profile_review_comment}</p>
            </div>
          )}

          {/* Telegram Chat ID */}
          <div className="mt-3 flex items-center gap-2 text-sm">
            <Send className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
            {tgEdit ? (
              <div className="flex items-center gap-1.5 flex-1">
                <input
                  autoFocus
                  value={tgValue}
                  onChange={e => setTgValue(e.target.value)}
                  placeholder="telegram_chat_id (число)"
                  className="flex-1 px-2 py-1 text-xs bg-[var(--bg-primary)] border border-[var(--accent)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
                />
                <button
                  onClick={saveTelegram}
                  disabled={tgSaving}
                  className="p-1 text-[var(--success)] hover:bg-[var(--success)]/10 rounded transition-colors"
                >
                  {tgSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => { setTgEdit(false); setTgValue(op.telegram_chat_id ?? ''); }}
                  className="p-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)] rounded transition-colors"
                >
                  <XCircle className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 flex-1">
                <span className={`text-xs ${tgValue ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)] italic'}`}>
                  {tgValue || 'telegram_chat_id не указан'}
                </span>
                <button
                  onClick={() => setTgEdit(true)}
                  className="p-1 text-[var(--text-muted)] hover:text-[var(--accent)] rounded transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* Widget management */}
          {op.slug && (
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)]">
                  <Globe className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  Виджет для партнёрского сайта
                </div>
                <button
                  onClick={toggleWidget}
                  className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                    widgetEnabled
                      ? 'bg-[var(--success)]/15 text-[var(--success)]'
                      : 'bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {widgetEnabled ? 'Включён' : 'Выключен'}
                </button>
              </div>

              {widgetEnabled && (
                <>
                  {/* Embed code */}
                  <div className="flex items-center gap-1.5 mb-2">
                    <code className="flex-1 text-[10px] bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-secondary)] truncate select-all">
                      {`<script src="https://tourhab.ru/api/widget/lead.js?partner=${op.slug}" defer></script>`}
                    </code>
                    <button
                      onClick={copyEmbed}
                      className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] rounded transition-colors shrink-0"
                      title="Скопировать код"
                    >
                      {widgetCopied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {/* Allowed domains */}
                  <div className="text-xs text-[var(--text-muted)] mb-1 flex items-center justify-between">
                    <span>Разрешённые домены:</span>
                    {!widgetEditing && (
                      <button
                        onClick={() => setWidgetEditing(true)}
                        className="text-[var(--accent)] hover:opacity-75 transition-opacity"
                      >
                        Изменить
                      </button>
                    )}
                  </div>
                  {widgetEditing ? (
                    <div>
                      <textarea
                        value={widgetDomains}
                        onChange={e => setWidgetDomains(e.target.value)}
                        placeholder="example.com&#10;www.partner.ru"
                        rows={3}
                        className="w-full text-xs px-2 py-1.5 bg-[var(--bg-primary)] border border-[var(--accent)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none resize-none"
                      />
                      <div className="flex gap-1.5 mt-1">
                        <button
                          onClick={saveWidgetDomains}
                          disabled={widgetSaving}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--accent)] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-50"
                        >
                          {widgetSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          Сохранить
                        </button>
                        <button
                          onClick={() => setWidgetEditing(false)}
                          className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-[var(--text-secondary)]">
                      {widgetDomains.trim()
                        ? widgetDomains.split('\n').filter(Boolean).map((d, i) => (
                            <span key={i} className="inline-block bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 mr-1 mb-1">{d.trim()}</span>
                          ))
                        : <span className="text-[var(--text-muted)] italic">Домены не указаны — виджет не будет работать</span>
                      }
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Actions */}
          {op.profile_status === 'pending' && (
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => onApprove(op.id)}
                disabled={acting === op.id}
                className="flex items-center gap-1.5 px-4 py-2 bg-[var(--success)] hover:bg-[var(--success)]/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {acting === op.id
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <CheckCircle2 className="w-4 h-4" />
                }
                Одобрить
              </button>
              <button
                onClick={() => onReject(op.id, op.company_name)}
                disabled={acting === op.id}
                className="flex items-center gap-1.5 px-4 py-2 border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger)]/5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                <XCircle className="w-4 h-4" />
                Отклонить
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ScrapeAction = 'scrape_operators' | 'scrape_guides' | 'scrape_tours' | 'scrape_tours_per_operator_taras' | 'scrape_tours_per_operator_all' | 'debug_fetch' | 'debug_fetch_tours' | 'audit_site' | 'diagnose_brightdata';

interface ScrapeResult {
  ok: boolean;
  duration_ms?: number;
  operators_processed?: number;
  tours_found?: number;
  tours_saved?: number;
  operators_found?: number;
  operators_saved?: number;
  // scrape_guides fields
  updated?: number;
  guides?: { name: string; status: string; cert?: string }[];
  errors?: number | string[];
  log?: string[];
  error?: string;
  // audit_site fields
  audited_at?: string;
  sections?: {
    key: string;
    label: string;
    url: string;
    status: string;
    html_length: number;
    title: string | null;
    item_count: number;
    top_classes: string[];
    nav_links: string[];
    internal_links: { url: string; text: string }[];
    html_preview: string;
    pagination: { found: boolean; total_pages?: number; total_items?: number };
  }[];
  summary?: {
    accessible_sections: number;
    total_items_found: number;
    discovered_paths: string[];
  };
  // diagnose_brightdata fields
  token_set?: boolean;
  reachable?: boolean;
  status?: number;
  // debug_fetch (operators) fields
  html_fetched?: boolean;
  html_length?: number;
  html_preview?: string;
  top_classes?: string[];
  // scrape_tours fields
  total?: number;
  inserted?: number;
  matched_operators?: number;
  tours?: { title: string; date?: string; price?: number; status: string }[];
  debug?: {
    strategy: string;
    html_length?: number;
    next_data_found?: boolean;
    api_tried?: string[];
  };
  // debug_fetch_tours fields
  next_data_found?: boolean;
  next_data_keys?: string[];
  api_probes?: { url: string; status: string }[];
}

interface DbStatus {
  total: number;
  with_website: number;
}

function ScraperPanel() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<ScrapeAction | null>(null);
  const [result, setResult] = useState<ScrapeResult | null>(null);
  const [lastAction, setLastAction] = useState<ScrapeAction | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch('/api/admin/operators/db-status')
      .then(r => r.ok ? r.json() : null)
      .then((j: unknown) => {
        if (j && typeof j === 'object' && 'total' in j) {
          setDbStatus(j as DbStatus);
        }
      })
      .catch(() => {});
  }, [open]);

  async function runAction(action: ScrapeAction) {
    setRunning(action);
    setLastAction(action);
    setResult(null);
    setShowLog(false);
    try {
      let body: Record<string, unknown>;
      if (action === 'diagnose_brightdata') {
        body = { action: 'diagnose_brightdata' };
      } else if (action === 'debug_fetch') {
        body = { action: 'debug_fetch' };
      } else if (action === 'debug_fetch_tours') {
        body = { action: 'debug_fetch_tours' };
      } else if (action === 'audit_site') {
        body = { action: 'audit_site' };
      } else if (action === 'scrape_tours') {
        body = { action: 'scrape_tours' };
      } else if (action === 'scrape_operators') {
        body = { action: 'scrape_operators' };
      } else if (action === 'scrape_guides') {
        body = { action: 'scrape_guides' };
      } else if (action === 'scrape_tours_per_operator_taras') {
        body = {
          action: 'scrape_tours_per_operator',
          categories: ['volcano', 'sea', 'rafting', 'thermal'],
          max_operators: 20,
        };
      } else {
        body = {
          action: 'scrape_tours_per_operator',
          max_operators: 20,
        };
      }
      const res = await fetch('/api/admin/import/operators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j: unknown = await res.json();
      const parsed = j as ScrapeResult;
      setResult(parsed);
      // Автоматически открыть лог если 0 операторов обработано
      const isTours = action !== 'scrape_operators';
      if (isTours && (parsed.operators_processed === 0 || parsed.tours_found === 0)) {
        setShowLog(true);
      }
      // Обновить статус БД после импорта операторов
      if (action === 'scrape_operators') {
        fetch('/api/admin/operators/db-status')
          .then(r => r.ok ? r.json() : null)
          .then((s: unknown) => { if (s && typeof s === 'object' && 'total' in s) setDbStatus(s as DbStatus); })
          .catch(() => {});
      }
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setRunning(null);
    }
  }

  const durationSec = result?.duration_ms ? (result.duration_ms / 1000).toFixed(1) : null;
  const noWebsites = dbStatus !== null && dbStatus.with_website === 0;

  return (
    <div className="mb-6 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
          <Database className="w-4 h-4 text-[var(--ocean)]" />
          Сбор данных туров
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />}
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-[var(--border)]">
          {/* Статус БД */}
          {dbStatus && (
            <div className="mt-3 text-xs text-[var(--text-muted)] flex items-center gap-2">
              <span>БД: {dbStatus.total} операторов</span>
              <span>·</span>
              <span className={dbStatus.with_website > 0 ? 'text-[var(--success)]' : 'text-[var(--warning)]'}>
                {dbStatus.with_website} с сайтом
              </span>
            </div>
          )}

          {/* Предупреждение если нет операторов с сайтами */}
          {noWebsites && (
            <div className="mt-2 p-2 bg-[var(--warning)]/10 border border-[var(--warning)]/25 rounded text-xs text-[var(--warning)]">
              ⚠ Сначала запустите «Шаг 1» — без сайтов операторов поиск туров невозможен
            </div>
          )}

          <p className="text-xs text-[var(--text-muted)] mt-3 mb-2">
            Парсинг сайтов туроператоров через Bright Data + AI-извлечение. Занимает 2-5 минут.
          </p>

          <div className="space-y-2">
            {/* Диагностика Bright Data */}
            <div className="flex items-center gap-2 flex-wrap pb-2 border-b border-[var(--border)]">
              <span className="text-[10px] font-bold text-[var(--text-muted)] w-10 shrink-0">ТЕСТ</span>
              <button
                onClick={() => runAction('diagnose_brightdata')}
                disabled={running !== null}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/20 rounded-lg hover:bg-[var(--warning)]/20 transition-colors disabled:opacity-50"
                title="Проверяет BRIGHTDATA_API_TOKEN и доступность прокси. Запускай если аудит возвращает 403."
              >
                {running === 'diagnose_brightdata'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Database className="w-3.5 h-3.5" />
                }
                Тест Bright Data
              </button>
              {/* Аудит сайта */}
              <button
                onClick={() => runAction('audit_site')}
                disabled={running !== null}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--accent)]/8 text-[var(--accent)] border border-[var(--accent)]/20 rounded-lg hover:bg-[var(--accent)]/15 transition-colors disabled:opacity-50"
                title="Обходит все разделы visitkamchatka.ru через Bright Data: маршруты, места, операторы, туры. Занимает ~3 мин."
              >
                {running === 'audit_site'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />
                }
                Аудит visitkamchatka.ru
              </button>
            </div>

            {/* Шаг 1 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold text-[var(--text-muted)] w-10 shrink-0">ШАГ 1</span>
              <button
                onClick={() => runAction('scrape_operators')}
                disabled={running !== null}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--ocean)]/10 text-[var(--ocean)] border border-[var(--ocean)]/20 rounded-lg hover:bg-[var(--ocean)]/20 transition-colors disabled:opacity-50"
              >
                {running === 'scrape_operators'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />
                }
                Импорт операторов (visitkamchatka.ru)
              </button>
              <button
                onClick={() => runAction('debug_fetch')}
                disabled={running !== null}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--bg-primary)] text-[var(--text-muted)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                title="Показать что возвращает Bright Data с visitkamchatka.ru"
              >
                {running === 'debug_fetch'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Database className="w-3.5 h-3.5" />
                }
                Debug HTML
              </button>
            </div>

            {/* Шаг 1А: гиды с visitkamchatka.ru/guides/ */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold text-[var(--text-muted)] w-10 shrink-0">ШАГ 1А</span>
              <button
                onClick={() => runAction('scrape_guides')}
                disabled={running !== null}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--ocean)]/10 text-[var(--ocean)] border border-[var(--ocean)]/20 rounded-lg hover:bg-[var(--ocean)]/20 transition-colors disabled:opacity-50"
                title="Парсит visitkamchatka.ru/guides/ — аттестованные гиды Камчатки → partners (guide) + guide_certifications"
              >
                {running === 'scrape_guides'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />
                }
                Импорт гидов (visitkamchatka.ru/guides/)
              </button>
            </div>

            {/* Шаг 1Б: туры с биржи tours.visitkamchatka.ru — работает независимо */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold text-[var(--text-muted)] w-10 shrink-0">ШАГ 1Б</span>
              <button
                onClick={() => runAction('scrape_tours')}
                disabled={running !== null}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20 rounded-lg hover:bg-[var(--success)]/20 transition-colors disabled:opacity-50"
              >
                {running === 'scrape_tours'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Play className="w-3.5 h-3.5" />
                }
                Туры с биржи (tours.visitkamchatka.ru)
              </button>
              <button
                onClick={() => runAction('debug_fetch_tours')}
                disabled={running !== null}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--bg-primary)] text-[var(--text-muted)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                title="Диагностика: __NEXT_DATA__, API-пробы, HTML структура"
              >
                {running === 'debug_fetch_tours'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Database className="w-3.5 h-3.5" />
                }
                Debug Tours
              </button>
            </div>

            {/* Шаг 2 */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-[var(--text-muted)] w-10 shrink-0">ШАГ 2</span>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => runAction('scrape_tours_per_operator_taras')}
                  disabled={running !== null || noWebsites}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 rounded-lg hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-40"
                >
                  {running === 'scrape_tours_per_operator_taras'
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Play className="w-3.5 h-3.5" />
                  }
                  Найти туры: Тарас (вулкан / море / сплав / термы)
                </button>

                <button
                  onClick={() => runAction('scrape_tours_per_operator_all')}
                  disabled={running !== null || noWebsites}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[var(--bg-primary)] text-[var(--text-secondary)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40"
                >
                  {running === 'scrape_tours_per_operator_all'
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Database className="w-3.5 h-3.5" />
                  }
                  Все туры всех операторов
                </button>
              </div>
            </div>
          </div>

          {running && (
            <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Парсинг запущен... это займёт несколько минут
            </div>
          )}

          {result && (
            <div className={`mt-3 p-3 rounded-lg text-xs ${result.ok ? 'bg-[var(--success)]/8 border border-[var(--success)]/20' : 'bg-[var(--danger)]/8 border border-[var(--danger)]/20'}`}>
              {result.ok ? (
                <div className="space-y-0.5">
                  <p className="font-medium text-[var(--success)] flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Готово за {durationSec}с
                  </p>
                  {result.total !== undefined && (
                    <p className="text-[var(--text-secondary)]">Найдено: {result.total} | Добавлено: {result.inserted ?? 0} | Обновлено: {result.updated ?? 0}</p>
                  )}
                  {result.operators_found !== undefined && (
                    <p className="text-[var(--text-secondary)]">Операторов: {result.operators_found} найдено</p>
                  )}
                  {result.operators_processed !== undefined && (
                    <p className="text-[var(--text-secondary)]">Операторов обработано: {result.operators_processed}</p>
                  )}
                  {result.tours_found !== undefined && (
                    <p className="text-[var(--text-secondary)]">Туров найдено: {result.tours_found}</p>
                  )}
                  {result.tours_saved !== undefined && (
                    <p className="text-[var(--text-secondary)]">Туров сохранено: {result.tours_saved}</p>
                  )}
                  {Array.isArray(result.errors) && result.errors.length > 0 && (
                    <div className="mt-1">
                      {result.errors.map((e, i) => (
                        <p key={i} className="text-[var(--danger)] break-words">{e}</p>
                      ))}
                    </div>
                  )}
                  {typeof result.errors === 'number' && result.errors > 0 && (
                    <p className="text-[var(--warning)]">Ошибок: {result.errors}</p>
                  )}
                  {/* diagnose_brightdata результат */}
                  {result.token_set !== undefined && (
                    <div className="mt-1 space-y-0.5">
                      <p className={result.token_set ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                        Токен BRIGHTDATA_API_TOKEN: {result.token_set ? 'задан' : 'НЕ ЗАДАН — добавь в Timeweb'}
                      </p>
                      {result.token_set && (
                        <p className={result.reachable ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                          Прокси доступен: {result.reachable ? `да (HTTP ${result.status})` : `нет (${result.error ?? `HTTP ${result.status}`})`}
                        </p>
                      )}
                    </div>
                  )}
                  {/* audit_site результат */}
                  {result.summary && (
                    <div className="mt-1 space-y-1">
                      <p className="text-[var(--text-secondary)]">
                        Доступно разделов: <b>{result.summary.accessible_sections}</b> · Найдено элементов: <b>{result.summary.total_items_found}</b>
                      </p>
                      {result.sections && result.sections.map(s => (
                        <div key={s.key} className={`flex items-start gap-2 text-[10px] ${s.status === 'ok' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>
                          <span className={`shrink-0 font-medium ${s.status === 'ok' ? 'text-[var(--success)]' : s.status === '403' ? 'text-[var(--danger)]' : 'text-[var(--warning)]'}`}>
                            {s.status === 'ok' ? '✓' : s.status === '403' ? '✗' : '?'}
                          </span>
                          <span className="shrink-0 w-36">{s.label}</span>
                          <span className={`shrink-0 ${s.item_count > 0 ? 'text-[var(--success)]' : ''}`}>
                            {s.status === 'ok' ? `${s.item_count} эл. · ${s.html_length} байт` : s.status}
                          </span>
                          {s.title && <span className="text-[var(--text-muted)] truncate">{s.title}</span>}
                        </div>
                      ))}
                      {result.summary.discovered_paths.length > 0 && (
                        <div className="mt-1">
                          <p className="text-[var(--text-muted)] mb-0.5">Найденные разделы:</p>
                          <p className="text-[10px] text-[var(--text-muted)] break-words">
                            {result.summary.discovered_paths.slice(0, 30).join(' · ')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  {/* scrape_tours результат */}
                  {result.total !== undefined && (
                    <p className="text-[var(--text-secondary)]">Туров найдено: {result.total}, сохранено: {result.inserted ?? 0}, операторов: {result.matched_operators ?? 0}</p>
                  )}
                  {result.debug && (
                    <p className="text-[var(--text-muted)] text-[10px]">Стратегия: <b>{result.debug.strategy}</b> · HTML: {result.debug.html_length ?? '—'} байт · __NEXT_DATA__: {result.debug.next_data_found ? '✓ найден' : '✗ нет'}</p>
                  )}
                  {result.tours && result.tours.length > 0 && (
                    <div className="mt-1 max-h-40 overflow-y-auto">
                      {result.tours.slice(0, 20).map((t, i) => (
                        <p key={i} className="text-[var(--text-muted)] text-[10px]">{t.title.slice(0, 60)} · {t.date ?? '—'} · {t.price ? `${t.price}₽` : '—'} · {t.status}</p>
                      ))}
                    </div>
                  )}
                  {/* Debug HTML результаты (operators) */}
                  {result.html_length !== undefined && result.total === undefined && result.next_data_found === undefined && (
                    <p className="text-[var(--text-secondary)]">
                      HTML: {result.html_fetched ? `${result.html_length} байт` : 'не получен (403 или нет BD токена)'}
                    </p>
                  )}
                  {result.top_classes && result.top_classes.length > 0 && (
                    <p className="text-[var(--text-muted)] break-words text-[10px]">CSS классы: {result.top_classes.join(', ')}</p>
                  )}
                  {result.html_preview && (
                    <pre className="mt-2 max-h-48 overflow-y-auto text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap bg-[var(--bg-primary)] rounded p-2">
                      {result.html_preview}
                    </pre>
                  )}
                  {/* Debug Tours результаты */}
                  {result.next_data_found !== undefined && (
                    <div className="mt-1 space-y-0.5">
                      <p className={`font-medium ${result.next_data_found ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                        __NEXT_DATA__: {result.next_data_found ? `✓ найден — ключи: ${result.next_data_keys?.join(', ') || '?'}` : '✗ не найден (возможно JS-рендеринг или 403)'}
                      </p>
                      {result.api_probes && (
                        <div>
                          <p className="text-[var(--text-muted)]">API-пробы:</p>
                          {result.api_probes.map((p, i) => (
                            <p key={i} className={`text-[10px] ${p.status === 'json' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
                              {p.url} → {p.status}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Подсказка если нет операторов с сайтом */}
                  {lastAction !== 'scrape_operators' && result.operators_processed === 0 && result.total === undefined && (
                    <p className="text-[var(--warning)] mt-1">
                      ⚠ 0 операторов с сайтом — сначала запустите «ШАГ 1: Импорт операторов»
                    </p>
                  )}
                  {result.log && result.log.length > 0 && (
                    <button
                      onClick={() => setShowLog(s => !s)}
                      className="mt-1 text-[var(--ocean)] underline underline-offset-2"
                    >
                      {showLog ? 'Скрыть лог' : `Показать лог (${result.log.length} строк)`}
                    </button>
                  )}
                  {showLog && result.log && (
                    <pre className="mt-2 max-h-48 overflow-y-auto text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap bg-[var(--bg-primary)] rounded p-2">
                      {result.log.join('\n')}
                    </pre>
                  )}
                </div>
              ) : (
                <p className="text-[var(--danger)]">{result.error ?? 'Ошибка выполнения'}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function OperatorsClient() {
  const [tab, setTab]             = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [acting, setActing]       = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{ id: string; name: string } | null>(null);
  const [counts, setCounts]       = useState<Record<string, number>>({});

  const load = useCallback(async (status: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/operators?status=${status}&limit=100`);
      const j: unknown = await res.json();
      if (typeof j === 'object' && j !== null && 'data' in j) {
        setOperators((j as { data: OperatorRow[] }).data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Load counts for badge display
  const loadCounts = useCallback(async () => {
    const statuses: Array<'pending' | 'approved' | 'rejected'> = ['pending', 'approved', 'rejected'];
    const results = await Promise.all(
      statuses.map(s =>
        fetch(`/api/admin/operators?status=${s}&limit=1`)
          .then(r => r.json())
          .then((j: unknown) => {
            const total = typeof j === 'object' && j !== null && 'meta' in j
              ? (j as { meta: { total: number } }).meta.total
              : 0;
            return [s, total] as [string, number];
          })
          .catch(() => [s, 0] as [string, number])
      )
    );
    setCounts(Object.fromEntries(results));
  }, []);

  useEffect(() => { load(tab); }, [load, tab]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  async function approve(id: string) {
    setActing(id);
    try {
      const res = await fetch(`/api/admin/operators/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      const j: unknown = await res.json();
      if (typeof j === 'object' && j !== null && 'success' in j && (j as { success: boolean }).success) {
        setOperators(prev => prev.filter(o => o.id !== id));
        setCounts(prev => ({ ...prev, pending: (prev.pending ?? 1) - 1, approved: (prev.approved ?? 0) + 1 }));
      }
    } finally {
      setActing(null);
    }
  }

  async function reject(id: string, comment: string) {
    setRejectTarget(null);
    setActing(id);
    try {
      const res = await fetch(`/api/admin/operators/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', comment }),
      });
      const j: unknown = await res.json();
      if (typeof j === 'object' && j !== null && 'success' in j && (j as { success: boolean }).success) {
        setOperators(prev => prev.filter(o => o.id !== id));
        setCounts(prev => ({ ...prev, pending: (prev.pending ?? 1) - 1, rejected: (prev.rejected ?? 0) + 1 }));
      }
    } finally {
      setActing(null);
    }
  }

  const filtered = operators.filter(o =>
    o.company_name.toLowerCase().includes(search.toLowerCase()) ||
    o.contact_name.toLowerCase().includes(search.toLowerCase()) ||
    o.email.toLowerCase().includes(search.toLowerCase())
  );

  const TABS = ['pending', 'approved', 'rejected', 'all'] as const;

  return (
    <Protected roles={['admin']}>
      {rejectTarget && (
        <RejectModal
          name={rejectTarget.name}
          onConfirm={comment => reject(rejectTarget.id, comment)}
          onCancel={() => setRejectTarget(null)}
        />
      )}

      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Building2 className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Операторы</h1>
          {counts.pending > 0 && (
            <span className="px-2 py-0.5 text-xs bg-[var(--warning)]/20 text-[var(--warning)] rounded-full font-medium">
              {counts.pending} ожидают
            </span>
          )}
        </div>

        {/* Scraper panel */}
        <ScraperPanel />

        {/* Tabs */}
        <div className="flex gap-1 mb-4 bg-[var(--bg-primary)] rounded-lg p-1 w-fit">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors relative ${
                tab === t
                  ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {TAB_LABELS[t]}
              {counts[t] !== undefined && counts[t] > 0 && t !== 'all' && (
                <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">({counts[t]})</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по названию, контакту, email..."
            className="w-full pl-10 pr-4 py-2.5 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>

        {/* List */}
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Clock className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-[var(--text-secondary)]">
              {tab === 'pending' ? 'Нет заявок на проверке' : 'Ничего не найдено'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(op => (
              <OperatorCard
                key={op.id}
                op={op}
                onApprove={approve}
                onReject={(id, name) => setRejectTarget({ id, name })}
                acting={acting}
              />
            ))}
          </div>
        )}
      </div>
    </Protected>
  );
}
