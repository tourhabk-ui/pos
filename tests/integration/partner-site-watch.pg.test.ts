/**
 * Наблюдение за сайтами партнёров на настоящем PostgreSQL (слово владельца
 * 22.10: «нам нужно проверять сайты партнеров на изменение»; на вопросы —
 * «сообщать мне», «всех с сайтом, сами»).
 *
 * Судится то, что решает база, а мок ответил бы на любой SQL:
 *  - какие страницы под наблюдением: главная партнёра с сайтом (колонка или
 *    contacts, с «www.» и без схемы) и страницы-источники его туров НА
 *    ВИТРИНЕ (шлюз publicTourSql) на его же домене; источник на чужом
 *    домене, неактивный, удалённый и черновой тур, партнёр справочника без
 *    туров и без проверки — мимо;
 *  - три прогона подряд: точка отсчёта со списком владельцу, затем смена цены
 *    («было/стало»), 404 «пропала», отказ сети дважды — «не открывается»;
 *    robots.txt соблюдается; одинаковый текст не копится.
 *
 * Сеть подменена (safeFetchText): чужие сайты из теста не читаются.
 * Своя база `partner_site_watch_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const net = vi.hoisted(() => ({
  pages: new Map<string, { status: number; body?: string }>(),
  calls: [] as Array<{ url: string; ua: string | undefined }>,
  sent: [] as string[],
}));

vi.mock('@/lib/agents/scout-fetch', () => ({
  safeFetchText: async (url: string, opts?: { userAgent?: string }) => {
    net.calls.push({ url, ua: opts?.userAgent });
    const p = net.pages.get(url);
    if (!p) return { ok: false, reason: 'источник ответил 404', status: 404 };
    if (p.status === 0) return { ok: false, reason: 'запрос не прошёл: ECONNRESET' };
    if (p.status !== 200) return { ok: false, reason: `источник ответил ${p.status}`, status: p.status };
    return { ok: true, body: p.body ?? '', finalUrl: url, truncated: false };
  },
}));

vi.mock('@/lib/telegram/admin-notify', () => ({
  notifyOwnerPartnerSites: async (text: string) => { net.sent.push(text); return { ok: true }; },
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[partner-site-watch.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'partner_site_watch_test';

const KRAI = '11111111-1111-4111-8111-111111111111';
const FISH = '22222222-2222-4222-8222-222222222222';
const VERIFIED = '33333333-3333-4333-8333-333333333333';
const DIRECTORY = '44444444-4444-4444-8444-444444444444';
const ARRAY_CONTACTS = '55555555-5555-4555-8555-555555555555';
// Как «Камчатская рыбалка»: туры сверены с одностраничным сайтом (1106), адреса
// страниц у туров нет, отметки «проверен» нет — главная всё равно под наблюдением.
const ONE_PAGE = '66666666-6666-4666-8666-666666666666';
const DRAFT_ONLY = '77777777-7777-4777-8777-777777777777';
// Сайт ведём мы (1312): туров нет, отметки «проверен» нет — читается всё равно.
const MANAGED = '88888888-8888-4888-8888-888888888888';

const page = (title: string, price: string) =>
  `<html><body><h1>${title}</h1><p>Цена: ${price} ₽</p><p>Программа на 5 дней</p><script>t=${Math.random()}</script></body></html>`;

withPg('сайты партнёров: изменения против прошлого раза', () => {
  let pool: import('pg').Pool;
  const noSleep = async () => {};

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    await pool.query('TRUNCATE partners, operator_tours, partner_page_snapshots CASCADE');

    const partner = async (id: string, name: string, cols: { website?: string | null; contacts?: unknown; verified?: boolean }) => {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, contacts, slug, is_public, is_verified, status, website)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3::jsonb, $4, TRUE, $5, 'active', $6)`,
        [id, name, JSON.stringify(cols.contacts ?? {}), `test-${id.slice(0, 4)}`, cols.verified ?? false, cols.website ?? null],
      );
    };
    await partner(KRAI, 'Край Тест', { website: 'https://www.krai-test.ru' });
    await partner(FISH, 'Рыбалка Тест', { contacts: { website: 'fish-test.ru' } });
    await partner(VERIFIED, 'Проверенный Тест', { website: 'https://verified-test.ru', verified: true });
    await partner(DIRECTORY, 'Справочник Тест', { website: 'https://dir-test.ru' });
    await partner(ARRAY_CONTACTS, 'Массив Тест', { contacts: ['+7 900 000-00-00'] });
    await partner(ONE_PAGE, 'Одностраничный Тест', { contacts: { website: 'https://onepage-test.ru' } });
    await partner(DRAFT_ONLY, 'Только черновик Тест', { website: 'https://draft-only-test.ru' });
    await partner(MANAGED, 'Наш сайт Тест', { website: 'https://managed-test.ru' });
    await pool.query('UPDATE partners SET site_managed_by_platform = TRUE WHERE id = $1', [MANAGED]);

    let n = 0;
    const tour = async (op: string, title: string, url: string | null, state: 'live' | 'inactive' | 'deleted' | 'draft' = 'live') => {
      n++;
      await pool.query(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, max_participants,
                                     is_active, is_published, deleted_at, source_url)
         VALUES ($1, $2, $3, 'trekking', 1000, 10, $4, $7, CASE WHEN $5 THEN NOW() ELSE NULL END, $6)`,
        [op, title, `watch-tour-${n}`, state !== 'inactive', state === 'deleted', url, state !== 'draft'],
      );
    };
    await tour(KRAI, 'Восхождение на Ключевскую', 'https://krai-test.ru/tours/a/');
    await tour(KRAI, 'Сплав по Быстрой', 'https://krai-test.ru/tours/b/');
    await tour(KRAI, 'Чужой источник', 'https://visitkamchatka.ru/tours/x');
    await tour(KRAI, 'Снятый тур', 'https://krai-test.ru/tours/old/', 'inactive');
    await tour(KRAI, 'Удалённый тур', 'https://krai-test.ru/tours/gone/', 'deleted');
    await tour(KRAI, 'Черновик', 'https://krai-test.ru/tours/draft/', 'draft');
    await tour(FISH, 'Рыбалка на Жупанове', 'https://fish-test.ru/t/1');
    await tour(ARRAY_CONTACTS, 'Тур без сайта', null);
    await tour(ONE_PAGE, 'Зимняя рыбалка', null);
    await tour(DRAFT_ONLY, 'Ещё не выложен', 'https://draft-only-test.ru/t/', 'draft');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('под наблюдением — главные и страницы туров на витрине на своём домене, и только они', async () => {
    const { watchedPages } = await import('@/lib/partners/site-watch-run');
    const pages = await watchedPages();
    expect(pages.map((p) => p.url).sort()).toEqual([
      'https://fish-test.ru',
      'https://fish-test.ru/t/1',
      'https://krai-test.ru/tours/a/',
      'https://krai-test.ru/tours/b/',
      'https://managed-test.ru',
      'https://onepage-test.ru',
      'https://verified-test.ru',
      'https://www.krai-test.ru',
    ]);
    const a = pages.find((p) => p.url === 'https://krai-test.ru/tours/a/');
    expect(a).toMatchObject({ partnerName: 'Край Тест', tours: ['Восхождение на Ключевскую'], partnerId: KRAI });
    expect(pages.find((p) => p.url === 'https://verified-test.ru')?.tours).toEqual([]);
    expect(pages.find((p) => p.url === 'https://onepage-test.ru')).toMatchObject({ partnerId: ONE_PAGE, tours: [], managedByUs: false });
    expect(pages.find((p) => p.url === 'https://managed-test.ru')).toMatchObject({ partnerId: MANAGED, tours: [], managedByUs: true });
  });

  async function snapshots(url: string) {
    return (await pool.query<{ outcome: string; event: string; text: string | null; diff: { removed: string[]; added: string[] } | null; http_status: number | null }>(
      `SELECT outcome, event, text, diff, http_status FROM partner_page_snapshots WHERE url = $1 ORDER BY id`, [url],
    )).rows;
  }

  it('прогон 1 — точка отсчёта: список владельцу, robots.txt соблюдён, имя своё', async () => {
    net.pages.set('https://krai-test.ru/robots.txt', { status: 200, body: 'User-agent: *\nDisallow: /tours/b/' });
    net.pages.set('https://www.krai-test.ru', { status: 200, body: page('Край Тест', '1') });
    net.pages.set('https://krai-test.ru/tours/a/', { status: 200, body: page('Восхождение', '320 000') });
    net.pages.set('https://krai-test.ru/tours/b/', { status: 200, body: page('Сплав', '90 000') });
    net.pages.set('https://fish-test.ru', { status: 200, body: page('Рыбалка', '1') });
    net.pages.set('https://fish-test.ru/t/1', { status: 200, body: page('Жупанова', '150 000') });
    net.pages.set('https://verified-test.ru', { status: 200, body: page('Проверенный', '1') });
    net.pages.set('https://onepage-test.ru', { status: 200, body: page('Зимняя рыбалка', '22 000') });
    net.pages.set('https://managed-test.ru', { status: 200, body: page('Наш сайт', '20 000') });
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');
    const r = await runSiteWatch({ sleep: noSleep });
    expect(r.pages).toBe(8);
    expect(r.events).toEqual({ baseline: 7, quiet: 1 });
    expect(net.calls.some((c) => c.url === 'https://krai-test.ru/tours/b/')).toBe(false);
    expect(net.calls.every((c) => c.ua?.startsWith('VedarSiteWatch/'))).toBe(true);
    expect((await snapshots('https://krai-test.ru/tours/b/'))[0]).toMatchObject({ outcome: 'robots', text: null });
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]).toContain('наблюдение начато');
    expect(net.sent[0]).toContain('Край Тест — страниц: 3');
    expect(net.sent[0]).toContain('Рыбалка Тест — страниц: 2');
    expect(net.sent[0]).toContain('Одностраничный Тест — страниц: 1\n');
    expect(net.sent[0]).toContain('Наш сайт Тест — страниц: 1 · сайт ведём мы');
    expect(net.sent[0]).not.toContain('Справочник Тест');
    expect(net.sent[0]).not.toContain('Только черновик Тест');
  });

  it('прогон 2 — цена сменилась, страница тура пропала: владельцу «было/стало» и «пропала»', async () => {
    net.sent.length = 0;
    net.pages.set('https://krai-test.ru/tours/a/', { status: 200, body: page('Восхождение', '340 000') });
    net.pages.delete('https://fish-test.ru/t/1');
    net.pages.set('https://verified-test.ru', { status: 0 });
    net.pages.set('https://managed-test.ru', { status: 200, body: page('Наш сайт', '22 000') });
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');
    const r = await runSiteWatch({ sleep: noSleep });
    expect(r.events).toMatchObject({ changed: 2, gone: 1, same: 3, quiet: 2 });
    const a = await snapshots('https://krai-test.ru/tours/a/');
    expect(a[1]).toMatchObject({ outcome: 'ok', event: 'changed', diff: { removed: ['Цена: 320 000 ₽'], added: ['Цена: 340 000 ₽'] } });
    expect(a[1].text).toContain('340 000');
    expect((await snapshots('https://fish-test.ru/t/1'))[1]).toMatchObject({ outcome: 'gone', event: 'gone', http_status: 404 });
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]).toContain('тур «Восхождение на Ключевскую»');
    expect(net.sent[0]).toContain('было: Цена: 320 000 ₽');
    expect(net.sent[0]).toContain('стало: Цена: 340 000 ₽');
    expect(net.sent[0]).toContain('тур «Рыбалка на Жупанове»');
    expect(net.sent[0]).toContain('страница пропала с сайта партнёра (404)');
    expect(net.sent[0]).not.toContain('Проверенный Тест');
    expect(net.sent[0]).toContain('Наш сайт Тест</b> (сайт ведём мы) — главная страница сайта');
    expect(net.sent[0]).toContain('стало: Цена: 22 000 ₽');
    expect(net.sent[0]).toContain('правим мы сами');
    expect(net.sent[0]).toContain('Наши карточки этих туров могли устареть');
  });

  it('прогон 3 — без перемен текст не копится; 404 второй раз молчит; отказ второй день — «не открывается»', async () => {
    net.sent.length = 0;
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');
    const r = await runSiteWatch({ sleep: noSleep });
    expect(r.events).toMatchObject({ same: 5, quiet: 2, failing: 1 });
    const a = await snapshots('https://krai-test.ru/tours/a/');
    expect(a.map((s) => s.event)).toEqual(['baseline', 'changed', 'same']);
    expect(a.map((s) => s.text !== null)).toEqual([true, true, false]);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]).toContain('Проверенный Тест</b> — главная страница сайта');
    expect(net.sent[0]).toContain('не открывается второй день');
    expect(net.sent[0]).not.toContain('Рыбалка на Жупанове');
  });

  it('прогон 4 — тихо: сообщения нет вовсе', async () => {
    net.sent.length = 0;
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');
    const r = await runSiteWatch({ sleep: noSleep });
    expect(r.notified).toBeNull();
    expect(net.sent).toEqual([]);
  });

  it('крон-роут: без секрета — 401; с секретом — ответ с исходами', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/partner-site-watch/route');
    const { NextRequest } = await import('next/server');
    expect((await GET(new NextRequest('http://localhost/x'))).status).toBe(401);
    const res = await GET(new NextRequest('http://localhost/x', { headers: { authorization: 'Bearer test-secret' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, pages: 8 });
  });

  it('1312 отмечает сайт «Камчатской рыбалки» нашим — и только его; повтор ничего не ломает', async () => {
    const FISHINGKAM = '0aaa4f05-b479-418b-9d54-2b909783dfd7';
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, contacts, slug, is_public, status, site_managed_by_platform)
       VALUES ($1, 'Камчатская рыбалка', 'operator', '{}'::jsonb, '{}'::jsonb, 'fishingkam-1312', TRUE, 'active', FALSE)`,
      [FISHINGKAM],
    );
    const sql = readFileSync('migrations/1312_partner_site_managed_by_platform.sql', 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const { rows } = await pool.query<{ id: string; m: boolean }>(
      `SELECT id::text AS id, site_managed_by_platform AS m FROM partners WHERE id::text IN ($1, $2, $3) ORDER BY id`,
      [FISHINGKAM, ONE_PAGE, KRAI],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.m]))).toEqual({ [FISHINGKAM]: true, [ONE_PAGE]: false, [KRAI]: false });
  });
  it('сайт партнёра на его домене (loadPartnerSite): профиль и только живые туры, скрытый партнёр — нет', async () => {
    const { loadPartnerSite } = await import('@/lib/partner-sites/load');
    const site = await loadPartnerSite(KRAI);
    expect(site?.profile.name).toBe('Край Тест');
    expect(site?.profile.id).toBe(KRAI);
    expect(site?.tours.map((t) => t.title).sort()).toEqual(['Восхождение на Ключевскую', 'Сплав по Быстрой', 'Чужой источник']);
    expect(site?.tours[0]).toMatchObject({ base_price: '1000.00', max_participants: 10 });
    expect(await loadPartnerSite('no-such-partner')).toBeNull();
    expect(await loadPartnerSite('99999999-9999-4999-8999-999999999999')).toBeNull();
    await pool.query('UPDATE partners SET is_public = FALSE WHERE id = $1', [DIRECTORY]);
    expect(await loadPartnerSite(DIRECTORY)).toBeNull();
  });
  it('домен из реестра находит своего партнёра по id, какой бы slug у него ни был (22.10: по slug предпросмотр отвечал 404)', async () => {
    const { loadPartnerSite } = await import('@/lib/partner-sites/load');
    const { partnerSiteForHost } = await import('@/lib/partner-sites/registry');
    const fk = partnerSiteForHost('fishingkam.ru');
    expect(fk).not.toBeNull();
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, contacts, slug, is_public, status)
       VALUES ($1, 'Камчатская рыбалка', 'operator', '{}'::jsonb, '{}'::jsonb, 'slug-ne-iz-reestra', TRUE, 'active')
       ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, is_public = TRUE`,
      [fk!.partnerId],
    );
    expect((await loadPartnerSite(fk!.partnerId))?.profile.name).toBe('Камчатская рыбалка');
  });
});
