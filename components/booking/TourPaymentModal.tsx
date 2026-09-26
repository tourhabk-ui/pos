'use client';

/**
 * Модалка брони тура на /calendar и /routes/[id].
 *
 * ── Почему внутри та же форма, что на карточке тура (26.09) ───────────────
 *
 * До этого дня модалка была отдельной дверью со своей логикой: вошедший
 * турист бронировал через `POST /api/bookings/tour` (своя копия вставки
 * брони, мимо `reserveBooking`), и тут же открывался виджет CloudPayments —
 * деньги списывались с карты ДО того, как оператор подтвердил дату. Правило
 * платформы обратное (§7, `lib/bookings/success-view.ts`): платится бронь,
 * ПОДТВЕРЖДЁННАЯ оператором, QR на `new` не выдаётся. Гость же вместо брони
 * получал лид, и продажа по ссылке агента в нём терялась.
 *
 * Теперь модалка — только рамка. Внутри `BookingFormClient`: та же форма, тот
 * же `POST /api/hub/bookings/create` → `reserveBooking`, тот же код агентской
 * ссылки и тот же переход на `/booking-success/{id}?t=...`, где турист
 * оплатит после подтверждения. Имя файла оставлено ради двух потребителей;
 * «Payment» в нём теперь историческое.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { X, AlertTriangle } from 'lucide-react';
import BookingFormClient from '@/components/marketplace/BookingFormClient';

interface TourPaymentModalProps {
  open: boolean;
  onClose: () => void;
  tourId: number;
  tourName: string;
  operatorName: string;
  priceBase: number | null;
  /** operator_tours.price_unit — «за группу» не множится на участников. */
  priceUnit?: string | null;
  /** Для «за человека в день»: без неё сумма считалась бы как за один день. */
  duration?: { multi_day_count: number | null; duration_hours: number | null };
  maxGroupSize: number | null;
  /** Дата, выбранная снаружи (день календаря, ближайший выезд) — стартовое значение формы. */
  nextDeparture: string | null;
}

export default function TourPaymentModal({
  open,
  onClose,
  tourId,
  tourName,
  operatorName,
  priceBase,
  priceUnit,
  duration,
  maxGroupSize,
  nextDeparture,
}: TourPaymentModalProps) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-md bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={`Заявка на тур ${tourName}`}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors z-10"
          aria-label="Закрыть"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-6 space-y-4">
          <div className="pr-6">
            <p className="text-xs text-[var(--text-muted)]">
              {operatorName}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Оплата — после того, как оператор подтвердит дату.
            </p>
          </div>

          {priceBase != null && priceBase > 0 ? (
            <BookingFormClient
              tourId={tourId}
              tourTitle={tourName}
              basePrice={priceBase}
              priceUnit={priceUnit}
              duration={duration}
              maxParticipants={maxGroupSize ?? 10}
              initialDate={nextDeparture ? nextDeparture.slice(0, 10) : null}
            />
          ) : (
            // Цены нет — сумму заявки посчитать не из чего, и выдумывать её
            // нельзя (§4.0). Честнее отправить на карточку тура.
            <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm text-[var(--text-secondary)]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--warning)]" aria-hidden="true" />
              <p>
                Цена этого тура не указана.{' '}
                <Link href={`/marketplace/tours/${tourId}`} className="text-[var(--ocean)] hover:underline">
                  Откройте карточку тура
                </Link>
                , чтобы уточнить детали у оператора.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
