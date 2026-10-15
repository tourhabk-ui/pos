/**
 * Типы для системы бронирований Kamchatour Hub
 * Расширенная бизнес-логика: статусы, отмены, возвраты, логирование
 */

/**
 * Значения `operator_bookings.booking_status` — из единого словаря
 * `lib/types/statuses.ts` (аудит 15.10, A11). Своего перечня здесь нет: до
 * этой правки их было два, и они расходились (`rejected` там, `no_show`
 * здесь). Состав и почему без `rejected` — в шапке словаря.
 *
 * История (11.09, #1814): прежде тип здесь называл статусы, которых ни один
 * писатель не производит (`pending`, `cancelled_by_tourist`,
 * `cancelled_by_operator`, `refunded`), — `lib/bookings/booking.service.ts`
 * писал их в другую таблицу `bookings`, и реальный столбец их не видел.
 *
 * Кто отменил (турист/оператор) и на сколько положен возврат — не отдельные
 * СТАТУСЫ бронирования (колонки под это в `operator_bookings` нет), а
 * `cancellation_reason` (текст) и вычисляемый `RefundResult` соответственно.
 */
import { BOOKING_STATUSES, type BookingStatus } from '@/lib/types/statuses';

export { BOOKING_STATUSES };
export type { BookingStatus };

/** Статусы, считающиеся терминальными (нельзя менять) */
export const TERMINAL_STATUSES: ReadonlySet<BookingStatus> = new Set([
  'completed',
  'cancelled',
  'no_show',
]);

/** Статус отмены — один, `cancelled`. Кто отменил — в `cancellation_reason`. */
export const CANCELLED_STATUSES: ReadonlySet<BookingStatus> = new Set([
  'cancelled',
]);

/**
 * Разрешенные переходы статусов
 * Ключ — текущий статус, значение — массив допустимых следующих статусов
 */
export const ALLOWED_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  new: ['confirmed', 'cancelled'],
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
} as const;

export interface RefundResult {
  /**
   * Процент возврата — по условиям тура (решение владельца 24.09, «как у
   * оператора»; правило — lib/payments/tour-refund.ts): до срока 100, позже
   * процент оператора, отмена оператором или нет условий — 100.
   */
  percent: number;
  /** Сумма к возврату в рублях */
  amount: number;
  /** Текстовое объяснение */
  reason: string;
}

export interface BookingLogEntry {
  id: string;
  bookingId: string;
  fromStatus: BookingStatus;
  toStatus: BookingStatus;
  changedBy: string | null;
  comment: string | null;
  createdAt: Date;
}

export interface BookingWithDetails {
  id: string;
  status: BookingStatus;
  tour: {
    id: string;
    title: string;
    price: number;
  };
  tourist: {
    id: string;
    name: string;
    email: string;
  };
  date: Date;
  participants: number;
  totalAmount: number;
  refundAmount: number | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  specialRequests: string | null;
  paymentStatus: string;
  createdAt: Date;
  updatedAt: Date;
  logs: BookingLogEntry[];
  /**
   * Вейвер (согласие с рисками) для высокорисковых туров. Заполняется только
   * для броней оператора (operator_bookings); для legacy-броней — undefined.
   */
  waiverRequired?: boolean;
  waiverSigned?: boolean;
}

export interface CreateBookingInput {
  tourId: string;
  date: string;
  participants: number;
  specialRequests?: string;
  /** UUID заезда из tour_departures (если бронь через календарь заездов) */
  departureId?: string;
}

export interface RescheduleBookingInput {
  targetTourId: string;
  targetDate: string;
  participants?: number;
  comment?: string;
}

export interface CancelBookingResult {
  booking: BookingWithDetails;
  refund: RefundResult;
}
