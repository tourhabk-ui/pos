/**
 * Перепись виджетов GET /api/cron/widget-census (аудит 15.10, находка
 * WID-measure, W6) — вызовом, на моке пула, который пропускает ТОЛЬКО SELECT:
 * перепись, попытавшаяся писать, краснеет здесь же.
 *
 * Держит:
 *  - по каждому партнёру с включённым виджетом — выдачи и открытия по хосту
 *    (хост сверен со списком при чтении), разговоры, заявки, псевдолиды и
 *    ушедшие другим операторам;
 *  - часть, которая не прочиталась, — null у всех партнёров и запись в
 *    failed_measures с SQLSTATE, а не ноль (§4.0) — для КАЖДОЙ из четырёх
 *    частей (аудит 15.10, W3-measure: прежде проверялись две, и нули вместо
 *    null у псевдолидов проходили зелёными);
 *  - проба сайтов: found / not_found / could_not_check, и «не смог» не
 *    выдаётся за «не нашёл»; переадресация на IP, localhost, частную сеть или
 *    не http/https не запрашивается, переходов не больше трёх (W3-measure);
 *  - перед каждым запросом имя разрешается в DNS: частный адрес, порт не
 *    80/443 — не запрашивается; тело главной читается не дальше предела;
 *    домен сверх лимита за прогон назван «не спрошен», а не пропущен;
 *    форма чужого партнёра с общим началом slug — не наша (R-census);
 *  - заметка о served говорит правду о кэше lead.js — по правилам
 *    next.config.js, сопоставленным матчером Next (R-census);
 *  - роут закрыт CRON_SECRET и пробует сайты только по probe_sites=1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  censusWidgets, detectWidgetScripts, probeSite, SITE_PROBE_MAX_REDIRECTS,
  SITE_PROBE_MAX, SITE_PROBE_BODY_LIMIT, CENSUS_NOTES,
  PARTNERS_SQL, TELEMETRY_SQL, CHAT_SESSIONS_SQL, FORM_LEADS_SQL, CHAT_PSEUDO_LEADS_SQL,
  type ResolveLike,
} from '@/lib/analytics/widget-census';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

const MESTECHKO = { id: 'p-mest', slug: 'mestechko', name: 'Местечко Камчатка', widget_domains: ['mestechkokam.ru'] };
const FISHING = { id: 'p-fish', slug: 'fishingkam', name: 'Камчатская рыбалка', widget_domains: ['fishingkam.ru'] };

/** Ответы по запросам; пишущий запрос — ошибка теста, а не ответ. */
type Answers = Map<string, () => unknown[]>;
function readOnlyPool(answers: Answers) {
  const seen: string[] = [];
  const query = vi.fn(async (sql: string) => {
    seen.push(sql);
    // Чтение — SELECT или WITH … SELECT; ни одного пишущего глагола.
    if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|MERGE)\b/i.test(sql)) {
      throw new Error(`перепись пишет: ${sql.slice(0, 80)}`);
    }
    const a = answers.get(sql);
    if (!a) throw new Error(`неожиданный запрос: ${sql.slice(0, 80)}`);
    return { rows: a() };
  });
  return { query, seen };
}

function fullAnswers(): Answers {
  return new Map<string, () => unknown[]>([
    [PARTNERS_SQL, () => [MESTECHKO, FISHING]],
    [TELEMETRY_SQL, () => [
      { partner_id: 'p-fish', host: 'fishingkam.ru', widget: 'form', served: 120, opened: 9, last_day: '2026-10-15' },
      { partner_id: 'p-fish', host: 'www.fishingkam.ru', widget: 'form', served: 4, opened: 1, last_day: '2026-10-14' },
      { partner_id: 'p-fish', host: 'copy.example', widget: 'form', served: 2, opened: 0, last_day: '2026-10-10' },
      { partner_id: 'p-fish', host: null, widget: 'form', served: 3, opened: 0, last_day: '2026-10-12' },
      { partner_id: 'p-mest', host: 'mestechkokam.ru', widget: 'chat', served: null, opened: 5, last_day: '2026-10-15' },
    ]],
    [CHAT_SESSIONS_SQL, () => [
      { partner_id: 'p-mest', sessions_30d: 4, sessions_90d: 6, user_messages_30d: 9, user_messages_90d: 13,
        listed_90d: 3, unlisted_90d: 0, not_sent_90d: 1, origin_not_recorded_90d: 2, last_at: '2026-10-15 10:00:00+00' },
    ]],
    [FORM_LEADS_SQL, () => [
      { partner_id: 'p-fish', leads_30d: 2, leads_90d: 5, self_90d: 1,
        listed_90d: 1, unlisted_90d: 0, not_sent_90d: 0, origin_not_recorded_90d: 4, last_at: '2026-10-14 08:00:00+00' },
    ]],
    [CHAT_PSEUDO_LEADS_SQL, () => [
      { partner_id: 'p-fish', pseudo_30d: 1, pseudo_90d: 3, handed_to_other_operators_90d: 2 },
    ]],
  ]);
}

