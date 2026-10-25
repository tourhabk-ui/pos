/**
 * Честные визиты (владелец 24.10): автопроверка с обычным Chrome, вызов без
 * маяка, ИИ-краулер, админ и адрес коробки не попадают в «люди».
 *
 * Старые строки по User-Agent не переписываются: его в page_views не было.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth/jwt';
import { classifyPageHit } from '@/lib/analytics/visit-class';
import { classifyAddressBurst, ENGAGED_DWELL_MS } from '@/lib/analytics/address-burst';
import { queryAddressTop } from '@/lib/analytics/address-top';
import { ipHash } from '@/lib/analytics/visitor-hash';
import { kamchatkaDayBounds } from '@/lib/analytics/kamchatka-day';
import { isAiFamily } from '@/lib/analytics/bot-detect';
import { isPlatformBoxIp, platformBoxAddresses } from '@/lib/analytics/box-ip';
import { isStaffOwnVisit } from '@/lib/analytics/staff-visit';
import { POST } from '@/app/api/analytics/hit/route';
import { POST as dwellPost } from '@/app/api/analytics/dwell/route';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({
      query: (...a: unknown[]) => query(...a),
      release: () => undefined,
    }),
  },
}));

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function hitBody(over: Record<string, unknown> = {}) {
  return { path: '/kuzmich', beacon: true, webdriver: false, ...over };
}

async function post(opts: {
  ip?: string | null;
  ua?: string;
  cookie?: string;
  body?: Record<string, unknown>;
}) {
  const headers = new Headers({ 'content-type': 'application/json', 'user-agent': opts.ua ?? CHROME });
  if (opts.ip) headers.set('x-forwarded-for', opts.ip);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  const res = await POST(new NextRequest('http://localhost/api/analytics/hit', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? hitBody()),
  }));
  return res.json() as Promise<{ ok: boolean; audience?: string }>;
}

function inserted(): unknown[] {
  const call = query.mock.calls.find((c) => String(c[0]).includes('ua_family'));
  return (call?.[1] as unknown[]) ?? [];
}

describe('класс просмотра', () => {
  const person = { userAgent: CHROME, webdriver: false, clientBeacon: true, own: false };

  it('обычный Chrome с маяком — человек', () => {
    const c = classifyPageHit(person);
    expect(c.audience).toBe('person');
    expect(c.isBot).toBe(false);
    expect(c.isSelf).toBe(false);
  });

  it('тот же Chrome с navigator.webdriver — не человек', () => {
    const c = classifyPageHit({ ...person, webdriver: true });
    expect(c.audience).toBe('bot');
    expect(c.isBot).toBe(true);
    expect(c.family).toBe('browser');
  });

  it('HeadlessChrome, Playwright и Puppeteer в адресе — бот и без флага webdriver', () => {
    for (const ua of [
      'Mozilla/5.0 HeadlessChrome/131.0.0.0 Safari/537.36',
      `${CHROME} Playwright`,
      `${CHROME} Puppeteer`,
    ]) {
      const c = classifyPageHit({ ...person, userAgent: ua });
      expect(c.audience, ua).toBe('bot');
    }
  });

  it('вызов без клиентского маяка — служебный, не человек', () => {
    const c = classifyPageHit({ ...person, clientBeacon: false });
    expect(c.audience).toBe('bot');
    expect(c.isBot).toBe(true);
  });

  it('ИИ-краулеры — отдельный исход, не общая куча ботов', () => {
    for (const [ua, family] of [
      ['Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'openai'],
      ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'anthropic'],
      ['Mozilla/5.0 (compatible; PerplexityBot/1.0)', 'perplexity'],
      ['Mozilla/5.0 (compatible; YouBot/1.0)', 'you'],
      ['cohere-ai', 'cohere'],
      ['Mozilla/5.0 (compatible; AI2Bot)', 'ai2'],
      ['MistralAI-User/1.0', 'mistral'],
      ['Mozilla/5.0 (compatible; GrokBot/1.0)', 'xai'],
      ['Mozilla/5.0 (compatible; Baiduspider/2.0)', 'baidu'],
      ['Mozilla/5.0 (compatible; YandexBot/3.0)', 'yandex'],
      ['Mozilla/5.0 (compatible; YandexAccessibilityBot/3.0)', 'yandex'],
    ] as const) {
      const c = classifyPageHit({ ...person, userAgent: ua });
      expect(c.family, ua).toBe(family);
      expect(c.isBot, ua).toBe(true);
      expect(c.audience, ua).toBe(isAiFamily(family) ? 'ai' : 'bot');
    }
    expect(isAiFamily('baidu')).toBe(false);
    expect(isAiFamily('openai')).toBe(true);
  });

  it('Яндекс.Браузер человека не бот', () => {
    const c = classifyPageHit({
      ...person,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 YaBrowser/24.6.0',
    });
    expect(c.audience).toBe('person');
  });

  it('свой заход важнее бота: в люди не входит', () => {
    const c = classifyPageHit({ ...person, webdriver: true, own: true });
    expect(c.audience).toBe('self');
    expect(c.isSelf).toBe(true);
    expect(c.isBot).toBe(true);
  });
});

describe('адрес коробки и роль', () => {
  it('петля и список VEDAR_BOX_IPS — свои, чужой адрес и пусто — нет', () => {
    const known = platformBoxAddresses('203.0.113.8, ::ffff:198.51.100.2', []);
    expect(isPlatformBoxIp('127.0.0.1', known)).toBe(true);
    expect(isPlatformBoxIp('::ffff:127.0.0.1', known)).toBe(true);
    expect(isPlatformBoxIp('203.0.113.8', known)).toBe(true);
    expect(isPlatformBoxIp('198.51.100.2', known)).toBe(true);
    expect(isPlatformBoxIp('203.0.113.9', known)).toBe(false);
    expect(isPlatformBoxIp(null, known)).toBe(false);
    expect(isPlatformBoxIp('', known)).toBe(false);
  });

  it('админ и оператор с живой сессией — свои, турист, отзыв и битый токен — нет', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'honest-visits-test-secret-32chars';
    query.mockResolvedValue({ rows: [{ id: 'session' }] });
    const admin = await createToken({ userId: 'u-admin', email: 'a@example.com', role: 'admin' });
    const operator = await createToken({ userId: 'u-op', email: 'o@example.com', role: 'operator' });
    const tourist = await createToken({ userId: 'u-t', email: 't@example.com', role: 'tourist' });
    expect(await isStaffOwnVisit(`auth_token=${admin}`)).toBe(true);
    expect(await isStaffOwnVisit(`theme=dark; auth_token=${operator}`)).toBe(true);
    expect(await isStaffOwnVisit(`auth_token=${tourist}`)).toBe(false);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await isStaffOwnVisit(`auth_token=${admin}`)).toBe(false);
    expect(await isStaffOwnVisit('auth_token=not-a-jwt')).toBe(false);
    expect(await isStaffOwnVisit(null)).toBe(false);
    query.mockRejectedValueOnce(new Error('сессия не прочитана'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await isStaffOwnVisit(`auth_token=${operator}`)).toBe(false);
    expect(err.mock.calls.some((c) => String(c[0]).includes('[staff-visit]'))).toBe(true);
    err.mockRestore();
  });
});

describe('приём маяка не пишет автопроверку в люди', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [{ id: '1' }] });
  });

  it('Chrome с webdriver — audience bot, в строке is_bot и без класса устройства', async () => {
    const json = await post({ ip: '203.0.113.20', body: hitBody({ webdriver: true }) });
    expect(json.audience).toBe('bot');
    const params = inserted();
    expect(params[5]).toBe(true);
    expect(params[7]).toBe(false);
    expect(params[8]).toBeNull();
    expect(params[9]).toBe('browser');
    expect(params[10]).toBe(true);
    expect(params.join(' ')).not.toContain('Chrome/131');
  });

  it('тот же Chrome без webdriver и с маяком — человек', async () => {
    const json = await post({ ip: '203.0.113.21' });
    expect(json.audience).toBe('person');
    const params = inserted();
    expect(params[5]).toBe(false);
    expect(params[7]).toBe(false);
    expect(params[8]).toBe('desktop');
  });

  it('без маяка — бот, даже если адрес как у Chrome', async () => {
    const json = await post({ ip: '203.0.113.22', body: { path: '/planning' } });
    expect(json.audience).toBe('bot');
    expect(inserted()[10]).toBe(false);
  });

  it('GPTBot — ИИ, Baiduspider — бот', async () => {
    const ai = await post({
      ip: '203.0.113.23',
      ua: 'Mozilla/5.0 (compatible; GPTBot/1.2)',
    });
    expect(ai.audience).toBe('ai');
    expect(inserted()[9]).toBe('openai');

    query.mockClear();
    const baidu = await post({
      ip: '203.0.113.24',
      ua: 'Mozilla/5.0 (compatible; Baiduspider/2.0)',
    });
    expect(baidu.audience).toBe('bot');
    expect(inserted()[9]).toBe('baidu');
  });

  it('адрес коробки и сессия оператора — свои, не люди', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'honest-visits-test-secret-32chars';
    const box = await post({ ip: '127.0.0.1' });
    expect(box.audience).toBe('self');
    expect(inserted()[7]).toBe(true);

    query.mockClear();
    const token = await createToken({ userId: 'u-op', email: 'o@example.com', role: 'operator' });
    const staff = await post({ ip: '203.0.113.25', cookie: `auth_token=${token}` });
    expect(staff.audience).toBe('self');
    expect(inserted()[5]).toBe(false);
    expect(inserted()[7]).toBe(true);
  });
});

describe('старые строки не удаляются', () => {
  it('миграция добавляет метки и не трогает is_bot задним числом', () => {
    const sql = readFileSync('migrations/1328_page_views_honest_class.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS client_beacon');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS ua_family');
    expect(sql).not.toMatch(/DELETE\s+FROM\s+page_views/i);
    expect(sql).not.toMatch(/UPDATE\s+page_views/i);
  });

  it('хэш адреса добавляется без переписывания старых строк', () => {
    const sql = readFileSync('migrations/1329_page_views_ip_hash.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS ip_hash');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS anomaly_bot');
    expect(sql).not.toMatch(/DELETE\s+FROM\s+page_views/i);
    expect(sql).not.toMatch(/UPDATE\s+page_views/i);
  });
});

describe('порог адреса', () => {
  const person = { isBot: false, isSelf: false, priorInteraction: false, fromPath: null };

  it('31-й просмотр без взаимодействия — бот, 30-й — ещё человек', () => {
    expect(classifyAddressBurst({ ...person, priorHits: 30 }).reclass).toBe('burst');
    expect(classifyAddressBurst({ ...person, priorHits: 30 }).anomaly).toBe(true);
    expect(classifyAddressBurst({ ...person, priorHits: 30 }).isBot).toBe(true);
    expect(classifyAddressBurst({ ...person, priorHits: 29 }).reclass).toBeNull();
    expect(classifyAddressBurst({ ...person, priorHits: 29 }).isBot).toBe(false);
  });

  it('переход или время на странице порог не включает', () => {
    expect(classifyAddressBurst({ ...person, priorHits: 80, fromPath: '/catalog' }).reclass).toBe('release');
    expect(classifyAddressBurst({ ...person, priorHits: 80, fromPath: '/catalog' }).isBot).toBe(false);
    expect(classifyAddressBurst({ ...person, priorHits: 80, priorInteraction: true }).isBot).toBe(false);
  });

  it('адрес сервера остаётся своим: порог не делает его уличным ботом', () => {
    const box = classifyAddressBurst({ ...person, isSelf: true, priorHits: 100 });
    expect(box.anomaly).toBe(false);
    expect(box.isBot).toBe(false);
    expect(box.reclass).toBe('burst');
  });

  it('уже бот по адресу браузера не получает метку, которую снимет время на странице', () => {
    const bot = classifyAddressBurst({ ...person, isBot: true, priorHits: 100 });
    expect(bot.anomaly).toBe(false);
    expect(bot.isBot).toBe(true);
    expect(bot.reclass).toBe('burst');
  });
});

describe('хэш адреса', () => {
  it('один адрес в одни сутки — один хэш, без сырого IP и без браузера', () => {
    const a = ipHash('203.0.113.7', '2026-10-24', 's');
    expect(a).toBe(ipHash('::ffff:203.0.113.7', '2026-10-24', 's'));
    expect(a).not.toBe(ipHash('203.0.113.7', '2026-10-25', 's'));
    expect(a).not.toBe(ipHash('203.0.113.8', '2026-10-24', 's'));
    expect(a).not.toContain('203');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('камчатские сутки 24.10 начинаются в 12:00 UTC', () => {
    const bounds = kamchatkaDayBounds(new Date('2026-10-23T12:00:00.000Z'));
    expect(bounds.day).toBe('2026-10-24');
    expect(bounds.end.getTime() - bounds.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('приём маяка: всплеск с одного адреса', () => {
  beforeEach(() => {
    query.mockReset();
  });

  function withStats(hits: number, interaction: boolean) {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('AS hits')) return { rows: [{ hits, interaction }] };
      return { rows: [{ id: '9' }] };
    });
  }

  function updates(): string[] {
    return query.mock.calls.map((c) => String(c[0])).filter((sql) => sql.includes('SET is_bot'));
  }

  it('31-й просмотр без взаимодействия — бот, сырого IP в параметрах нет', async () => {
    withStats(30, false);
    const json = await post({ ip: '203.0.113.40' });
    expect(json.audience).toBe('bot');
    const params = inserted();
    expect(params[5]).toBe(true);
    expect(params[7]).toBe(false);
    expect(params[8]).toBeNull();
    expect(params[11]).toMatch(/^[0-9a-f]{32}$/);
    expect(params[12]).toBe(true);
    const burstCall = query.mock.calls.find((c) => String(c[0]).includes('anomaly_bot = TRUE'));
    const burst = String(burstCall?.[0] ?? '');
    expect(burst).toContain('NOT p.is_self');
    expect(burst).toContain('p.from_path IS NULL');
    // Короткое время трекер шлёт сам при уходе: строку с ним всплеск метит.
    expect(burst).toContain('p.dwell_ms < $4');
    // Взаимодействие засчитывается своему визиту, а не всему адресу.
    expect(burst).toMatch(/NOT EXISTS[\s\S]*seen\.session_id = p\.session_id[\s\S]*seen\.from_path IS NOT NULL OR seen\.dwell_ms >= \$4/);
    expect((burstCall?.[1] as unknown[])[3]).toBe(ENGAGED_DWELL_MS);
    expect(burst).not.toMatch(/DELETE/i);
    expect(JSON.stringify(query.mock.calls)).not.toContain('203.0.113.40');
  });

  it('переход внутри визита порог не включает и снимает прежнюю метку своего визита', async () => {
    withStats(80, false);
    const json = await post({ ip: '203.0.113.41', body: hitBody({ fromPath: '/catalog', sessionId: 'visit-0041' }) });
    expect(json.audience).toBe('person');
    expect(inserted()[12]).toBe(false);
    const release = query.mock.calls.find((c) => String(c[0]).includes('anomaly_bot = FALSE'));
    expect(String(release?.[0])).toContain('NOT is_self');
    expect(String(release?.[0])).toContain('session_id = $4');
    expect((release?.[1] as unknown[])[3]).toBe('visit-0041');
  });

  it('переход без визита снимать чужие метки не берётся: сама строка уже человек', async () => {
    withStats(80, false);
    const json = await post({ ip: '203.0.113.43', body: hitBody({ fromPath: '/catalog' }) });
    expect(json.audience).toBe('person');
    expect(updates()).toEqual([]);
  });

  it('адрес коробки при том же всплеске остаётся своим', async () => {
    withStats(100, false);
    const json = await post({ ip: '127.0.0.1' });
    expect(json.audience).toBe('self');
    expect(inserted()[5]).toBe(false);
    expect(inserted()[7]).toBe(true);
    expect(inserted()[12]).toBe(false);
    expect(updates().some((sql) => sql.includes('NOT p.is_self'))).toBe(true);
    expect(JSON.stringify(query.mock.calls)).not.toContain('127.0.0.1');
  });

  it('колонки ещё нет — просмотр пишется, порог не выдумывается', async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('AS hits')) {
        throw Object.assign(new Error('column ip_hash does not exist'), { code: '42703' });
      }
      return { rows: [{ id: '1' }] };
    });
    const json = await post({ ip: '203.0.113.42' });
    expect(json.audience).toBe('person');
    expect(updates()).toEqual([]);
  });

  it('без адреса заголовка хэш пустой, а не петля', async () => {
    query.mockResolvedValue({ rows: [{ id: '1' }] });
    const json = await post({});
    expect(json.audience).toBe('person');
    expect(inserted()[11]).toBeNull();
    expect(inserted()[7]).toBe(false);
  });
});

describe('время на странице снимает только метку порога', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it('сначала пишет dwell один раз, затем снимает anomaly_bot за камчатские сутки', async () => {
    const res = await dwellPost(new NextRequest('http://localhost/api/analytics/dwell', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
      body: JSON.stringify({ id: '15', ms: 1200 }),
    }));
    expect(res.status).toBe(200);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toContain('dwell_ms IS NULL');
    expect(sqls[1]).toContain('anomaly_bot = $3');
    // Судит записанное время против порога и только свой визит.
    expect(sqls[1]).toContain('touched.dwell_ms >= $2');
    expect(sqls[1]).toContain('p.session_id = touched.session_id');
    expect(query.mock.calls[1][1]).toEqual(['15', ENGAGED_DWELL_MS, false]);
    expect(sqls[1]).toContain('NOT p.is_self');
    expect(sqls[1]).toContain('Asia/Kamchatka');
    expect(sqls.join('\n')).not.toMatch(/DELETE/i);
    expect(JSON.stringify(query.mock.calls)).not.toContain('203.0.113.50');
  });
});

describe('топ адресов', () => {
  it('отдаёт усечённый хэш, просмотры и короткое семейство', async () => {
    const bounds = kamchatkaDayBounds(new Date('2026-10-23T12:00:00.000Z'));
    const top = await queryAddressTop(async (sql) => {
      expect(sql).toContain('left(ip_hash, 12)');
      expect(sql).not.toMatch(/user_agent/i);
      return {
        rows: [
          { hash: 'a'.repeat(32), hits: '40', family_n: 1, family: 'browser' },
          { hash: 'b'.repeat(32), hits: 2, family_n: 3, family: 'browser' },
          { hash: 'c'.repeat(32), hits: 1, family_n: 0, family: null },
          { hash: 'not-hex!!!!!', hits: 9, family_n: 1, family: 'x' },
        ],
      };
    }, bounds);
    expect(top.day).toBe('2026-10-24');
    expect(top.errorCode).toBeNull();
    expect(top.rows).toEqual([
      { hash: 'aaaaaaaaaaaa', hits: 40, ua: 'browser' },
      { hash: 'bbbbbbbbbbbb', hits: 2, ua: 'несколько' },
      { hash: 'cccccccccccc', hits: 1, ua: 'не записано' },
    ]);
  });

  it('отказ запроса — не пустой список', async () => {
    const top = await queryAddressTop(async () => {
      throw Object.assign(new Error('column ip_hash does not exist'), { code: '42703' });
    }, kamchatkaDayBounds(new Date('2026-10-23T12:00:00.000Z')));
    expect(top.rows).toBeNull();
    expect(top.errorCode).toBe('42703');
  });
});
