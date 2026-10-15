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
 * Своя база `operators_list_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, prefetch: () => {} }),
  usePathname: () => '/operators',
}));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[operators-list.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'operators_list_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = 863;

const MIG_1270 = readFileSync(join(process.cwd(), 'migrations/1270_mestechko_hero_helicopter.sql'), 'utf-8');
const OLD_HERO = '/images/mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-02.jpg';
const NEW_HERO = '/images/mestechko/kurilskoe-ozero-01.jpg';
const VOLCANOESLAND_HERO = '/images/volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-02.jpg';

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

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

withPg('витрина /operators: факты о живых турах, кнопки видов, без перевозчиков (PAVEL-operators)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    await pool.query(
      `DELETE FROM _migrations
        WHERE (regexp_match(name, '^(\\d+)_'))[1]::int >= $1`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

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
});