afterEach(() => { vi.unstubAllGlobals(); });

/** DNS, где у каждого имени — публичный адрес: сеть теста не трогается. */
const publicDns: ResolveLike = async () => [{ address: '93.184.216.34' }];
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
const io = (fetchImpl: FetchFn, resolve: ResolveLike = publicDns) => ({ fetch: fetchImpl, resolve });

describe('перепись: что считается', () => {
  it('выдачи и открытия по хосту, хост сверен со списком; у чата served — null, а не ноль', async () => {
    const { query } = readOnlyPool(fullAnswers());
    const r = await censusWidgets({ query } as never);
    expect(r.failed_measures).toEqual([]);
    const fish = r.partners!.find((p) => p.slug === 'fishingkam')!;
    expect(fish.telemetry_30d!.form).toEqual({ served: 129, opened: 10 });
    expect(fish.telemetry_30d!.by_host.map((h) => [h.host, h.host_check])).toEqual([
      ['fishingkam.ru', 'listed'], ['www.fishingkam.ru', 'listed'], ['copy.example', 'unlisted'], [null, 'not_sent'],
    ]);
    const mest = r.partners!.find((p) => p.slug === 'mestechko')!;
    expect(mest.telemetry_30d!.chat).toEqual({ served: null, opened: 5 });
    expect(mest.telemetry_30d!.by_host[0].served).toBeNull();
  });

  it('разговоры, заявки и псевдолиды; нет строк при прочитанной части — честный ноль', async () => {
    const { query } = readOnlyPool(fullAnswers());
    const r = await censusWidgets({ query } as never);
    const fish = r.partners!.find((p) => p.slug === 'fishingkam')!;
    const mest = r.partners!.find((p) => p.slug === 'mestechko')!;
    expect(fish.form_leads).toMatchObject({ leads_30d: 2, leads_90d: 5, origin_not_recorded_90d: 4 });
    expect(fish.chat_pseudo_leads).toEqual({ pseudo_30d: 1, pseudo_90d: 3, handed_to_other_operators_90d: 2 });
    expect(fish.chat_sessions).toMatchObject({ sessions_30d: 0, sessions_90d: 0 });
    expect(mest.chat_sessions).toMatchObject({ sessions_30d: 4, listed_90d: 3, origin_not_recorded_90d: 2 });
    expect(mest.form_leads).toMatchObject({ leads_30d: 0, leads_90d: 0 });
    expect(r.partners!.every((p) => p.site_probe === undefined)).toBe(true);
  });

  it('все запросы — чтение, и каждой части ровно один', async () => {
    const { query, seen } = readOnlyPool(fullAnswers());
    await censusWidgets({ query } as never);
    expect(seen.sort()).toEqual([PARTNERS_SQL, TELEMETRY_SQL, CHAT_SESSIONS_SQL, FORM_LEADS_SQL, CHAT_PSEUDO_LEADS_SQL].sort());
  });
});

/** Четыре части после списка партнёров: запрос, имя в failed_measures, поле у партнёра. */
const PARTS = [
  { measure: 'widget_daily', sql: TELEMETRY_SQL, field: 'telemetry_30d' },
  { measure: 'chat_sessions', sql: CHAT_SESSIONS_SQL, field: 'chat_sessions' },
  { measure: 'form_leads', sql: FORM_LEADS_SQL, field: 'form_leads' },
  { measure: 'chat_pseudo_leads', sql: CHAT_PSEUDO_LEADS_SQL, field: 'chat_pseudo_leads' },
] as const;

