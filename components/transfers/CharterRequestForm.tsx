'use client';

/**
 * Заявка на машину целиком — форма страницы перевозчика (стандарт карточки
 * трансфера 13.10; владелец: «да делай»). До неё заявку можно было отправить
 * только через MCP или звонком.
 *
 * POST /api/charter-requests — тот же путь записи, что у MCP
 * request_charter: те же даты, тот же прайс, тот же текст менеджеру.
 *
 * Обещаний, которых система не держит, в тексте нет: машина заявкой НЕ
 * закрепляется (занятость на даты не ведётся), сумму платформа не называет
 * (в прайсе не сказано, сколько дней входит в цену), оплаты через платформу
 * нет. Согласие — текстом «передачу перевозчику»: телефон уходит ему.
 */

import { useState, type FormEvent } from 'react';
import { Send, CheckCircle2, AlertCircle } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { formatRub, rateOnScreenOf, type CharterRate } from '@/lib/transfers/charter-format';

/** Своё направление вместо строки прайса. */
const OTHER = '__other__';

interface Props {
  carrierSlug: string;
  carrierName: string;
  /** Направления прайса — названия строк как у перевозчика. */
  destinations: string[];
  /** Строка прайса, с которой пришли («Заказать» у строки); null — первая. */
  initialDestination?: string | null;
  /**
   * Цена за час и за день (1292): у такого перевозчика направлений нет, куда
   * ехать — пишет заказчик, и ответ после отправки называет эту цену, а не
   * «направления нет в прайсе».
   */
  rates?: Array<Pick<CharterRate, 'unit' | 'priceRub' | 'vehicleKind'>>;
}

interface Sent {
  destination: string;
  priceLine: { to: string; price_rub: number; note: string | null } | null;
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
export function charterMissing(f: {
  destination: string; dateFrom: string; passengers: string; name: string; phone: string; pdConsent: boolean;
}): string[] {
  const missing: string[] = [];
  if (f.destination.trim().length < 2) missing.push('куда ехать');
  if (!f.dateFrom) missing.push('дата выезда');
  if (!(Number(f.passengers) >= 1)) missing.push('сколько человек');
  if (f.name.trim().length < 2) missing.push('имя');
  if (f.phone.trim().length < 7) missing.push('телефон');
  if (!f.pdConsent) missing.push('согласие на обработку данных');
  return missing;
}

export function CharterRequestForm({ carrierSlug, carrierName, destinations, initialDestination, rates = [] }: Props) {
  const [pick, setPick] = useState(
    initialDestination && destinations.includes(initialDestination) ? initialDestination : destinations[0] ?? OTHER,
  );
  const [custom, setCustom] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [passengers, setPassengers] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [pdConsent, setPdConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  // «Заказать» у другой строки прайса на той же странице: меняется только
  // направление — введённые дата, имя и телефон остаются. После отправленной
  // заявки это заказ ещё одной машины: форма снова открыта.
  const [linked, setLinked] = useState(initialDestination ?? null);
  if ((initialDestination ?? null) !== linked) {
    setLinked(initialDestination ?? null);
    if (initialDestination && destinations.includes(initialDestination)) {
      setPick(initialDestination);
      setOutcome({ kind: 'idle' });
    }
  }

  const destination = pick === OTHER ? custom.trim() : pick;

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
      const res = await fetch('/api/charter-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrier: carrierSlug,
          destination,
          date_from: dateFrom,
          date_to: dateTo || undefined,
          passengers: Number(passengers),
          name: name.trim(),
          phone: phone.trim(),
          comment: comment.trim() || undefined,
          pd_consent: pdConsent,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const body = (data && typeof data === 'object' ? data : {}) as {
        success?: unknown; error?: unknown; field?: unknown;
        data?: { price_line?: Sent['priceLine'] };
      };
      if (res.ok && body.success === true) {
        setOutcome({ kind: 'sent', sent: { destination, priceLine: body.data?.price_line ?? null } });
      } else {
        setOutcome({
          kind: 'error',
          message: typeof body.error === 'string' ? body.error : 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните перевозчику.',
          field: typeof body.field === 'string' ? body.field : undefined,
        });
      }
    } catch {
      setOutcome({ kind: 'error', message: 'Нет связи. Попробуйте ещё раз или позвоните перевозчику.' });
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
          <p className="font-semibold text-[var(--text-primary)]">Заявка принята: «{carrierName}», {sent.destination}</p>
          <p className="text-sm text-[var(--text-secondary)]">
            Машина этим ещё не закреплена: менеджер Ведара позвонит, согласует поездку с перевозчиком и подтвердит.
          </p>
          {sent.priceLine ? (
            <p className="text-sm text-[var(--text-secondary)]">
              По прайсу: {sent.priceLine.to} — {formatRub(sent.priceLine.price_rub)} за машину
              {sent.priceLine.note ? ` (${sent.priceLine.note})` : ''}. Сколько дней входит в цену, уточнит перевозчик.
            </p>
          ) : rates.length > 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">
              По прайсу: {rates.map((r) => rateOnScreenOf(r, rates)).join(' · ')} за машину. Сколько часов займёт поездка и итоговую сумму
              назовёт перевозчик.
            </p>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">Этого направления нет в прайсе — цену назовёт перевозчик.</p>
          )}
          <p className="text-xs text-[var(--text-muted)]">Расчёт — напрямую с перевозчиком: через Ведар машина не оплачивается.</p>
        </div>
      </div>
    );
  }

