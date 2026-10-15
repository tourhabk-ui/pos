/**
 * Измеримость виджетов на настоящем PostgreSQL (аудит 15.10, находка
 * WID-measure): миграция 1282, счёт выдач и открытий, запись «откуда пришёл»
 * в chat_sessions и перепись — запросами, которыми работает прод.
 *
 * Мок ответил бы на любой SQL. Здесь решается то, что статикой не проверить:
 *  - строки без хоста сходятся в одну (UNIQUE NULLS NOT DISTINCT), а не
 *    плодятся по строке на каждую выдачу без Referer;
 *  - у чата served = NULL по построению — CHECK не даёт записать ноль;
 *  - выключенному виджету счёт не заводится;
 *  - происхождение разговора пишется первым сообщением и не переписывается;
 *  - перепись читает и ничего не меняет, slug «fish» не собирает разговоры
 *    «fish_x» (самый длинный подходящий slug);
 *  - заявка формы достаётся ОДНОМУ партнёру: адресату, а по slug — только
 *    без адресата (аудит 15.10, W3-measure: прежнее `operator_id OR slug`
 *    считало заявку с адресатом одного партнёра и slug другого дважды).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from '../helpers/pg-schema';
import {
  recordWidgetServed, recordWidgetOpened, WIDGET_CHAT_SESSION_SQL,
} from '@/lib/embed/widget-telemetry';
import { censusWidgets } from '@/lib/analytics/widget-census';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
const TEST_DB = 'widget_measure_test';
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';

if (!PG_URL) {
  console.warn('[widget-measure] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

withPg('виджеты на настоящем PostgreSQL', () => {
  let pool: Pool;
  let mest = '';
  let fish = '';
  let fishX = '';

  beforeAll(async () => {
    const url = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: url, max: 4 });
    const ins = async (slug: string, enabled: boolean, domains: string[]) => (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, slug, widget_enabled, widget_domains)
       VALUES ($1, 'operator', '{}'::jsonb, $1, $2, $3) RETURNING id::text AS id`,
      [slug, enabled, domains],
    )).rows[0]!.id;
    mest = await ins('wmt-mest', true, ['mestechkokam.ru']);
    fish = await ins('wmt-fish', true, ['fish.ru']);
    fishX = await ins('wmt-fish_x', true, []);
    await ins('wmt-off', false, ['volcanoesland.ru']);
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch((e: unknown) => {
      console.warn('[widget-measure] тестовая база не удалена:', e instanceof Error ? e.message : e);
    });
    await admin.end();
  });

  const rows = async () => (await pool.query(
    `SELECT p.slug, d.host, d.widget, d.served, d.opened
       FROM widget_daily d JOIN partners p ON p.id = d.partner_id
      WHERE p.slug LIKE 'wmt-%'
      ORDER BY p.slug, d.widget, d.host NULLS LAST`,
  )).rows;

  it('выдачи формы: по строке на хост, строки без хоста сходятся в одну; боты не считаются', async () => {
    await recordWidgetServed(pool, mest, 'mestechkokam.ru', BROWSER);
    await recordWidgetServed(pool, mest, 'mestechkokam.ru', BROWSER);
    await recordWidgetServed(pool, mest, null, BROWSER);
    await recordWidgetServed(pool, mest, null, BROWSER);
    await recordWidgetServed(pool, mest, null, 'Mozilla/5.0 (compatible; YandexBot/3.0)');
    expect(await rows()).toEqual([
      { slug: 'wmt-mest', host: 'mestechkokam.ru', widget: 'form', served: 2, opened: 0 },
      { slug: 'wmt-mest', host: null, widget: 'form', served: 2, opened: 0 },
    ]);
  });

  it('открытия: форма — к той же строке; чат — своя строка с served NULL; выключенный виджет не считается', async () => {
    await recordWidgetOpened(pool, 'wmt-mest', 'mestechkokam.ru', 'form');
    await recordWidgetOpened(pool, 'wmt-mest', 'mestechkokam.ru', 'chat');
    await recordWidgetOpened(pool, 'wmt-mest', 'mestechkokam.ru', 'chat');
    await recordWidgetOpened(pool, 'wmt-off', 'volcanoesland.ru', 'chat');
    await recordWidgetOpened(pool, 'wmt-fish', 'copy.example', 'form');
    expect(await rows()).toEqual([
      { slug: 'wmt-fish', host: 'copy.example', widget: 'form', served: 0, opened: 1 },
      { slug: 'wmt-mest', host: 'mestechkokam.ru', widget: 'chat', served: null, opened: 2 },
      { slug: 'wmt-mest', host: 'mestechkokam.ru', widget: 'form', served: 2, opened: 1 },
      { slug: 'wmt-mest', host: null, widget: 'form', served: 2, opened: 0 },
    ]);
  });

  it('у чата ноль выдач записать нельзя — CHECK', async () => {
    await expect(pool.query(
      `INSERT INTO widget_daily (partner_id, day, host, widget, served, opened) VALUES ($1, CURRENT_DATE, 'x.ru', 'chat', 0, 0)`,
      [mest],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('разговор чата: происхождение первого сообщения не переписывается', async () => {
    const first = JSON.stringify({ host: 'mestechkokam.ru', path: '/tury/', host_check: 'listed' });
    const later = JSON.stringify({ host: 'evil.example', path: '/', host_check: 'unlisted' });
    await pool.query(WIDGET_CHAT_SESSION_SQL, ['widget_wmt-mest_w_1', '[]', 1, first]);
    await pool.query(WIDGET_CHAT_SESSION_SQL, ['widget_wmt-mest_w_1', '[]', 2, later]);
    const r = await pool.query(`SELECT widget_origin, user_message_count FROM chat_sessions WHERE session_id = 'widget_wmt-mest_w_1'`);
    expect(r.rows[0]).toEqual({ widget_origin: JSON.parse(first), user_message_count: 2 });
  });

  it('перепись: читает, считает по партнёру и ничего не меняет', async () => {
    await pool.query(WIDGET_CHAT_SESSION_SQL, ['widget_wmt-fish_x_w_9', '[]', 3, JSON.stringify({ host: null, path: null, host_check: 'not_sent' })]);
    await pool.query(WIDGET_CHAT_SESSION_SQL, ['widget_wmt-fish_w_2', '[]', 1, JSON.stringify({ host: 'fish.ru', path: '/', host_check: 'listed' })]);
    await pool.query(
      `INSERT INTO leads (name, phone, status, operator_id, source_data, created_at) VALUES
         ('Иван', '+79000000001', 'new', $1, '{"source":"partner_widget","partner_slug":"wmt-mest","widget_origin":{"host":"mestechkokam.ru","path":"/","host_check":"listed"}}'::jsonb, NOW() - INTERVAL '3 days'),
         ('Пётр', '+79000000002', 'new', $1, '{"source":"partner_widget","partner_slug":"wmt-mest"}'::jsonb, NOW() - INTERVAL '60 days'),
         ('Widget: fish', '', 'new', NULL, '{"type":"widget","partner_id":"wmt-fish","notified_operators":["other-op"]}'::jsonb, NOW() - INTERVAL '5 days'),
         ('Widget: fish', '', 'new', NULL, '{"type":"widget","partner_id":"wmt-fish"}'::jsonb, NOW() - INTERVAL '40 days')`,
      [mest],
    );
    // Адресат — fish, а slug в source_data — mest: заявка только у fish.
    // Адресата нет, slug — mest: заявка у mest (старая форма слала только slug).
    await pool.query(
      `INSERT INTO leads (name, phone, status, operator_id, source_data, created_at) VALUES
         ('Анна', '+79000000003', 'new', $1, '{"source":"partner_widget","partner_slug":"wmt-mest"}'::jsonb, NOW() - INTERVAL '2 days'),
         ('Олег', '+79000000004', 'new', NULL, '{"source":"partner_widget","partner_slug":"wmt-mest"}'::jsonb, NOW() - INTERVAL '10 days')`,
      [fish],
    );
    const before = (await pool.query(`SELECT (SELECT COUNT(*) FROM widget_daily) + (SELECT COUNT(*) FROM chat_sessions) + (SELECT COUNT(*) FROM leads) AS n`)).rows[0].n;

    const r = await censusWidgets(pool);
    expect(r.failed_measures).toEqual([]);
    const by = (slug: string) => r.partners!.find((p) => p.slug === slug)!;
    const mine = r.partners!.map((p) => p.slug).filter((sl) => sl?.startsWith('wmt-'));
    expect(mine).toEqual(['wmt-fish', 'wmt-fish_x', 'wmt-mest']);

    expect(by('wmt-mest').telemetry_30d!.form).toEqual({ served: 4, opened: 1 });
    expect(by('wmt-mest').telemetry_30d!.chat).toEqual({ served: null, opened: 2 });
    expect(by('wmt-fish').telemetry_30d!.by_host).toEqual([
      expect.objectContaining({ host: 'copy.example', host_check: 'unlisted', served: 0, opened: 1 }),
    ]);

    expect(by('wmt-mest').chat_sessions).toMatchObject({ sessions_30d: 1, listed_90d: 1 });
    // slug «fish» не собирает разговоры «fish_x»: разговор достаётся самому
    // длинному подходящему slug.
    expect(by('wmt-fish').chat_sessions).toMatchObject({ sessions_30d: 1, sessions_90d: 1, listed_90d: 1 });
    expect(by('wmt-fish_x').chat_sessions).toMatchObject({ sessions_30d: 1, not_sent_90d: 1 });

    // mest: своя (3 дня, listed), своя (60 дней), без адресата по slug (10 дней).
    // Заявка «Анна» с адресатом fish сюда не входит.
    expect(by('wmt-mest').form_leads).toMatchObject({ leads_30d: 2, leads_90d: 3, listed_90d: 1, origin_not_recorded_90d: 2 });
    expect(by('wmt-fish').form_leads).toMatchObject({ leads_30d: 1, leads_90d: 1, listed_90d: 0, origin_not_recorded_90d: 1 });
    // Каждая заявка формы посчитана ровно один раз.
    const formTotal = r.partners!
      .filter((p) => p.slug?.startsWith('wmt-'))
      .reduce((n, p) => n + (p.form_leads?.leads_90d ?? 0), 0);
    expect(formTotal).toBe(4);
    expect(by('wmt-fish').chat_pseudo_leads).toEqual({ pseudo_30d: 1, pseudo_90d: 2, handed_to_other_operators_90d: 1 });
    expect(by('wmt-mest').chat_pseudo_leads).toEqual({ pseudo_30d: 0, pseudo_90d: 0, handed_to_other_operators_90d: 0 });
    // Выключенный виджет в перепись не входит.
    expect(r.partners!.some((p) => p.slug === 'wmt-off')).toBe(false);

    const after = (await pool.query(`SELECT (SELECT COUNT(*) FROM widget_daily) + (SELECT COUNT(*) FROM chat_sessions) + (SELECT COUNT(*) FROM leads) AS n`)).rows[0].n;
    expect(after).toBe(before);
    expect(fishX).not.toBe('');
  });
});
