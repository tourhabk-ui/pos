'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { StayDatePicker } from './calendars/StayDatePicker';
import { GuestSelector } from './ui/GuestSelector';
import { computeStayTotal, NightPrice } from '@/lib/booking/stay-price';
import { ROOM_TYPE_LABELS, RoomType } from '@/lib/stay/room-types';
import { STAY_PAY_ON_SITE } from '@/lib/stay/pay-on-site';

/**
 * Форма бронирования жилья с выбором номера. Расчёт суммы зеркалит
 * серверный book-роут: сумма реальных цен по ночам из
 * /prices?roomId= (override номера > объекта > базовая цена номера),
 * БЕЗ множителей на гостей и выдуманных сборов. Гости — только
 * валидация вместимости номера. Бронь создаёт POST .../book.
 *
 * Оплаты на платформе НЕТ (решение владельца 26.09): гость платит владельцу
 * при заселении, после подтверждения брони. До 26.09 здесь стоял виджет
 * CloudPayments на платёж, который book-роут создать не мог (таблицы
 * payments на проде нет), и гостю предлагали «Оплатить» до подтверждения.
 */

export interface BookableRoom {
  id: string;
  name: string;
  roomType: string;
  maxGuests: number;
  pricePerNight: number;
}

interface StayBookingFormProps {
  accommodationId: string;
  accommodationName: string;
  rooms: BookableRoom[];
}

