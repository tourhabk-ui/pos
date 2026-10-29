/**
 * Витрина компаний /operators на настоящем PostgreSQL — находка аудита 15.10
 * PAVEL-operators (жалоба «Местечка Камчатка»: «я там не выделяюсь, у меня
 * основное — вертолётные экскурсии»).
 *
 * Мок ответил бы на любой SQL, поэтому сцена разыгрывается на схеме baseline
 * прода плюс всех миграций. Здесь судится то, что текстом запроса не
 * проверить:
 *
 *   - строка фактов считает только ЖИВЫЕ туры (условие каталога и MCP
 *     get_tours — шлюз витрины publicTourSql): удалённый, выключенный и
 *     неопубликованный тур в число не входят;
 *   - кнопка вида есть, только если у компании списка есть живой тур этого
 *     вида, и число на ней — число компаний списка: тур перевозчика и тур
 *     скрытой компании его не поднимают;
 *   - перевозчик (category = 'transfer') в список «Операторы Камчатки» не
 *     входит ни выдачей, ни счётом (CLAUDE.md §14);
 *   - старая ссылка ?category=fishing через роут даёт список без фильтра;
 *   - карточки, отрисованные из этих данных, показывают строку фактов и
 *     кнопку «Вертолёт» и не показывают перевозчика;
 *   - миграция 1270 меняет обложку Местечка только поверх обложки 1222 и
 *     не трогает обложку «Края Вулканов».
 *
 * Вложенный блок «виджет партнёра» — находка аудита 15.10 WID-config: вторая
 * витрина компании, на её собственном сайте. Отдельным файлом он не заведён
 * намеренно: pg-файлы идут последовательно, и их число держит порог
 * `tests/unit/pg-tests-run-in-ci.test.ts`; предмет тот же — строка partners
 * «Местечка» и её миграции. Что было на проде и что судится — в шапке блока.
 *
 * Своя база `operators_list_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest, NextResponse } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, prefetch: () => {} }),
  usePathname: () => '/operators',
}));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
// PATCH настроек виджета (блок WID-config) зовётся как администратор; прочие
// роуты этого файла проверку прав не зовут.
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireAdmin: vi.fn(async () => ({ userId: 'admin-test', role: 'admin' })),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[operators-list.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'operators_list_test';

const MIG_1270 = readFileSync(join(process.cwd(), 'migrations/1270_mestechko_hero_helicopter.sql'), 'utf-8');
const OLD_HERO = '/images/mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-02.jpg';
const NEW_HERO = '/images/mestechko/kurilskoe-ozero-01.jpg';
const VOLCANOESLAND_HERO = '/images/volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-02.jpg';

const MIG_1280 = readFileSync(join(process.cwd(), 'migrations/1280_mestechko_widget_button_and_form_intro.sql'), 'utf-8');
const MIG_1281 = readFileSync(join(process.cwd(), 'migrations/1281_leads_widget_form_channel.sql'), 'utf-8');
/** Заготовка колонки из 142 — то, что лежит у партнёров, заведённых до 1280. */
const LEGACY_142 = { greeting: 'Привет!', accentColor: '#D44A0C', buttonText: 'Чат', position: 'right' };

const P = {
  heli:    { id: 'a1270000-0000-4000-8000-000000000001', slug: 'test-heli',    name: 'Тест Вертолёты',   category: 'operator', pub: true },
  nolive:  { id: 'a1270000-0000-4000-8000-000000000002', slug: 'test-nolive',  name: 'Тест Без Туров',   category: 'operator', pub: true },
  fish:    { id: 'a1270000-0000-4000-8000-000000000003', slug: 'test-fish',    name: 'Тест Рыбалка',     category: 'operator', pub: true },
  carrier: { id: 'a1270000-0000-4000-8000-000000000004', slug: 'test-carrier', name: 'Тест Перевозчик',  category: 'transfer', pub: true },
  hidden:  { id: 'a1270000-0000-4000-8000-000000000005', slug: 'test-hidden',  name: 'Тест Скрытый',     category: 'operator', pub: false },
} as const;

type Tour = [partner: keyof typeof P, activity: string | null, live: 'live' | 'deleted' | 'inactive' | 'unpublished'];
const TOURS: Tour[] = [
  ['heli', 'helicopter', 'live'], ['heli', 'helicopter', 'live'], ['heli', 'helicopter', 'live'],
  ['heli', 'jeep_safari', 'live'], ['heli', 'jeep_safari', 'live'], ['heli', 'jeep_safari', 'live'],
  ['heli', 'snowmobile', 'live'], ['heli', null, 'live'],
  ['heli', 'helicopter', 'deleted'], ['heli', 'helicopter', 'inactive'], ['heli', 'helicopter', 'unpublished'],
  ['nolive', 'helicopter', 'unpublished'], ['nolive', 'fishing', 'deleted'],
  ['fish', 'fishing', 'live'], ['fish', 'fishing', 'live'],
  ['carrier', 'helicopter', 'live'],
  ['hidden', 'helicopter', 'live'], ['hidden', 'bears', 'live'],
];

