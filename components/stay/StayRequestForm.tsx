'use client';

/**
 * Заявка хозяину жилья без своей брони — форма на карточке (1206, решение
 * владельца 10.10: «для броней нужна удобная форма для приложения MAX»).
 *
 * Гость указывает даты, сколько человек, имя и телефон; хозяин получает это
 * одним сообщением в MAX и перезванивает сам. Это не бронь: даты и цену
 * подтверждает хозяин, поэтому итог формы — «заявка передана», и только когда
 * сервер сказал, кому она дошла (хозяину или оператору платформы). Не дошла
 * никому — так и написано, и рядом телефон.
 *
 * Согласие — общая галочка в варианте «владельцу жилья»: телефон гостя уходит
 * хозяину, а не туроператору. В запрос уходит СОСТОЯНИЕ галочки, отправка
 * без неё не проходит (tests/unit/pd-consent-registry.test.ts).
 */

import { useState } from 'react';
import { Send, CheckCircle2 } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';

type Delivered = 'owner' | 'platform' | 'none';

function kamchatkaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kamchatka' }).format(new Date());
}

function plusDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function StayRequestForm({ accommodationId, phoneLabel, ownerOnMax }: {
  accommodationId: string;
  /** Телефон объекта для запасного пути, если заявка не дошла. */
  phoneLabel: string | null;
  /** Хозяин подключил MAX: заявка придёт ему туда. Без этого «в MAX» не обещаем. */
  ownerOnMax: boolean;
}) {
  const today = kamchatkaToday();
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(plusDays(today, 1));
  const [guests, setGuests] = useState('2');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [pdConsent, setPdConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Delivered | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pdConsent) {
      setError('Отметьте согласие на обработку персональных данных');
      return;
    }
    if (checkOut <= checkIn) {
      setError('Дата выезда должна быть позже даты заезда');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/accommodations/${accommodationId}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          check_in: checkIn,
          check_out: checkOut,
          guests: Number(guests),
          name,
          phone,
          comment: comment.trim() || undefined,
          pd_consent: pdConsent,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { success: true; data: { delivered: Delivered } }
        | { success: false; error?: string }
        | null;
      if (body && body.success) {
        // Маяка воронки нет намеренно: каждая заявка — строка stay_requests.
        setDone(body.data.delivered);
      } else {
        setError((body && !body.success && body.error) || `Сервер ответил ${res.status}`);
      }
    } catch {
      setError('Нет связи с сервером. Попробуйте ещё раз или позвоните владельцу.');
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-2" aria-live="polite">
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--success)]">
          <CheckCircle2 className="w-4 h-4" /> Заявка передана
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {done === 'owner'
            ? 'Владелец получил её в MAX и перезвонит вам, чтобы подтвердить даты и цену.'
            : 'Её получил оператор платформы: он свяжется с владельцем, а владелец перезвонит вам.'}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-[var(--text-primary)]">Заявка владельцу</p>
        {/* Владелец 10.10, вопрос гостя «где MAX?»: кнопки по номеру в MAX не
            бывает, а эта форма и есть путь в MAX — говорим это прямо, но
            только когда хозяин действительно подключён. */}
        {ownerOnMax && (
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Придёт владельцу сообщением в MAX — он перезвонит сам.
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="ds-label">Заезд</span>
          <input type="date" required min={today} value={checkIn}
                 onChange={e => { setCheckIn(e.target.value); if (checkOut <= e.target.value) setCheckOut(plusDays(e.target.value, 1)); }}
                 className="ds-input w-full" />
        </label>
        <label className="block">
          <span className="ds-label">Выезд</span>
          <input type="date" required min={plusDays(checkIn, 1)} value={checkOut}
                 onChange={e => setCheckOut(e.target.value)} className="ds-input w-full" />
        </label>
      </div>
      <label className="block">
        <span className="ds-label">Сколько человек</span>
        <input type="number" inputMode="numeric" required min={1} max={50} value={guests}
               onChange={e => setGuests(e.target.value)} className="ds-input w-full" />
      </label>
      <label className="block">
        <span className="ds-label">Имя</span>
        <input type="text" required minLength={2} maxLength={120} autoComplete="name" value={name}
               onChange={e => setName(e.target.value)} className="ds-input w-full" />
      </label>
      <label className="block">
        <span className="ds-label">Телефон</span>
        <input type="tel" required minLength={10} maxLength={20} autoComplete="tel" inputMode="tel"
               placeholder="+7 900 000-00-00" value={phone}
               onChange={e => setPhone(e.target.value)} className="ds-input w-full" />
      </label>
      <label className="block">
        <span className="ds-label">Комментарий (необязательно)</span>
        <textarea maxLength={1000} rows={2} value={comment}
                  onChange={e => setComment(e.target.value)} className="ds-input w-full" />
      </label>
      <PdConsentCheckbox id="stay-request-consent" purpose="stay" checked={pdConsent} onChange={setPdConsent} />
      {error && (
        <p className="text-xs text-[var(--danger)]" role="alert">
          {error}{phoneLabel ? ` Телефон владельца: ${phoneLabel}.` : ''}
        </p>
      )}
      <button type="submit" disabled={sending || !pdConsent}
              className="ds-btn ds-btn-primary w-full sm:w-auto inline-flex items-center justify-center gap-2 disabled:opacity-50">
        <Send className="w-4 h-4" />
        {sending ? 'Отправляем…' : 'Отправить заявку'}
      </button>
      <p className="text-xs text-[var(--text-muted)]">
        Это заявка, а не бронь: даты и цену подтверждает владелец. Платформа оплату не принимает.
      </p>
    </form>
  );
}
