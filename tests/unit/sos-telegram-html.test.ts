/**
 * SOS-тревога доходит, что бы человек ни написал (аудит перед запуском, 22.10).
 *
 * Тревога уходит в Telegram с parse_mode HTML, а имя, телефон, тип, сообщение,
 * узел меша и IP подставлялись в разметку как есть. «<» или «&» в сообщении
 * («до лагеря < 2 км») ломали разбор: Telegram отвечал 400, и тревога не
 * доходила до дежурного вовсе — сигнал лежал только в базе.
 *
 * Здесь — вызов роута с Telegram, который судит разметку так же строго, как
 * настоящий: тег вне разрешённых или голые «<», «>», «&» — 400. Сторож держит
 * обе половины починки: первый же запрос принят (экранирование), а отказ
 * разметки по любой другой причине кончается повтором без неё, а не
 * молчанием.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/database', () => ({
  query: vi.fn(async () => ({ rows: [{ id: 'sos-test-1' }] })),
}));
vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(async () => ({ isAuthenticated: false, userId: null, role: null, email: null })),
}));

import { POST } from '@/app/api/safety/sos/route';

/** Разметка, которую Telegram примет: теги тревоги и мнемоники, больше ничего. */
function telegramAcceptsHtml(text: string): boolean {
  const bare = text.replace(/<\/?b>|<\/?i>|<a href="[^"<>]*">|<\/a>/g, '');
  if (/[<>]/.test(bare)) return false;
  return !/&(?!(?:lt|gt|amp|quot|#\d+);)/.test(bare);
}

interface TgBody { chat_id: string; text: string; parse_mode?: string }

let sent: TgBody[] = [];
const envBefore = { ...process.env };

function stubTelegram(opts: { rejectHtml?: 'invalid' | 'always' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as TgBody;
    sent.push(body);
    const html = body.parse_mode === 'HTML';
    const reject = html && (opts.rejectHtml === 'always' || !telegramAcceptsHtml(body.text));
    return new Response(JSON.stringify(reject
      ? { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }
      : { ok: true, result: { message_id: 1 } }), { status: reject ? 400 : 200 });
  }));
}

function sos(ip: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(new NextRequest('https://vedarai.ru/api/safety/sos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  sent = [];
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-100';
  delete process.env.TELEGRAM_ADMIN_CHAT_ID;
  delete process.env.TELEGRAM_API_BASE;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...envBefore };
});

describe('SOS: текст человека не ломает разметку тревоги', () => {
  it('«<», «>» и «&» в имени, сообщении и типе — тревога принята с первого раза', async () => {
    stubTelegram();
    const res = await sos('203.0.113.11', {
      lat: 53.25, lng: 158.83,
      tourist_name: '<Иван> & Ко',
      tourist_phone: '+7 914 000-00-00',
      emergency_type: 'травма <ноги>',
      message: 'до лагеря < 2 км & темнеет, нога > не держит',
    });
    const json = await res.json() as { success: boolean; notified: boolean };
    expect(json).toMatchObject({ success: true, notified: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].parse_mode).toBe('HTML');
    expect(telegramAcceptsHtml(sent[0].text)).toBe(true);
    expect(sent[0].text).toContain('до лагеря &lt; 2 км &amp; темнеет');
    expect(sent[0].text).toContain('&lt;Иван&gt; &amp; Ко');
    // Разметка самой тревоги цела: жирный заголовок и ссылка на карту.
    expect(sent[0].text).toContain('<b>');
    expect(sent[0].text).toMatch(/<a href="https:\/\/www\.google\.com\/maps\?q=53\.25,158\.83">/);
  });

  it('IP, Sec-Fetch-Site и узел меша — тоже через экранирование', async () => {
    stubTelegram();
    const res = await sos('<script>', {
      source: 'mesh_relay', relayed_by: 'node<7>&x', message: 'нужна помощь',
    }, { 'sec-fetch-site': 'same<origin>' });
    const json = await res.json() as { notified: boolean };
    expect(json.notified).toBe(true);
    expect(sent).toHaveLength(1);
    expect(telegramAcceptsHtml(sent[0].text)).toBe(true);
    expect(sent[0].text).toContain('node&lt;7&gt;&amp;x');
  });

  it('разметку не приняли по иной причине — повтор без неё, тот же смысл, тревога доставлена', async () => {
    stubTelegram({ rejectHtml: 'always' });
    const res = await sos('203.0.113.12', {
      lat: 53.25, lng: 158.83, tourist_name: 'Анна', message: 'до лагеря < 2 км & темнеет',
    });
    const json = await res.json() as { notified: boolean };
    expect(json.notified).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].parse_mode).toBeUndefined();
    expect(sent[1].text).toContain('до лагеря < 2 км & темнеет');
    expect(sent[1].text).toContain('https://www.google.com/maps?q=53.25,158.83');
    expect(sent[1].text).not.toMatch(/<\/?b>|&lt;|&amp;/);
  });

  it('отказ не из-за разметки (не 400) повтором не маскируется — notified честно false', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as TgBody);
      return new Response(JSON.stringify({ ok: false, error_code: 401 }), { status: 401 });
    }));
    const res = await sos('203.0.113.13', { message: 'помогите' });
    const json = await res.json() as { success: boolean; notified: boolean };
    expect(json).toMatchObject({ success: true, notified: false });
    expect(sent).toHaveLength(1);
  });
});
