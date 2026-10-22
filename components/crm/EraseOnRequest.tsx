'use client';

/**
 * Стереть карточку клиента по обращению человека (152-ФЗ, ст. 21; #2327) —
 * только на экране администратора. Ответ на удаление аккаунта обещает:
 * карточку, где кроме его заявок есть чужие записи или записи партнёра,
 * сотрёт по письму администратор (unprovenCrmSentence). Здесь он это и делает:
 * основание — дата обращения и, если есть, его номер (структурой, без
 * свободного текста: основание ложится в журнал навсегда, и имени человека
 * там быть не должно), затем подтверждение — стирание необратимо. Что
 * стирается — eraseCrmContactOnRequest (lib/account/erase.ts): поля и записи
 * партнёра в карточке, но не связанные с ней заявки и брони — имя и телефон,
 * записанные в них самих, остаются у партнёра, и экран говорит это до и после.
 */
import { useState } from 'react';
import { ShieldOff } from 'lucide-react';
import { CRM_API } from './api';

interface Props {
  contactId: string;
  /** Стёрто — карточку надо перечитать. */
  onErased: () => void;
}

type Phase = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'sending' } | { kind: 'done' };

function errorOf(json: unknown): string | null {
  return typeof json === 'object' && json !== null && typeof (json as { error?: unknown }).error === 'string'
    ? (json as { error: string }).error
    : null;
}

/** Сегодня по часам браузера, ГГГГ-ММ-ДД — верхняя граница даты обращения. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Что остаётся после стирания — одними словами до и после: экран не обещает больше, чем сделает. */
const SOURCES_STAY = 'Заявки и брони, связанные с карточкой, это не стирает: имя и телефон, записанные в них самих, '
  + 'остаются у партнёра.';

export function EraseOnRequest({ contactId, onErased }: Props) {
  const [received, setReceived] = useState('');
  const [ticket, setTicket] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const ticketOk = /^\d{0,12}$/.test(ticket.trim());
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(received) && ticketOk;
  const edit = (set: (v: string) => void) => (v: string) => { set(v); if (phase.kind === 'confirm') setPhase({ kind: 'idle' }); };

  async function erase() {
    setPhase({ kind: 'sending' });
    setError(null);
    try {
      const res = await fetch(`${CRM_API.admin}/${encodeURIComponent(contactId)}/erase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ received, ...(ticket.trim() ? { ticket: ticket.trim() } : {}) }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorOf(json) ?? 'Не удалось стереть карточку, попробуйте позже');
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({ kind: 'done' });
      onErased();
    } catch {
      setError('Нет связи с сервером — карточка не стёрта');
      setPhase({ kind: 'idle' });
    }
  }

  if (phase.kind === 'done') {
    return (
      <p role="status" className="text-sm text-[var(--text-secondary)]">
        Данные клиента в карточке стёрты, основание записано в журнал. {SOURCES_STAY}
      </p>
    );
  }

  return (
    <section className="space-y-2 rounded-lg border border-[var(--border)] p-3" aria-label="Обращение по персональным данным">
      <p className="ds-label flex items-center gap-2">
        <ShieldOff className="w-4 h-4 text-[var(--danger)]" /> Обращение по персональным данным
      </p>
      <p className="text-xs text-[var(--text-secondary)]">
        Если человек попросил стереть свои данные и вы сверили с ним, что карточка его, — сотрите имя, телефон, почту,
        заметку и метки карточки, тексты задач и касаний. Вместо имени партнёр увидит «Удалённый пользователь». {SOURCES_STAY}{' '}
        Это необратимо.
      </p>
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <label className="ds-label" htmlFor={`crm-erase-received-${contactId}`}>Дата обращения</label>
          <input
            id={`crm-erase-received-${contactId}`}
            type="date"
            value={received}
            max={todayIso()}
            onChange={(e) => edit(setReceived)(e.target.value)}
            className="ds-input"
          />
        </div>
        <div className="space-y-1">
          <label className="ds-label" htmlFor={`crm-erase-ticket-${contactId}`}>Номер обращения, если есть</label>
          <input
            id={`crm-erase-ticket-${contactId}`}
            inputMode="numeric"
            value={ticket}
            maxLength={12}
            onChange={(e) => edit(setTicket)(e.target.value)}
            className="ds-input"
          />
        </div>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Основание ложится в журнал навсегда — только дата и номер, без имени, телефона и почты человека.
      </p>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {phase.kind === 'idle' && (
        <>
          <button
            type="button"
            disabled={!ready}
            onClick={() => setPhase({ kind: 'confirm' })}
            className="ds-btn ds-btn-secondary disabled:opacity-40"
          >
            Стереть данные клиента
          </button>
          {!ready && (
            <p className="text-xs text-[var(--text-muted)]">
              {ticketOk ? 'Укажите дату обращения.' : 'Номер обращения — только цифры.'}
            </p>
          )}
        </>
      )}
      {(phase.kind === 'confirm' || phase.kind === 'sending') && (
        <div role="alertdialog" aria-label="Подтверждение стирания" className="rounded-lg bg-[var(--bg-card)] border border-[var(--danger)] p-3 space-y-2">
          <p className="text-sm text-[var(--text-primary)]">Стереть данные клиента в этой карточке безвозвратно?</p>
          <div className="flex gap-2 flex-wrap">
            <button type="button" disabled={phase.kind === 'sending'} onClick={() => void erase()} className="ds-btn ds-btn-danger">
              Да, стереть
            </button>
            <button type="button" disabled={phase.kind === 'sending'} onClick={() => setPhase({ kind: 'idle' })} className="ds-btn ds-btn-secondary">
              Отмена
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
