'use client';

/**
 * Карточка клиента (CRM #2325): как связаться, что о нём записано, откуда он
 * пришёл. Партнёр правит только имя, заметку и метки — телефон, почта и
 * согласие приходят из источников и руками не переписываются. Администратор
 * видит карточку любого партнёра с его именем и ничего не правит.
 */
import { useEffect, useRef, useState } from 'react';
import { X, Phone, Mail, UserCheck, ShieldCheck, ShieldQuestion, Plus, Briefcase } from 'lucide-react';
import type { ContactCard } from '@/lib/crm/contact-queries';
import type { PartnerRef } from '@/lib/crm/admin-queries';
import { useModalDialog } from '@/hooks/use-modal-dialog';
import { CRM_API, type CrmMode } from './api';
import { SOURCE_KIND_LABELS, statusLabel, formatSourceDate, formatMoment, partnerCategoryLabel } from './labels';

type Card = ContactCard & { partner?: PartnerRef };

type CardState =
  | { kind: 'loading' }
  | { kind: 'ready'; card: Card }
  | { kind: 'error'; message: string };

interface Props {
  contactId: string;
  /** admin — карточка любого партнёра, только просмотр. */
  mode?: CrmMode;
  onClose: () => void;
  /** Что-то сохранено — список обновит строку. */
  onChanged: () => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readCard(json: unknown): Card | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const d = json.data;
  return typeof d.id === 'string' && Array.isArray(d.sources) && Array.isArray(d.tags) ? (d as unknown as Card) : null;
}

const MAX_TAGS = 20;

