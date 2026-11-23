/**
 * Модерация правок тура — на настоящем PostgreSQL (план готовности 23.11,
 * этап 4).
 *
 * Содержание тура попадает на витрину только после одобрения. Здесь судится
 * сама механика на схеме прода:
 *  - опубликованный тур: правка цены и снимков — черновик, витрина прежняя;
 *    одобрение применяет её одним действием, отказ оставляет витрину;
 *  - скрыть тур, поменять сезон и число мест — сразу, без черновика;
 *  - первый выклад: публикацию ставит только одобрение;
 *  - тур не на витрине правится свободно, пока не попросил публикацию;
 *  - вторая правка дополняет первую; возврат к значению витрины убирает поле;
 *  - администратор одобряет то, что видел: правка после показа — `changed`;
 *  - тестовый профиль: одобренный тур на витрину всё равно не выходит.
 *
 * Своя база `tour_moderation_test`. Без KERNEL_PG_TEST_URL файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import type { TourPatchInput } from '@/lib/tours/tour-write';
import type { TourChange } from '@/lib/tours/tour-change';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
// Вошедший — владелец кабинета оператора (USER ниже): двери судятся целиком,
// подменён только разбор JWT. Модель подменена ответом-заготовкой.
// `who` переключает вошедшего на администратора — тем же роутом он правит витрину.
const who = vi.hoisted(() => ({
  userId: 'c4000000-0000-4000-8000-000000000201', // = USER
  role: 'operator' as 'operator' | 'admin',
}));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireOperator: vi.fn(async () => ({ userId: who.userId, role: who.role })),
  requireAdmin: vi.fn(async () => ({ userId: 'c4000000-0000-4000-8000-0000000002ad', role: 'admin' })), // = ADMIN
}));
// Транспорт сообщения владельцу подменён: настоящие чаты из тестов не тревожим.
const sent = vi.hoisted(() => ({ alerts: [] as Array<{ text: string; stub: string; to: unknown; buttons: Array<{ url: string }> }> }));
vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async (a: { text: string; stub: string; to: unknown; buttons: Array<{ url: string }> }) => {
    sent.alerts.push(a);
    return { channel: 'max', delivered: true };
  }),
}));
// Поисковикам из теста не пишем; что пинг уходит только после одобрения — считаем вызовы.
const pings = vi.hoisted(() => ({ tours: [] as string[] }));
vi.mock('@/lib/seo/indexnow', async (orig) => ({
  ...(await orig<typeof import('@/lib/seo/indexnow')>()),
  pingTourChanged: vi.fn((id: string | number | bigint) => { pings.tours.push(String(id)); }),
}));
// Крючок перед транзакцией: «кто-то поправил тур, пока инструмент думал».
const tx = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));
vi.mock('@/lib/database', async (orig) => {
  const real = await orig<typeof import('@/lib/database')>();
  return {
    ...real,
    transaction: async <T,>(cb: Parameters<typeof real.transaction<T>>[0]) => {
      const before = tx.before;
      tx.before = null;
      if (before) await before();
      return real.transaction(cb);
    },
  };
});
const ai = vi.hoisted(() => ({ answer: '{}' }));
vi.mock('@/lib/ai/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/providers')>()),
  callAIWaterfall: vi.fn(async () => ai.answer),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[tour-moderation.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'tour_moderation_test';
const OP = 'c4000000-0000-4000-8000-000000000101';
const OTHER = 'c4000000-0000-4000-8000-000000000102';
const STAND = 'c4000000-0000-4000-8000-000000000103';
const USER = 'c4000000-0000-4000-8000-000000000201';
const ADMIN = 'c4000000-0000-4000-8000-0000000002ad';
/** Разделитель тысяч у ru-RU — неразрывный пробел; для сверки он обычный. */
const sp = (s: string | undefined) => (s ?? '').replace(/[\u00a0\u202f]/g, ' ');