withPg('витрина /operators: факты о живых турах, кнопки видов, без перевозчиков (PAVEL-operators)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    // Сцена своя: компании, заведённые миграциями, из списка убираются, чтобы
    // числа на кнопках принадлежали только засеянным строкам.
    await pool.query(`UPDATE partners SET is_public = FALSE`);
    for (const p of Object.values(P)) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, TRUE, 'active')`,
        [p.id, p.name, p.category, p.slug, p.pub],
      );
    }
    let n = 0;
    for (const [who, activity, state] of TOURS) {
      n++;
      await pool.query(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, max_participants,
                                     is_active, is_published, deleted_at)
         VALUES ($1, $2, $3, $4, 1000, 10, $5, $6, CASE WHEN $7 THEN NOW() ELSE NULL END)`,
        [P[who].id, `Тур ${n}`, `test-tour-${n}`, activity, state !== 'inactive', state !== 'unpublished', state === 'deleted'],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  it('список — три компании без перевозчика и скрытой; счёт совпадает', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const r = await queryOperators({ page: 1, limit: 12 });
    expect(r.items.map((i) => i.slug).sort()).toEqual(['test-fish', 'test-heli', 'test-nolive']);
    expect(r.meta.total).toBe(3);
  });

  it('строка фактов — только живые туры, тур без вида в числе, но не в разбивке', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const { tourFactsLine } = await import('@/lib/operators/tour-facts');
    const r = await queryOperators({ page: 1, limit: 12 });
    const by = Object.fromEntries(r.items.map((i) => [i.slug, i.tourFacts]));
    expect(by['test-heli']).toEqual({
      total: 8,
      byActivity: [
        { activity_type: 'helicopter', count: 3 },
        { activity_type: 'jeep_safari', count: 3 },
        { activity_type: 'snowmobile', count: 1 },
      ],
    });
    expect(tourFactsLine(by['test-heli'])).toBe('8 туров · Вертолёт 3 · Джип-сафари 3 · Снегоход 1');
    expect(by['test-nolive']).toEqual({ total: 0, byActivity: [] });
    expect(tourFactsLine(by['test-nolive'])).toBeNull();
    expect(tourFactsLine(by['test-fish'])).toBe('2 тура · Рыбалка 2');
  });

  it('кнопки видов — по живым турам компаний списка; перевозчик и скрытая не поднимают число', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const r = await queryOperators({ page: 1, limit: 12 });
    expect(r.activities).toEqual([
      { activity_type: 'helicopter', count: 1 },
      { activity_type: 'jeep_safari', count: 1 },
      { activity_type: 'fishing', count: 1 },
      { activity_type: 'snowmobile', count: 1 },
    ]);
  });

  it('фильтр «Вертолёт» — только компания с живым вертолётным туром', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const heli = await queryOperators({ page: 1, limit: 12, activity: 'helicopter' });
    expect(heli.items.map((i) => i.slug)).toEqual(['test-heli']);
    expect(heli.meta.total).toBe(1);
    const fish = await queryOperators({ page: 1, limit: 12, activity: 'fishing' });
    expect(fish.items.map((i) => i.slug)).toEqual(['test-fish']);
    const bears = await queryOperators({ page: 1, limit: 12, activity: 'bears' });
    expect(bears.items).toEqual([]);
  });

  it('роут: старая ссылка ?category=fishing — список без фильтра, не пустая выдача', async () => {
    const { GET } = await import('@/app/api/operators/route');
    const res = await GET(new NextRequest('http://localhost/api/operators?category=fishing'));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { slug: string }[]; meta: { total: number }; degraded?: boolean };
    expect(body.degraded).toBeUndefined();
    expect(body.meta.total).toBe(3);
    expect(body.data.map((d) => d.slug)).not.toContain('test-carrier');
  });

  it('карточки из этих данных: строка фактов и «Вертолёт · 1» видны, перевозчика нет', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const { default: OperatorsPageClient } = await import('@/app/operators/_OperatorsClient');
    const r = await queryOperators({ page: 1, limit: 12 });
    const html = renderToStaticMarkup(React.createElement(OperatorsPageClient, {
      initialItems: r.items,
      initialMeta: r.meta,
      initialKey: JSON.stringify({ search: '', activity: '', page: 1 }),
      initialActivities: r.activities,
    }));
    expect(html).toContain('8 туров · Вертолёт 3 · Джип-сафари 3 · Снегоход 1');
    expect(html).toContain('href="/operators?activity=helicopter"');
    expect(html).toContain('Вертолёт · 1');
    expect(html).not.toContain(P.carrier.name);
    expect(html).not.toContain(P.hidden.name);
    expect(html).not.toMatch(/>0 туров/);
  });

  it('кнопка «Операторы» в Telegram: отбор и порядок витрины, счёт всего списка, пауза проката (находка 24.10)', async () => {
    // До 24.10 кнопка брала `partners WHERE is_public LIMIT 10`: прокат, партнёр
    // без адреса (ссылка /operators/null) и перевозчик шли под «Операторы».
    // Свои строки сцены заводятся здесь и убираются в конце: числа витрины
    // остальных тестов не меняются.
    const extra = [
      { id: 'a1270000-0000-4000-8000-000000000006', slug: 'test-cars', name: 'Тест Прокат', category: 'cars' },
      { id: 'a1270000-0000-4000-8000-000000000007', slug: null, name: 'Тест Без Адреса', category: 'operator' },
    ];
    for (const p of extra) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, TRUE, TRUE, 'active')`,
        [p.id, p.name, p.category, p.slug],
      );
    }
    try {
      const { queryOperatorLinks } = await import('@/lib/operators/list-query');
      const all = await queryOperatorLinks(10);
      // По алфавиту, как /operators: «Без Туров», «Вертолёты», «Рыбалка».
      expect(all.items.map((i) => i.slug)).toEqual(['test-nolive', 'test-heli', 'test-fish']);
      expect(all.total).toBe(3);

      const cut = await queryOperatorLinks(2);
      expect(cut.items.map((i) => i.slug)).toEqual(['test-nolive', 'test-heli']);
      expect(cut.total).toBe(3);

      const paused = await queryOperatorLinks(10, ['test-fish']);
      expect(paused.items.map((i) => i.slug)).toEqual(['test-nolive', 'test-heli']);
      expect(paused.total).toBe(2);

      const { touristOperatorsList } = await import('@/lib/telegram/operators-list');
      const text = await touristOperatorsList(new Date('2026-11-01T00:00:00Z'));
      expect(text).toContain('все 3');
      expect(text).toContain('href="https://vedarai.ru/operators/test-heli"');
      for (const name of [P.carrier.name, P.hidden.name, 'Тест Прокат', 'Тест Без Адреса']) {
        expect(text).not.toContain(name);
      }
      expect(text).not.toContain('/operators/null');
    } finally {
      await pool.query(`DELETE FROM partners WHERE id = ANY($1::uuid[])`, [extra.map((p) => p.id)]);
    }
  });

  it('миграция 1270: обложка Местечка — вертолётный кадр, только поверх обложки 1222', async () => {
    const hero = async (slug: string) =>
      (await pool.query<{ hero_image: string | null }>(`SELECT hero_image FROM partners WHERE slug = $1`, [slug])).rows[0]?.hero_image;

    // Цепочка миграций уже прошла: 1222 поставила старую обложку, 1270 сменила.
    expect(await hero('mestechko')).toBe(NEW_HERO);
    expect(await hero('volcanoesland')).toBe(VOLCANOESLAND_HERO);

    // Повторный прогон ничего не меняет.
    expect((await pool.query(MIG_1270)).rowCount).toBe(0);

    // Обложку сменил человек — миграция её не перетирает.
    await pool.query(`UPDATE partners SET hero_image = '/images/mestechko/vertolet-tolbachik-02.jpg' WHERE slug = 'mestechko'`);
    expect((await pool.query(MIG_1270)).rowCount).toBe(0);
    expect(await hero('mestechko')).toBe('/images/mestechko/vertolet-tolbachik-02.jpg');

    // Поверх обложки 1222 — меняет.
    await pool.query(`UPDATE partners SET hero_image = $1 WHERE slug = 'mestechko'`, [OLD_HERO]);
    expect((await pool.query(MIG_1270)).rowCount).toBe(1);
    expect(await hero('mestechko')).toBe(NEW_HERO);
    expect(await hero('volcanoesland')).toBe(VOLCANOESLAND_HERO);

    // Кадр лежит на диске вместе с нарезкой, которую раздаёт карточка.
    for (const f of ['kurilskoe-ozero-01.jpg', 'kurilskoe-ozero-01.640.webp']) {
      expect(existsSync(join(process.cwd(), 'public/images/mestechko', f)), f).toBe(true);
    }
  });
  /**
   * Виджет партнёра на его сайте — находка аудита 15.10 WID-config
   * (карт-бланш владельца 15.10).
   *
   * Что было на проде:
   *   - кнопка формы заявки «Местечка» подписана «Чат» (заготовка DEFAULT
   *     колонки из 142), а над полями формы — приветствие чата «…спрашивайте»;
   *   - PATCH админки заменял widget_config целиком: смена цвета стирала
   *     приветствие, подпись и отступ, поставленные миграциями;
   *   - заявки с формы виджета ложились в канал 'other'.
   *
   * Судится то, что видно только на базе:
   *   - цепочка 1216 → 1260 → 1280 даёт «Местечку» подпись «Заявка на тур» и
   *     вступление формы; lead.js и /api/widget/partner читают ЭТУ строку;
   *   - 1280 не перетирает подпись и вступление, выбранные самим партнёром,
   *     а новым партнёрам заготовку больше не пишет;
   *   - PATCH сливает конфиг: присланный ключ меняется, остальные живут;
   *   - 1281 переводит в 'widget' только заявки формы виджета в 'other'/NULL:
   *     форма страницы оператора (согласие тоже 'widget'), псевдолид чата и
   *     канал, распознанный иначе, не трогаются; второй прогон — ноль строк.
   *
   * База и пул — от внешнего блока. Сцена витрины (все прочие компании
   * скрыты) виджету не мешает: lead.js и /api/widget/partner смотрят на
   * widget_enabled, а не на is_public. Свои партнёры блока заводятся
   * скрытыми, чтобы не поднять числа витрины при любом порядке тестов.
   */
  describe('виджет партнёра: подпись кнопки, вступление формы, слияние настроек, канал заявок (WID-config)', () => {
    const cfg = async (slug: string) =>
      (await pool.query<{ widget_config: Record<string, unknown> | null }>(
        `SELECT widget_config FROM partners WHERE slug = $1`, [slug],
      )).rows[0]?.widget_config ?? null;

    async function leadJsButton(slug: string): Promise<{ status: number; text: string | null; accent: string | null }> {
      const { GET } = await import('@/app/api/widget/lead.js/route');
      const res = await GET(new NextRequest(`https://vedarai.ru/api/widget/lead.js?partner=${slug}`));
      const js = await res.text();
      // Значение подписи — из выданного скрипта, то есть из строки базы через
      // настоящий роут; исполнение скрипта в DOM судит юнит-сторож.
      const text = js.match(/var BTN_TEXT = '([^']*)'/)?.[1] ?? null;
      const accent = js.match(/var ACCENT = '([^']*)'/)?.[1] ?? null;
      return { status: res.status, text, accent };
    }

    it('цепочка миграций: у «Местечка» кнопка «Заявка на тур», своё вступление формы, приветствие чата цело', async () => {
      const c = await cfg('mestechko');
      expect(c).not.toBeNull();
      expect(c!.buttonText).toBe('Заявка на тур');
      expect(String(c!.formIntro)).toContain('«Местечко Камчатка» свяжется с вами');
      expect(String(c!.formIntro)).not.toMatch(/сегодня|в течение|минут|час/);
      expect(String(c!.greeting)).toContain('Я Кузьмич');

      const btn = await leadJsButton('mestechko');
      expect(btn.status).toBe(200);
      expect(btn.text).toBe('Заявка на тур');
      expect(btn.accent).toBe('#006CE4');
    });

    it('/api/widget/partner/mestechko отдаёт форме вступление, а не приветствие чата', async () => {
      const { GET } = await import('@/app/api/widget/partner/[partnerId]/route');
      const res = await GET(new NextRequest('https://vedarai.ru/api/widget/partner/mestechko'),
        { params: Promise.resolve({ partnerId: 'mestechko' }) });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { formIntro: string; greeting: string; accentColor: string } };
      expect(body.data.formIntro).toContain('«Местечко Камчатка» свяжется с вами');
      expect(body.data.formIntro).not.toBe(body.data.greeting);
      expect(body.data.accentColor).toBe('#006CE4');
    });

    it('1280 не перетирает выбор партнёра и повтор ничего не меняет', async () => {
      await pool.query(
        `UPDATE partners SET widget_config = widget_config || '{"buttonText":"Записаться","formIntro":"Пишите — ответим."}'::jsonb
          WHERE slug = 'mestechko'`,
      );
      const before = await cfg('mestechko');
      await pool.query(MIG_1280);
      await pool.query(MIG_1280);
      const after = await cfg('mestechko');
      expect(after).toEqual(before);
      expect(after!.buttonText).toBe('Записаться');
      expect(after!.formIntro).toBe('Пишите — ответим.');

      // Обратно к заготовке — 1280 снова ставит подпись по смыслу.
      await pool.query(
        `UPDATE partners SET widget_config = (widget_config - 'formIntro') || '{"buttonText":"Чат"}'::jsonb
          WHERE slug = 'mestechko'`,
      );
      await pool.query(MIG_1280);
      const fixed = await cfg('mestechko');
      expect(fixed!.buttonText).toBe('Заявка на тур');
      expect(String(fixed!.formIntro)).toContain('«Местечко Камчатка»');
    });

    it('1280 трогает только «Местечко»; новому партнёру заготовка 142 больше не пишется', async () => {
      await pool.query(
        `INSERT INTO partners (name, category, contact, slug, is_public, widget_enabled, widget_config)
         VALUES ('Тест Заготовка', 'operator', '{}'::jsonb, 'test-legacy', FALSE, TRUE, $1::jsonb)`,
        [JSON.stringify(LEGACY_142)],
      );
      await pool.query(MIG_1280);
      expect(await cfg('test-legacy')).toEqual(LEGACY_142);

      await pool.query(
        `INSERT INTO partners (name, category, contact, slug, is_public, widget_enabled)
         VALUES ('Тест Новый', 'operator', '{}'::jsonb, 'test-new', FALSE, TRUE)`,
      );
      expect(await cfg('test-new')).toEqual({});

      // Читатели: заготовка и пустота — «не задано», а не «Чат» и не #D44A0C.
      for (const slug of ['test-legacy', 'test-new']) {
        const btn = await leadJsButton(slug);
        expect(btn.status).toBe(200);
        expect(btn.text).toBe('Заявка на тур');
        expect(btn.accent).toBe('#006CE4');
      }
    });

    it('PATCH админки сливает widget_config: смена цвета не стирает приветствие и подпись', async () => {
      const id = (await pool.query<{ id: string }>(`SELECT id FROM partners WHERE slug = 'mestechko'`)).rows[0].id;
      const before = await cfg('mestechko');
      const { PATCH } = await import('@/app/api/admin/operators/[id]/widget/route');
      const patch = (body: unknown, pid = id) => PATCH(
        new NextRequest(`https://vedarai.ru/api/admin/operators/${pid}/widget`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: pid }) },
      );

      try {
        const res = await patch({ widget_config: { accentColor: '#003466' } });
        expect(res.status).toBe(200);
        const after = await cfg('mestechko');
        expect(after).toEqual({ ...before, accentColor: '#003466' });

        // Тумблер приходит без конфига — конфиг не трогается вовсе.
        expect((await patch({ widget_enabled: true })).status).toBe(200);
        expect(await cfg('mestechko')).toEqual(after);

        // Несуществующий оператор — честный 404, а не «успех».
        const missing = await patch({ widget_enabled: false }, '00000000-0000-4000-8000-0000000000ff');
        expect(missing.status).toBe(404);
        expect(missing).toBeInstanceOf(NextResponse);
      } finally {
        // Свой цвет «Местечку» ставил только этот тест: вернуть строку, чтобы
        // проверки цепочки миграций не зависели от порядка тестов в файле.
        await pool.query(`UPDATE partners SET widget_config = $1::jsonb WHERE id = $2`, [JSON.stringify(before), id]);
      }
    });

    it('1281: в «widget» уходят только заявки формы виджета из other/NULL; повтор — ноль строк', async () => {
      const lead = async (sourceData: Record<string, unknown> | null, channel: string | null, sourceUrl: string | null = null) =>
        (await pool.query<{ id: string }>(
          `INSERT INTO leads (name, phone, source_url, source_data, source_channel)
           VALUES ('Тест', '+70000000000', $1, $2::jsonb, $3) RETURNING id`,
          [sourceUrl, sourceData ? JSON.stringify(sourceData) : null, channel],
        )).rows[0].id;

      const ids = {
        formOther: await lead({ source: 'partner_widget', partner_slug: 'mestechko' }, 'other'),
        formNull: await lead({ source: 'partner_widget', partner_slug: 'fishingkam' }, null),
        formMcp: await lead({ source: 'partner_widget', partner_slug: 'mestechko' }, 'mcp'),
        operatorPage: await lead({ source: 'operator_page', partner_slug: 'mestechko' }, 'site', 'https://vedarai.ru/mestechko'),
        // Тот же partner_slug и согласие 'widget', канал не распознан — всё равно
        // не виджет: признак только source.
        operatorPageOther: await lead({ source: 'operator_page', partner_slug: 'mestechko' }, 'other'),
        chat: await lead({ type: 'widget', partner_id: 'mestechko' }, 'widget'),
        plain: await lead(null, 'other'),
      };
      const channel = async (id: string) =>
        (await pool.query<{ source_channel: string | null }>(`SELECT source_channel FROM leads WHERE id = $1`, [id])).rows[0].source_channel;

      const first = await pool.query(MIG_1281);
      expect(first.rowCount).toBe(2);
      expect(await channel(ids.formOther)).toBe('widget');
      expect(await channel(ids.formNull)).toBe('widget');
      expect(await channel(ids.formMcp)).toBe('mcp');
      expect(await channel(ids.operatorPage)).toBe('site');
      expect(await channel(ids.operatorPageOther)).toBe('other');
      expect(await channel(ids.chat)).toBe('widget');
      expect(await channel(ids.plain)).toBe('other');

      const second = await pool.query(MIG_1281);
      expect(second.rowCount).toBe(0);
    });
  });

  /**
   * Гид Андрей Запорожец (1338, слово владельца 26.10: «проверегный гид»,
   * «Авторскте туры гида», «фото используй с подписью»). Гид — не компания,
   * но свои туры продаёт он сам, поэтому идёт той же витриной: каталог,
   * карточка тура, список компаний. Блок последний в файле: он открывает
   * карточку гида, а счёт списка выше считан без неё.
   *
   * Судится то, что текстом миграции не проверить: на шаблоне (карточки нет)
   * она заводится; импортная скрытая карточка реестра открывается, а не
   * дублируется; две карточки-кандидата — ничего не трогается; повтор — ноль
   * изменений; подпись снимков доходит до карточки тура; телефона нет нигде.
   */
  describe('гид Андрей Запорожец: карточка и авторские туры (1338)', () => {
    const MIG_1338 = readFileSync(join(process.cwd(), 'migrations/1338_guide_zaporozhets_tours.sql'), 'utf-8');
    const SLUG = 'andrey-zaporozhets';
    const guideTours = async (pid: string) => (await pool.query<{ slug: string }>(
      `SELECT slug FROM operator_tours WHERE operator_id = $1::uuid AND deleted_at IS NULL ORDER BY slug`, [pid],
    )).rows.map((r) => r.slug);
    /** Пять туров с описанием гида — на витрине; восемь строк прайса без описания — черновики. */
    const TOUR_SLUGS = [
      'zaporozhets-kanyon-opasnyy-dachnye', 'zaporozhets-kurilskoe-ozero-3-dnya', 'zaporozhets-kurilskoe-ozero-4-dnya',
      'zaporozhets-tolbachik-4-dnya', 'zaporozhets-vulkan-gorelyy',
    ];
    const DRAFT_SLUGS = [
      'zaporozhets-avacha-voskhozhdenie', 'zaporozhets-avachinskiy-pereval-verblyud', 'zaporozhets-bukhta-russkaya',
      'zaporozhets-dachnye-spokoynyy', 'zaporozhets-ganalskie-vostryaki', 'zaporozhets-tolmachevo',
      'zaporozhets-vachkazhets-ozerki', 'zaporozhets-verblyud-plyazh',
    ];
    const ALL_SLUGS = [...TOUR_SLUGS, ...DRAFT_SLUGS].sort();
    const reset = async () => {
      await pool.query(`DELETE FROM operator_tours WHERE slug LIKE 'zaporozhets-%'`);
      await pool.query(`DELETE FROM partners WHERE slug = $1 OR slug LIKE 'vk-guide-zaporozhets%'`, [SLUG]);
    };

    it('на шаблоне карточки нет — миграция её завела: гид, проверен, одобрен, без телефона', async () => {
      const { rows } = await pool.query(
        `SELECT id, name, category, profile_status, is_verified, status, contact, contacts, phone,
                (SELECT count(*)::int FROM jsonb_object_keys(gallery_credits)) AS credits
           FROM partners WHERE slug = $1`, [SLUG],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Андрей Запорожец', category: 'guide', profile_status: 'approved', is_verified: true, status: 'active', credits: 24, phone: null });
      expect(JSON.stringify([rows[0].contact, rows[0].contacts])).not.toMatch(/\d{6,}|phone/);
      expect(await guideTours(rows[0].id)).toEqual(ALL_SLUGS);
    });

    it('туры на витрине: цена за человека, группа до 4, забор с адреса; подпись снимков и ссылка на гида на карточке тура', async () => {
      // Общий beforeAll файла закрыл все карточки; гиду её возвращаем, как на проде после 1338.
      await pool.query(`UPDATE partners SET is_public = TRUE WHERE slug = $1`, [SLUG]);
      const { publicTourSql } = await import('@/lib/tours/public-visibility');
      const live = await pool.query<{ slug: string; base_price: string; price_unit: string; max_participants: number; pickup_type: string; pickup_details: string }>(
        `SELECT ot.slug, ot.base_price, ot.price_unit, ot.max_participants, ot.pickup_type, ot.pickup_details
           FROM operator_tours ot JOIN partners p ON p.id = ot.operator_id
          WHERE p.slug = $1 AND ${publicTourSql('ot')} ORDER BY ot.base_price`, [SLUG],
      );
      expect(live.rows.map((r) => [r.slug, Number(r.base_price)])).toEqual([
        ['zaporozhets-vulkan-gorelyy', 15000], ['zaporozhets-kanyon-opasnyy-dachnye', 18000],
        ['zaporozhets-tolbachik-4-dnya', 85000], ['zaporozhets-kurilskoe-ozero-3-dnya', 95000],
        ['zaporozhets-kurilskoe-ozero-4-dnya', 125000],
      ]);
      for (const r of live.rows) {
        expect(r).toMatchObject({ price_unit: 'per_person', max_participants: 4, pickup_type: 'hotel_pickup' });
        expect(r.pickup_details).toContain('доплату 1 000 ₽');
      }

      const { loadTourCard } = await import('@/lib/tours/tour-detail-query');
      const { tourPhotoCaptions, tourPhotoCreditLine } = await import('@/lib/tours/photo-credits');
      const { operatorPagePath } = await import('@/lib/operators/page-link');
      const card = await loadTourCard('zaporozhets-tolbachik-4-dnya');
      expect(card).not.toBeNull();
      const captions = tourPhotoCaptions(card!.tour.photos ?? [], card!.tour.operator_photo_credits);
      expect(captions).toHaveLength(8);
      expect(captions.every((c) => c === 'Фото: Андрей Запорожец')).toBe(true);
      expect(tourPhotoCreditLine(captions)).toBe('Фото: Андрей Запорожец');
      expect(operatorPagePath({ slug: card!.tour.operator_slug, is_public: card!.tour.operator_public })).toBe('/operators/andrey-zaporozhets');
    });

    it('клипы Курильского (1340): шесть по порядку у обоих туров Курильского, у прочих туров гида — нет; повтор не затирает', async () => {
      const { parseTourClips } = await import('@/lib/tours/tour-clips');
      const BASE = 'https://s3.example/bucket';
      const clipsOf = async (slug: string) => (await pool.query<{ video_clips: unknown }>(
        `SELECT video_clips FROM operator_tours WHERE slug = $1`, [slug],
      )).rows[0]?.video_clips;
      const LABELS = [
        'Медведь поймал рыбу', 'Кутхины Баты: пемзовые столбы', 'Медвежата возятся у коряги',
        'Тюлени на песчаной косе', 'Красная рыба в прозрачной воде', 'Два медведя на галечном берегу',
      ];
      for (const slug of ['zaporozhets-kurilskoe-ozero-3-dnya', 'zaporozhets-kurilskoe-ozero-4-dnya']) {
        const clips = parseTourClips(await clipsOf(slug), BASE);
        expect(clips.map((c) => c.label), slug).toEqual(LABELS);
        expect(clips[0]).toEqual({
          url: `${BASE}/videos/zaporozhets/clip-bear-fish.mp4`,
          poster: `${BASE}/videos/zaporozhets/clip-bear-fish.poster.jpg`,
          label: 'Медведь поймал рыбу',
        });
      }
      for (const slug of ['zaporozhets-tolbachik-4-dnya', 'zaporozhets-vulkan-gorelyy', 'zaporozhets-kanyon-opasnyy-dachnye']) {
        expect(await clipsOf(slug), slug).toEqual([]);
      }
      // Свой выбор гида миграция не трогает: повтор с непустым списком — без изменений.
      const own = [{ key: 'videos/zaporozhets/own.mp4', poster: 'videos/zaporozhets/own.poster.jpg', label: 'Свой клип' }];
      await pool.query(`UPDATE operator_tours SET video_clips = $1::jsonb WHERE slug = 'zaporozhets-kurilskoe-ozero-3-dnya'`, [JSON.stringify(own)]);
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      await pool.query(readFileSync(join(process.cwd(), 'migrations/1340_guide_kurile_lake_clips.sql'), 'utf8'));
      expect(await clipsOf('zaporozhets-kurilskoe-ozero-3-dnya')).toEqual(own);
      expect(parseTourClips(await clipsOf('zaporozhets-kurilskoe-ozero-4-dnya'), BASE)).toHaveLength(6);
    });

    it('выезды гида: Курильское и Толбачик — его даты по 4 места; Горелый — сезон без ежедневных мест; черновики не видны', async () => {
      const { GET } = await import('@/app/api/tours/[id]/slots/route');
      const { NextRequest } = await import('next/server');
      const id = async (slug: string) => (await pool.query<{ id: string }>(`SELECT id::text FROM operator_tours WHERE slug = $1`, [slug])).rows[0].id;
      const slots = async (slug: string) => {
        const tid = await id(slug);
        const res = await GET(new NextRequest(`http://localhost/api/tours/${tid}/slots`), { params: Promise.resolve({ id: tid }) });
        expect(res.status).toBe(200);
        const body = await res.json() as { data?: { date: string; free_slots: number }[]; slots?: { date: string; free_slots: number }[] };
        return (body.data ?? body.slots ?? []).map((s) => [String(s.date).slice(0, 10), s.free_slots]);
      };
      // Окно ответа — от сегодня на год вперёд (база считает по своим часам):
      // ожидание сужается тем же окном, чтобы прошедший выезд не ронял проверку.
      const { rows: [w] } = await pool.query<{ a: string; b: string }>(
        `SELECT CURRENT_DATE::text AS a, (CURRENT_DATE + INTERVAL '1 year')::date::text AS b`,
      );
      const inWindow = (ds: string[]) => ds.filter((d) => d >= w.a && d <= w.b);
      const KURIL = ['2027-07-19', '2027-08-02', '2027-08-16', '2027-08-30', '2027-09-13', '2027-09-27'];
      const TOLB = ['2027-07-26', '2027-08-09', '2027-08-23', '2027-09-06', '2027-09-20'];
      expect(await slots('zaporozhets-kurilskoe-ozero-4-dnya')).toEqual(inWindow(KURIL).map((d) => [d, 4]));
      expect(await slots('zaporozhets-kurilskoe-ozero-3-dnya')).toEqual(inWindow(KURIL).map((d) => [d, 4]));
      expect((await slots('zaporozhets-tolbachik-4-dnya')).map(([d]) => d)).toEqual(inWindow(TOLB));
      // Сами выезды записаны все, независимо от сегодняшней даты.
      const rec = await pool.query<{ slug: string; d: string; n: number }>(
        `SELECT t.slug, a.date::text AS d, a.available_slots AS n FROM tour_availability a
           JOIN operator_tours t ON t.id = a.operator_tour_id WHERE t.slug LIKE 'zaporozhets-%' ORDER BY t.slug, a.date`,
      );
      expect(rec.rows.filter((r) => r.slug === 'zaporozhets-tolbachik-4-dnya').map((r) => r.d)).toEqual(TOLB);
      expect(rec.rows).toHaveLength(17);
      expect(rec.rows.every((r) => r.n === 4)).toBe(true);
      // «Не каждый день будут группы набраны» — ежедневных мест нет, только окно сезона.
      expect(await slots('zaporozhets-vulkan-gorelyy')).toEqual([]);
      const season = await pool.query(`SELECT season_start::text AS s, season_end::text AS e FROM operator_tours WHERE slug = 'zaporozhets-vulkan-gorelyy'`);
      expect(season.rows[0]).toEqual({ s: '2027-07-15', e: '2027-10-15' });

      const { publicTourSql } = await import('@/lib/tours/public-visibility');
      const vis = await pool.query<{ slug: string }>(
        `SELECT slug FROM operator_tours WHERE slug = ANY($1::text[]) AND ${publicTourSql('')}`, [DRAFT_SLUGS],
      );
      expect(vis.rows).toEqual([]);
      const russ = await pool.query(`SELECT base_price::int AS p, season_start::text AS s, pickup_type FROM operator_tours WHERE slug = 'zaporozhets-bukhta-russkaya'`);
      expect(russ.rows[0]).toEqual({ p: 19000, s: '2027-06-01', pickup_type: null });
    });

    it('гид — в списке компаний со строкой фактов о своих турах и на странице гидов', async () => {
      const { queryOperators } = await import('@/lib/operators/list-query');
      const { tourFactsLine } = await import('@/lib/operators/tour-facts');
      const { publicGuideWhere } = await import('@/lib/guides/visibility');
      const r = await queryOperators({ page: 1, limit: 12 });
      const guide = r.items.find((i) => i.slug === SLUG);
      expect(guide).toBeDefined();
      expect(tourFactsLine(guide!.tourFacts)).toMatch(/^5 туров · /);
      const g = await pool.query(`SELECT count(*)::int AS n FROM partners WHERE slug = $1 AND ${publicGuideWhere('partners')}`, [SLUG]);
      expect(g.rows[0].n).toBe(1);
    });

    it('скрытая карточка реестра открывается, а не дублируется; имя реестра остаётся; повтор ничего не меняет', async () => {
      await reset();
      const { rows: [reg] } = await pool.query<{ id: string }>(
        `INSERT INTO partners (slug, company_name, name, category, contact, external_source, is_verified, is_public, status)
         VALUES ('vk-guide-zaporozhets-test', 'Запорожец Андрей Тестович', 'Запорожец Андрей Тестович', 'guide', '{}'::jsonb,
                 'visitkamchatka', FALSE, FALSE, 'pending') RETURNING id`,
      );
      await pool.query(MIG_1338);
      const after = await pool.query(
        `SELECT id, slug, name, is_public, is_verified, profile_status, status, description FROM partners
          WHERE category = 'guide' AND name ILIKE '%запорожец%'`,
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({
        id: reg.id, slug: SLUG, name: 'Запорожец Андрей Тестович',
        is_public: true, is_verified: true, profile_status: 'approved', status: 'active',
      });
      expect(after.rows[0].description).toContain('Авторские туры гида');
      expect(await guideTours(reg.id)).toEqual(ALL_SLUGS);

      await pool.query(MIG_1338);
      expect((await pool.query(`SELECT count(*)::int AS n FROM partners WHERE category = 'guide' AND name ILIKE '%запорожец%'`)).rows[0].n).toBe(1);
      expect(await guideTours(reg.id)).toEqual(ALL_SLUGS);
    });

    it('две карточки-кандидата или отклонённая — ничего не трогается, туров нет', async () => {
      await reset();
      const two = await pool.query<{ id: string }>(
        `INSERT INTO partners (slug, name, category, contact, is_public)
         VALUES ('vk-guide-zaporozhets-a', 'Запорожец Андрей А', 'guide', '{}'::jsonb, FALSE),
                ('vk-guide-zaporozhets-b', 'Андрей Запорожец Б', 'guide', '{}'::jsonb, FALSE) RETURNING id`,
      );
      await pool.query(MIG_1338);
      for (const { id } of two.rows) {
        const p = await pool.query(`SELECT slug, is_public, profile_status FROM partners WHERE id = $1`, [id]);
        expect(p.rows[0].is_public).toBe(false);
        expect(p.rows[0].slug).not.toBe(SLUG);
        expect(await guideTours(id)).toEqual([]);
      }

      await reset();
      const { rows: [rej] } = await pool.query<{ id: string }>(
        `INSERT INTO partners (slug, name, category, contact, is_public, status)
         VALUES ('vk-guide-zaporozhets-r', 'Запорожец Андрей', 'guide', '{}'::jsonb, FALSE, 'rejected') RETURNING id`,
      );
      await pool.query(MIG_1338);
      expect((await pool.query(`SELECT is_public FROM partners WHERE id = $1`, [rej.id])).rows[0].is_public).toBe(false);
      expect(await guideTours(rej.id)).toEqual([]);
    });
  });
});
