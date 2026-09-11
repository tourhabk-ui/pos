/**
 * Booking & Availability Service
 * Functions related to booking CRUD, payment confirmation, cancellation, and availability.
 */

import {
  pool,
  toStringOrNull,
  toNumberOrNull,
} from '../_helpers';

export const bookingService = {
  normalize(row: Record<string, unknown> | null) {
    if (!row) {
      return null;
    }

    const specialRequests = typeof row.special_requests === 'string'
      ? row.special_requests
      : typeof row.specialRequests === 'string'
        ? row.specialRequests
        : null;

    return {
      id: row.id,
      userId: row.user_id ?? row.userId ?? null,
      tourId: row.tour_id ?? row.tourId ?? null,
      startDate: row.start_date ?? row.startDate ?? row.date ?? null,
      guestsCount: row.guests_count ?? row.guestsCount ?? row.participants ?? null,
      totalPrice: row.total_price ?? row.totalPrice ?? null,
      status: row.status ?? null,
      paymentStatus: row.payment_status ?? row.paymentStatus ?? null,
      specialRequests,
      createdAt: row.created_at ?? row.createdAt ?? null,
      updatedAt: row.updated_at ?? row.updatedAt ?? null,
    };
  },
  async getById(id: string) {
    const result = await pool.query(
      `SELECT id, operator_tour_id AS tour_id, user_id,
              booking_date AS start_date, booking_date AS date,
              participants, participants AS guests_count,
              COALESCE(final_price, base_total_price) AS total_price,
              booking_status AS status, payment_status, special_requests,
              created_at, updated_at
       FROM operator_bookings WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async getByIdForUser(id: string, userId: string) {
    const result = await pool.query(
      `SELECT id, operator_tour_id AS tour_id, user_id,
              booking_date AS start_date, booking_date AS date,
              participants, participants AS guests_count,
              COALESCE(final_price, base_total_price) AS total_price,
              booking_status AS status, payment_status, special_requests,
              created_at, updated_at
       FROM operator_bookings WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [id, userId]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async create(data: Record<string, unknown>) {
    const tourId = toStringOrNull(data.tourId) ?? toStringOrNull(data.tour_id);
    const userId = toStringOrNull(data.userId) ?? toStringOrNull(data.user_id);
    const totalPrice = toNumberOrNull(data.totalPrice) ?? toNumberOrNull(data.finalPrice) ?? toNumberOrNull(data.total_price);
    const startDate = toStringOrNull(data.startDate) ?? toStringOrNull(data.date) ?? new Date().toISOString().slice(0, 10);
    const participants = toNumberOrNull(data.participants) ?? toNumberOrNull(data.guestsCount) ?? toNumberOrNull(data.guests_count) ?? 1;
    const specialRequests = toStringOrNull(data.specialRequests) ?? toStringOrNull(data.special_requests);

    if (!tourId || !userId || totalPrice === null) {
      throw new Error('Required fields: tourId, userId, totalPrice');
    }

    const result = await pool.query(
      `INSERT INTO operator_bookings (
         user_id,
         operator_tour_id,
         booking_date,
         participants,
         base_total_price,
         booking_status,
         payment_status,
         special_requests,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'pending', 'pending', $6, NOW(), NOW())
       RETURNING *`,
      [userId, tourId, startDate, participants, totalPrice, specialRequests]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async update(id: string, data: Record<string, unknown>) {
    const specialRequests = typeof data.specialRequests === 'string'
      ? data.specialRequests
      : typeof data.special_requests === 'string'
        ? data.special_requests
        : null;

    const result = await pool.query(
      `UPDATE operator_bookings
       SET
         booking_status = COALESCE($2, booking_status),
         special_requests = COALESCE($3, special_requests),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, data.status ?? null, specialRequests]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async updateForUser(id: string, userId: string, data: Record<string, unknown>) {
    const specialRequests = typeof data.specialRequests === 'string'
      ? data.specialRequests
      : typeof data.special_requests === 'string'
        ? data.special_requests
        : null;

    const result = await pool.query(
      `UPDATE operator_bookings
       SET
         booking_status = COALESCE($3, booking_status),
         special_requests = COALESCE($4, special_requests),
         updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, data.status ?? null, specialRequests]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async confirmPayment(bookingId: string, _transactionId: string) {
    const result = await pool.query(
      `UPDATE operator_bookings
       SET
         booking_status = 'confirmed',
         payment_status = 'paid',
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [bookingId]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  // cancel() удалён 11.09 — ЧЕТВЁРТАЯ реализация отмены, у которой не было
  // ни одного потребителя (`bookingService` не импортирует никто, кроме
  // барреля `lib/services/index.ts`).
  //
  // Она расходилась с живыми путями сразу в четырёх местах: не ставила
  // `cancelled_at`, писала причину в `special_requests` вместо
  // `cancellation_reason`, не возвращала места в `tour_availability` (#1816) и
  // возвращала вызывающему `refundAmount: 0` — то есть УТВЕРЖДАЛА, что
  // возврата не будет, хотя решения никто не принимал и механизма возврата в
  // платформе нет вовсе (#1813).
  //
  // Расходящийся дубль опаснее отсутствия: он ждёт первого, кто найдёт его
  // поиском и позовёт, считая работающим путём. Цену такой копии платформа уже
  // платила — две SOS-кнопки разошлись поведением (#887).
  //
  // Отмена живёт в трёх настоящих местах: /api/bookings/[id]/cancel (турист),
  // /api/hub/operator/bookings/[id] и /api/operator/bookings/[id] (оператор).
  // Правило «отмена возвращает места» держит
  // tests/unit/cancel-releases-slots.test.ts.

  async list(params: Record<string, unknown>) {
    const limit = (params.limit as number) || 20;
    const offset = (params.offset as number) || 0;
    const result = await pool.query(
      `SELECT id, operator_tour_id AS tour_id, user_id,
              booking_date AS start_date, booking_date AS date,
              participants, participants AS guests_count,
              COALESCE(final_price, base_total_price) AS total_price,
              booking_status AS status, payment_status, special_requests,
              created_at, updated_at
       FROM operator_bookings WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return { bookings: result.rows.map(row => this.normalize(row)) };
  },
};

// ========================================
// Availability Service
// ========================================

export const availabilityService = {
  async search(params: Record<string, unknown>) {
    return [];
  },
  async getByTour(tourId: string) {
    return { availability: [] };
  },
  async createSlot(data: Record<string, unknown>) {
    return {
      id: crypto.randomUUID(),
      ...data,
      createdAt: new Date().toISOString(),
    };
  },
  async getCalendar(tourId: string, startDate: Date, endDate: Date) {
    return {
      tourId,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      days: [],
    };
  },
  async update(id: string, data: Record<string, unknown>) {
    return { success: true };
  },
};