withPg('модерация правок тура', () => {
  let pool: import('pg').Pool;

  const addTour = async (owner: string, title: string, o: { published?: boolean; price?: number } = {}) => (await pool.query<{ id: string }>(
    `INSERT INTO operator_tours (operator_id, title, description, base_price, price_unit, max_participants, is_active, is_published,
                                 activity_type, duration_hours, photos, tour_image, included)
     VALUES ($1, $2, 'Описание тура для проверки модерации правок.', $3, 'person', 8, TRUE, $4, 'hiking', 6,
             ARRAY['/a.jpg'], '/a.jpg', ARRAY['Гид'])
     RETURNING id::text AS id`,
    [owner, title, o.price ?? 10000, o.published === true],
  )).rows[0].id;

  const liveOf = async (id: string) => (await pool.query(
    `SELECT title, description, base_price::float8 AS base_price, photos, tour_image, is_published, is_active,
            max_participants, season_start::text AS season_start, cancellation_policy, cancellation_free_days
       FROM operator_tours WHERE id = $1::bigint`, [id],
  )).rows[0] as Record<string, unknown>;

  const onStorefront = async (id: string) => {
    const { publicTourSql } = await import('@/lib/tours/public-visibility');
    const { rows } = await pool.query(`SELECT 1 FROM operator_tours ot WHERE ot.id = $1::bigint AND ${publicTourSql('ot')}`, [id]);
    return rows.length === 1;
  };

  const change = async (id: string, owner: string | null, input: Record<string, unknown>): Promise<TourChange> => {
    const { saveTourChange } = await import('@/lib/tours/tour-change');
    const { transaction } = await import('@/lib/database');
    const current = (await pool.query(`SELECT main_place_id FROM operator_tours WHERE id = $1::bigint`, [id])).rows[0] ?? {};
    return transaction((client) => saveTourChange(client, {
      tourId: id, ownerId: owner, userId: owner ? USER : ADMIN, input: input as TourPatchInput, current,
    }));
  };

  const queue = async () => {
    const { listPendingTourEdits } = await import('@/lib/tours/moderation-review');
    const listed = await listPendingTourEdits();
    if (listed.outcome !== 'ok') throw new Error('очередь не прочитана');
    return listed.edits;
  };
  const decide = async (id: string, action: 'approve' | 'reject', seen: string | null, reason: string | null = null) => {
    const { decideTourEdit } = await import('@/lib/tours/moderation-review');
    return decideTourEdit({ id, action, reason, moderatedBy: ADMIN, seen });
  };
  const pendingCount = async (tourId: string) => Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM operator_tour_edits WHERE tour_id = $1::bigint AND moderation_status = 'pending'`, [tourId],
  )).rows[0].n);

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query(`INSERT INTO users (id, email, name, password_hash, role) VALUES
      ($1, 'mod-op@example.test', 'Тест', 'x', 'operator'), ($2, 'mod-admin@example.test', 'Администратор', 'x', 'admin')`, [USER, ADMIN]);
    for (const [id, name, isTest] of [[OP, 'Оператор', false], [OTHER, 'Другой оператор', false], [STAND, 'Стенд', true]] as const) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, profile_status, is_public, is_test)
         VALUES ($1, $2, 'operator', '{}'::jsonb, 'approved', $3, $4)`,
        [id, name, !isTest, isTest],
      );
    }
    // Кабинет вошедшего — карточка OP.
    await pool.query(`UPDATE partners SET user_id = $2 WHERE id = $1`, [OP, USER]);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    await dropTestDatabase(PG_URL, TEST_DB).catch(() => {});
  });

  describe('опубликованный тур', () => {
    let tour = '';
    beforeAll(async () => { tour = await addTour(OP, 'Вулкан Горелый', { published: true }); });

    it('цена и снимки — черновик; витрина показывает прежнее', async () => {
      const r = await change(tour, OP, { base_price: 12000, photos: ['/images/tours/b.jpg', '/images/tours/c.jpg'] });
      expect(r.outcome).toBe('pending');
      if (r.outcome !== 'pending') return;
      expect(r.pending.fields).toEqual(['base_price', 'photos']);
      expect(r.pending.notice).toContain('На витрине пока прежняя версия');
      const live = await liveOf(tour);
      expect(live.base_price).toBe(10000);
      expect(live.photos).toEqual(['/a.jpg']);
      expect(live.tour_image).toBe('/a.jpg');
      expect(await onStorefront(tour)).toBe(true);
    });

    it('вторая правка дополняет первую, а не заменяет её', async () => {
      const r = await change(tour, OP, { title: 'Вулкан Горелый с кальдерой' });
      expect(r.outcome === 'pending' && r.pending.fields).toEqual(['title', 'base_price', 'photos']);
      expect(await pendingCount(tour)).toBe(1);
      expect((await liveOf(tour)).title).toBe('Вулкан Горелый');
    });

    it('поле вернули к значению витрины — в черновике его нет', async () => {
      const r = await change(tour, OP, { title: 'Вулкан Горелый' });
      expect(r.outcome === 'pending' && r.pending.fields).toEqual(['base_price', 'photos']);
    });

    it('скрыть тур, число мест и расписание — сразу, черновик не трогается', async () => {
      const r = await change(tour, OP, { is_active: false, max_participants: 12, schedule_kind: 'any_day' });
      expect(r.outcome).toBe('written');
      const live = await liveOf(tour);
      expect(live.is_active).toBe(false);
      expect(live.max_participants).toBe(12);
      expect((await pool.query(`SELECT schedule_kind FROM operator_tours WHERE id = $1::bigint`, [tour])).rows[0].schedule_kind).toBe('any_day');
      expect(await onStorefront(tour)).toBe(false);
      expect(await pendingCount(tour)).toBe(1);
      await change(tour, OP, { is_active: true });
      expect(await onStorefront(tour)).toBe(true);
    });

    it('очередь администратора: дифф «было / стало» и отпечаток', async () => {
      const edit = (await queue()).find((e) => e.tourId === tour);
      expect(edit).toMatchObject({ kind: 'edit', partnerName: 'Оператор', tourTitle: 'Вулкан Горелый' });
      expect(edit?.changes.map((c) => [c.field, sp(c.before), sp(c.after)])).toEqual([
        ['base_price', '10 000 ₽', '12 000 ₽'],
        ['photos', 'снимков: 1', 'снимков: 2'],
      ]);
      expect(edit?.changes[1]).toMatchObject({ beforePhotos: ['/a.jpg'], afterPhotos: ['/images/tours/b.jpg', '/images/tours/c.jpg'] });
      expect(edit?.seen).toMatch(/^[0-9a-f]{64}$/);
    });

    it('оператор дописал правку после показа — одобрение не применяется', async () => {
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      await change(tour, OP, { base_price: 13000 });
      expect(await decide(shown.id, 'approve', shown.seen)).toEqual({ outcome: 'changed' });
      expect((await liveOf(tour)).base_price).toBe(10000);
      expect(await decide(shown.id, 'approve', null)).toEqual({ outcome: 'changed' });
    });

    it('одобрение одним действием: цена, снимки и главное фото на витрине', async () => {
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      const r = await decide(shown.id, 'approve', shown.seen);
      expect(r).toMatchObject({ outcome: 'approved', partnerId: OP, tourId: tour, published: false, fields: ['base_price', 'photos'] });
      const live = await liveOf(tour);
      expect(live.base_price).toBe(13000);
      expect(live.photos).toEqual(['/images/tours/b.jpg', '/images/tours/c.jpg']);
      expect(live.tour_image).toBe('/images/tours/b.jpg');
      expect(await pendingCount(tour)).toBe(0);
      const kept = (await pool.query(`SELECT moderation_status, live_before, moderated_by::text AS by FROM operator_tour_edits WHERE id = $1`, [shown.id])).rows[0];
      expect(kept.moderation_status).toBe('approved');
      expect(kept.by).toBe(ADMIN);
      expect(Number(kept.live_before.base_price)).toBe(10000);
      expect(kept.live_before.photos).toEqual(['/a.jpg']);
    });

    it('повторное решение по той же правке — «уже решено»', async () => {
      const id = (await pool.query(`SELECT id::text AS id FROM operator_tour_edits WHERE tour_id = $1::bigint`, [tour])).rows[0].id;
      expect(await decide(id, 'approve', 'x')).toEqual({ outcome: 'already' });
      expect(await decide(id, 'reject', null, 'причина')).toEqual({ outcome: 'already' });
    });

    it('отказ: витрина прежняя, причина видна владельцу', async () => {
      await change(tour, OP, { description: 'Новое описание, которое администратор вернёт на доработку.' });
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      const r = await decide(shown.id, 'reject', null, 'В описании обещан подъём на вершину, а в программе его нет');
      expect(r).toMatchObject({ outcome: 'rejected', fields: ['description'], published: false });
      expect((await liveOf(tour)).description).toBe('Описание тура для проверки модерации правок.');
      const { loadOwnTourEdits } = await import('@/lib/tours/moderation-store');
      const own = await loadOwnTourEdits([tour], new Map());
      expect(own?.get(tour)).toMatchObject({
        pending: null,
        rejected: { reason: 'В описании обещан подъём на вершину, а в программе его нет', fields: ['description'] },
      });
    });

    it('условия отмены: одобрение сбрасывает числа, выведенные из прежнего текста', async () => {
      await pool.query(
        `UPDATE operator_tours SET cancellation_policy = 'Бесплатно за 3 дня', cancellation_free_days = 3 WHERE id = $1::bigint`, [tour],
      );
      await change(tour, OP, { cancellation_policy: 'Бесплатно за 7 дней' });
      expect((await liveOf(tour)).cancellation_free_days).toBe(3);
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      expect((await decide(shown.id, 'approve', shown.seen)).outcome).toBe('approved');
      const live = await liveOf(tour);
      expect(live.cancellation_policy).toBe('Бесплатно за 7 дней');
      expect(live.cancellation_free_days).toBeNull();
    });

    it('сохранили форму без единой правки — «без изменений», а не ошибка; пустой запрос — «нечего сохранять»', async () => {
      const live = await liveOf(tour);
      // Форма шлёт себя целиком: то же название и то же описание.
      expect(await change(tour, OP, { title: live.title, description: live.description })).toEqual({ outcome: 'unchanged' });
      expect(await change(tour, OP, {})).toEqual({ outcome: 'empty' });
      expect(await pendingCount(tour)).toBe(0);
    });

    it('чужой тур владелец не правит и черновика не оставляет', async () => {
      expect(await change(tour, OTHER, { base_price: 1 })).toEqual({ outcome: 'not_found' });
      expect(await pendingCount(tour)).toBe(0);
    });

    it('администратор правит напрямую: он и есть проверка', async () => {
      const r = await change(tour, null, { base_price: 15000 });
      expect(r.outcome).toBe('written');
      expect((await liveOf(tour)).base_price).toBe(15000);
      expect(await pendingCount(tour)).toBe(0);
    });
  });

  describe('первый выклад', () => {
    let tour = '';
    beforeAll(async () => { tour = await addTour(OP, 'Черновик сплава'); });

    it('тур не на витрине правится свободно: проверять нечего', async () => {
      const r = await change(tour, OP, { base_price: 9000, title: 'Сплав по реке Быстрая' });
      expect(r.outcome).toBe('written');
      expect(await liveOf(tour)).toMatchObject({ base_price: 9000, title: 'Сплав по реке Быстрая', is_published: false });
      expect(await pendingCount(tour)).toBe(0);
    });

    it('галочка «Опубликован» — просьба: публикацию ставит только одобрение', async () => {
      const r = await change(tour, OP, { is_published: true, base_price: 9500 });
      expect(r.outcome).toBe('pending');
      if (r.outcome !== 'pending') return;
      expect(r.pending.wantsPublish).toBe(true);
      expect(r.pending.notice).toContain('Туристы увидят его после одобрения');
      const live = await liveOf(tour);
      expect(live.is_published).toBe(false);
      // Содержание этой же правки записано: администратор увидит именно его.
      expect(live.base_price).toBe(9500);
      expect(await onStorefront(tour)).toBe(false);
    });

    it('после просьбы содержание замирает: правка идёт в черновик', async () => {
      const r = await change(tour, OP, { base_price: 9900 });
      expect(r.outcome === 'pending' && r.pending.fields).toEqual(['base_price']);
      expect((await liveOf(tour)).base_price).toBe(9500);
    });

    it('в очереди — новый тур со всем содержанием, а не один дифф', async () => {
      const edit = (await queue()).find((e) => e.tourId === tour)!;
      expect(edit.kind).toBe('publish');
      const line = (f: string) => sp(edit.content.find((c) => c.field === f)?.text);
      expect(line('title')).toBe('Сплав по реке Быстрая');
      expect(line('base_price')).toBe('9 900 ₽');
      expect(line('cancellation_policy')).toBe('не записано');
    });

    it('одобрение ставит тур на витрину вместе с правкой', async () => {
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      const r = await decide(shown.id, 'approve', shown.seen);
      expect(r).toMatchObject({ outcome: 'approved', published: true });
      expect(await liveOf(tour)).toMatchObject({ is_published: true, base_price: 9900 });
      expect(await onStorefront(tour)).toBe(true);
    });

    it('снять с публикации — сразу; вернуть — снова через проверку', async () => {
      expect((await change(tour, OP, { is_published: false })).outcome).toBe('written');
      expect(await onStorefront(tour)).toBe(false);
      const again = await change(tour, OP, { is_published: true });
      expect(again.outcome).toBe('pending');
      expect((await liveOf(tour)).is_published).toBe(false);
    });

    it('владелец отзывает просьбу — черновика нет, тур снова правится свободно', async () => {
      const { withdrawTourEdit } = await import('@/lib/tours/moderation-store');
      expect(await withdrawTourEdit(tour, OTHER)).toBe('none');
      expect(await withdrawTourEdit(tour, OP)).toBe('withdrawn');
      expect(await pendingCount(tour)).toBe(0);
      expect((await change(tour, OP, { base_price: 8000 })).outcome).toBe('written');
    });
  });

  describe('прочие двери владельца: мимо очереди не пускает ни одна', () => {
    const post = (url: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost${url}`, { method, body: JSON.stringify(body) });
    const pendingPatch = async (tourId: string) => (await pool.query<{ patch: Record<string, unknown>; wants_publish: boolean }>(
      `SELECT patch, wants_publish FROM operator_tour_edits WHERE tour_id = $1::bigint AND moderation_status = 'pending'`, [tourId],
    )).rows[0] ?? null;

    it('старая дверь «опубликовать»: тур показан, но на витрину его ставит одобрение', async () => {
      const tour = await addTour(OP, 'Старая дверь публикации');
      await pool.query(`UPDATE operator_tours SET is_active = FALSE WHERE id = $1::bigint`, [tour]);
      const { POST } = await import('@/app/api/operator/tours/[id]/publish/route');
      const res = await POST(post(`/api/operator/tours/${tour}/publish`, {}), { params: Promise.resolve({ id: tour }) });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.status).toBe('pending_review');
      expect(body.message).toContain('отправлен на проверку');
      const live = await liveOf(tour);
      expect(live.is_active).toBe(true);
      expect(live.is_published).toBe(false);
      expect(await onStorefront(tour)).toBe(false);
      expect(await pendingPatch(tour)).toEqual({ patch: {}, wants_publish: true });
    });

    it('старая дверь «опубликовать»: чужой тур — «не найден», просьбы нет', async () => {
      const tour = await addTour(OTHER, 'Чужой для публикации');
      await pool.query(`UPDATE operator_tours SET is_active = FALSE WHERE id = $1::bigint`, [tour]);
      const { POST } = await import('@/app/api/operator/tours/[id]/publish/route');
      const res = await POST(post(`/api/operator/tours/${tour}/publish`, {}), { params: Promise.resolve({ id: tour }) });
      expect(res.status).toBe(404);
      expect((await liveOf(tour)).is_active).toBe(false);
      expect(await pendingPatch(tour)).toBeNull();
    });

    it('быстрое заполнение: описание и сложность тура на витрине — на проверку', async () => {
      const tour = await addTour(OP, 'Быстрое заполнение', { published: true });
      const { PATCH } = await import('@/app/api/operator/tours/quick-fill/route');
      const text = await PATCH(post('/api/operator/tours/quick-fill', { tourId: tour, field: 'description', value: 'Новое описание из быстрого заполнения.' }, 'PATCH'));
      const textBody = await text.json();
      expect(text.status).toBe(200);
      expect(textBody.pending).toContain('отправлена на проверку (описание)');
      expect((await liveOf(tour)).description).toBe('Описание тура для проверки модерации правок.');
      expect((await pendingPatch(tour))?.patch).toEqual({ description: 'Новое описание из быстрого заполнения.' });

      // Сложность с 23.11 — тоже на проверку: на витрине прежняя, в черновике — новая.
      const hard = await PATCH(post('/api/operator/tours/quick-fill', { tourId: tour, field: 'difficulty', value: 'hard' }, 'PATCH'));
      expect((await hard.json()).pending).toContain('отправлена на проверку (описание, сложность)');
      expect((await pool.query(`SELECT difficulty FROM operator_tours WHERE id = $1::bigint`, [tour])).rows[0].difficulty).toBeNull();
      expect((await pendingPatch(tour))?.patch).toEqual({ description: 'Новое описание из быстрого заполнения.', difficulty: 'hard' });
      // Чужой тур той же дверью не пишется.
      const foreign = await addTour(OTHER, 'Чужой для быстрого заполнения', { published: true });
      const denied = await PATCH(post('/api/operator/tours/quick-fill', { tourId: foreign, field: 'description', value: 'Чужая правка.' }, 'PATCH'));
      expect(denied.status).toBe(404);
      expect(await pendingPatch(foreign)).toBeNull();
    });

    it('ИИ-заполнение: текст модели в туре на витрине — на проверку; вписанное оператором в черновик не затирается', async () => {
      const tour = await addTour(OP, 'ИИ-заполнение', { published: true });
      await pool.query(`UPDATE operator_tours SET included = NULL, what_to_bring = NULL, difficulty = NULL WHERE id = $1::bigint`, [tour]);
      // Оператор уже вписал «что взять» и ждёт проверки.
      await change(tour, OP, { what_to_bring: ['Термос оператора'] });
      ai.answer = JSON.stringify({
        short_description: 'Короткое описание от модели.', difficulty: 'medium',
        included: ['Трансфер от модели'], what_to_bring: ['Список модели'], notes: 'Служебная заметка.',
      });
      const { runAutoFillAI } = await import('@/app/api/operator/tours/auto-fill-ai/route');
      const out = await runAutoFillAI(OP, tour);
      const data = (out.body as { data: { filled: number; pending: string | null } }).data;
      expect(out.status).toBe(200);
      expect(data.filled).toBe(4);
      expect(data.pending).toContain('отправлена на проверку');
      const row = (await pool.query(
        `SELECT short_description, included, what_to_bring, difficulty, notes FROM operator_tours WHERE id = $1::bigint`, [tour],
      )).rows[0];
      // Витрина: тексты и сложность прежние; сразу — только служебная заметка.
      expect(row).toEqual({ short_description: null, included: null, what_to_bring: null, difficulty: null, notes: 'Служебная заметка.' });
      expect((await pendingPatch(tour))?.patch).toEqual({
        short_description: 'Короткое описание от модели.', included: ['Трансфер от модели'], what_to_bring: ['Термос оператора'],
        difficulty: 'medium',
      });
    });

    it('массовая смена цен: тур на витрине — на проверку, черновик — сразу, изменённый после предпросмотра — пропущен', async () => {
      const live = await addTour(OP, 'Цены: на витрине', { published: true, price: 10000 });
      const draft = await addTour(OP, 'Цены: черновик', { price: 20000 });
      const moved = await addTour(OP, 'Цены: менялась', { published: true, price: 30000 });
      const { createPendingChange, confirmPendingChange } = await import('@/lib/crm/price-change');
      const { transaction } = await import('@/lib/database');
      const row = (id: string, before: number) => ({ tourId: Number(id), title: 'Тур', baseBefore: before, baseAfter: before * 1.1, saturdayBefore: before, saturdayAfter: before, tiersOverride: false });
      const preview = { change: { kind: 'base_price', percent: 10, tourIds: 'all' }, sampleDate: '2026-12-05', tours: [row(live, 10000), row(draft, 20000), row(moved, 30000)] };
      const id = await createPendingChange(pool, OP, preview as never, Date.now());
      await pool.query(`UPDATE operator_tours SET base_price = 31000 WHERE id = $1::bigint`, [moved]);
      const res = await transaction((client) => confirmPendingChange(client, OP, id, USER, Date.now()));
      expect(res).toEqual({ outcome: 'applied', applied: [Number(draft)], pending: [Number(live)], skipped: [Number(moved)] });
      expect((await liveOf(live)).base_price).toBe(10000);
      expect((await pendingPatch(live))?.patch).toEqual({ base_price: 11000 });
      expect((await liveOf(draft)).base_price).toBe(22000);
      expect((await liveOf(moved)).base_price).toBe(31000);
      expect(await pendingPatch(moved)).toBeNull();
    });

    it('ИИ-чат оператора: цена тура на витрине — на проверку, и модель об этом знает', async () => {
      const tour = await addTour(OP, 'ИИ-чат: цена', { published: true, price: 10000 });
      const { getOperatorTools } = await import('@/lib/agents/sdk/operator-tools');
      const tool = getOperatorTools(OP, 'seed-price').find((t) => t.name === 'update_tour_price')!;
      const out = JSON.parse(await tool.execute({ tour_id: tour, new_price: '11000' }));
      expect(out.success).toBe(true);
      expect(out.pending_review).toBe(true);
      expect(out.note).toContain('На витрине пока прежняя версия');
      expect((await liveOf(tour)).base_price).toBe(10000);
      expect((await pendingPatch(tour))?.patch).toEqual({ base_price: 11000 });
    });

    it('ИИ-чат оператора: тур поправили между чтением и записью — конфликт, черновика нет', async () => {
      const tour = await addTour(OP, 'ИИ-чат: конфликт', { published: true, price: 10000 });
      const { getOperatorTools } = await import('@/lib/agents/sdk/operator-tools');
      const tool = getOperatorTools(OP, 'seed-conflict').find((t) => t.name === 'update_tour_price')!;
      tx.before = async () => { await pool.query(`UPDATE operator_tours SET updated_at = NOW() + interval '1 second' WHERE id = $1::bigint`, [tour]); };
      const out = JSON.parse(await tool.execute({ tour_id: tour, new_price: '11000' }));
      expect(out.error).toContain('изменён параллельно');
      expect((await liveOf(tour)).base_price).toBe(10000);
      expect(await pendingPatch(tour)).toBeNull();
    });

    it('ИИ-чат оператора: «опубликуй» — просьба; «сними с публикации» — сразу', async () => {
      const tour = await addTour(OP, 'ИИ-чат: публикация');
      const { getOperatorTools } = await import('@/lib/agents/sdk/operator-tools');
      const publish = getOperatorTools(OP, 'seed-pub-1').find((t) => t.name === 'set_tour_published')!;
      const asked = JSON.parse(await publish.execute({ tour_id: tour, published: true }));
      expect(asked.success).toBe(true);
      expect(asked.is_published).toBe(false);
      expect(asked.pending_review).toBe(true);
      expect(asked.message).toContain('отправлен на проверку');
      expect(await onStorefront(tour)).toBe(false);
      expect(await pendingPatch(tour)).toEqual({ patch: {}, wants_publish: true });

      const shownTour = await addTour(OP, 'ИИ-чат: снять', { published: true });
      const hide = getOperatorTools(OP, 'seed-pub-2').find((t) => t.name === 'set_tour_published')!;
      const hidden = JSON.parse(await hide.execute({ tour_id: shownTour, published: false }));
      expect(hidden).toMatchObject({ success: true, is_published: false, message: 'Тур снят с публикации' });
      expect(hidden.pending_review).toBeUndefined();
      expect(await onStorefront(shownTour)).toBe(false);
    });
  });

  describe('кабинет оператора: форма тура и её двери', () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const openForm = async (id: string) => {
      const { GET } = await import('@/app/api/hub/operator/tours/[id]/route');
      const res = await GET(new NextRequest(`http://localhost/api/hub/operator/tours/${id}`), ctx(id));
      return { status: res.status, body: await res.json() };
    };
    const saveForm = async (id: string, body: unknown) => {
      const { PATCH } = await import('@/app/api/hub/operator/tours/[id]/route');
      const res = await PATCH(new NextRequest(`http://localhost/api/hub/operator/tours/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), ctx(id));
      return { status: res.status, body: await res.json() };
    };
    const asAdmin = async <T,>(fn: () => Promise<T>): Promise<T> => {
      who.userId = ADMIN; who.role = 'admin';
      try { return await fn(); } finally { who.userId = USER; who.role = 'operator'; }
    };
    const waitingPatch = async (tourId: string) => (await pool.query<{ patch: Record<string, unknown> }>(
      `SELECT patch FROM operator_tour_edits WHERE tour_id = $1::bigint AND moderation_status = 'pending'`, [tourId],
    )).rows[0]?.patch ?? null;

    it('владелец: форма показывает его правку, а не витрину; состояние — «на проверке» с диффом', async () => {
      const tour = await addTour(OP, 'Форма: правка на проверке', { published: true, price: 10000 });
      await change(tour, OP, { base_price: 12000 });
      const r = await openForm(tour);
      expect(r.status).toBe(200);
      expect(Number(r.body.data.base_price)).toBe(12000);
      expect(r.body.data.moderation).toMatchObject({ state: 'pending', published: true, direct: false });
      expect(r.body.data.moderation.pending.changes.map((c: { field: string }) => c.field)).toEqual(['base_price']);
      expect(sp(r.body.data.moderation.pending.changes[0].before)).toBe('10 000 ₽');
      // Сохранение формы без правок черновик не стирает: форма прислала те же значения.
      const again = await saveForm(tour, { base_price: 12000 });
      expect(again.status).toBe(200);
      expect(await waitingPatch(tour)).toEqual({ base_price: 12000 });
      expect((await liveOf(tour)).base_price).toBe(10000);
    });

    it('форма целиком: сохранили без правок — черновика нет; поменяли сезон и сложность — на проверку, форма показывает правку', async () => {
      const tour = await addTour(OP, 'Форма: сезон и сложность', { published: true, price: 10000 });
      await pool.query(
        `UPDATE operator_tours
            SET difficulty = 'easy', duration_hours = 8.5, duration_type = 'day', location_name = 'Вулкан Горелый',
                location_type = 'volcano', latitude = 52.558, longitude = 158.03,
                season_start = '2027-06-01', season_end = '2027-09-30'
          WHERE id = $1::bigint`, [tour]);
      // Что шлёт редактор: числа — parseFloat, день — первые десять знаков, как в _EditTourClient.
      const formOf = (t: Record<string, unknown>) => ({
        title: t.title, description: t.description, location_name: t.location_name, location_type: t.location_type,
        latitude: t.latitude == null ? null : parseFloat(String(t.latitude)),
        longitude: t.longitude == null ? null : parseFloat(String(t.longitude)),
        base_price: parseFloat(String(t.base_price)),
        max_participants: Number(t.max_participants),
        duration_hours: t.duration_hours == null ? null : parseFloat(String(t.duration_hours)),
        duration_type: t.duration_type ?? null,
        multi_day_count: t.multi_day_count == null ? null : Number(t.multi_day_count),
        season_start: typeof t.season_start === 'string' ? t.season_start.slice(0, 10) : null,
        season_end: typeof t.season_end === 'string' ? t.season_end.slice(0, 10) : null,
        seasonal_only: t.seasonal_only === true, difficulty: t.difficulty ?? null,
        is_active: t.is_active, photos: t.photos,
      });
      const opened = await openForm(tour);
      expect(opened.status).toBe(200);
      const form = formOf(opened.body.data);
      expect(form).toMatchObject({ season_start: '2027-06-01', duration_hours: 8.5, latitude: 52.558, seasonal_only: false });

      const same = await saveForm(tour, form);
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      // Число мест и «активен» форма пишет сразу при каждом сохранении; на проверку не ушло ничего.
      expect(same.body.pending).toBeNull();
      expect(await waitingPatch(tour)).toBeNull();

      const edited = await saveForm(tour, { ...form, season_start: '2027-06-15', difficulty: 'hard' });
      expect(edited.status).toBe(200);
      expect(edited.body.pending.fields).toEqual(['difficulty', 'season_start']);
      expect(edited.body.pending.notice).toBe('Правка отправлена на проверку (сложность, начало сезона). На витрине пока прежняя версия.');
      expect(await waitingPatch(tour)).toEqual({ difficulty: 'hard', season_start: '2027-06-15' });
      const live = (await pool.query(
        `SELECT difficulty, season_start::text AS season_start FROM operator_tours WHERE id = $1::bigint`, [tour],
      )).rows[0];
      expect(live).toEqual({ difficulty: 'easy', season_start: '2027-06-01' });

      // Форма владельца показывает его правку и дифф словами; повторное сохранение её не стирает.
      const again = await openForm(tour);
      expect(again.body.data.difficulty).toBe('hard');
      expect(String(again.body.data.season_start).slice(0, 10)).toBe('2027-06-15');
      expect(again.body.data.moderation.pending.changes.map((c: { label: string; before: string; after: string }) => [c.label, c.before, c.after])).toEqual([
        ['Сложность', 'Лёгкий', 'Сложный'],
        ['Начало сезона', '1 июня 2027 г.', '15 июня 2027 г.'],
      ]);
      const resaved = await saveForm(tour, formOf(again.body.data));
      expect(resaved.status).toBe(200);
      expect(await waitingPatch(tour)).toEqual({ difficulty: 'hard', season_start: '2027-06-15' });
      // Администратору форма отдаёт версию с сайта.
      const admin = await asAdmin(() => openForm(tour));
      expect(admin.body.data.difficulty).toBe('easy');
    });

    it('владелец: содержание — на проверку и ответ это называет; число мест и скрытие — сразу', async () => {
      const tour = await addTour(OP, 'Форма: сохранение', { published: true, price: 10000 });
      const r = await saveForm(tour, { base_price: 13000, max_participants: 5, is_active: false });
      expect(r.status).toBe(200);
      expect(r.body.pending.fields).toEqual(['base_price']);
      expect(r.body.pending.notice).toBe('Правка отправлена на проверку (цена). На витрине пока прежняя версия.');
      const live = await liveOf(tour);
      expect(live).toMatchObject({ base_price: 10000, max_participants: 5, is_active: false, is_published: true });
    });

    it('владелец: галочка публикации из формы тур не публикует — только просит', async () => {
      const tour = await addTour(OP, 'Форма: публикация');
      const r = await saveForm(tour, { is_published: true });
      expect(r.status).toBe(200);
      expect(r.body.pending.wantsPublish).toBe(true);
      expect((await liveOf(tour)).is_published).toBe(false);
      expect(await onStorefront(tour)).toBe(false);
      expect((await openForm(tour)).body.data.moderation).toMatchObject({ state: 'pending', published: false });
    });

    it('администратор: в форме версия с сайта; его правка пишется напрямую и чужой черновик не применяет', async () => {
      const tour = await addTour(OP, 'Форма: администратор', { published: true, price: 10000 });
      await change(tour, OP, { base_price: 12000 });
      const seen = await asAdmin(() => openForm(tour));
      expect(Number(seen.body.data.base_price)).toBe(10000);
      expect(seen.body.data.moderation).toMatchObject({ direct: true, state: 'pending' });
      const saved = await asAdmin(() => saveForm(tour, { title: 'Форма: имя от администратора' }));
      expect(saved.status).toBe(200);
      expect(saved.body.pending).toBeNull();
      const live = await liveOf(tour);
      expect(live.title).toBe('Форма: имя от администратора');
      expect(live.base_price).toBe(10000);
      expect(await waitingPatch(tour)).toEqual({ base_price: 12000 });
      // Администратор публикует сам — он и есть проверка.
      const draft = await addTour(OP, 'Форма: администратор публикует');
      await asAdmin(() => saveForm(draft, { is_published: true }));
      expect(await onStorefront(draft)).toBe(true);
    });

    it('отзыв правки: свой тур — черновика нет, форма снова показывает витрину; чужой — 404', async () => {
      const tour = await addTour(OP, 'Форма: отзыв', { published: true, price: 10000 });
      await change(tour, OP, { base_price: 12000 });
      const foreign = await addTour(OTHER, 'Форма: чужой отзыв', { published: true, price: 10000 });
      await change(foreign, OTHER, { base_price: 12000 });
      const { DELETE } = await import('@/app/api/hub/operator/tours/[id]/edit/route');
      const del = async (id: string) => (await DELETE(new NextRequest(`http://localhost/api/hub/operator/tours/${id}/edit`, { method: 'DELETE' }), ctx(id))).status;
      expect(await del(foreign)).toBe(404);
      expect(await waitingPatch(foreign)).toEqual({ base_price: 12000 });
      expect(await del(tour)).toBe(200);
      expect(await waitingPatch(tour)).toBeNull();
      const form = await openForm(tour);
      expect(Number(form.body.data.base_price)).toBe(10000);
      expect(form.body.data.moderation.state).toBe('live');
      expect(await del(tour)).toBe(404);
      // Чужой черновик этого теста дальше не нужен: соседние тесты считают правки партнёра OTHER.
      await pool.query(`DELETE FROM operator_tour_edits WHERE tour_id = $1::bigint`, [foreign]);
    });

    it('адрес снимка с чужой схемой дверь не сохраняет: ни в черновик, ни в тур', async () => {
      const { PHOTO_ADDRESS_TEXT } = await import('@/lib/tours/photo-address');
      const tour = await addTour(OP, 'Форма: адрес снимка', { published: true, price: 10000 });
      const before = (await liveOf(tour)).photos;
      for (const body of [
        { photos: ['/images/tours/ok.jpg', 'javascript:alert(1)'] },
        { tour_image: 'data:text/html,<script>alert(1)</script>' },
        { photos: ['java\tscript:alert(1)'] },
      ]) {
        const r = await saveForm(tour, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(JSON.stringify(r.body)).toContain(PHOTO_ADDRESS_TEXT);
      }
      expect(await waitingPatch(tour)).toBeNull();
      expect((await liveOf(tour)).photos).toEqual(before);
      // Ссылка на снимок со своего сайта — обычная правка: черновик, витрина прежняя.
      const ok = await saveForm(tour, { photos: ['https://example.com/photo.jpg'] });
      expect(ok.status).toBe(200);
      expect(await waitingPatch(tour)).toEqual({ photos: ['https://example.com/photo.jpg'] });
      expect((await liveOf(tour)).photos).toEqual(before);
    });

    it('«снимок» с адресом ручки сайта дверь не сохраняет; старый снимок тура форму не запирает (перепроверка 23.11)', async () => {
      const { PHOTO_ADDRESS_TEXT } = await import('@/lib/tours/photo-address');
      const tour = await addTour(OP, 'Форма: путь сайта вместо снимка', { published: true, price: 10000 });
      // У тура — старая запись, которая новому правилу не отвечает: `/a.jpg` не из каталога картинок.
      const before = (await liveOf(tour)).photos as string[];
      expect(before).toEqual(['/a.jpg']);
      // Браузер проверяющего запросил бы такой «снимок» сам, со своей кукой.
      for (const body of [
        { photos: ['/a.jpg', '/api/admin/evo?action=rescue-scan'] },
        { tour_image: '/api/auth/magic?token=abc' },
        { photos: ['//evil.example/a.jpg'] },
        { photos: ['https:evil.example/a.jpg'] },
        { photos: ['/images/../api/admin/evo'] },
        { photos: ['javascript://x y/%0Aalert(1)'] },
      ]) {
        const r = await saveForm(tour, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(JSON.stringify(r.body)).toContain(PHOTO_ADDRESS_TEXT);
      }
      expect(await waitingPatch(tour)).toBeNull();
      expect((await liveOf(tour)).photos).toEqual(before);

      // Форма прислала старый снимок обратно и добавила настоящий — правка принята.
      const added = await saveForm(tour, { photos: ['/a.jpg', '/images/tours/new.jpg'] });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(await waitingPatch(tour)).toEqual({ photos: ['/a.jpg', '/images/tours/new.jpg'] });
      // Снимок из правки на проверке — тоже снимок тура: форма шлёт его обратно без отказа.
      const again = await saveForm(tour, { photos: ['/a.jpg', '/images/tours/new.jpg'], base_price: 11000 });
      expect(again.status).toBe(200);
      expect(await waitingPatch(tour)).toEqual({ photos: ['/a.jpg', '/images/tours/new.jpg'], base_price: 11000 });
      // Администратор той же дверью чужой путь тоже не запишет.
      const admin = await asAdmin(() => saveForm(tour, { photos: ['/api/admin/evo?action=rescue-scan'] }));
      expect(admin.status).toBe(400);
      expect((await liveOf(tour)).photos).toEqual(before);

      // Черновик, который лёг до правила, со старым адресом внутри: форма владельца
      // показывает его снимки и шлёт их обратно — сохранение не запирается.
      const old = await addTour(OP, 'Форма: старый адрес в черновике', { published: true, price: 10000 });
      await change(old, OP, { photos: ['/a.jpg', '/legacy/old.png'] });
      const resaved = await saveForm(old, { photos: ['/a.jpg', '/legacy/old.png'], base_price: 12000 });
      expect(resaved.status, JSON.stringify(resaved.body)).toBe(200);
      expect(await waitingPatch(old)).toEqual({ photos: ['/a.jpg', '/legacy/old.png'], base_price: 12000 });
      // Чужой адрес рядом со старыми всё равно отклонён.
      expect((await saveForm(old, { photos: ['/a.jpg', '/legacy/old.png', '/legacy/new.png'] })).status).toBe(400);
    });

    it('новый тур: «снимок» с адресом ручки сайта не создаётся', async () => {
      const { POST } = await import('@/app/api/hub/operator/tours/route');
      const { PHOTO_ADDRESS_TEXT } = await import('@/lib/tours/photo-address');
      const body = {
        title: 'Новый тур с чужим адресом', location_type: 'volcano', activity_type: 'trekking', location_name: 'Вулкан Горелый',
        base_price: 10000, price_unit: 'per_person', max_participants: 6,
      };
      const count = async () => Number((await pool.query(
        `SELECT COUNT(*)::int AS n FROM operator_tours WHERE operator_id = $1::uuid AND title = $2`, [OP, body.title],
      )).rows[0].n);
      for (const photos of [['/api/admin/evo?action=rescue-scan'], ['photo.jpg'], ['//evil.example/a.jpg']]) {
        const res = await POST(new NextRequest('http://localhost/api/hub/operator/tours', { method: 'POST', body: JSON.stringify({ ...body, photos }) }));
        expect(res.status, JSON.stringify(photos)).toBe(400);
        expect(JSON.stringify(await res.json())).toContain(PHOTO_ADDRESS_TEXT);
      }
      expect(await count()).toBe(0);
    });

    it('чужой тур форма не открывает и не сохраняет', async () => {
      const foreign = await addTour(OTHER, 'Форма: чужой тур', { published: true, price: 10000 });
      expect((await openForm(foreign)).status).toBe(404);
      expect((await saveForm(foreign, { base_price: 1 })).status).toBe(404);
      expect(await waitingPatch(foreign)).toBeNull();
      expect((await liveOf(foreign)).base_price).toBe(10000);
    });
  });

  describe('дверь администратора: очередь и решение', () => {
    const adminGet = async () => {
      const { GET } = await import('@/app/api/admin/moderation/tour-edits/route');
      const res = await GET(new NextRequest('http://localhost/api/admin/moderation/tour-edits'));
      return (await res.json()) as { success: boolean; data: { edits: Array<{ id: string; tourId: string; kind: string; seen: string; changes: Array<{ field: string; before: string; after: string }> }> } };
    };
    const adminPost = async (id: string, body: unknown) => {
      const { POST } = await import('@/app/api/admin/moderation/tour-edits/[id]/route');
      const res = await POST(
        new NextRequest(`http://localhost/api/admin/moderation/tour-edits/${id}`, { method: 'POST', body: JSON.stringify(body) }),
        { params: Promise.resolve({ id }) },
      );
      return { status: res.status, body: await res.json() };
    };

    it('одобрение одним действием: правка на витрине, черновик закрыт; канала нет — запрос не падает', async () => {
      const tour = await addTour(OP, 'Дверь админа: одобрение', { published: true, price: 10000 });
      await change(tour, OP, { base_price: 12500, photos: ['/images/tours/x.jpg'] });
      const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      expect(card.kind).toBe('edit');
      expect(card.changes.map((c) => c.field)).toEqual(['base_price', 'photos']);
      expect(sp(card.changes[0].before)).toBe('10 000 ₽');
      expect(sp(card.changes[0].after)).toBe('12 500 ₽');
      sent.alerts.length = 0;
      pings.tours.length = 0;
      const r = await adminPost(card.id, { action: 'approve', seen: card.seen });
      expect(r.status).toBe(200);
      expect(r.body.message).toBe('«Дверь админа: одобрение»: правка на сайте');
      const live = await liveOf(tour);
      expect(live.base_price).toBe(12500);
      expect(live.photos).toEqual(['/images/tours/x.jpg']);
      expect(live.tour_image).toBe('/images/tours/x.jpg');
      const closed = (await pool.query(
        `SELECT moderation_status, moderated_by::text AS moderated_by, live_before FROM operator_tour_edits WHERE id = $1::uuid`, [card.id],
      )).rows[0];
      expect(closed.moderation_status).toBe('approved');
      expect(closed.moderated_by).toBe(ADMIN);
      expect(Number(closed.live_before.base_price)).toBe(10000);
      expect(closed.live_before.photos).toEqual(['/a.jpg']);
      // У карточки OP нет ни MAX, ни Telegram: сообщение не ушло, решение записано.
      expect(sent.alerts).toHaveLength(0);
      expect(pings.tours).toEqual([tour]);
      // Повторное решение не применяется.
      expect((await adminPost(card.id, { action: 'approve', seen: card.seen })).status).toBe(409);
    });

    it('черновик с адресом, который не снимок, одобрить нельзя — только вернуть (перепроверка 23.11)', async () => {
      const tour = await addTour(OP, 'Дверь админа: чужой адрес в черновике', { published: true, price: 10000 });
      // Черновик лёг мимо роута (до правила двери или другой дверью): в нём путь ручки сайта.
      await change(tour, OP, { photos: ['/a.jpg', '/api/admin/evo?action=rescue-scan'] });
      const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      pings.tours.length = 0;
      const r = await adminPost(card.id, { action: 'approve', seen: card.seen });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('bad_photo');
      expect(r.body.error).toContain('Тур не изменён');
      expect((await liveOf(tour)).photos).toEqual(['/a.jpg']);
      expect(await pendingCount(tour)).toBe(1);
      expect(pings.tours).toEqual([]);
      // Вернуть правку с причиной можно.
      const back = await adminPost(card.id, { action: 'reject', reason: 'Второй адрес — не снимок, загрузите фото.' });
      expect(back.status).toBe(200);
      expect((await liveOf(tour)).photos).toEqual(['/a.jpg']);

      // Старый адрес, уже стоящий у тура, одобрению не мешает: оно его не добавляет.
      await change(tour, OP, { photos: ['/a.jpg', '/images/tours/ok.jpg'] });
      const next = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      expect((await adminPost(next.id, { action: 'approve', seen: next.seen })).status).toBe(200);
      expect((await liveOf(tour)).photos).toEqual(['/a.jpg', '/images/tours/ok.jpg']);
    });

    it('отказ с причиной: витрина прежняя, владельцу — сообщение в его канал без ПД, поисковикам ничего', async () => {
      const tour = await addTour(OP, 'Дверь админа: отказ', { published: true, price: 10000 });
      await change(tour, OP, { base_price: 1 });
      await pool.query(`UPDATE partners SET max_chat_id = 555001 WHERE id = $1`, [OP]);
      const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      sent.alerts.length = 0;
      pings.tours.length = 0;
      const r = await adminPost(card.id, { action: 'reject', reason: 'Цена <ниже> себестоимости' });
      await pool.query(`UPDATE partners SET max_chat_id = NULL WHERE id = $1`, [OP]);
      expect(r.status).toBe(200);
      expect(r.body.message).toBe('«Дверь админа: отказ»: правка отклонена, на сайте прежняя версия');
      expect((await liveOf(tour)).base_price).toBe(10000);
      expect(pings.tours).toEqual([]);
      expect(sent.alerts).toHaveLength(1);
      const alert = sent.alerts[0];
      // Адресно — в привязанный чат владельца (bigint из базы приходит строкой).
      expect(alert.to).toEqual({ maxChatId: '555001', telegramChatId: null });
      expect(alert.text).toBe([
        '<b>Правка тура отклонена</b>',
        '«Дверь админа: отказ»: на сайте прежняя версия (цена).',
        'Причина: Цена &lt;ниже&gt; себестоимости',
        'Исправить и отправить на проверку ещё раз можно в кабинете на сайте.',
      ].join('\n'));
      expect(alert.buttons[0].url).toMatch(/\/hub\/operator\/tours$/);
      // Владелец видит причину в кабинете.
      const { loadOwnTourEdits } = await import('@/lib/tours/moderation-store');
      const own = await loadOwnTourEdits([tour], new Map());
      expect(own?.get(tour)?.rejected?.reason).toBe('Цена <ниже> себестоимости');
    });

    it('новый тур: одобрение ставит публикацию, владельцу — «тур одобрен»', async () => {
      const tour = await addTour(OP, 'Дверь админа: новый тур');
      await change(tour, OP, { is_published: true });
      await pool.query(`UPDATE partners SET max_chat_id = 555001 WHERE id = $1`, [OP]);
      const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      expect(card.kind).toBe('publish');
      sent.alerts.length = 0;
      const r = await adminPost(card.id, { action: 'approve', seen: card.seen });
      await pool.query(`UPDATE partners SET max_chat_id = NULL WHERE id = $1`, [OP]);
      expect(r.body.message).toBe('«Дверь админа: новый тур»: тур опубликован');
      expect(await onStorefront(tour)).toBe(true);
      expect(sent.alerts[0].text).toBe('<b>Тур одобрен</b>\n«Дверь админа: новый тур»: проверка пройдена, тур опубликован.');
    });

    it('владелец дописал правку после показа карточки — 409, витрина прежняя', async () => {
      const tour = await addTour(OP, 'Дверь админа: устаревшая карточка', { published: true, price: 10000 });
      await change(tour, OP, { base_price: 11000 });
      const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      await change(tour, OP, { base_price: 99000 });
      const r = await adminPost(card.id, { action: 'approve', seen: card.seen });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('changed');
      expect((await liveOf(tour)).base_price).toBe(10000);
    });
  });

  /**
   * Слово владельца 23.11: «Сложность, длительность, место и сезон тоже идут
   * через проверку. От них зависят планер и даты, поэтому без проверки сразу
   * на сайт нельзя». Мок принял бы любое значение; здесь типы колонок —
   * numeric, integer, date, boolean — настоящие, и судит сервер.
   */
  describe('сложность, длительность, место и сезон — через проверку (слово владельца 23.11)', () => {
    const FIELDS_SQL = `SELECT difficulty, duration_hours::float8 AS duration_hours, duration_type, multi_day_count,
            location_name, location_type, latitude::float8 AS latitude, longitude::float8 AS longitude,
            season_start::text AS season_start, season_end::text AS season_end, seasonal_only
       FROM operator_tours WHERE id = $1::bigint`;
    const fieldsOf = async (id: string) => (await pool.query(FIELDS_SQL, [id])).rows[0] as Record<string, unknown>;
    const seed = async (id: string) => pool.query(
      `UPDATE operator_tours
          SET difficulty = 'easy', duration_hours = 8, duration_type = 'day', multi_day_count = NULL,
              location_name = 'Вулкан Горелый', location_type = 'volcano', latitude = 52.558, longitude = 158.03,
              season_start = '2027-06-01', season_end = '2027-09-30', seasonal_only = NULL
        WHERE id = $1::bigint`, [id]);
    const BEFORE = {
      difficulty: 'easy', duration_hours: 8, duration_type: 'day', multi_day_count: null,
      location_name: 'Вулкан Горелый', location_type: 'volcano', latitude: 52.558, longitude: 158.03,
      season_start: '2027-06-01', season_end: '2027-09-30', seasonal_only: null,
    };
    const EDIT = {
      difficulty: 'hard', duration_hours: 30.5, duration_type: 'multi_day', multi_day_count: 3,
      location_name: 'Вулкан Мутновский', location_type: 'hot_spring', latitude: 52.4531, longitude: 158.195,
      season_start: '2027-07-15', season_end: null, seasonal_only: true,
    };
    let tour = '';
    beforeAll(async () => {
      tour = await addTour(OP, 'Поля планера и дат', { published: true });
      await seed(tour);
    });

    it('форма прислала те же значения в своём виде — правки нет, черновика нет', async () => {
      // Число вместо numeric-строки, false вместо «не записано», день строкой.
      const same = await change(tour, OP, { ...BEFORE, seasonal_only: false });
      expect(same.outcome).toBe('unchanged');
      expect(await pendingCount(tour)).toBe(0);
    });

    it('правка всех одиннадцати полей — черновик; витрина, даты и планер читают прежнее', async () => {
      const r = await change(tour, OP, EDIT);
      expect(r.outcome).toBe('pending');
      if (r.outcome !== 'pending') return;
      expect(r.row).toBeNull();
      expect(r.pending.fields).toEqual([
        'difficulty', 'duration_hours', 'duration_type', 'multi_day_count',
        'location_name', 'location_type', 'latitude', 'longitude',
        'season_start', 'season_end', 'seasonal_only',
      ]);
      expect(r.pending.notice).toContain('сложность');
      expect(r.pending.notice).toContain('начало сезона');
      expect(await fieldsOf(tour)).toEqual(BEFORE);
    });

    it('скрыть тур и поменять число мест при этом можно сразу', async () => {
      const r = await change(tour, OP, { is_active: false, max_participants: 5 });
      expect(r.outcome).toBe('written');
      expect((await liveOf(tour)).is_active).toBe(false);
      await change(tour, OP, { is_active: true });
      expect(await pendingCount(tour)).toBe(1);
      expect(await fieldsOf(tour)).toEqual(BEFORE);
    });

    it('очередь администратора: было и стало словами, дата — днём календаря', async () => {
      const edit = (await queue()).find((e) => e.tourId === tour);
      const by = Object.fromEntries((edit?.changes ?? []).map((c) => [c.field, [sp(c.before), sp(c.after)]]));
      expect(by).toEqual({
        difficulty: ['Лёгкий', 'Сложный'],
        duration_hours: ['8', '30,5'],
        duration_type: ['однодневный', 'многодневный'],
        multi_day_count: ['не записано', '3'],
        location_name: ['Вулкан Горелый', 'Вулкан Мутновский'],
        location_type: ['Вулкан', 'Термальный источник'],
        latitude: ['52,558', '52,4531'],
        longitude: ['158,03', '158,195'],
        season_start: ['1 июня 2027 г.', '15 июля 2027 г.'],
        season_end: ['30 сентября 2027 г.', 'не записано'],
        seasonal_only: ['нет', 'да'],
      });
    });

    it('владелец вернул поле к значению витрины — в черновике его нет; вернул всё — черновика нет', async () => {
      const back = await change(tour, OP, { difficulty: 'easy', season_start: '2027-06-01', latitude: 52.558 });
      expect(back.outcome === 'pending' && back.pending.fields).toEqual([
        'duration_hours', 'duration_type', 'multi_day_count', 'location_name', 'location_type', 'longitude',
        'season_end', 'seasonal_only',
      ]);
      const all = await change(tour, OP, { ...BEFORE, seasonal_only: false });
      expect(all.outcome).toBe('unchanged');
      expect(await pendingCount(tour)).toBe(0);
    });

    it('одобрение применяет правку в своих типах: число, целое, дата, отметка и «не записано»', async () => {
      await change(tour, OP, EDIT);
      const edit = (await queue()).find((e) => e.tourId === tour);
      expect(edit).toBeTruthy();
      const done = await decide(edit!.id, 'approve', edit!.seen);
      expect(done.outcome).toBe('approved');
      expect(await fieldsOf(tour)).toEqual(EDIT);
      expect(await pendingCount(tour)).toBe(0);
      // «Что было» записано днём календаря и числами базы, а не объектом времени.
      const before = (await pool.query(
        `SELECT live_before FROM operator_tour_edits WHERE id = $1::uuid`, [edit!.id],
      )).rows[0].live_before as Record<string, unknown>;
      expect(before.season_start).toBe('2027-06-01');
      expect(before.season_end).toBe('2027-09-30');
      expect(before.difficulty).toBe('easy');
      expect(Number(before.duration_hours)).toBe(8);
      expect(before.seasonal_only).toBeNull();
    });

    it('отказ: витрина прежняя, поля названы владельцу', async () => {
      await change(tour, OP, { season_end: '2027-10-31', difficulty: 'expert' });
      const edit = (await queue()).find((e) => e.tourId === tour);
      const done = await decide(edit!.id, 'reject', null, 'Сезон до конца октября не подтверждён расписанием.');
      expect(done).toMatchObject({ outcome: 'rejected', fields: ['difficulty', 'season_end'] });
      expect(await fieldsOf(tour)).toEqual(EDIT);
    });

    it('владелец дописал сезон после показа карточки — одобрение не применяется', async () => {
      await change(tour, OP, { difficulty: 'medium' });
      const shown = (await queue()).find((e) => e.tourId === tour);
      await change(tour, OP, { season_start: '2027-08-01' });
      expect((await decide(shown!.id, 'approve', shown!.seen)).outcome).toBe('changed');
      expect((await fieldsOf(tour)).difficulty).toBe('hard');
      expect((await fieldsOf(tour)).season_start).toBe('2027-07-15');
      const { withdrawTourEdit } = await import('@/lib/tours/moderation-store');
      expect(await withdrawTourEdit(tour, OP)).toBe('withdrawn');
    });

    it('тур не на витрине и без просьбы о проверке правится свободно', async () => {
      const draft = await addTour(OP, 'Черновик с сезоном');
      const r = await change(draft, OP, { difficulty: 'hard', season_start: '2027-06-10', duration_hours: 12, seasonal_only: true });
      expect(r.outcome).toBe('written');
      expect(await fieldsOf(draft)).toMatchObject({ difficulty: 'hard', season_start: '2027-06-10', duration_hours: 12, seasonal_only: true });
      expect(await pendingCount(draft)).toBe(0);
    });

    it('сезон тура на сайте — на проверку; владелец видит свою правку словами', async () => {
      const r = await change(tour, OP, { season_start: '2027-07-20', season_end: '2027-09-10' });
      expect(r.outcome === 'pending' && r.pending.fields).toEqual(['season_start', 'season_end']);
      const { loadOwnTourEdits } = await import('@/lib/tours/moderation-store');
      const edits = await loadOwnTourEdits([tour], new Map([[tour, await fieldsOf(tour)]]));
      expect(edits?.get(tour)?.pending?.changes.map((c) => [c.label, c.before, c.after])).toEqual([
        ['Начало сезона', '15 июля 2027 г.', '20 июля 2027 г.'],
        ['Конец сезона', 'не записано', '10 сентября 2027 г.'],
      ]);
      const { withdrawTourEdit } = await import('@/lib/tours/moderation-store');
      await withdrawTourEdit(tour, OP);
    });

    it('администратор правит напрямую: он и есть проверка', async () => {
      const r = await change(tour, null, { difficulty: 'easy', season_end: '2027-09-30' });
      expect(r.outcome).toBe('written');
      expect(await fieldsOf(tour)).toMatchObject({ difficulty: 'easy', season_end: '2027-09-30' });
      expect(await pendingCount(tour)).toBe(0);
    });
  });

  describe('края', () => {
    it('одобренный тур тестового профиля на витрину не выходит', async () => {
      const tour = await addTour(STAND, 'Тур стенда');
      await change(tour, STAND, { is_published: true });
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      expect((await decide(shown.id, 'approve', shown.seen)).outcome).toBe('approved');
      expect((await liveOf(tour)).is_published).toBe(true);
      expect(await onStorefront(tour)).toBe(false);
    });

    it('тур удалён, пока правка ждала, — применять не к чему', async () => {
      const tour = await addTour(OP, 'Удалят', { published: true });
      await change(tour, OP, { base_price: 1 });
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE id = $1::bigint`, [tour]);
      expect(await decide(shown.id, 'approve', shown.seen)).toEqual({ outcome: 'not_found' });
      expect((await queue()).some((e) => e.tourId === tour)).toBe(false);
    });

    it('чужой ключ в черновике к живой строке не доходит', async () => {
      const tour = await addTour(OP, 'Чужой ключ', { published: true });
      await pool.query(
        `INSERT INTO operator_tour_edits (tour_id, partner_id, patch) VALUES ($1::bigint, $2::uuid, $3::jsonb)`,
        [tour, OP, JSON.stringify({ base_price: 11000, is_active: false, operator_id: OTHER, deleted_at: '2020-01-01' })],
      );
      const shown = (await queue()).find((e) => e.tourId === tour)!;
      expect(shown.changes.map((c) => c.field)).toEqual(['base_price']);
      expect((await decide(shown.id, 'approve', shown.seen)).outcome).toBe('approved');
      const row = (await pool.query(
        `SELECT base_price::float8 AS base_price, is_active, operator_id::text AS operator_id, deleted_at FROM operator_tours WHERE id = $1::bigint`, [tour],
      )).rows[0];
      expect(row).toEqual({ base_price: 11000, is_active: true, operator_id: OP, deleted_at: null });
    });

    it('база не принимает пустой черновик и второй pending на тур', async () => {
      const tour = await addTour(OP, 'Ограничения', { published: true });
      const code = async (sql: string, params: unknown[]) => pool.query(sql, params).then(() => 'ok', (e: { code?: string }) => e.code);
      expect(await code(`INSERT INTO operator_tour_edits (tour_id, partner_id) VALUES ($1::bigint, $2::uuid)`, [tour, OP])).toBe('23514');
      expect(await code(`INSERT INTO operator_tour_edits (tour_id, partner_id, patch) VALUES ($1::bigint, $2::uuid, '[]'::jsonb)`, [tour, OP])).toBe('23514');
      expect(await code(`INSERT INTO operator_tour_edits (tour_id, partner_id, wants_publish) VALUES ($1::bigint, $2::uuid, TRUE)`, [tour, OP])).toBe('ok');
      expect(await code(`INSERT INTO operator_tour_edits (tour_id, partner_id, wants_publish) VALUES ($1::bigint, $2::uuid, TRUE)`, [tour, OP])).toBe('23505');
    });

    it('список туров кабинета несёт метку проверки у каждого тура', async () => {
      const waitingPublish = await addTour(OP, 'Список: ждёт публикации');
      await change(waitingPublish, OP, { is_published: true });
      const waitingEdit = await addTour(OP, 'Список: ждёт правка', { published: true });
      await change(waitingEdit, OP, { base_price: 777 });
      const calm = await addTour(OP, 'Список: спокойный', { published: true });
      const { GET } = await import('@/app/api/hub/operator/tours/route');
      const res = await GET(new NextRequest('http://localhost/api/hub/operator/tours?limit=100&offset=0'));
      const body = await res.json() as { success: boolean; data: Array<{ id: string | number; review: string | null; base_price: string }> };
      expect(res.status).toBe(200);
      const byId = new Map(body.data.map((t) => [String(t.id), t]));
      expect(byId.get(waitingPublish)?.review).toBe('pending_publish');
      expect(byId.get(waitingEdit)?.review).toBe('pending_edit');
      expect(byId.get(calm)?.review).toBeNull();
      // Список показывает витрину: цена — прежняя, пока правку не одобрили.
      expect(Number(byId.get(waitingEdit)?.base_price)).toBe(10000);
    });

    it('чек-лист готовности называет, сколько туров и правок ждёт проверки', async () => {
      const { readPartnerReadiness } = await import('@/lib/partners/readiness-store');
      const mine = await readPartnerReadiness({ partnerId: OP, category: 'operator', viewer: 'owner' });
      const waiting = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM operator_tour_edits WHERE partner_id = $1::uuid AND moderation_status = 'pending'`, [OP]);
      expect(waiting.rows[0].n).toBeGreaterThan(0);
      expect(mine.items.find((i) => i.key === 'content')?.detail).toContain(`на проверке: ${waiting.rows[0].n}`);
      const other = await readPartnerReadiness({ partnerId: OTHER, category: 'operator', viewer: 'owner' });
      expect(other.items.find((i) => i.key === 'content')?.detail).not.toContain('на проверке');
    });

    it('счёт правок на проверке — для чек-листа готовности', async () => {
      const { countPendingTourEdits } = await import('@/lib/tours/moderation-store');
      expect(await countPendingTourEdits(OTHER)).toBe(0);
      expect(await countPendingTourEdits(OP)).toBeGreaterThanOrEqual(1);
    });
  });
});
