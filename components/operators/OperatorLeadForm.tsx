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
import { RequestChatLinks } from '@/components/requests/RequestChatLinks';

interface Props {
  partnerSlug: string;
  partnerName: string;
  /** Откуда заявка: страница оператора на Ведаре (по умолчанию) или сайт партнёра, который отдаёт Ведар. */
  source?: LeadFormSource;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'sent'; page: string | null; maxLink: string | null }
  | { kind: 'error'; message: string };

export const LEAD_FORM_SOURCE = 'operator_page';
/** Форма на сайте партнёра на его домене (lib/partner-sites): канал лида — сайт партнёра, а не Ведар. */
export const PARTNER_SITE_LEAD_SOURCE = 'partner_site';
export type LeadFormSource = typeof LEAD_FORM_SOURCE | typeof PARTNER_SITE_LEAD_SOURCE;

export function OperatorLeadForm({ partnerSlug, partnerName, source = LEAD_FORM_SOURCE }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [pdConsent, setPdConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const ready = name.trim().length >= 2 && phone.trim().length >= 7 && pdConsent && !submitting;
  // Форма на сайте самой компании: переписка на Ведаре — в новой вкладке, сайт компании остаётся.
  const newTabLinks = source === 'partner_site';

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Без согласия на ПД заявка не уходит — общий закон форм платформы
    // (сторож lead-pd-consent): кнопка и так неактивна, но проверка
    // держится и при отправке клавишей.
    if (!pdConsent) { setOutcome({ kind: 'error', message: 'Нужно согласие на обработку персональных данных.' }); return; }
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
          source_data: { source, partner_slug: partnerSlug },
          pd_consent: true,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const ok = res.ok
        && typeof data === 'object' && data !== null
        && (data as { success?: unknown }).success === true;
      if (ok) {
        // Страница заявки с перепиской и MAX (1350) — если ключ выдался.
        const d = data as { page?: unknown; max_link?: unknown };
        setOutcome({
          kind: 'sent',
          page: typeof d.page === 'string' ? d.page : null,
          maxLink: typeof d.max_link === 'string' ? d.max_link : null,
        });
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
            Она уже в его кабинете на Ведаре. Оператор ответит сам: по телефону или в переписке по ссылке ниже.
          </p>
          <div className="mt-3">
            <RequestChatLinks page={outcome.page} maxLink={outcome.maxLink} newTab={newTabLinks} />
          </div>
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
      <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="operator-lead-consent" />
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