interface BookingSuccess {
  bookingId: string;
  totalPrice: number;
  nights: number;
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(v);
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function StayBookingForm({ accommodationId, accommodationName, rooms }: StayBookingFormProps) {
  const [roomId, setRoomId] = useState<string>(rooms[0]?.id ?? '');
  const [checkIn, setCheckIn] = useState<Date | null>(null);
  const [checkOut, setCheckOut] = useState<Date | null>(null);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [specialRequests, setSpecialRequests] = useState('');
  const [prices, setPrices] = useState<NightPrice[]>([]);
  const [pricesFailed, setPricesFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<BookingSuccess | null>(null);

  const room = rooms.find(r => r.id === roomId) ?? null;

  // Реальные цены по ночам выбранного номера. Горизонт — год, как у
  // календаря дат (иначе даты за горизонтом вечно «недогружены»).
  // Смена номера сбрасывает карту цен и отменяет устаревший ответ —
  // иначе цены прошлого номера применились бы к новому.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    setPrices([]);
    setPricesFailed(false);
    const start = new Date();
    const end = new Date();
    end.setFullYear(end.getFullYear() + 1);
    fetch(
      `/api/accommodations/${accommodationId}/prices?` +
      `startDate=${ymd(start)}&endDate=${ymd(end)}&roomId=${roomId}`
    )
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { prices: { date: string; price: number; isBlocked: boolean }[] } } | null) => {
        if (cancelled) return;
        if (d?.success && Array.isArray(d.data?.prices)) {
          setPrices(d.data.prices.map(p => ({ date: p.date, price: p.price, isBlocked: p.isBlocked })));
        } else {
          setPricesFailed(true);
        }
      })
      .catch(() => { if (!cancelled) setPricesFailed(true); });
    return () => { cancelled = true; };
  }, [accommodationId, roomId]);

  // Смена номера: гости не должны превышать вместимость нового номера
  useEffect(() => {
    if (!room) return;
    if (adults + children > room.maxGuests) {
      setAdults(Math.min(adults, room.maxGuests));
      setChildren(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const totals = useMemo(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) return null;
    return computeStayTotal(prices, ymd(checkIn), ymd(checkOut));
  }, [prices, checkIn, checkOut]);

  const guestsOverCapacity = room ? adults + children > room.maxGuests : false;

  const canSubmit =
    !!room && !!checkIn && !!checkOut && !!totals &&
    totals.blockedDate === null && totals.missingNights === 0 &&
    !guestsOverCapacity && adults >= 1 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!room || !checkIn || !checkOut) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/accommodations/${accommodationId}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: room.id,
          checkInDate: ymd(checkIn),
          checkOutDate: ymd(checkOut),
          adults,
          children,
          specialRequests: specialRequests.trim() || undefined,
        }),
      });

      if (res.status === 401) {
        setError('Чтобы забронировать, войдите в аккаунт');
        return;
      }

      const d = await res.json() as {
        success?: boolean;
        error?: string;
        data?: {
          bookingId: string;
          nights: number;
          priceBreakdown?: { totalPrice: number };
        };
      };
      if (!res.ok || !d.success || !d.data) {
        setError(d.error || 'Не удалось создать бронирование');
        return;
      }

      setSuccess({
        bookingId: d.data.bookingId,
        // Сумма — СЕРВЕРНАЯ, не клиентский расчёт
        totalPrice: d.data.priceBreakdown?.totalPrice ?? totals?.total ?? 0,
        nights: d.data.nights,
      });
    } catch {
      setError('Сетевая ошибка — попробуйте ещё раз');
    } finally {
      setSubmitting(false);
    }
  }

  if (rooms.length === 0) {
    return (
      <div className="ds-card p-6 text-center">
        <p className="text-sm text-[var(--text-secondary)]">
          Онлайн-бронирование появится, когда владелец добавит номера.
        </p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="ds-card p-6 space-y-4" aria-live="polite">
        <p className="text-base font-semibold text-[var(--text-primary)]">Заявка отправлена владельцу</p>
        <p className="text-sm text-[var(--text-secondary)]">
          {accommodationName} · {room?.name} · {success.nights} ноч. ·{' '}
          <span className="font-semibold text-[var(--text-primary)]">{formatMoney(success.totalPrice)} ₽</span>
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          <span className="ds-badge border border-[var(--border)] text-[var(--warning)]">Ожидает подтверждения</span>
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          {STAY_PAY_ON_SITE}. Платформа деньги за проживание не принимает. О решении владельца сообщим письмом;
          статус — в разделе <Link href="/hub/tourist/stays" className="underline text-[var(--ocean)]">«Мои проживания»</Link>.
        </p>
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* Выбор номера */}
      <div className="ds-card p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Номер</h3>
        <div className="space-y-2">
          {rooms.map(r => (
            <label
              key={r.id}
              className={`flex items-center justify-between gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                roomId === r.id
                  ? 'border-[var(--accent)] bg-[var(--bg-hover)]'
                  : 'border-[var(--border)] hover:border-[var(--accent)]'
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <input
                  type="radio"
                  name="room"
                  value={r.id}
                  checked={roomId === r.id}
                  onChange={() => setRoomId(r.id)}
                />
                <span className="text-sm text-[var(--text-primary)] truncate">{r.name}</span>
                <span className="text-xs text-[var(--text-muted)] hidden sm:inline">
                  {ROOM_TYPE_LABELS[r.roomType as RoomType] ?? r.roomType} · до {r.maxGuests} гостей
                </span>
              </span>
              <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap">
                {formatMoney(r.pricePerNight)} ₽/ночь
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Даты */}
      <div className="ds-card p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Даты проживания</h3>
        <StayDatePicker
          accommodationId={accommodationId}
          roomId={roomId || undefined}
          pricePerNight={room?.pricePerNight ?? 0}
          showPriceBreakdown={false}
          onDatesChange={(inDate, outDate) => {
            setCheckIn(inDate);
            setCheckOut(outDate);
          }}
        />
      </div>

      {/* Гости */}
      <div className="ds-card p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Гости</h3>
        <GuestSelector
          key={roomId}
          maxGuests={room?.maxGuests ?? 10}
          initialAdults={adults}
          initialChildren={children}
          onChange={(a, c) => { setAdults(a); setChildren(c); }}
        />
        {guestsOverCapacity && room && (
          <p className="text-xs text-[var(--danger)] mt-2">
            Номер вмещает до {room.maxGuests} гостей — выберите другой номер или уменьшите число гостей.
          </p>
        )}
      </div>

      {/* Пожелания */}
      <div className="ds-card p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Пожелания (необязательно)</h3>
        <textarea
          className="ds-input resize-none"
          rows={3}
          value={specialRequests}
          onChange={e => setSpecialRequests(e.target.value)}
          placeholder="Поздний заезд, детская кроватка..."
        />
      </div>

      {/* Итог — честная сумма по ночам, как посчитает сервер */}
      {totals && room && (
        <div className="ds-card p-5">
          <div className="flex justify-between items-center text-sm mb-1">
            <span className="text-[var(--text-secondary)]">
              {room.name} · {totals.nights} ноч.
            </span>
            <span className="font-bold text-lg text-[var(--text-primary)]">
              {formatMoney(totals.total)} ₽
            </span>
          </div>
          <p className="text-[10px] text-[var(--text-muted)]">
            Сумма реальных цен по ночам (тарифы владельца учтены). Без скрытых сборов. {STAY_PAY_ON_SITE}.
          </p>
          {totals.blockedDate && (
            <p className="text-xs text-[var(--danger)] mt-2">
              Владелец закрыл продажу на {totals.blockedDate.split('-').reverse().join('.')} — выберите другие даты.
            </p>
          )}
          {totals.missingNights > 0 && (
            <p className="text-xs text-[var(--warning)] mt-2">
              Не удалось загрузить цены на часть ночей — обновите страницу.
            </p>
          )}
        </div>
      )}

      {pricesFailed && (
        <p className="text-sm text-[var(--danger)]">Не удалось загрузить цены номера. Обновите страницу.</p>
      )}

      {error && (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {error}{' '}
          {error.includes('войдите') && (
            <Link href="/auth/login" className="underline text-[var(--ocean)]">Войти</Link>
          )}
        </p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full ds-btn ds-btn-primary py-3 text-base disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Оформляем…' : 'Забронировать'}
      </button>
    </form>
  );
}
