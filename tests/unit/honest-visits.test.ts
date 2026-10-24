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
import { isAiFamily } from '@/lib/analytics/bot-detect';
import { isPlatformBoxIp, platformBoxAddresses } from '@/lib/analytics/box-ip';
import { isStaffOwnVisit } from '@/lib/analytics/staff-visit';
import { POST } from '@/app/api/analytics/hit/route';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

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

  it('админ и оператор — свои, турист и битый токен — нет', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'honest-visits-test-secret-32chars';
    const admin = await createToken({ userId: 'u-admin', email: 'a@example.com', role: 'admin' });
    const operator = await createToken({ userId: 'u-op', email: 'o@example.com', role: 'operator' });
    const tourist = await createToken({ userId: 'u-t', email: 't@example.com', role: 'tourist' });
    expect(await isStaffOwnVisit(`auth_token=${admin}`)).toBe(true);
    expect(await isStaffOwnVisit(`theme=dark; auth_token=${operator}`)).toBe(true);
    expect(await isStaffOwnVisit(`auth_token=${tourist}`)).toBe(false);
    expect(await isStaffOwnVisit('auth_token=not-a-jwt')).toBe(false);
    expect(await isStaffOwnVisit(null)).toBe(false);
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
});