  const invalid = (f: string) => outcome.kind === 'error' && outcome.field === f;
  const today = localToday();
  const missing = charterMissing({ destination, dateFrom, passengers, name, phone, pdConsent });
  const ready = missing.length === 0 && !submitting;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-label={`Заявка на машину: ${carrierName}`}>
      <div>
        <label htmlFor="charter-destination" className="ds-label">Куда</label>
        {destinations.length > 0 && (
          <select
            id="charter-destination"
            className="ds-input w-full"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            aria-invalid={invalid('destination') || undefined}
          >
            {destinations.map((d) => <option key={d} value={d}>{d}</option>)}
            <option value={OTHER}>Другое направление</option>
          </select>
        )}
        {pick === OTHER && (
          <input
            id={destinations.length > 0 ? 'charter-destination-other' : 'charter-destination'}
            aria-label={destinations.length > 0 ? 'Своё направление' : undefined}
            type="text"
            className={`ds-input w-full${destinations.length > 0 ? ' mt-2' : ''}`}
            placeholder={destinations.length > 0 ? 'Например, Мутновский' : 'Откуда и куда — например, из аэропорта в город'}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            maxLength={200}
            aria-invalid={invalid('destination') || undefined}
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="charter-date-from" className="ds-label">Выезд</label>
          <input id="charter-date-from" type="date" min={today} className="ds-input w-full" value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)} required aria-invalid={invalid('date_from') || undefined} />
        </div>
        <div>
          <label htmlFor="charter-date-to" className="ds-label">Возвращение</label>
          <input id="charter-date-to" type="date" min={dateFrom || today} className="ds-input w-full" value={dateTo}
            onChange={(e) => setDateTo(e.target.value)} aria-invalid={invalid('date_to') || undefined}
            aria-describedby="charter-date-to-hint" />
          <p id="charter-date-to-hint" className="text-xs text-[var(--text-muted)] mt-1">если не в тот же день</p>
        </div>
      </div>

      <div>
        <label htmlFor="charter-passengers" className="ds-label">Сколько человек</label>
        <input id="charter-passengers" type="number" inputMode="numeric" min={1} max={60} className="ds-input w-full"
          value={passengers} onChange={(e) => setPassengers(e.target.value)} required
          aria-invalid={invalid('passengers') || undefined} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-3">
        <div>
          <label htmlFor="charter-name" className="ds-label">Имя и фамилия</label>
          <input id="charter-name" type="text" autoComplete="name" className="ds-input w-full" value={name}
            onChange={(e) => setName(e.target.value)} maxLength={120} required aria-invalid={invalid('name') || undefined} />
        </div>
        <div>
          <label htmlFor="charter-phone" className="ds-label">Телефон</label>
          <input id="charter-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+7" className="ds-input w-full"
            value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} required
            aria-invalid={invalid('phone') || undefined} />
        </div>
      </div>

      <div>
        <label htmlFor="charter-comment" className="ds-label">Пожелания</label>
        <textarea id="charter-comment" className="ds-input w-full min-h-20" value={comment}
          onChange={(e) => setComment(e.target.value)} maxLength={1000}
          placeholder="Откуда забрать, багаж, дети, сколько дней на месте" />
      </div>

      <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="charter-consent" purpose="carrier" />

      {outcome.kind === 'error' && (
        <p role="alert" className="flex items-start gap-2 text-sm text-[var(--danger)]">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
          <span>{outcome.message}</span>
        </p>
      )}

      {/* Неактивная — и выглядит неактивной: прежде она оставалась яркой, и
          нажатие без ответа читалось как «не работает». */}
      <button type="submit"
        className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={!ready || !pdConsent} style={{ minHeight: 44 }}
        aria-describedby={missing.length > 0 ? 'charter-missing' : undefined}>
        <Send className="w-4 h-4" aria-hidden />
        {submitting ? 'Отправляем…' : 'Отправить заявку на машину'}
      </button>
      {missing.length > 0 && (
        <p id="charter-missing" className="text-sm text-[var(--text-secondary)]">
          Чтобы отправить, осталось: {missing.join(', ')}.
        </p>
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Это заявка, не бронь: машина закрепляется после звонка менеджера и подтверждения перевозчика.
      </p>
    </form>
  );
}
