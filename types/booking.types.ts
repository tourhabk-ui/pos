/**
 * Типы для системы бронирований Kamchatour Hub
 * Расширенная бизнес-логика: статусы, отмены, возвраты, логирование
 */

/**
 * Реальные значения `operator_bookings.booking_status` (11.09, #1814).
 *
 * До этой правки тип называл статусы, которых ни один писатель не производит
 * (`pending`, `cancelled_by_tourist`, `cancelled_by_operator`, `refunded`) —
 * `lib/bookings/booking.service.ts` строил переходы по ним и писал их в
 * таблицу `bookings` (другую, с несовместимой схемой), поэтому реальный
 * столбец их никогда не видел. Источник правды здесь три независимых места,
 * согласные между собой: Zod-схема ручной правки статуса
 * (`app/api/hub/operator/bookings/[id]/route.ts`), единственный писатель при
 * создании (`lib/bookings/reserve.ts`) и WHERE-фильтры занятости по всей базе
 * (`booking_status NOT IN ('cancelled','rejected')`, `IN ('new','confirmed')`).
 * `rejected` встречается только в защитном WHERE, ни один писатель его не
 * производит — в перечень не включён (правило 10.09: объявлять статус без
 * производителя значит повторить эту же ошибку в другую сторону).
 *
 * Кто отменил (турист/оператор) и на сколько положен возврат — не отдельные
 * СТАТУСЫ бронирования (колонки под это в `operator_bookings` нет), а
 * `cancellation_reason` (текст) и вычисляемый `RefundResult` соответственно.
 */
export type BookingStatus =
  | 'new'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show';

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
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
} as const;

export interface RefundResult {
  /**
   * Процент возврата. Решение владельца 11.09 (#1813): пока всегда 100 —
   * тиражированная лестница 100/50/0 по часам до тура снята до отдельного
   * решения о ней. Числовой тип (не литерал 100) сохранён нарочно: изменение
   * политики не должно требовать переписывать интерфейс.
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
  changedBy: string;
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
