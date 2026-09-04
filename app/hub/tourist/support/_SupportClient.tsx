'use client';

import { useState, useCallback, useEffect } from 'react';
import { Protected } from '@/components/auth/Protected';
import {
  LifeBuoy, Plus, X, ChevronRight, MessageSquare,
  Loader2, CheckCircle, AlertCircle, Clock, RotateCcw,
} from 'lucide-react';

// Модель — та же, что у админки и Telegram-бота (lib/support/ticket.service,
// миграция 078): переписка лежит в самом тикете, статусы и категории — из
// CHECK таблицы. До 04.09 экран ждал поля priority/description и статусы
// КАПСОМ из «столпового» сервиса, которых в базе не было никогда.
interface Message {
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: string;
}

interface Ticket {
  id: string;
  subject: string;
  status: string;
  category: string | null;
  messages: Message[];
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserProfile {
  id: string;
  name: string;
  email: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  booking: 'Бронирование',
  billing: 'Оплата',
  refund: 'Возврат',
  safety: 'Безопасность',
  operator: 'Оператор или гид',
  content: 'Маршруты и места',
  technical: 'Технический вопрос',
  other: 'Другое',
};

const STATUS_CONFIG: Record<string, { label: string; icon: typeof CheckCircle; className: string }> = {
  open: { label: 'Открыта', icon: AlertCircle, className: 'text-[var(--ocean)] bg-[var(--ocean)]/10' },
  assigned: { label: 'Назначена', icon: Clock, className: 'text-[var(--ocean)] bg-[var(--ocean)]/10' },
  in_progress: { label: 'В работе', icon: Clock, className: 'text-[var(--warning)] bg-[var(--warning)]/10' },
  escalated: { label: 'Передана выше', icon: RotateCcw, className: 'text-[var(--accent)] bg-[var(--accent)]/10' },
  resolved: { label: 'Решена', icon: CheckCircle, className: 'text-[var(--success)] bg-[var(--success)]/10' },
  closed: { label: 'Закрыта', icon: X, className: 'text-[var(--text-muted)] bg-[var(--bg-hover)]' },
};

/** Первое сообщение туриста — это и есть описание заявки. */
function firstText(ticket: Ticket): string {
  return ticket.messages?.find((m) => m.role === 'user')?.text ?? '';
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, icon: AlertCircle, className: 'text-[var(--text-muted)] bg-[var(--bg-hover)]' };
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.className}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

type View = 'list' | 'create' | 'detail';

