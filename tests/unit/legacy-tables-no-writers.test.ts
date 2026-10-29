/**
 * Живые пути не пишут в `tours`/`bookings` и не ссылаются на них
 * (аудит 15.10, P2-02).
 *
 * CLAUDE.md §4: туры — только `operator_tours`, брони — только
 * `operator_bookings`. На проде `tours` и `bookings` — отдельные несовместимые
 * таблицы с uuid-ключом (#1814), и колонки-ссылки на них (`conversations.tour_id`,
 * `reviews.tour_id`, ...) — тоже uuid. Аудит нашёл пять писателей:
 *
 * - `POST /api/chat/conversations` — ЖИВОЙ (кнопка «Написать оператору» на
 *   карточке тура): писал id из `operator_tours` (bigint) в
 *   `conversations.tour_id` (uuid → tours), 22P02 на каждом создании беседы;
 * - `POST /api/tours` (и его реэкспорт `POST /api/discovery/tours`) —
 *   `INSERT INTO tours` колонками, которых у неё нет;
 * - `POST /api/tours/create` — `INSERT INTO tours` и `tour_assets`;
 * - `POST /api/discovery/reviews` — отзыв о туре в `reviews.tour_id`, где
 *   отзывы о туре не читает никто (их читают из `operator_tour_reviews`);
 * - `tourService.update()` — `UPDATE tours`, сирота.
 *
 * Волна 2 (п. 1.12) сняла остаток: `reviewService` целиком (правка, одобрение,
 * ответ и удаление отзыва по `reviews.tour_id` → tours) с его роутом
 * `/api/discovery/reviews/[id]` и `GET /api/discovery/tours/[id]/stats`
 * вместе с `tourService.getStats` — у обоих не было ни одного вызывающего.
 *
 * Живой путь починен, мёртвые сняты. Здесь — вызовом, а не поиском по тексту
 * (CLAUDE.md §4, «Сторож судит поведение»): маршрут зовётся с данными, весь
 * SQL, ушедший в пул, записывается и судится. Запрет на появление нового
 * текста `INSERT INTO tours` в app/ и lib/ держит
 * tests/unit/compat-view-writes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];

/** Ответ пула по форме запроса — только то, что нужно путям ниже дойти до записи. */
function answer(sql: string): { rows: Record<string, unknown>[]; rowCount: number } {
  const s = sql.replace(/\s+/g, ' ');
  // Роль собеседника — категория карточки (29.10): запрос читает и её.
  if (/SELECT user_id(?:, category)? FROM partners/i.test(s)) return { rows: [{ user_id: 'operator-user-1', category: 'operator' }], rowCount: 1 };
  if (/INSERT INTO conversations\b/i.test(s)) {
    return { rows: [{ id: 'conv-new', type: 'direct', subject: null, tour_id: null, booking_id: null }], rowCount: 1 };
  }
  if (/FROM operator_tours t JOIN partners p/i.test(s)) return { rows: [{ id: '51' }], rowCount: 1 };
  if (/FROM operator_tours t LEFT JOIN partners p/i.test(s) && /WHERE t\.id = \$1/i.test(s)) {
    return { rows: [{ id: '51', title: 'Вулкан Горелый', is_active: false }], rowCount: 1 };
  }
  if (/UPDATE operator_tours SET is_active/i.test(s)) {
    return { rows: [{ id: '51', title: 'Вулкан Горелый', is_active: true }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

async function record(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  return answer(sql);
}

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => record(sql, params),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => record(sql, params),
      release: () => undefined,
    }),
  },
}));

const auth = { userId: 'tourist-1', role: 'tourist' };
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: async () => auth,
  requireOperator: async () => ({ userId: 'operator-user-1', role: 'operator' }),
  requireAdmin: async () => ({ userId: 'admin-1', role: 'admin' }),
}));

vi.mock('@/lib/crm/chat-events', () => ({ recordChatMessageQuietly: async () => undefined }));

const ROOT = process.cwd();

