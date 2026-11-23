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
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireOperator: vi.fn(async () => ({ userId: 'c4000000-0000-4000-8000-000000000201', role: 'operator' })), // = USER
}));
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
    const { listPendingTourEdits } = await import('@/lib/tours/moderation-store');
    const listed = await listPendingTourEdits();
    if (listed.outcome !== 'ok') throw new Error('очередь не прочитана');
    return listed.edits;
  };
  const decide = async (id: string, action: 'approve' | 'reject', seen: string | null, reason: string | null = null) => {
    const { decideTourEdit } = await import('@/lib/tours/moderation-store');
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
      const r = await change(tour, OP, { base_price: 12000, photos: ['/b.jpg', '/c.jpg'] });
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

    it('скрыть тур, сезон и число мест — сразу, черновик не трогается', async () => {
      const r = await change(tour, OP, { is_active: false, max_participants: 12, season_start: '2027-06-01' });
      expect(r.outcome).toBe('written');
      const live = await liveOf(tour);
      expect(live.is_active).toBe(false);
      expect(live.max_participants).toBe(12);
      expect(live.season_start).toBe('2027-06-01');
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
      expect(edit?.changes[1]).toMatchObject({ beforePhotos: ['/a.jpg'], afterPhotos: ['/b.jpg', '/c.jpg'] });
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
      expect(live.photos).toEqual(['/b.jpg', '/c.jpg']);
      expect(live.tour_image).toBe('/b.jpg');
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

    it('быстрое заполнение: описание тура на витрине — на проверку, сложность — сразу', async () => {
      const tour = await addTour(OP, 'Быстрое заполнение', { published: true });
      const { PATCH } = await import('@/app/api/operator/tours/quick-fill/route');
      const text = await PATCH(post('/api/operator/tours/quick-fill', { tourId: tour, field: 'description', value: 'Новое описание из быстрого заполнения.' }, 'PATCH'));
      const textBody = await text.json();
      expect(text.status).toBe(200);
      expect(textBody.pending).toContain('отправлена на проверку (описание)');
      expect((await liveOf(tour)).description).toBe('Описание тура для проверки модерации правок.');
      expect((await pendingPatch(tour))?.patch).toEqual({ description: 'Новое описание из быстрого заполнения.' });

      const now = await PATCH(post('/api/operator/tours/quick-fill', { tourId: tour, field: 'difficulty', value: 'hard' }, 'PATCH'));
      expect((await now.json()).pending).toBeNull();
      expect((await pool.query(`SELECT difficulty FROM operator_tours WHERE id = $1::bigint`, [tour])).rows[0].difficulty).toBe('hard');
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
      // Витрина: тексты прежние; сложность и служебная заметка — сразу.
      expect(row).toEqual({ short_description: null, included: null, what_to_bring: null, difficulty: 'medium', notes: 'Служебная заметка.' });
      expect((await pendingPatch(tour))?.patch).toEqual({
        short_description: 'Короткое описание от модели.', included: ['Трансфер от модели'], what_to_bring: ['Термос оператора'],
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

    it('счёт правок на проверке — для чек-листа готовности', async () => {
      const { countPendingTourEdits } = await import('@/lib/tours/moderation-store');
      expect(await countPendingTourEdits(OTHER)).toBe(0);
      expect(await countPendingTourEdits(OP)).toBeGreaterThanOrEqual(1);
    });
  });
});
