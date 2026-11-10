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
 *    robots.txt соблюдается; одинаковый текст не копится;
 *  - отчёт 08.11: выезд сегодняшнего дня по Камчатке и счётчик мест — не
 *    изменение, снятая будущая дата — изменение; что не влезло в одно
 *    сообщение, приходит следующими;
 *  - отчёт 10.11: страница больше потолка чтения — «не смог прочитать», её
 *    обрезок не сохраняется и не сравнивается; снимок, снятый старым чтением
 *    с обрезкой, с первым полным чтением не сравнивается.
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
  calls: [] as Array<{ url: string; ua: string | undefined; limit: number | undefined }>,
  sent: [] as string[],
}));

vi.mock('@/lib/agents/scout-fetch', () => ({
  safeFetchText: async (url: string, opts?: { userAgent?: string; bodyLimit?: number }) => {
    net.calls.push({ url, ua: opts?.userAgent, limit: opts?.bodyLimit });
    const p = net.pages.get(url);
    if (!p) return { ok: false, reason: 'источник ответил 404', status: 404 };
    if (p.status === 0) return { ok: false, reason: 'запрос не прошёл: ECONNRESET' };
    if (p.status !== 200) return { ok: false, reason: `источник ответил ${p.status}`, status: p.status };
    // Как настоящий safeFetchText: тело длиннее потолка отдаётся обрезанным и с признаком.
    const body = p.body ?? '';
    const limit = opts?.bodyLimit ?? 600_000;
    return { ok: true, body: body.slice(0, limit), finalUrl: url, truncated: body.length > limit };
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
  // Запас как у beforeAll: в полном прогоне под нагрузкой снятие базы не укладывалось в 10 с по умолчанию.
  }, 60_000);

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

  // Отчёт 23.10: 24 «изменения» «Местечка Камчатка» — менялись только цифры
  // капчи формы (Contact Form 7, две формы на странице). Прежний снимок
  // записан ещё с капчей: сравнение обязано выбросить её с обеих сторон.
  it('прогон 5 — капча формы сменила цифры, снимок записан с капчей: молчим; цена сменилась — говорим', async () => {
    const quiz = (q: string) =>
      `<p>Защита от роботов: <span class="wpcf7-form-control-wrap"><label><span class="wpcf7-quiz-label">${q}</span> <input type="text" name="quiz-413" /></label></span></p>`;
    const url = 'https://onepage-test.ru';
    const { textHash } = await import('@/lib/partners/site-watch');
    const oldText = 'Зимняя рыбалка\nЦена: 22 000 ₽\nПрограмма на 5 дней\nЗащита от роботов: 3+3=?\nЗащита от роботов: 5+5=?';
    await pool.query(
      `INSERT INTO partner_page_snapshots (partner_id, url, outcome, http_status, text_hash, text, event)
       VALUES ($1::uuid, $2, 'ok', 200, $3, $4, 'changed')`,
      [ONE_PAGE, url, textHash(oldText), oldText],
    );
    net.sent.length = 0;
    net.pages.set(url, { status: 200, body: page('Зимняя рыбалка', '22 000').replace('</body>', `${quiz('1+1=?')}${quiz('4+4=?')}</body>`) });
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');
    await runSiteWatch({ sleep: noSleep });
    const quiet = (await snapshots(url)).at(-1);
    expect(quiet).toMatchObject({ outcome: 'ok', event: 'same', diff: null });
    expect(quiet?.text).not.toContain('Защита от роботов');
    expect(net.sent.join('\n')).not.toContain('Одностраничный Тест');

    net.sent.length = 0;
    net.pages.set(url, { status: 200, body: page('Зимняя рыбалка', '25 000').replace('</body>', `${quiz('2+2=?')}</body>`) });
    await runSiteWatch({ sleep: noSleep });
    expect((await snapshots(url)).at(-1)).toMatchObject({
      event: 'changed', diff: { removed: ['Цена: 22 000 ₽'], added: ['Цена: 25 000 ₽'] },
    });
    expect(net.sent.join('\n')).toContain('стало: Цена: 25 000 ₽');
    expect(net.sent.join('\n')).not.toContain('Защита от роботов');
  });

  // Отчёт 08.11 о «Лагуне»: у каждого тура «изменением» звались выезд, день
  // которого наступил, и счётчик мест, а 14 изменений не влезли в сообщение и
  // были отосланы в таблицу базы. Дата «сегодня» здесь настоящая, по Камчатке:
  // судится и то, что прогон передаёт её в сравнение.
  it('прогон 6 — много изменений приходят несколькими сообщениями; выезд сегодняшнего дня и счётчик мест — тишина; снятая будущая дата — изменение', async () => {
    const { kamchatkaToday } = await import('@/lib/planner/calendar-days');
    const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const [y, m, d] = kamchatkaToday().split('-').map(Number);
    const ru = (offset: number) => {
      const t = new Date(Date.UTC(y, m - 1, d + offset));
      return `${String(t.getUTCDate()).padStart(2, '0')} ${MONTHS_GEN[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
    };
    const dep = (offset: number, seats: number) =>
      `<div>Начало тура</div><div>${ru(offset)},</div><div>в 09:00</div><div>Окончание тура</div>`
      + `<div>${ru(offset)}</div><div>от 9 000 руб.</div><div>Осталось ${seats} мест</div>`;
    const calendar = (...deps: string[]) => `<html><body><h1>Восхождение</h1><p>Программа на 5 дней</p>${deps.join('')}</body></html>`;
    const long = (tag: string) =>
      `<html><body>${Array.from({ length: 8 }, (_, i) => `<p>${tag} ${i} ${'текст '.repeat(40)}</p>`).join('')}</body></html>`;
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');

    // 6а: пять страниц сменились разом — в одно сообщение не влезают.
    net.sent.length = 0;
    net.pages.set('https://krai-test.ru/tours/a/', { status: 200, body: calendar(dep(0, 8), dep(2, 8), dep(3, 8)) });
    net.pages.set('https://www.krai-test.ru', { status: 200, body: long('Край') });
    net.pages.set('https://fish-test.ru', { status: 200, body: long('Рыбалка') });
    net.pages.set('https://managed-test.ru', { status: 200, body: long('Наш сайт') });
    net.pages.set('https://onepage-test.ru', { status: 200, body: long('Одностраничный') });
    const a = await runSiteWatch({ sleep: noSleep });
    expect(a.events).toMatchObject({ changed: 5 });
    expect(a.notified).toEqual({ ok: true });
    expect(net.sent.length).toBeGreaterThan(1);
    expect(net.sent[0]).toMatch(/^<b>Сайты партнёров: изменений — 5<\/b>/);
    for (const msg of net.sent.slice(1)) expect(msg).toMatch(/^<b>Сайты партнёров — продолжение<\/b>/);
    const all = net.sent.join('\n');
    for (const name of ['Край Тест</b> — тур «Восхождение на Ключевскую»', 'Край Тест</b> — главная', 'Рыбалка Тест', 'Наш сайт Тест', 'Одностраничный Тест']) {
      expect(all).toContain(name);
    }
    expect(all).not.toContain('partner_page_snapshots');
    expect(all.split('Наши карточки этих туров могли устареть')).toHaveLength(2);

    // 6б: выезд сегодняшнего дня ушёл с календаря, на другом сменился счётчик мест — молчим.
    net.sent.length = 0;
    net.pages.set('https://krai-test.ru/tours/a/', { status: 200, body: calendar(dep(2, 5), dep(3, 8)) });
    const b = await runSiteWatch({ sleep: noSleep });
    expect(b.notified).toBeNull();
    expect(net.sent).toEqual([]);
    const quiet = (await snapshots('https://krai-test.ru/tours/a/')).at(-1);
    expect(quiet).toMatchObject({ outcome: 'ok', event: 'same', diff: null });
    expect(quiet?.text).not.toContain(`${ru(0)},`);

    // 6в: снят выезд послезавтрашнего дня — это изменение.
    net.pages.set('https://krai-test.ru/tours/a/', { status: 200, body: calendar(dep(2, 5)) });
    await runSiteWatch({ sleep: noSleep });
    expect((await snapshots('https://krai-test.ru/tours/a/')).at(-1)).toMatchObject({
      event: 'changed', diff: { removed: [`${ru(3)},`, ru(3)], added: [] },
    });
    expect(net.sent.join('\n')).toContain(`было: ${ru(3)},`);
  });

  // Отчёт 10.11: страницы туров laguna-expedition.ru выросли до 741 тыс.
  // знаков, чтение обрезало тело на 600 тыс., и хвост страницы ушёл владельцу
  // строками «было: Проживание в спа-отеле…». Признак обрезки не читался.
  it('прогон 7 — страница больше потолка чтения: не сохраняется и не сравнивается; второй день — владельцу «читается не целиком»', async () => {
    const { WATCH_BODY_LIMIT, TEXT_CAP } = await import('@/lib/partners/site-watch');
    const { runSiteWatch, TOO_BIG_FAILURE } = await import('@/lib/partners/site-watch-run');
    const url = 'https://fish-test.ru';
    const rows = async () => (await pool.query<{ outcome: string; event: string; text: string | null; text_hash: string | null; failure: string | null; body_chars: number | null; http_status: number | null }>(
      `SELECT outcome, event, text, text_hash, failure, body_chars, http_status FROM partner_page_snapshots WHERE url = $1 ORDER BY id`, [url],
    )).rows;
    const before = (await rows()).at(-1);
    expect(before).toMatchObject({ outcome: 'ok' });
    const tour = (extra = '') => `<html><body>${Array.from({ length: 8 }, (_, i) => `<p>Рыбалка ${i} ${'текст '.repeat(40)}</p>`).join('')}${extra}</body></html>`;

    // 7а: тело на один знак длиннее потолка — в конце страницы, как у «Лагуны», важные строки.
    const pad = WATCH_BODY_LIMIT + 1 - tour('<script></script><p>Проживание в отеле (3 ночи)</p>').length;
    const giant = tour(`<script>${'x'.repeat(pad)}</script><p>Проживание в отеле (3 ночи)</p>`);
    expect(giant).toHaveLength(WATCH_BODY_LIMIT + 1);
    net.sent.length = 0;
    net.calls.length = 0;
    net.pages.set(url, { status: 200, body: giant });
    const first = await runSiteWatch({ sleep: noSleep });
    // Свой потолок доходит до чтения страниц; robots.txt читается общим.
    expect(net.calls.filter((c) => !c.url.endsWith('/robots.txt')).every((c) => c.limit === WATCH_BODY_LIMIT)).toBe(true);
    expect((await rows()).at(-1)).toEqual({
      outcome: 'failed', event: 'quiet', text: null, text_hash: null, failure: TOO_BIG_FAILURE, body_chars: WATCH_BODY_LIMIT, http_status: 200,
    });
    expect(first.reports.find((r) => r.url === url)).toMatchObject({ outcome: 'failed', event: 'quiet', tooBig: true });
    expect(net.sent.join('\n')).not.toContain('Рыбалка Тест');

    // Второй день: владельцу — словами, что страница не читается целиком.
    net.sent.length = 0;
    const second = await runSiteWatch({ sleep: noSleep });
    expect(second.reports.find((r) => r.url === url)).toMatchObject({ event: 'failing', tooBig: true });
    const told = net.sent.join('\n');
    expect(told).toContain('Рыбалка Тест</b> — главная страница сайта\nстраница второй день не прочитана; сегодня она больше потолка чтения');
    expect(told).not.toContain('не открывается');
    expect(told).not.toContain('было:');

    // Ровно в потолок — читается; текст длиннее своего потолка — тоже «не смог».
    const wordy = `<html><body>${Array.from({ length: 12_000 }, (_, i) => `<p>Пункт программы ${i}</p>`).join('')}</body></html>`;
    expect(wordy.length).toBeLessThan(WATCH_BODY_LIMIT);
    net.pages.set(url, { status: 200, body: wordy });
    await runSiteWatch({ sleep: noSleep });
    const capped = (await rows()).at(-1);
    expect(capped).toMatchObject({ outcome: 'failed', text: null, failure: TOO_BIG_FAILURE, body_chars: wordy.length });
    const { fullPageText } = await import('@/lib/partners/site-watch');
    expect(fullPageText(wordy).length).toBeGreaterThan(TEXT_CAP);

    // 7б: страница снова обычная. Сравнивается с последним ПОЛНЫМ снимком —
    // обрезок точкой сравнения не стал, и «пропавшего» хвоста в разнице нет.
    net.sent.length = 0;
    const normal = tour('<p>Цена: 9 000 ₽</p>');
    net.pages.set(url, { status: 200, body: normal });
    await runSiteWatch({ sleep: noSleep });
    const back = (await rows()).at(-1);
    expect(back).toMatchObject({ outcome: 'ok', event: 'changed', failure: null, body_chars: normal.length });
    expect(back?.text).toContain('Цена: 9 000 ₽');
    expect(net.sent.join('\n')).toContain('стало: Цена: 9 000 ₽');
    expect(net.sent.join('\n')).not.toContain('было:');

    // Ровно в потолок тела — читается целиком.
    const exact = tour(`<script>${'x'.repeat(pad - 1)}</script><p>Проживание в отеле (3 ночи)</p>`).replace('<p>Проживание', '<p>Цена: 9 000 ₽</p><p>Проживание');
    const fit = `${exact.slice(0, -'</body></html>'.length - (exact.length - WATCH_BODY_LIMIT))}</body></html>`;
    expect(fit).toHaveLength(WATCH_BODY_LIMIT);
    net.sent.length = 0;
    net.pages.set(url, { status: 200, body: fit });
    await runSiteWatch({ sleep: noSleep });
    expect((await rows()).at(-1)).toMatchObject({ outcome: 'ok', body_chars: WATCH_BODY_LIMIT });
    net.pages.set(url, { status: 200, body: normal });
    await runSiteWatch({ sleep: noSleep });
  });

  it('прогон 8 — снимок старого чтения с обрезанной страницы: хвост не новость, смена цены в видимой части видна; дальше — обычное сравнение', async () => {
    const { textHash, LEGACY_BODY_LIMIT } = await import('@/lib/partners/site-watch');
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');
    const url = 'https://verified-test.ru';
    const last = async () => (await pool.query<{ outcome: string; event: string; text: string | null; diff: unknown; body_chars: number | null }>(
      `SELECT outcome, event, text, diff, body_chars FROM partner_page_snapshots WHERE url = $1 ORDER BY id DESC LIMIT 1`, [url],
    )).rows[0];
    // Как 10.11 у «Лагуны»: в снимке — страница без хвоста, размер чтения не записан.
    const cutText = 'Проверенный\nЦена: 45 000 ₽\nПрограмма на 4 дня';
    await pool.query(
      `INSERT INTO partner_page_snapshots (partner_id, url, outcome, http_status, text_hash, text, event)
       VALUES ($1::uuid, $2, 'ok', 200, $3, $4, 'changed')`,
      [VERIFIED, url, textHash(cutText), cutText],
    );
    const calendarPage = (price: string) =>
      `<html><body><h1>Проверенный</h1><p>Цена: ${price} ₽</p><p>Программа на 4 дня</p><script>${'x'.repeat(LEGACY_BODY_LIMIT)}</script>`
      + '<p>Проживание в спа-отеле (3 ночи)</p><p>Номер реестровой записи: 000</p></body></html>';
    net.sent.length = 0;
    net.pages.set(url, { status: 200, body: calendarPage('45 000') });
    await runSiteWatch({ sleep: noSleep });
    const base = await last();
    expect(base).toMatchObject({ outcome: 'ok', event: 'baseline', diff: null, body_chars: calendarPage('45 000').length });
    expect(base.text).toContain('Номер реестровой записи: 000');
    expect(net.sent.join('\n')).not.toContain('Проверенный Тест');

    // Размер чтения теперь записан: следующая правка партнёра видна как обычно —
    // и в самом конце страницы тоже: снимок уже полный, хвост у него не «невидимый».
    net.sent.length = 0;
    net.pages.set(url, { status: 200, body: calendarPage('47 000').replace('</body>', '<p>Новое условие отмены</p></body>') });
    await runSiteWatch({ sleep: noSleep });
    expect(await last()).toMatchObject({
      event: 'changed', diff: { removed: ['Цена: 45 000 ₽'], added: ['Цена: 47 000 ₽', 'Новое условие отмены'] },
    });
    expect(net.sent.join('\n')).toContain('Проверенный Тест</b> — главная страница сайта');
    expect(net.sent.join('\n')).toContain('стало: Цена: 47 000 ₽');
    expect(net.sent.join('\n')).toContain('стало: Новое условие отмены');

    // Находка проверки 10.11: первое полное чтение пришлось бы на день акции.
    // Цена сменилась там, куда старое чтение доставало, — владелец это видит,
    // а хвост страницы «появившимся» не называется.
    const promoUrl = 'https://managed-test.ru';
    const promoCut = 'Наш сайт\nЦена: 60 000 ₽\nПрограмма на 4 дня\nПрожи';
    await pool.query(
      `INSERT INTO partner_page_snapshots (partner_id, url, outcome, http_status, text_hash, text, event)
       VALUES ($1::uuid, $2, 'ok', 200, $3, $4, 'changed')`,
      [MANAGED, promoUrl, textHash(promoCut), promoCut],
    );
    net.sent.length = 0;
    net.pages.set(promoUrl, {
      status: 200,
      body: `<html><body><h1>Наш сайт</h1><p>Цена: 54 000 ₽</p><p>Программа на 4 дня</p><script>${'x'.repeat(LEGACY_BODY_LIMIT)}</script>`
        + '<p>Проживание в спа-отеле (3 ночи)</p><p>Номер реестровой записи: 000</p></body></html>',
    });
    await runSiteWatch({ sleep: noSleep });
    const promo = (await pool.query<{ event: string; diff: unknown; body_chars: number | null }>(
      `SELECT event, diff, body_chars FROM partner_page_snapshots WHERE url = $1 ORDER BY id DESC LIMIT 1`, [promoUrl],
    )).rows[0];
    expect(promo).toMatchObject({ event: 'changed', diff: { removed: ['Цена: 60 000 ₽'], added: ['Цена: 54 000 ₽'] } });
    expect(promo.body_chars).toBeGreaterThan(LEGACY_BODY_LIMIT);
    const told = net.sent.join('\n');
    expect(told).toContain('было: Цена: 60 000 ₽');
    expect(told).toContain('стало: Цена: 54 000 ₽');
    expect(told).not.toContain('Проживание');
    expect(told).not.toContain('Номер реестровой записи');
  });

  // Находка проверки 10.11: место вызова legacyReadWasCut не держал ни один
  // прогон — перестановка аргументов и потеря длины текста выживали.
  it('прогон 9 — старый снимок: страница меньше старых потолков сравнивается целиком; текст длиннее старого потолка — по видимой части', async () => {
    const { textHash, LEGACY_TEXT_CAP } = await import('@/lib/partners/site-watch');
    const { runSiteWatch } = await import('@/lib/partners/site-watch-run');
    const legacy = async (partner: string, url: string, text: string) => pool.query(
      `INSERT INTO partner_page_snapshots (partner_id, url, outcome, http_status, text_hash, text, event)
       VALUES ($1::uuid, $2, 'ok', 200, $3, $4, 'changed')`,
      [partner, url, textHash(text), text],
    );
    const last = async (url: string) => (await pool.query<{ event: string; diff: { removed: string[]; added: string[] } | null }>(
      `SELECT event, diff FROM partner_page_snapshots WHERE url = $1 ORDER BY id DESC LIMIT 1`, [url],
    )).rows[0];

    // (1) Тело 100 тыс. знаков — старое чтение его не резало: новая строка в конце страницы — новость.
    const small = 'https://fish-test.ru';
    await legacy(FISH, small, 'Рыбалка\nЦена: 1 000 ₽\nПрограмма');
    net.sent.length = 0;
    net.pages.set(small, {
      status: 200,
      body: `<html><body><h1>Рыбалка</h1><p>Цена: 2 000 ₽</p><p>Программа</p><script>${'x'.repeat(100_000)}</script><p>Новая строка в конце</p></body></html>`,
    });
    await runSiteWatch({ sleep: noSleep });
    expect(await last(small)).toMatchObject({
      event: 'changed', diff: { removed: ['Цена: 1 000 ₽'], added: ['Цена: 2 000 ₽', 'Новая строка в конце'] },
    });
    expect(net.sent.join('\n')).toContain('стало: Новая строка в конце');

    // (2) Тело малое, а текст длиннее старого потолка текста: снимок — его начало,
    // хвост текста — не новость.
    const wordy = 'https://onepage-test.ru';
    const lines = Array.from({ length: 4_000 }, (_, i) => `Пункт программы ${i}`);
    const cut = lines.join('\n').slice(0, LEGACY_TEXT_CAP);
    await legacy(ONE_PAGE, wordy, cut);
    net.sent.length = 0;
    const body = `<html><body>${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>`;
    expect(body.length).toBeLessThan(600_000);
    expect(lines.join('\n').length).toBeGreaterThan(LEGACY_TEXT_CAP);
    net.pages.set(wordy, { status: 200, body });
    await runSiteWatch({ sleep: noSleep });
    expect(await last(wordy)).toMatchObject({ event: 'baseline', diff: null });
    expect(net.sent.join('\n')).not.toContain('Одностраничный Тест');
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