export function ContactPanel({ contactId, mode = 'partner', onClose, onChanged }: Props) {
  const readOnly = mode === 'admin';
  const dialogRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [name, setName] = useState('');
  const [tagInput, setTagInput] = useState('');

  useModalDialog(dialogRef, onClose, () => !saving);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${CRM_API[mode]}/${encodeURIComponent(contactId)}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        if (ctrl.signal.aborted) return;
        const card = res.ok ? readCard(json) : null;
        if (card) {
          setState({ kind: 'ready', card });
          setNotes(card.notes ?? '');
          setName(card.display_name ?? '');
        } else {
          const msg = isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось открыть клиента, попробуйте позже';
          setState({ kind: 'error', message: msg });
        }
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ kind: 'error', message: 'Нет связи с сервером — карточка не загружена' });
      });
    return () => ctrl.abort();
  }, [contactId, mode]);

  async function save(patch: { display_name?: string; notes?: string | null; tags?: string[] }): Promise<boolean> {
    if (readOnly) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`${CRM_API.partner}/${encodeURIComponent(contactId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || !isRecord(json) || json.success !== true) {
        setSaveError(isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось сохранить, попробуйте позже');
        return false;
      }
      setState((s) => (s.kind === 'ready' ? { kind: 'ready', card: { ...s.card, ...patch } } : s));
      onChanged();
      return true;
    } catch {
      setSaveError('Нет связи с сервером — не сохранено');
      return false;
    } finally {
      setSaving(false);
    }
  }

  function addTag() {
    if (state.kind !== 'ready') return;
    const t = tagInput.trim().slice(0, 40);
    if (!t || state.card.tags.includes(t) || state.card.tags.length >= MAX_TAGS) { setTagInput(''); return; }
    void save({ tags: [...state.card.tags, t] }).then((ok) => { if (ok) setTagInput(''); });
  }

  const card = state.kind === 'ready' ? state.card : null;
  const nameChanged = card !== null && name.trim() !== '' && name.trim() !== (card.display_name ?? '');
  const notesChanged = card !== null && notes !== (card.notes ?? '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-contact-title"
        className="ds-card w-full sm:max-w-xl max-h-[92dvh] overflow-y-auto rounded-t-lg sm:rounded-lg p-5 space-y-5 outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="crm-contact-title" className="ds-h2 text-[var(--text-primary)]">
            {card?.display_name ?? (card ? 'Имя не указано' : 'Клиент')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Закрыть"
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors duration-200 disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {state.kind === 'loading' && (
          <div className="space-y-2">
            <div className="ds-skeleton h-5 w-2/3 rounded" />
            <div className="ds-skeleton h-20 rounded-lg" />
          </div>
        )}

        {state.kind === 'error' && <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>}

        {card && (
          <>
            {card.partner && (
              <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <Briefcase className="w-4 h-4 text-[var(--ocean)]" />
                Клиент партнёра «{card.partner.name}» · {partnerCategoryLabel(card.partner.category)}
              </p>
            )}

            <section className="space-y-2 text-sm" aria-label="Контакты">
              {card.phone && (
                <a href={`tel:${card.phone}`} className="flex items-center gap-2 text-[var(--ocean)] hover:underline">
                  <Phone className="w-4 h-4" /> {card.phone}
                </a>
              )}
              {card.email && (
                <a href={`mailto:${card.email}`} className="flex items-center gap-2 text-[var(--ocean)] hover:underline break-all">
                  <Mail className="w-4 h-4 shrink-0" /> {card.email}
                </a>
              )}
              {!card.phone && !card.email && (
                <p className="text-[var(--text-muted)]">Ни телефона, ни почты источник не записал.</p>
              )}
              {card.has_account && (
                <p className="flex items-center gap-2 text-[var(--text-secondary)]">
                  <UserCheck className="w-4 h-4" /> Есть аккаунт на платформе
                </p>
              )}
            </section>

            <section className="rounded-lg border border-[var(--border)] p-3 text-xs space-y-1" aria-label="Согласие на обработку данных">
              {card.consent ? (
                <>
                  <p className="flex items-center gap-2 text-[var(--success)] font-medium">
                    <ShieldCheck className="w-4 h-4" /> Согласие на обработку данных записано {formatMoment(card.consent.recorded_at) ?? ''}
                  </p>
                  {(card.consent.source || card.consent.version) && (
                    <p className="text-[var(--text-muted)]">
                      {[card.consent.source && `форма: ${card.consent.source}`, card.consent.version && `редакция ${card.consent.version}`]
                        .filter(Boolean).join(' · ')}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 text-[var(--text-secondary)] font-medium">
                    <ShieldQuestion className="w-4 h-4" /> Согласие на обработку данных не записано
                  </p>
                  <p className="text-[var(--text-muted)]">
                    Форма, через которую пришёл клиент, согласия не собирала, или клиент добавлен вручную. Это не отказ — просто записи нет.
                  </p>
                </>
              )}
            </section>

            {readOnly ? (
              <>
                <section className="space-y-2" aria-label="Метки">
                  <p className="ds-label">Метки партнёра</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {card.tags.map((t) => (
                      <span key={t} className="ds-badge bg-[var(--bg-hover)] text-[var(--text-secondary)]">{t}</span>
                    ))}
                    {card.tags.length === 0 && <span className="text-xs text-[var(--text-muted)]">Меток нет</span>}
                  </div>
                </section>

                <section className="space-y-1" aria-label="Заметка">
                  <p className="ds-label">Заметка партнёра</p>
                  <p className="text-sm text-[var(--text-secondary)] whitespace-pre-line">
                    {card.notes ?? <span className="text-[var(--text-muted)]">Заметки нет</span>}
                  </p>
                </section>
              </>
            ) : (
              <>
                <section className="space-y-2" aria-label="Имя">
                  <label className="ds-label" htmlFor="crm-contact-name">Как называть клиента</label>
                  <div className="flex gap-2">
                    <input
                      id="crm-contact-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={200}
                      placeholder="Имя"
                      className="ds-input flex-1"
                    />
                    {nameChanged && (
                      <button type="button" disabled={saving} onClick={() => void save({ display_name: name.trim() })} className="ds-btn ds-btn-secondary">
                        Сохранить
                      </button>
                    )}
                  </div>
                </section>

                <section className="space-y-2" aria-label="Метки">
                  <p className="ds-label">Метки</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {card.tags.map((t) => (
                      <span key={t} className="ds-badge inline-flex items-center gap-1 bg-[var(--bg-hover)] text-[var(--text-secondary)]">
                        {t}
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void save({ tags: card.tags.filter((x) => x !== t) })}
                          aria-label={`Убрать метку ${t}`}
                          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    {card.tags.length === 0 && <span className="text-xs text-[var(--text-muted)]">Меток нет</span>}
                  </div>
                  {card.tags.length < MAX_TAGS && (
                    <div className="flex gap-2">
                      <input
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                        maxLength={40}
                        placeholder="Новая метка: постоянный, рыбалка, семья…"
                        aria-label="Новая метка"
                        className="ds-input flex-1"
                      />
                      <button type="button" disabled={saving || !tagInput.trim()} onClick={addTag} className="ds-btn ds-btn-secondary" aria-label="Добавить метку">
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </section>

                <section className="space-y-2" aria-label="Заметка">
                  <label className="ds-label" htmlFor="crm-contact-notes">Заметка</label>
                  <textarea
                    id="crm-contact-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    maxLength={5000}
                    rows={3}
                    placeholder="Что важно помнить о клиенте"
                    className="ds-input w-full"
                  />
                  {notesChanged && (
                    <button type="button" disabled={saving} onClick={() => void save({ notes: notes.trim() || null })} className="ds-btn ds-btn-secondary">
                      Сохранить заметку
                    </button>
                  )}
                </section>
              </>
            )}

            {saveError && <p className="text-sm text-[var(--danger)]" role="alert">{saveError}</p>}

            <section className="space-y-2" aria-label="Откуда клиент">
              <p className="ds-label">Откуда клиент</p>
              {card.sources.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">Добавлен вручную — броней и заявок пока нет.</p>
              ) : (
                <ul className="space-y-2">
                  {card.sources.map((s) => {
                    const from = formatSourceDate(s.date_from);
                    const to = formatSourceDate(s.date_to);
                    const status = statusLabel(s.status);
                    return (
                      <li key={`${s.kind}:${s.id}`} className="rounded-lg border border-[var(--border)] p-3 text-xs space-y-0.5">
                        <p className="flex items-center justify-between gap-2">
                          <span className="font-medium text-[var(--text-primary)]">{SOURCE_KIND_LABELS[s.kind]}</span>
                          <span className="text-[var(--text-muted)]">{formatMoment(s.occurred_at)}</span>
                        </p>
                        {s.title && <p className="text-[var(--text-secondary)]">{s.title}</p>}
                        <p className="text-[var(--text-muted)]">
                          {[from && (to && to !== from ? `${from} — ${to}` : from), s.people !== null && `${s.people} чел.`, status]
                            .filter(Boolean).join(' · ')}
                        </p>
                        {s.person_name && s.person_name !== card.display_name && (
                          <p className="text-[var(--text-muted)]">Записан как «{s.person_name}»</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
