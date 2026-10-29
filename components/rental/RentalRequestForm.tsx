'use client';

/**
 * Заявка на прокат автомобиля — форма страницы прокатчика (витрина проката
 * 23.10, по образцу заявки на машину перевозчика CharterRequestForm).
 *
 * POST /api/car-rental-requests — путь записи lib/rental/rental-request-service.
 *
 * Обещаний, которых система не держит, в тексте нет: машина заявкой НЕ
 * закрепляется (занятость система не ведёт), сумму платформа не называет
 * (цена за сутки, иногда «от», и что в неё входит — не записано), оплаты
 * через платформу нет. Согласие — текстом «передачу прокату автомобилей»:
 * телефон уходит ему.
 */

import { useState, type FormEvent } from 'react';
import { Send, CheckCircle2, AlertCircle } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { formatRub } from '@/lib/transfers/charter-format';
import { RequestChatLinks } from '@/components/requests/RequestChatLinks';

interface OfferChoice {
  title: string;
  priceRubPerDay: number;
  priceIsFrom: boolean;
}

interface Props {
  companySlug: string;
  companyName: string;
  /** Машины прайса — названия строк как у прокатчика. */
  offers: OfferChoice[];
  /** Машина, с которой пришли («Заказать» у строки); null — первая. */
  initialOffer?: string | null;
}

interface Sent {
  /** Страница заявки с перепиской и MAX (1350); null — ключ не выдался. */
  page: string | null;
  maxLink: string | null;
  car: string;
  dateFrom: string;
  dateTo: string;
  days: number | null;
  price: { rub_per_day: number; is_from: boolean } | null;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'sent'; sent: Sent }
  | { kind: 'error'; message: string; field?: string };

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Чего не хватает для отправки — словами, в порядке полей. Кнопка без
 * согласия неактивна (закон форм платформы), и серая кнопка без причины
 * читалась как «не работает» (владелец 14.10: «это сложно получается»).
 */
export function rentalMissing(f: {
  car: string; dateFrom: string; dateTo: string; name: string; phone: string; pdConsent: boolean;
}): string[] {
  const missing: string[] = [];
  if (!f.car) missing.push('машина');
  if (!f.dateFrom) missing.push('дата начала');
  if (!f.dateTo) missing.push('дата возврата');
  if (f.name.trim().length < 2) missing.push('имя');
  if (f.phone.trim().length < 7) missing.push('телефон');
  if (!f.pdConsent) missing.push('согласие на обработку данных');
  return missing;
}

