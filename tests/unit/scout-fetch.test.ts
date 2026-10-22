/**
 * safeFetchText — чтение чужой страницы: каждый адрес и каждое
 * перенаправление судятся заново, читающий называет себя, а отказ сервера
 * несёт код. Код нужен наблюдению за сайтами партнёров (22.10): 404
 * «страницы тура больше нет» и обрыв сети — разные исходы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => [{ address: host === 'internal.example.ru' ? '10.0.0.5' : '93.184.216.34', family: 4 }],
}));

import { safeFetchText } from '@/lib/agents/scout-fetch';

const realFetch = globalThis.fetch;
let seen: Array<{ url: string; ua: string | null }> = [];

beforeEach(() => {
  seen = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, ua: new Headers(init?.headers).get('user-agent') });
    if (url === 'https://partner.example.ru/tour/') return new Response('<p>Тур</p>', { status: 200 });
    if (url === 'https://partner.example.ru/gone/') return new Response('нет', { status: 404 });
    if (url === 'https://partner.example.ru/jump/') {
      return new Response(null, { status: 302, headers: { location: 'http://internal.example.ru/meta' } });
    }
    return new Response('?', { status: 500 });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe('safeFetchText', () => {
  it('читающий называет себя: своё имя доходит до запроса, без имени — разведчик', async () => {
    expect(await safeFetchText('https://partner.example.ru/tour/', { userAgent: 'VedarSiteWatch/1.0 (+https://vedarai.ru)' }))
      .toMatchObject({ ok: true, body: '<p>Тур</p>' });
    await safeFetchText('https://partner.example.ru/tour/');
    expect(seen.map((s) => s.ua)).toEqual(['VedarSiteWatch/1.0 (+https://vedarai.ru)', 'VedarScout/1.0 (+https://vedarai.ru)']);
  });

  it('отказ сервера несёт код: 404 отличим от 500', async () => {
    expect(await safeFetchText('https://partner.example.ru/gone/')).toMatchObject({ ok: false, status: 404 });
    expect(await safeFetchText('https://partner.example.ru/other/')).toMatchObject({ ok: false, status: 500 });
  });

  it('перенаправление на внутренний адрес не читается', async () => {
    const r = await safeFetchText('https://partner.example.ru/jump/');
    expect(r.ok).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(['https://partner.example.ru/jump/']);
  });
});