describe('перепись: отказ части', () => {
  // У каждой части есть партнёр со строкой и партнёр без строки: «нет строки
  // при отказе» и «нет строки при прочитанной части» — разные ответы, и
  // отказ не имеет права превратиться ни в чужие нули, ни в свои.
  it.each(PARTS)('$measure не прочиталась — null у обоих партнёров, SQLSTATE названа, прочие части на месте', async ({ measure, sql, field }) => {
    const answers = fullAnswers();
    answers.set(sql, () => { throw Object.assign(new Error('отказ'), { code: '57014' }); });
    const { query } = readOnlyPool(answers);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await censusWidgets({ query } as never);
    err.mockRestore();
    expect(r.failed_measures).toEqual([{ measure, sqlstate: '57014' }]);
    expect(r.partners).toHaveLength(2);
    for (const p of r.partners!) {
      expect(p[field]).toBeNull();
      for (const other of PARTS.filter((x) => x.field !== field)) {
        expect(p[other.field]).not.toBeNull();
      }
    }
  });

  it('две части не прочитались — обе null у всех и обе названы, остальное на месте', async () => {
    const answers = fullAnswers();
    answers.set(CHAT_SESSIONS_SQL, () => { throw Object.assign(new Error('нет колонки'), { code: '42703' }); });
    answers.set(TELEMETRY_SQL, () => { throw Object.assign(new Error('нет таблицы'), { code: '42P01' }); });
    const { query } = readOnlyPool(answers);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await censusWidgets({ query } as never);
    err.mockRestore();
    expect(r.failed_measures).toEqual(expect.arrayContaining([
      { measure: 'chat_sessions', sqlstate: '42703' },
      { measure: 'widget_daily', sqlstate: '42P01' },
    ]));
    expect(r.failed_measures).toHaveLength(2);
    for (const p of r.partners!) {
      expect(p.chat_sessions).toBeNull();
      expect(p.telemetry_30d).toBeNull();
      expect(p.form_leads).not.toBeNull();
    }
  });

  it('список партнёров не прочитался — partners null, остальные части названы невыполненными', async () => {
    const answers = fullAnswers();
    answers.set(PARTNERS_SQL, () => { throw Object.assign(new Error('сеть'), { code: '08006' }); });
    const { query, seen } = readOnlyPool(answers);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await censusWidgets({ query } as never);
    err.mockRestore();
    expect(r.partners).toBeNull();
    expect(r.failed_measures.map((f) => f.measure)).toEqual(['partners', 'widget_daily', 'chat_sessions', 'form_leads', 'chat_pseudo_leads']);
    expect(seen).toEqual([PARTNERS_SQL]);
  });
});