export function RentalRequestForm({ companySlug, companyName, offers, initialOffer }: Props) {
  const titles = offers.map((o) => o.title);
  const [car, setCar] = useState(initialOffer && titles.includes(initialOffer) ? initialOffer : titles[0] ?? '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [pdConsent, setPdConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  // «Заказать» у другой строки прайса на той же странице: меняется только
  // машина — введённые даты, имя и телефон остаются.
  const [linked, setLinked] = useState(initialOffer ?? null);
  if ((initialOffer ?? null) !== linked) {
    setLinked(initialOffer ?? null);
    if (initialOffer && titles.includes(initialOffer)) {
      setCar(initialOffer);
      setOutcome({ kind: 'idle' });
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Без согласия заявка не уходит: кнопка и так неактивна, но проверка
    // держится и при отправке клавишей (общий закон форм платформы).
    if (!pdConsent) {
      setOutcome({ kind: 'error', message: 'Нужно согласие на обработку персональных данных.', field: 'pd_consent' });
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setOutcome({ kind: 'idle' });
    try {
      const res = await fetch('/api/car-rental-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: companySlug,
          car,
          date_from: dateFrom,
          date_to: dateTo,
          name: name.trim(),
          phone: phone.trim(),
          comment: comment.trim() || undefined,
          pd_consent: pdConsent,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const body = (data && typeof data === 'object' ? data : {}) as {
        success?: unknown; error?: unknown; field?: unknown;
        data?: { days?: unknown; price?: Sent['price']; page?: string | null; max_link?: string | null };
      };
      if (res.ok && body.success === true) {
        setOutcome({
          kind: 'sent',
          sent: {
            car, dateFrom, dateTo,
            days: typeof body.data?.days === 'number' ? body.data.days : null,
            price: body.data?.price ?? null,
            page: body.data?.page ?? null,
            maxLink: body.data?.max_link ?? null,
          },
        });
      } else {
        setOutcome({
          kind: 'error',
          message: typeof body.error === 'string' ? body.error : 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните прокатчику.',
          field: typeof body.field === 'string' ? body.field : undefined,
        });
      }
    } catch {
      setOutcome({ kind: 'error', message: 'Нет связи. Попробуйте ещё раз или позвоните прокатчику.' });
    } finally {
      setSubmitting(false);
    }
  }

  if (outcome.kind === 'sent') {
    const { sent } = outcome;
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-4">
        <CheckCircle2 className="w-5 h-5 text-[var(--success)] flex-shrink-0 mt-0.5" aria-hidden />
        <div className="space-y-1.5">
          <p className="font-semibold text-[var(--text-primary)]">Заявка принята: «{companyName}», {sent.car}</p>
          <p className="text-sm text-[var(--text-secondary)]">
            С {sent.dateFrom} по {sent.dateTo}{sent.days !== null ? `, дней: ${sent.days}` : ''}. Машина этим ещё не закреплена:
            менеджер Ведара позвонит, согласует машину с прокатчиком и подтвердит.
          </p>
          {sent.price && (
            <p className="text-sm text-[var(--text-secondary)]">
              По прайсу: {sent.price.is_from ? 'от ' : ''}{formatRub(sent.price.rub_per_day)} за сутки за машину.
              {sent.price.is_from ? ' Точную цену назовёт прокатчик.' : ''} Что входит в цену, уточнит прокатчик; итоговую сумму платформа не называет.
            </p>
          )}
          <p className="text-xs text-[var(--text-muted)]">Расчёт — напрямую с прокатчиком: через Ведар машина не оплачивается.</p>
          <RequestChatLinks page={sent.page} maxLink={sent.maxLink} />
        </div>
      </div>
    );
  }

  const invalid = (f: string) => outcome.kind === 'error' && outcome.field === f;
  const today = localToday();
  const missing = rentalMissing({ car, dateFrom, dateTo, name, phone, pdConsent });
  const ready = missing.length === 0 && !submitting;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-label={`Заявка на машину: ${companyName}`}>
      <div>
        <label htmlFor="rental-car" className="ds-label">Машина</label>
        <select
          id="rental-car"
          className="ds-input w-full"
          value={car}
          onChange={(e) => setCar(e.target.value)}
          aria-invalid={invalid('car') || undefined}
        >
          {offers.map((o) => (
            <option key={o.title} value={o.title}>
              {o.title} — {o.priceIsFrom ? 'от ' : ''}{formatRub(o.priceRubPerDay)}/сутки
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="rental-date-from" className="ds-label">Начало</label>
          <input id="rental-date-from" type="date" min={today} className="ds-input w-full" value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)} required aria-invalid={invalid('date_from') || undefined} />
        </div>
        <div>
          <label htmlFor="rental-date-to" className="ds-label">Возврат</label>
          <input id="rental-date-to" type="date" min={dateFrom || today} className="ds-input w-full" value={dateTo}
            onChange={(e) => setDateTo(e.target.value)} required aria-invalid={invalid('date_to') || undefined} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-3">
        <div>
          <label htmlFor="rental-name" className="ds-label">Имя и фамилия</label>
          <input id="rental-name" type="text" autoComplete="name" className="ds-input w-full" value={name}
            onChange={(e) => setName(e.target.value)} maxLength={120} required aria-invalid={invalid('name') || undefined} />
        </div>
        <div>
          <label htmlFor="rental-phone" className="ds-label">Телефон</label>
          <input id="rental-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+7" className="ds-input w-full"
            value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} required
            aria-invalid={invalid('phone') || undefined} />
        </div>
      </div>

      <div>
        <label htmlFor="rental-comment" className="ds-label">Пожелания</label>
        <textarea id="rental-comment" className="ds-input w-full min-h-20" value={comment}
          onChange={(e) => setComment(e.target.value)} maxLength={1000}
          placeholder="Куда поедете, нужен ли водитель, где удобно забрать машину" />
      </div>

      <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="rental-consent" purpose="rental" />

      {outcome.kind === 'error' && (
        <p role="alert" className="flex items-start gap-2 text-sm text-[var(--danger)]">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
          <span>{outcome.message}</span>
        </p>
      )}

      {/* Неактивная — и выглядит неактивной; под ней сказано, чего не хватает. */}
      <button type="submit"
        className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={!ready || !pdConsent} style={{ minHeight: 44 }}
        aria-describedby={missing.length > 0 ? 'rental-missing' : undefined}>
        <Send className="w-4 h-4" aria-hidden />
        {submitting ? 'Отправляем…' : 'Отправить заявку на машину'}
      </button>
      {missing.length > 0 && (
        <p id="rental-missing" className="text-sm text-[var(--text-secondary)]">
          Чтобы отправить, осталось: {missing.join(', ')}.
        </p>
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Это заявка, не бронь: машина закрепляется после звонка менеджера и подтверждения прокатчика.
      </p>
    </form>
  );
}
