'use client';

/**
 * «Написать оператору» на странице партнёра (владелец 13.10: «форму можно»).
 *
 * Заявка уходит тем же путём, что из виджета на сайте партнёра
 * (app/widget/lead-form): POST /api/leads с `partner_slug` на верхнем уровне —
 * роут резолвит по нему operator_id, и лид ложится в ящик ЭТОГО оператора,
 * а не в общий пул. Бронь здесь не создаётся: бронь живёт на карточке тура
 * (решение владельца 02.10), а это заявка-разговор.
 *
 * Обещаний, которых система не держит, в тексте нет: срок ответа оператора
 * нам неизвестен, поэтому «ответит сам», а не «в течение часа».
 */

import { useState, type FormEvent } from 'react';
import { Send, CheckCircle2, AlertCircle } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';

interface Props {
  partnerSlug: string;
  partnerName: string;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export const LEAD_FORM_SOURCE = 'operator_page';

export function OperatorLeadForm({ partnerSlug, partnerName }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const ready = name.trim().length >= 2 && phone.trim().length >= 7 && consent && !submitting;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setOutcome({ kind: 'idle' });
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          comment: comment.trim() || undefined,
          partner_slug: partnerSlug,
          source_url: typeof window !== 'undefined' ? window.location.href.slice(0, 500) : undefined,
          source_data: { source: LEAD_FORM_SOURCE, partner_slug: partnerSlug },
          pd_consent: true,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const ok = res.ok
        && typeof data === 'object' && data !== null
        && (data as { success?: unknown }).success === true;
      if (ok) {
        setOutcome({ kind: 'sent' });
      } else {
        const message = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните оператору.';
        setOutcome({ kind: 'error', message });
      }
    } catch {
      setOutcome({ kind: 'error', message: 'Нет связи. Попробуйте ещё раз или позвоните оператору.' });
    } finally {
      setSubmitting(false);
    }
  }

  if (outcome.kind === 'sent') {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-4">
        <CheckCircle2 className="w-5 h-5 text-[var(--success)] flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-[var(--text-primary)]">Заявка ушла оператору «{partnerName}»</p>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Она уже в его кабинете на Ведаре. Оператор ответит сам: по телефону или в мессенджере.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="operator-lead-name" className="ds-label">Имя</label>
          <input
            id="operator-lead-name"
            name="name"
            type="text"
            autoComplete="name"
            className="ds-input w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
          />
        </div>
        <div>
          <label htmlFor="operator-lead-phone" className="ds-label">Телефон</label>
          <input
            id="operator-lead-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="ds-input w-full"
            placeholder="+7"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={30}
            required
          />
        </div>
      </div>
      <div>
        <label htmlFor="operator-lead-comment" className="ds-label">Что интересует</label>
        <textarea
          id="operator-lead-comment"
          name="comment"
          className="ds-input w-full min-h-24"
          placeholder="Даты, сколько человек, какой тур или маршрут"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={1000}
        />
      </div>
      <PdConsentCheckbox checked={consent} onChange={setConsent} id="operator-lead-consent" />
      {outcome.kind === 'error' && (
        <p role="alert" className="flex items-start gap-2 text-sm text-[var(--danger)]">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{outcome.message}</span>
        </p>
      )}
      <button type="submit" className="ds-btn ds-btn-primary inline-flex items-center gap-2" disabled={!ready}>
        <Send className="w-4 h-4" />
        {submitting ? 'Отправляем…' : 'Отправить оператору'}
      </button>
    </form>
  );
}