describe('проба сайтов', () => {
  const page = (html: string, status = 200) => new Response(html, { status, headers: { 'content-type': 'text/html' } });

  it('распознаёт форму и чат именно этого партнёра', () => {
    expect(detectWidgetScripts('<script defer src="https://vedarai.ru/api/widget/lead.js?partner=fishingkam"></script>', 'fishingkam')).toEqual(['form']);
    expect(detectWidgetScripts('<script src="https://vedarai.ru/widget/embed.js" data-partner-id="mestechko" defer></script>', 'mestechko')).toEqual(['chat']);
    // Чужой партнёр — не наш скрипт.
    expect(detectWidgetScripts('<script src="https://vedarai.ru/widget/embed.js" data-partner-id="mestechko-2"></script>', 'mestechko')).toEqual([]);
    expect(detectWidgetScripts('<script src="https://vedarai.ru/api/widget/lead.js?partner=mestechko"></script>', 'fishingkam')).toEqual([]);
  });

  it('форма чужого партнёра, чей slug начинается с нашего, — не наша (R-census)', () => {
    // Код вставки — как выдаёт админка: lead.js?partner=<slug>.
    expect(detectWidgetScripts('<script src="https://vedarai.ru/api/widget/lead.js?partner=fishingkam" defer></script>', 'fish')).toEqual([]);
    expect(detectWidgetScripts('<script src="https://vedarai.ru/api/widget/lead.js?partner=mestechko-2" defer></script>', 'mestechko')).toEqual([]);
    expect(detectWidgetScripts("<script src='https://vedarai.ru/api/widget/lead.js?partner=mestechko_x'></script>", 'mestechko')).toEqual([]);
    // Наш — и без кавычек, и с параметрами вокруг, и через &amp; в атрибуте.
    expect(detectWidgetScripts('<script src=https://vedarai.ru/api/widget/lead.js?partner=mestechko defer></script>', 'mestechko')).toEqual(['form']);
    expect(detectWidgetScripts('<script src="https://vedarai.ru/api/widget/lead.js?partner=fish&v=2"></script>', 'fish')).toEqual(['form']);
    expect(detectWidgetScripts('<script src="https://vedarai.ru/api/widget/lead.js?v=2&amp;partner=fish"></script>', 'fish')).toEqual(['form']);
    // Чужой скрипт первым на странице не заслоняет наш.
    expect(detectWidgetScripts(
      '<script src="https://vedarai.ru/api/widget/lead.js?partner=fishingkam"></script><script src="https://vedarai.ru/api/widget/lead.js?partner=fish"></script>',
      'fish',
    )).toEqual(['form']);
  });

  it('три исхода; «не смог» не выдаётся за «не нашёл»', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://fishingkam.ru/') return page('<html><script src="https://vedarai.ru/api/widget/lead.js?partner=fishingkam"></script></html>');
      if (url === 'https://mestechkokam.ru/') return page('<html>Callibri</html>');
      if (url === 'https://blocked.ru/') return page('Forbidden', 403);
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    expect(await probeSite('fishingkam.ru', 'fishingkam', io(fetchImpl))).toMatchObject({ outcome: 'found', scripts: ['form'], http_status: 200 });
    expect(await probeSite('https://mestechkokam.ru/', 'mestechko', io(fetchImpl))).toMatchObject({ outcome: 'not_found', scripts: [] });
    expect(await probeSite('blocked.ru', 'x', io(fetchImpl))).toMatchObject({ outcome: 'could_not_check', http_status: 403 });
    expect(await probeSite('slow.ru', 'x', io(fetchImpl))).toMatchObject({ outcome: 'could_not_check', reason: 'нет ответа за 10 с' });
  });

  it('IP, localhost и мусор в списке не запрашиваются', async () => {
    const fetchImpl = vi.fn();
    // «127.1» и «0x7f.0.0.1» — тот же 127.0.0.1 после разбора адреса.
    for (const d of ['127.0.0.1', '127.1', '0x7f.0.0.1', 'localhost', 'intranet.local', 'nas.home.arpa', 'не домен']) {
      expect((await probeSite(d, 'x', io(fetchImpl as never))).outcome).toBe('could_not_check');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('переадресации (аудит 15.10, W3-measure)', () => {
    const redirect = (status: number, location?: string) =>
      new Response(null, { status, headers: location ? { location } : {} });

    /**
     * Подменный fetch по карте «адрес → ответ». Ведёт себя как настоящий: без
     * `redirect: 'manual'` сам идёт по Location. Поэтому проба, вернувшаяся к
     * `follow`, краснеет тем, что ЗАПРОСИЛА запретный адрес, а не случайно.
     * Неизвестный адрес отвечает 200 со скриптом — «внутренняя машина», куда
     * проба дойти не должна.
     */
    function sites(map: Record<string, () => Response>) {
      const requested: string[] = [];
      const modes: Array<RequestRedirect | undefined> = [];
      const fetchImpl = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
        modes.push(init.redirect);
        let current = url;
        for (let i = 0; i < 20; i += 1) {
          requested.push(current);
          const make = map[current];
          const res = make ? make() : page('<script src="https://vedarai.ru/api/widget/lead.js?partner=x"></script>');
          const loc = res.headers.get('location');
          if (init.redirect === 'manual' || res.status < 300 || res.status > 399 || !loc) return res;
          current = new URL(loc, current).href;
        }
        throw new Error('петля переадресаций в подменном fetch');
      });
      return { fetchImpl, requested, modes };
    }

    it('на IP, localhost, частную сеть и не http/https — не запрашивается, «не смог» с причиной', async () => {
      const targets: Record<string, string> = {
        'https://to-loop.ru/': 'http://127.0.0.1/',
        'https://to-ten.ru/': 'https://10.0.0.5/admin',
        'https://to-lan.ru/': 'http://192.168.1.1/',
        'https://to-meta.ru/': 'http://169.254.169.254/latest/meta-data/',
        'https://to-lh.ru/': 'http://localhost:3000/',
        'https://to-sub-lh.ru/': 'http://api.localhost/',
        'https://to-v6.ru/': 'http://[::1]/',
        'https://to-dec.ru/': 'http://2130706433/',
        'https://to-hex.ru/': 'http://0x7f.0.0.1/',
        'https://to-mdns.ru/': 'http://nas.local/',
        'https://to-ftp.ru/': 'ftp://files.example.ru/',
        // Публичное имя, но порт чужой службы — не главная (R-census).
        'https://to-pg.ru/': 'http://db.example.ru:5432/',
        'https://to-redis.ru/': 'https://cache.example.ru:6379/',
      };
      const { fetchImpl, requested } = sites(Object.fromEntries(
        Object.entries(targets).map(([from, to]) => [from, () => redirect(302, to)]),
      ));
      for (const from of Object.keys(targets)) {
        const r = await probeSite(new URL(from).hostname, 'x', io(fetchImpl));
        expect(r, from).toMatchObject({ outcome: 'could_not_check', http_status: 302, scripts: [] });
        expect(r.reason, from).toMatch(/не запрашивался/);
      }
      // Запрошены только главные доменов из списка — ни одного адреса за переадресацией.
      expect(requested.sort()).toEqual(Object.keys(targets).sort());
    });

    it('в причине отказа — куда вела переадресация, без query и hash', async () => {
      const { fetchImpl } = sites({
        'https://to-q.ru/': () => redirect(302, 'http://10.0.0.5/admin?token=secret123&phone=79001234567#x'),
      });
      const r = await probeSite('to-q.ru', 'x', io(fetchImpl));
      expect(r.reason).toMatch(/не запрашивался: http:\/\/10\.0\.0\.5\/admin$/);
      expect(r.reason).not.toMatch(/token|secret123|79001234567|#x/);
    });

    it('на публичный адрес — идёт, и абсолютный, и относительный; всегда вручную', async () => {
      const { fetchImpl, requested, modes } = sites({
        'https://fishingkam.ru/': () => redirect(301, 'https://www.fishingkam.ru/'),
        'https://www.fishingkam.ru/': () => page('<script src="https://vedarai.ru/api/widget/lead.js?partner=fishingkam"></script>'),
        'https://rel.ru/': () => redirect(302, '/ru/'),
        'https://rel.ru/ru/': () => page('<html>без виджета</html>'),
      });
      expect(await probeSite('fishingkam.ru', 'fishingkam', io(fetchImpl))).toMatchObject({ outcome: 'found', scripts: ['form'], http_status: 200 });
      expect(await probeSite('rel.ru', 'rel', io(fetchImpl))).toMatchObject({ outcome: 'not_found', http_status: 200 });
      expect(requested).toEqual(['https://fishingkam.ru/', 'https://www.fishingkam.ru/', 'https://rel.ru/', 'https://rel.ru/ru/']);
      expect(new Set(modes)).toEqual(new Set(['manual']));
    });

    it(`не больше ${SITE_PROBE_MAX_REDIRECTS} переходов; переадресация без адреса — «не смог»`, async () => {
      const { fetchImpl, requested } = sites({
        'https://chain.ru/': () => redirect(302, '/1'),
        'https://chain.ru/1': () => redirect(302, '/2'),
        'https://chain.ru/2': () => redirect(302, '/3'),
        'https://chain.ru/3': () => redirect(302, '/4'),
        'https://noloc.ru/': () => redirect(302),
      });
      expect(await probeSite('chain.ru', 'x', io(fetchImpl))).toMatchObject({ outcome: 'could_not_check', reason: expect.stringMatching(/больше 3 переадресаций/) });
      expect(requested).toEqual(['https://chain.ru/', 'https://chain.ru/1', 'https://chain.ru/2', 'https://chain.ru/3']);
      expect(await probeSite('noloc.ru', 'x', io(fetchImpl))).toMatchObject({ outcome: 'could_not_check', reason: expect.stringMatching(/без адреса/) });
    });

    describe('DNS перед каждым запросом (аудит 15.10, R-census)', () => {
      /**
       * DNS по карте «имя → адреса»; неизвестное имя — публичный адрес.
       * Спрошенные имена копятся: видно, что DNS спрошен ДО запроса.
       */
      function dns(map: Record<string, string[] | Error>) {
        const asked: string[] = [];
        const resolve: ResolveLike = async (hostname) => {
          asked.push(hostname);
          const v = map[hostname];
          if (v instanceof Error) throw v;
          return (v ?? ['93.184.216.34']).map((address) => ({ address }));
        };
        return { resolve, asked };
      }

      it('переадресация на публичное имя с частным адресом — «не смог» без второго запроса', async () => {
        const inner: Record<string, string> = {
          'http://127.0.0.1.nip.io:80/': '127.0.0.1',
          'http://ten.partner-dns.ru/': '10.0.0.5',
          'http://meta.partner-dns.ru/latest/meta-data/': '169.254.169.254',
          'http://lan.partner-dns.ru/': '192.168.1.10',
          'http://v6.partner-dns.ru/': '::1',
          'http://mapped.partner-dns.ru/': '::ffff:169.254.169.254',
        };
        for (const [to, address] of Object.entries(inner)) {
          const { fetchImpl, requested } = sites({ 'https://mestechkokam.ru/': () => redirect(302, to) });
          const { resolve, asked } = dns({ [new URL(to).hostname]: [address] });
          const r = await probeSite('mestechkokam.ru', 'mestechko', io(fetchImpl, resolve));
          expect(r, to).toMatchObject({ outcome: 'could_not_check', http_status: 302, scripts: [] });
          expect(r.reason, to).toContain(`разрешается в частный адрес ${address}`);
          expect(r.reason, to).toMatch(/не запрашивался/);
          expect(requested, to).toEqual(['https://mestechkokam.ru/']);
          expect(asked, to).toEqual(['mestechkokam.ru', new URL(to).hostname]);
        }
      });

      it('хоть один частный адрес среди публичных — отказ', async () => {
        const { fetchImpl, requested } = sites({ 'https://mestechkokam.ru/': () => redirect(302, 'https://mix.partner-dns.ru/') });
        const { resolve } = dns({ 'mix.partner-dns.ru': ['93.184.216.34', '10.1.2.3'] });
        const r = await probeSite('mestechkokam.ru', 'mestechko', io(fetchImpl, resolve));
        expect(r).toMatchObject({ outcome: 'could_not_check', reason: expect.stringContaining('10.1.2.3') });
        expect(requested).toEqual(['https://mestechkokam.ru/']);
      });

      it('домен из списка с частным адресом не запрашивается вовсе', async () => {
        const fetchImpl = vi.fn();
        const { resolve } = dns({ 'partner.example.ru': ['169.254.169.254'] });
        const r = await probeSite('partner.example.ru', 'x', io(fetchImpl as never, resolve));
        expect(r).toMatchObject({ outcome: 'could_not_check', http_status: null, reason: expect.stringMatching(/частный адрес 169\.254\.169\.254 — не запрашивался/) });
        expect(fetchImpl).not.toHaveBeenCalled();
      });

      it('имя не разрешилось или адресов нет — «не смог», запроса нет', async () => {
        const fetchImpl = vi.fn();
        const { resolve } = dns({
          'gone.ru': Object.assign(new Error('getaddrinfo ENOTFOUND gone.ru'), { code: 'ENOTFOUND' }),
          'empty.ru': [],
        });
        expect(await probeSite('gone.ru', 'x', io(fetchImpl as never, resolve))).toMatchObject({ outcome: 'could_not_check', reason: expect.stringMatching(/не разрешилось \(ENOTFOUND\)/) });
        expect(await probeSite('empty.ru', 'x', io(fetchImpl as never, resolve))).toMatchObject({ outcome: 'could_not_check', reason: expect.stringMatching(/адресов нет/) });
        expect(fetchImpl).not.toHaveBeenCalled();
      });

      it('DNS не ответил в срок — «нет ответа», а не зависание', async () => {
        const fetchImpl = vi.fn();
        const hang: ResolveLike = () => new Promise(() => undefined);
        const r = await probeSite('slow-dns.ru', 'x', io(fetchImpl as never, hang), 50);
        expect(r).toMatchObject({ outcome: 'could_not_check', reason: 'нет ответа за 0 с' });
        expect(fetchImpl).not.toHaveBeenCalled();
      });

      it('публичные адреса по всей цепочке — проба идёт, DNS спрошен перед каждым шагом', async () => {
        const { fetchImpl, requested } = sites({
          'https://fishingkam.ru/': () => redirect(301, 'https://www.fishingkam.ru:443/'),
          'https://www.fishingkam.ru/': () => page('<script src="https://vedarai.ru/api/widget/lead.js?partner=fishingkam"></script>'),
        });
        const { resolve, asked } = dns({});
        expect(await probeSite('fishingkam.ru', 'fishingkam', io(fetchImpl, resolve))).toMatchObject({ outcome: 'found', scripts: ['form'] });
        expect(requested).toEqual(['https://fishingkam.ru/', 'https://www.fishingkam.ru/']);
        expect(asked).toEqual(['fishingkam.ru', 'www.fishingkam.ru']);
      });
    });
  });

  describe('тело главной — не дальше предела (аудит 15.10, R-census)', () => {
    /**
     * Главная, которая не кончается: поток отдаёт куски по 64 КБ, пока его
     * читают. Проба, читающая тело целиком, здесь не вернётся никогда — и
     * сторож краснеет по сроку теста, а не по случайности. `pulled` — сколько
     * байт поток успел отдать, `cancelled` — закрыт ли он.
     */
    function endless(head: string) {
      const state = { pulled: 0, cancelled: false };
      const enc = new TextEncoder();
      const filler = enc.encode('<p>'.padEnd(64 * 1024, 'x'));
      let first = true;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = first ? enc.encode(head) : filler;
          first = false;
          state.pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() { state.cancelled = true; },
      });
      return { res: new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }), state };
    }

    it('бесконечная главная без скрипта — «не смог» с причиной, прочитано не больше предела, поток закрыт', async () => {
      const { res, state } = endless('<html><head></head><body>');
      const r = await probeSite('huge.ru', 'fish', io(async () => res));
      expect(r).toMatchObject({ outcome: 'could_not_check', http_status: 200, scripts: [], reason: expect.stringMatching(/главная длиннее .*скрипта нет/) });
      expect(state.pulled).toBeLessThanOrEqual(SITE_PROBE_BODY_LIMIT + 2 * 64 * 1024);
      expect(state.cancelled).toBe(true);
    });

    it('скрипт в начале длинной главной — найден, и сказано, что читали не всё', async () => {
      const { res, state } = endless('<html><script src="https://vedarai.ru/api/widget/lead.js?partner=fish" defer></script>');
      const r = await probeSite('huge.ru', 'fish', io(async () => res));
      expect(r).toMatchObject({ outcome: 'found', scripts: ['form'], reason: expect.stringMatching(/только в первых/) });
      expect(state.cancelled).toBe(true);
    });

    it('скрипт за пределом не виден — и это «не смог», а не «не нашёл»', async () => {
      const html = '<html>' + 'x'.repeat(SITE_PROBE_BODY_LIMIT) + '<script src="https://vedarai.ru/api/widget/lead.js?partner=fish"></script>';
      const r = await probeSite('huge.ru', 'fish', io(async () => page(html)));
      expect(r.outcome).toBe('could_not_check');
    });

    it('главная в пределе читается целиком: скрипт в самом конце найден', async () => {
      const html = '<html>' + 'x'.repeat(SITE_PROBE_BODY_LIMIT - 200) + '<script src="https://vedarai.ru/api/widget/lead.js?partner=fish"></script>';
      expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(SITE_PROBE_BODY_LIMIT);
      expect(await probeSite('big.ru', 'fish', io(async () => page(html)))).toMatchObject({ outcome: 'found', reason: null });
    });
  });

  it('с probeSites перепись спрашивает главную каждого домена и ничего не пишет', async () => {
    const { query } = readOnlyPool(fullAnswers());
    const fetchImpl = vi.fn(async (url: string) => page(url.includes('fishingkam')
      ? '<script src="https://vedarai.ru/api/widget/lead.js?partner=fishingkam"></script>' : '<html></html>'));
    const r = await censusWidgets({ query } as never, { probeSites: true, fetchImpl, resolveImpl: publicDns });
    expect(fetchImpl.mock.calls.map((c) => c[0]).sort()).toEqual(['https://fishingkam.ru/', 'https://mestechkokam.ru/']);
    expect(r.partners!.find((p) => p.slug === 'fishingkam')!.site_probe).toEqual([
      expect.objectContaining({ domain: 'fishingkam.ru', outcome: 'found', scripts: ['form'] }),
    ]);
    expect(r.partners!.find((p) => p.slug === 'mestechko')!.site_probe![0].outcome).toBe('not_found');
  });

  it(`домены сверх ${SITE_PROBE_MAX} за прогон — «не спрошен» с причиной, а не пропуск (R-census)`, async () => {
    const domains = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}.ru`);
    const partners = [
      // Без slug: искать нечего, бюджет не тратит.
      { id: 'p-0', slug: null, name: 'Без адреса', widget_domains: domains('noslug', 3) },
      { id: 'p-a', slug: 'aaa', name: 'А', widget_domains: domains('aaa', SITE_PROBE_MAX - 1) },
      { id: 'p-b', slug: 'bbb', name: 'Б', widget_domains: domains('bbb', 3) },
      { id: 'p-c', slug: 'ccc', name: 'В', widget_domains: domains('ccc', 1) },
    ];
    const answers = fullAnswers();
    answers.set(PARTNERS_SQL, () => partners);
    const { query } = readOnlyPool(answers);
    const fetchImpl = vi.fn(async () => page('<html></html>'));
    const r = await censusWidgets({ query } as never, { probeSites: true, fetchImpl, resolveImpl: publicDns });

    expect(fetchImpl).toHaveBeenCalledTimes(SITE_PROBE_MAX);
    // У каждого партнёра — запись на КАЖДЫЙ домен списка, ни один не пропал.
    for (const p of r.partners!) expect(p.site_probe!.map((x) => x.domain), p.name).toEqual(p.widget_domains);

    const by = (slug: string | null) => r.partners!.find((p) => p.slug === slug)!.site_probe!;
    expect(by(null).every((x) => x.outcome === 'could_not_check' && /нет slug/.test(x.reason ?? ''))).toBe(true);
    expect(by('aaa').every((x) => x.outcome === 'not_found')).toBe(true);
    expect(by('bbb').map((x) => x.outcome)).toEqual(['not_found', 'could_not_check', 'could_not_check']);
    const skipped = [...by('bbb').slice(1), ...by('ccc')];
    expect(skipped).toHaveLength(3);
    for (const x of skipped) {
      expect(x).toMatchObject({ outcome: 'could_not_check', url: null, http_status: null });
      expect(x.reason).toBe(`не спрошен: лимит ${SITE_PROBE_MAX} доменов за прогон исчерпан`);
    }
  });
});

describe('заметка о served — правда о кэше lead.js (аудит 15.10, R-census)', () => {
  // Заголовки — как их сопоставляет рантайм Next (getPathMatch со strict,
  // removeUnnamedParams и modifyRouteRegex, тот же приём, что в
  // seo-audit-2909-evening): правило судится поведением, а не на глаз.
  const ROOT = process.cwd();
  const req = createRequire(join(ROOT, 'package.json'));
  type HeaderRule = { source: string; headers: { key: string; value: string }[] };
  const { getPathMatch } = req('next/dist/shared/lib/router/utils/path-match') as {
    getPathMatch: (source: string, opts: Record<string, unknown>) => (path: string) => false | object;
  };
  const { modifyRouteRegex } = req('next/dist/lib/redirect-status') as {
    modifyRouteRegex: (regex: string, restricted?: string[]) => string;
  };

  /** Cache-Control из next.config.js для пути; совпавшие записи — последняя побеждает. */
  async function configCacheControl(path: string): Promise<string | null> {
    const cfg = req(join(ROOT, 'next.config.js')) as { headers: () => Promise<HeaderRule[]> };
    let value: string | null = null;
    for (const rule of await cfg.headers()) {
      const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r: string) => modifyRouteRegex(r) });
      if (match(path) === false) continue;
      for (const h of rule.headers) if (h.key.toLowerCase() === 'cache-control') value = h.value;
    }
    return value;
  }

  it('lead.js уходит без кэша браузера — и заметка переписи не обещает кэш, которого нет', async () => {
    const cc = await configCacheControl('/api/widget/lead.js');
    const note = CENSUS_NOTES.find((n) => n.startsWith('served'));
    expect(note).toBeDefined();
    const migrationHead = readFileSync(join(ROOT, 'migrations/1282_widget_daily.sql'), 'utf-8').split(/^CREATE /m)[0];
    if (cc !== null && /no-store/.test(cc)) {
      // Конфиг ставит no-store раньше роута, и «5 минут» роута до браузера не доходят.
      expect(note).toMatch(/без кэша браузера/);
      expect(note).toMatch(/верхняя граница/);
      expect(note).not.toMatch(/браузер держит/);
      expect(migrationHead).not.toMatch(/браузер держит/);
      expect(migrationHead).toMatch(/Кэша браузера у скрипта нет/);
    } else {
      // lead.js исключили из общего правила: кэш роута дошёл до браузера, и
      // served снова меньше просмотров — заметку и шапку 1282 надо переписать.
      expect(note, 'lead.js кэшируется, а заметка говорит «без кэша»').not.toMatch(/без кэша браузера/);
    }
    // Сегодня общее правило lead.js не исключает: ветка «кэш есть» не должна пройти незаметно.
    expect(cc).toMatch(/no-store/);
  });
});

describe('роут /api/cron/widget-census', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'census-secret-1');
    const { query } = readOnlyPool(fullAnswers());
    poolQuery.mockReset();
    poolQuery.mockImplementation(query);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function call(qs = '', secret?: string) {
    const { GET } = await import('@/app/api/cron/widget-census/route');
    return GET(new NextRequest(`https://vedarai.ru/api/cron/widget-census${qs}`, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }));
  }

  it('без секрета — 401 и ни одного запроса', async () => {
    const res = await call('', undefined);
    expect(res.status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('с секретом — перепись; сайты не спрашиваются без probe_sites=1', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call('', 'census-secret-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, probe: 'widget_census_v1', probe_sites: false, failed_measures: [] });
    expect(body.partners).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('отказ части — ok:false, часть названа', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql === FORM_LEADS_SQL) throw Object.assign(new Error('x'), { code: '57014' });
      return readOnlyPool(fullAnswers()).query(sql);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await (await call('', 'census-secret-1')).json();
    err.mockRestore();
    expect(body.ok).toBe(false);
    expect(body.failed_measures).toEqual([{ measure: 'form_leads', sqlstate: '57014' }]);
    expect(body.partners.map((p: { form_leads: unknown }) => p.form_leads)).toEqual([null, null]);
  });
});