export default function SupportClient() {
  const [view, setView] = useState<View>('list');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  // «Заявок нет» и «заявки не загрузились» — разные экраны (§4.0).
  const [listError, setListError] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [submittingReply, setSubmittingReply] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  // Create form state
  const [form, setForm] = useState({
    subject: '',
    description: '',
    category: 'other',
    customerName: '',
    customerEmail: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState(false);

  const fetchTickets = useCallback(async () => {
    setLoadingTickets(true);
    try {
      const res = await fetch('/api/support/tickets?limit=50');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setTickets(json.data as Ticket[]);
      } else {
        setListError(json.error ?? 'Не удалось загрузить заявки');
      }
    } catch {
      setListError('Нет связи с сервером');
    } finally {
      setLoadingTickets(false);
    }
  }, []);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const json = await res.json();
      if (json.success && json.data) {
        const p = json.data as UserProfile;
        setProfile(p);
        setForm((f) => ({ ...f, customerName: p.name ?? '', customerEmail: p.email ?? '' }));
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchTickets();
    fetchProfile();
  }, [fetchTickets, fetchProfile]);

  const openDetail = useCallback(async (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setView('detail');
    setLoadingMessages(true);
    try {
      const res = await fetch(`/api/support/tickets/${ticket.id}/messages`);
      const json = await res.json();
      setMessages(json.success && Array.isArray(json.data) ? (json.data as Message[]) : ticket.messages ?? []);
    } catch {
      // Переписка уже пришла вместе с тикетом — показываем её, не пустоту.
      setMessages(ticket.messages ?? []);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const submitTicket = useCallback(async () => {
    if (!form.subject.trim() || !form.description.trim()) {
      setFormError('Заполните тему и описание');
      return;
    }
    if (!form.customerName.trim() || !form.customerEmail.trim()) {
      setFormError('Заполните имя и email');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const res = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!json.success) {
        setFormError(json.error ?? json.errors ? JSON.stringify(json.errors) : 'Ошибка создания заявки');
        return;
      }
      setFormSuccess(true);
      await fetchTickets();
      setTimeout(() => {
        setFormSuccess(false);
        setForm((f) => ({ ...f, subject: '', description: '', category: 'other' }));
        setView('list');
      }, 1800);
    } catch {
      setFormError('Ошибка сети. Попробуйте снова.');
    } finally {
      setSubmitting(false);
    }
  }, [form, fetchTickets]);

  const sendReply = useCallback(async () => {
    if (!replyText.trim() || !selectedTicket) return;
    setSubmittingReply(true);
    try {
      const res = await fetch(`/api/support/tickets/${selectedTicket.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: replyText }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        setMessages((m) => [...m, json.data as Message]);
        setReplyText('');
      }
    } catch {
      // silent
    } finally {
      setSubmittingReply(false);
    }
  }, [replyText, selectedTicket]);

  return (
    <Protected roles={['tourist', 'admin']}>
      <div className="max-w-3xl mx-auto px-4 py-6 lg:py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {view !== 'list' && (
              <button
                onClick={() => { setView('list'); setSelectedTicket(null); }}
                className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
              >
                <ChevronRight className="w-5 h-5 rotate-180" />
              </button>
            )}
            <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">
              {view === 'list' ? 'Поддержка' : view === 'create' ? 'Новая заявка' : selectedTicket?.subject}
            </h1>
          </div>
          {view === 'list' && (
            <button
              onClick={() => setView('create')}
              className="ds-btn ds-btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Создать заявку
            </button>
          )}
        </div>

        {/* LIST VIEW */}
        {view === 'list' && (
          <div>
            {loadingTickets ? (
              <div className="flex justify-center py-16">
                <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
              </div>
            ) : listError ? (
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-10 text-center">
                <AlertCircle className="w-10 h-10 mx-auto mb-3 text-[var(--danger)]" />
                <p className="text-[var(--text-secondary)] mb-4">{listError}</p>
                <button onClick={() => { setListError(''); fetchTickets(); }} className="ds-btn ds-btn-secondary">
                  Повторить
                </button>
              </div>
            ) : tickets.length === 0 ? (
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-10 text-center">
                <LifeBuoy className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
                <p className="text-[var(--text-secondary)] mb-4">Заявок пока нет</p>
                <button
                  onClick={() => setView('create')}
                  className="ds-btn ds-btn-primary"
                >
                  Создать первую заявку
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {tickets.map((ticket) => (
                  <button
                    key={ticket.id}
                    onClick={() => openDetail(ticket)}
                    className="w-full text-left bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-[var(--text-primary)] truncate">{ticket.subject}</p>
                        <p className="text-sm text-[var(--text-muted)] mt-0.5 truncate">{firstText(ticket)}</p>
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <StatusBadge status={ticket.status} />
                          {ticket.category && (
                            <span className="text-xs text-[var(--text-muted)]">
                              {CATEGORY_LABELS[ticket.category] ?? ticket.category}
                            </span>
                          )}
                          <span className="text-xs text-[var(--text-muted)]">{formatDate(ticket.createdAt)}</span>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0 mt-1" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CREATE VIEW */}
        {view === 'create' && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6">
            {formSuccess ? (
              <div className="flex flex-col items-center py-8 text-center">
                <CheckCircle className="w-12 h-12 text-[var(--success)] mb-3" />
                <p className="text-lg font-semibold text-[var(--text-primary)]">Заявка создана</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Мы ответим вам в ближайшее время</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="ds-label">Ваше имя *</label>
                    <input
                      type="text"
                      value={form.customerName}
                      onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
                      placeholder="Имя Фамилия"
                      className="ds-input w-full"
                    />
                  </div>
                  <div>
                    <label className="ds-label">Email *</label>
                    <input
                      type="email"
                      value={form.customerEmail}
                      onChange={(e) => setForm((f) => ({ ...f, customerEmail: e.target.value }))}
                      placeholder="email@example.com"
                      className="ds-input w-full"
                    />
                  </div>
                </div>

                <div>
                  <label className="ds-label">Тема *</label>
                  <input
                    type="text"
                    value={form.subject}
                    maxLength={255}
                    onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                    placeholder="Кратко опишите проблему"
                    className="ds-input w-full"
                  />
                </div>

                <div>
                  <label className="ds-label">Категория</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                    className="ds-input w-full"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="ds-label">Описание * (минимум 10 символов)</label>
                  <textarea
                    value={form.description}
                    maxLength={5000}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder="Подробно опишите ситуацию..."
                    rows={5}
                    className="ds-input w-full resize-none"
                  />
                  <p className="text-xs text-[var(--text-muted)] mt-1 text-right">
                    {form.description.length}/5000
                  </p>
                </div>

                {formError && (
                  <p className="text-sm text-[var(--danger)] flex items-center gap-1">
                    <AlertCircle className="w-4 h-4" />
                    {formError}
                  </p>
                )}

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={submitTicket}
                    disabled={submitting}
                    className="ds-btn ds-btn-primary flex items-center gap-2"
                  >
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Отправить заявку
                  </button>
                  <button onClick={() => setView('list')} className="ds-btn ds-btn-secondary">
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* DETAIL VIEW */}
        {view === 'detail' && selectedTicket && (
          <div className="space-y-4">
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={selectedTicket.status} />
                {selectedTicket.category && (
                  <span className="text-sm text-[var(--text-muted)]">
                    {CATEGORY_LABELS[selectedTicket.category] ?? selectedTicket.category}
                  </span>
                )}
                <span className="text-sm text-[var(--text-muted)]">
                  Создан {formatDate(selectedTicket.createdAt)}
                </span>
              </div>
              {selectedTicket.resolution && (
                <p className="mt-3 text-sm text-[var(--text-primary)]">
                  <span className="font-medium">Решение: </span>{selectedTicket.resolution}
                </p>
              )}
            </div>

            {/* Messages */}
            <div className="space-y-3">
              {loadingMessages ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
                </div>
              ) : messages.length === 0 ? (
                <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 text-center">
                  <MessageSquare className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)]" />
                  <p className="text-sm text-[var(--text-secondary)]">Переписка пуста</p>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const isAgent = msg.role === 'agent' || msg.role === 'system';
                  return (
                    <div
                      key={`${msg.ts}-${i}`}
                      className={`rounded-lg p-4 ${isAgent
                        ? 'bg-[var(--bg-primary)] border border-[var(--border)]'
                        : 'bg-[var(--ocean)]/5 border border-[var(--ocean)]/20'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-[var(--text-secondary)]">
                          {msg.role === 'system' ? 'Система' : isAgent ? 'Служба поддержки' : 'Вы'}
                        </span>
                        <span className="text-xs text-[var(--text-muted)]">{formatDate(msg.ts)}</span>
                      </div>
                      <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">{msg.text}</p>
                    </div>
                  );
                })
              )}
            </div>

            {/* Reply */}
            {!['RESOLVED', 'CLOSED'].includes(selectedTicket.status) && (
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                <label className="ds-label">Ответить</label>
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Напишите сообщение..."
                  rows={3}
                  className="ds-input w-full resize-none mt-1"
                />
                <button
                  onClick={sendReply}
                  disabled={submittingReply || !replyText.trim()}
                  className="mt-3 ds-btn ds-btn-primary flex items-center gap-2"
                >
                  {submittingReply ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Отправить
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Protected>
  );
}