/** Запись в запрещённую таблицу — в любой форме, со схемой и без. */
const WRITES_LEGACY = /\b(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?)\s+(?:"?public"?\.)?"?(tours|bookings)"?(?:\s|\(|$)/i;

/** Колонка → значение у INSERT ... (cols) VALUES (...) по параметрам вызова. */
function insertedValues(call: Call, table: string): Record<string, unknown> | null {
  const m = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(([^)]*)\\)`, 'i').exec(call.sql);
  if (!m) return null;
  const cols = m[1].split(',').map((c) => c.trim());
  const vals = m[2].split(',').map((v) => v.trim());
  const out: Record<string, unknown> = {};
  cols.forEach((c, i) => {
    const p = /^\$(\d+)/.exec(vals[i] ?? '');
    out[c] = p ? call.params[Number(p[1]) - 1] : vals[i];
  });
  return out;
}

function noLegacyWrites() {
  const bad = calls.filter((c) => WRITES_LEGACY.test(c.sql)).map((c) => c.sql.replace(/\s+/g, ' ').slice(0, 120));
  expect(bad, 'запись в tours/bookings — писать надо в operator_tours/operator_bookings (CLAUDE.md §4)').toEqual([]);
}

function jsonReq(url: string, body: unknown): NextRequest {
  const r = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return Object.assign(r, { nextUrl: new URL(url) }) as unknown as NextRequest;
}

beforeEach(() => {
  calls.length = 0;
});

describe('«Написать оператору» с карточки тура — POST /api/chat/conversations', () => {
  it('беседа создаётся, id тура не уходит в колонку-ссылку на tours, тур остаётся темой', async () => {
    const { POST } = await import('@/app/api/chat/conversations/route');
    // Ровно то, что шлёт components/marketplace/MessageOperatorButton.tsx,
    // плюс bookingId: старый контракт роута его принимал.
    const res = await POST(
      jsonReq('http://localhost/api/chat/conversations', {
        operatorPartnerId: 'partner-5',
        tourId: 51,
        bookingId: '77',
        subject: 'Вулкан Горелый',
      }),
    );
    expect(res.status).toBe(201);

    const inserts = calls.map((c) => insertedValues(c, 'conversations')).filter((v): v is Record<string, unknown> => v !== null);
    expect(inserts, 'беседа должна создаваться ровно одной записью').toHaveLength(1);
    const row = inserts[0];
    // conversations.tour_id/booking_id на проде — uuid с ключом на tours/bookings:
    // туда не пишется ничего, кроме NULL (а лучше — ничего вовсе).
    expect(row.tour_id ?? null, 'tour_id ссылается на запрещённую tours — 22P02 на bigint id тура').toBeNull();
    expect(row.booking_id ?? null, 'booking_id ссылается на запрещённую bookings').toBeNull();
    expect(row.subject).toBe('Вулкан Горелый');
    // Ни в одном запросе пути число тура не ушло параметром.
    expect(calls.some((c) => c.params.some((p) => p === 51 || p === '51'))).toBe(false);
    noLegacyWrites();
  });

  it('тело не по форме — 400 по-русски, в базу не ходим', async () => {
    const { POST } = await import('@/app/api/chat/conversations/route');
    const res = await POST(jsonReq('http://localhost/api/chat/conversations', { participantId: 42 }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/[а-я]/i);
    expect(calls).toEqual([]);
  });
});

describe('публикация тура оператором — POST /api/discovery/tours/[id]/publish', () => {
  it('пишет operator_tours, не tours', async () => {
    const { POST } = await import('@/app/api/discovery/tours/[id]/publish/route');
    const res = await POST(jsonReq('http://localhost/api/discovery/tours/51/publish', {}), {
      params: Promise.resolve({ id: '51' }),
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => /UPDATE\s+operator_tours\s+SET\s+is_active\s*=\s*TRUE/i.test(c.sql))).toBe(true);
    noLegacyWrites();
  });
});

describe('мёртвые писатели сняты', () => {
  it('у /api/tours нет POST — Next отвечает 405; GET ходит только в operator_tours', async () => {
    const mod = (await import('@/app/api/tours/route')) as Record<string, unknown>;
    expect(mod.POST, 'POST /api/tours писал в tours несуществующими колонками и не выполнялся ни разу').toBeUndefined();
    const res = await (mod.GET as (r: NextRequest) => Promise<Response>)(
      Object.assign(new Request('http://localhost/api/tours'), { nextUrl: new URL('http://localhost/api/tours') }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !/\bFROM\s+tours\b/i.test(c.sql))).toBe(true);
    noLegacyWrites();
  });

  it('у /api/discovery/tours нет POST — реэкспорт вёл в тот же INSERT INTO tours', async () => {
    const mod = (await import('@/app/api/discovery/tours/route')) as Record<string, unknown>;
    expect(mod.POST).toBeUndefined();
    expect(typeof mod.GET).toBe('function');
  });

  it('у сервисов нет методов, писавших в tours и в reviews.tour_id', async () => {
    const services = (await import('@/lib/services')) as Record<string, unknown>;
    const tourService = services.tourService as Record<string, unknown>;
    expect('update' in tourService, 'tourService.update писал UPDATE tours').toBe(false);
    // Волна 2 (п. 1.12): reviewService снят целиком — правка, одобрение и
    // удаление отзыва по reviews.tour_id → tours; getStats тура считал
    // отзывы тем же несовместимым соединением uuid = bigint.
    expect('reviewService' in services, 'reviewService писал отзыв о туре в reviews.tour_id → tours').toBe(false);
    expect('getStats' in tourService, 'tourService.getStats читал reviews.tour_id = bigint и падал на любом туре').toBe(false);
  });

  it.each([
    'app/api/tours/create/route.ts',
    // Отзыв о туре пишет только POST /api/reviews/tour/[tourId] в
    // operator_tour_reviews — там, где его читают карточка и GET /api/reviews.
    'app/api/discovery/reviews/route.ts',
    'app/api/discovery/reviews/[id]/route.ts',
    'app/api/discovery/tours/[id]/stats/route.ts',
    'lib/services/operators/review.service.ts',
  ])('файла %s нет', (file) => {
    expect(existsSync(join(ROOT, file))).toBe(false);
  });
});
