'use client';

/**
 * Заявка хозяину жилья без своей брони — форма на карточке (1206, решение
 * владельца 10.10: «для броней нужна удобная форма для приложения MAX»).
 *
 * Гость указывает даты, сколько человек, имя и телефон; хозяин получает это
 * одним сообщением в MAX и перезванивает или отвечает в переписке: после
 * отправки гостю — ссылка на страницу заявки с перепиской и на подключение
 * MAX (1349). Это не бронь: даты и цену
 * подтверждает хозяин, поэтому итог формы — «заявка передана», и только когда
 * сервер сказал, кому она дошла (хозяину или оператору платформы). Не дошла
 * никому — так и написано, и рядом телефон.
 *
 * Согласие — общая галочка в варианте «владельцу жилья»: телефон гостя уходит
 * хозяину, а не туроператору. В запрос уходит СОСТОЯНИЕ галочки, отправка
 * без неё не проходит (tests/unit/pd-consent-registry.test.ts).
 */

import { useEffect, useState } from 'react';
import { Send, CheckCircle2 } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { RequestChatLinks } from '@/components/requests/RequestChatLinks';
import { BUSY_HORIZON_DAYS, busyWithin, groupRanges, guestBusyText, rangeWords, shiftYmd } from '@/lib/stay/busy-dates';

type Delivered = 'owner' | 'platform' | 'none';

/**
 * Занятые даты словом хозяина («занято с 5 по 9 ноября» в MAX, 30.10) —
 * три исхода (§4.0): список (пустой — всё открыто), null — не загрузились,
 * и это сказано; undefined — ещё грузятся.
 */
type BusyState = string[] | null | undefined;

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
  // Страница заявки с перепиской и ссылка подключить MAX (1349). null — ключ
  // не выдался: заявка принята, но переписки на сайте не будет.
  const [links, setLinks] = useState<{ page: string | null; max: string | null }>({ page: null, max: null });
  const [busy, setBusy] = useState<BusyState>(undefined);
  // Глубокая ссылка агента: ?date= (или check_in) &check_out=&guests=
  // (или participants/passengers) — форма открывается заполненной (разбор 01.11).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= today ? v : null);
    const ci = iso(q.get('check_in') ?? q.get('date'));
    if (ci) { setCheckIn(ci); setCheckOut(plusDays(ci, 1)); }
    const co = iso(q.get('check_out'));
    if (co && (!ci || co > ci)) setCheckOut(co);
    const g = q.get('guests') ?? q.get('participants') ?? q.get('passengers') ?? q.get('guest_count');
    if (g && /^\d{1,2}$/.test(g) && +g >= 1) setGuests(g);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    const endDate = shiftYmd(today, BUSY_HORIZON_DAYS);
    fetch(`/api/accommodations/${accommodationId}/blocked-dates?startDate=${today}&endDate=${endDate}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { success?: boolean; data?: { blockedDates?: unknown } } | null;
        const dates = body?.success ? body.data?.blockedDates : null;
        if (!alive) return;
        setBusy(Array.isArray(dates) ? dates.filter((d): d is string => typeof d === 'string') : null);
      })
      .catch(() => { if (alive) setBusy(null); });
    return () => { alive = false; };
  }, [accommodationId, today]);

  const busyRanges = busy ? groupRanges(busy) : [];
  const chosenBusy = busy && checkOut > checkIn ? busyWithin(busy, checkIn, checkOut) : [];

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
    if (chosenBusy.length > 0) {
      setError(guestBusyText(chosenBusy));
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
        | { success: true; data: { delivered: Delivered; page?: string | null; max_link?: string | null } }
        | { success: false; error?: string; data?: { busyDates?: unknown } }
        | null;
      if (body && body.success) {
        // Маяка воронки нет намеренно: каждая заявка — строка stay_requests.
        setLinks({ page: body.data.page ?? null, max: body.data.max_link ?? null });
        setDone(body.data.delivered);
      } else {
        // 409: хозяин закрыл даты после загрузки формы — список обновляется его словом.
        const fresh = body && !body.success ? body.data?.busyDates : undefined;
        if (Array.isArray(fresh)) setBusy([...(busy ?? []), ...fresh.filter((d): d is string => typeof d === 'string')]);
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
            ? 'Владелец получил её в MAX и перезвонит или ответит сообщением, чтобы подтвердить даты и цену.'
            : 'Её получил оператор платформы: он свяжется с владельцем, а владелец перезвонит вам.'}
        </p>
        <RequestChatLinks page={links.page} maxLink={links.max} />
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
      {/* Слово хозяина о занятости — до выбора дат, а не после отказа сервера. */}
      {busy === null && (
        <p className="text-xs text-[var(--text-muted)]">Занятые даты не загрузились: свободны ли ваши даты, скажет хозяин по заявке.</p>
      )}
      {busyRanges.length > 0 && (
        <p className="text-xs text-[var(--text-secondary)]" data-testid="stay-busy-dates">
          Хозяин отметил занятыми: {busyRanges.map(rangeWords).join('; ')}.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="ds-label">Заезд</span>
          <input type="date" name="check_in" required min={today} value={checkIn}
                 onChange={e => { setCheckIn(e.target.value); if (checkOut <= e.target.value) setCheckOut(plusDays(e.target.value, 1)); }}
                 className="ds-input w-full" />
        </label>
        <label className="block">
          <span className="ds-label">Выезд</span>
          <input type="date" name="check_out" required min={plusDays(checkIn, 1)} value={checkOut}
                 onChange={e => setCheckOut(e.target.value)} className="ds-input w-full" />
        </label>
      </div>
      <label className="block">
        <span className="ds-label">Сколько человек</span>
        <input type="number" name="guests" inputMode="numeric" required min={1} max={50} value={guests}
               onChange={e => setGuests(e.target.value)} className="ds-input w-full" />
      </label>
      <label className="block">
        <span className="ds-label">Имя</span>
        <input type="text" name="name" required minLength={2} maxLength={120} autoComplete="name" value={name}
               onChange={e => setName(e.target.value)} className="ds-input w-full" />
      </label>
      <label className="block">
        <span className="ds-label">Телефон</span>
        <input type="tel" name="phone" required minLength={10} maxLength={20} autoComplete="tel" inputMode="tel"
               placeholder="+7 900 000-00-00" value={phone}
               onChange={e => setPhone(e.target.value)} className="ds-input w-full" />
      </label>
      <label className="block">
        <span className="ds-label">Комментарий (необязательно)</span>
        <textarea name="comment" maxLength={1000} rows={2} value={comment}
                  onChange={e => setComment(e.target.value)} className="ds-input w-full" />
      </label>
      <PdConsentCheckbox id="stay-request-consent" purpose="stay" checked={pdConsent} onChange={setPdConsent} />
      {!error && chosenBusy.length > 0 && (
        <p className="text-xs text-[var(--warning)]" role="status">{guestBusyText(chosenBusy)}</p>
      )}
      {error && (
        <p className="text-xs text-[var(--danger)]" role="alert">
          {error}{phoneLabel ? ` Телефон владельца: ${phoneLabel}.` : ''}
        </p>
      )}
      <button type="submit" disabled={sending || !pdConsent || chosenBusy.length > 0}
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
