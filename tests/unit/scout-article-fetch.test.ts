// @vitest-environment node
/**
 * Разведка: статья по ссылке из чужой ленты и отметка «показано» (аудит 23.11).
 *
 * Адрес статьи приходит из лент, которые пишет кто угодно (новые посты Hacker
 * News). До 23.11 он читался голым `fetch` с редиректами: ответ 302 на
 * внутренний адрес уводил запрос прод-сервера внутрь сети. Теперь адрес и
 * каждое перенаправление судит `safeFetchText`, а отвергнутый адрес реле в
 * обход не получает.
 *
 * Отметка «показано» писалась ДО отправки: Telegram не принял выпуск — а
 * новости уже числились показанными на 30 суток.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => [{ address: host === 'internal.example.ru' ? '10.0.0.5' : '93.184.216.34', family: 4 }],
}));

import { readArticleHtml, fetchArticleText, recordSeenIfShown } from '@/lib/agents/scout-digest';

const RELAY = 'https://relay.example.workers.dev';
const realFetch = globalThis.fetch;
const realEnv = { base: process.env.SCOUT_RELAY_BASE, secret: process.env.CRON_SECRET };
let calls: Array<{ url: string; redirect: RequestRedirect | undefined; auth: string | null }> = [];

const TG_PREVIEW = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="ru_rst/1233">
    <div class="tgme_widget_message_text js-message_text" dir="auto">Соседний пост о другом</div>
    <a class="tgme_widget_message_date" href="https://t.me/ru_rst/1233"><time datetime="2026-11-22T10:00:00+00:00">10:00</time></a>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="ru_rst/1234">
    <div class="tgme_widget_message_text js-message_text" dir="auto">Утверждены правила субсидий на модульные отели</div>
    <a class="tgme_widget_message_date" href="https://t.me/ru_rst/1234"><time datetime="2026-11-23T10:00:00+00:00">10:00</time></a>
  </div>
</div>`;

beforeEach(() => {
  calls = [];
  process.env.SCOUT_RELAY_BASE = RELAY;
  process.env.CRON_SECRET = 'test-secret';
  delete process.env.FIRECRAWL_API_KEY;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect, auth: new Headers(init?.headers).get('authorization') });
    if (url === `${RELAY}/fetch?url=${encodeURIComponent('https://t.me/s/ru_rst')}`) return new Response(TG_PREVIEW, { status: 200 });
    if (url.startsWith(`${RELAY}/fetch?url=`)) return new Response('<p>через реле</p>', { status: 200 });
    // t.me из РФ закрыт: прямой запрос обрывается.
    if (url.startsWith('https://t.me/')) throw new Error('connect ETIMEDOUT');
    if (url === 'https://news.example.com/a') return new Response('<p>статья</p>', { status: 200 });
    if (url === 'https://news.example.com/moved') {
      return new Response(null, { status: 301, headers: { location: 'https://news.example.com/a' } });
    }
    if (url === 'https://evil.example.com/jump') {
      return new Response(null, { status: 302, headers: { location: 'http://internal.example.ru/meta' } });
    }
    if (url === 'https://evil.example.com/cloud') {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    if (url === 'https://geo.example.com/x') return new Response('нельзя', { status: 403 });
    if (url === 'https://gone.example.com/x') return new Response('нет', { status: 404 });
    if (url === 'https://down.example.com/x') throw new Error('connect ECONNRESET');
    return new Response('внутренний ответ', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv.base === undefined) delete process.env.SCOUT_RELAY_BASE; else process.env.SCOUT_RELAY_BASE = realEnv.base;
  if (realEnv.secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = realEnv.secret;
});

const relayCalls = () => calls.filter((c) => c.url.startsWith(RELAY));

describe('статья по ссылке из ленты', () => {
  it('обычная статья читается напрямую, перенаправления — вручную', async () => {
    expect(await readArticleHtml('https://news.example.com/a')).toBe('<p>статья</p>');
    expect(await readArticleHtml('https://news.example.com/moved')).toBe('<p>статья</p>');
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
    expect(relayCalls()).toEqual([]);
  });

  it('перенаправление на внутренний адрес: не запрошен ни он, ни реле', async () => {
    expect(await readArticleHtml('https://evil.example.com/jump')).toBe('');
    expect(await readArticleHtml('https://evil.example.com/cloud')).toBe('');
    expect(calls.map((c) => c.url)).toEqual(['https://evil.example.com/jump', 'https://evil.example.com/cloud']);
  });

  it('внутренний адрес прямо в ленте не запрашивается вовсе', async () => {
    expect(await readArticleHtml('http://169.254.169.254/latest/meta-data/')).toBe('');
    expect(await readArticleHtml('http://internal.example.ru/admin')).toBe('');
    expect(await readArticleHtml('file:///etc/passwd')).toBe('');
    expect(calls).toEqual([]);
  });

  it('гео-блок и обрыв сети — через реле; секрет уходит только реле', async () => {
    expect(await readArticleHtml('https://geo.example.com/x')).toBe('<p>через реле</p>');
    expect(await readArticleHtml('https://down.example.com/x')).toBe('<p>через реле</p>');
    expect(relayCalls().map((c) => c.url)).toEqual([
      `${RELAY}/fetch?url=${encodeURIComponent('https://geo.example.com/x')}`,
      `${RELAY}/fetch?url=${encodeURIComponent('https://down.example.com/x')}`,
    ]);
    expect(relayCalls().every((c) => c.auth === 'Bearer test-secret')).toBe(true);
    expect(calls.filter((c) => !c.url.startsWith(RELAY)).every((c) => c.auth === null)).toBe(true);
  });

  it('страницы нет (404) — реле её не найдёт и не зовётся', async () => {
    expect(await readArticleHtml('https://gone.example.com/x')).toBe('');
    expect(relayCalls()).toEqual([]);
  });

  it('реле не настроено — отказ остаётся отказом', async () => {
    delete process.env.SCOUT_RELAY_BASE;
    expect(await readArticleHtml('https://geo.example.com/x')).toBe('');
    expect(calls.map((c) => c.url)).toEqual(['https://geo.example.com/x']);
  });
});

describe('текст поста Telegram для фактчека', () => {
  // Страница самого поста отдаёт обёртку виджета без текста, а t.me из РФ
  // закрыт: читается превью канала, тем же помощником и с тем же реле.
  it('ссылка на пост: читается превью канала через реле, берётся именно этот пост', async () => {
    expect(await fetchArticleText('https://t.me/ru_rst/1234')).toBe('Утверждены правила субсидий на модульные отели');
    expect(calls.map((c) => c.url)).toEqual([
      'https://t.me/s/ru_rst',
      `${RELAY}/fetch?url=${encodeURIComponent('https://t.me/s/ru_rst')}`,
    ]);
  });

  it('поста на странице превью нет — пустая строка, а не чужой пост', async () => {
    expect(await fetchArticleText('https://t.me/ru_rst/999')).toBe('');
  });

  it('обычная статья: текст без разметки', async () => {
    expect(await fetchArticleText('https://news.example.com/a')).toBe('статья');
    expect(await fetchArticleText('')).toBe('');
  });
});

describe('отметка «показано»', () => {
  it('выпуск не ушёл никуда — отметки нет', async () => {
    const write = vi.fn(async () => {});
    expect(await recordSeenIfShown({ sent: false, aiSent: false }, write)).toBe('not_shown');
    expect(write).not.toHaveBeenCalled();
  });

  it('ушёл хотя бы в один канал — отметка пишется один раз', async () => {
    for (const shown of [{ sent: true, aiSent: false }, { sent: false, aiSent: true }, { sent: true, aiSent: true }]) {
      const write = vi.fn(async () => {});
      expect(await recordSeenIfShown(shown, write)).toBe('written');
      expect(write).toHaveBeenCalledTimes(1);
    }
  });

  it('запись не удалась — прогон не падает, исход назван', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn(async () => { throw new Error('connection terminated'); });
    expect(await recordSeenIfShown({ sent: true, aiSent: false }, write)).toBe('failed');
    expect(errors.mock.calls.flat().join(' ')).toContain('connection terminated');
    errors.mockRestore();
  });

  // Запрет: память «показано» не пишется раньше, чем выпуск ушёл.
  it('в прогоне отметка зовётся после обеих отправок и нигде ещё', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export async function runScoutDigest'));
    const mark = body.indexOf('await recordSeenIfShown({ sent, aiSent }, markSeen)');
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(body.indexOf('const sent = await tgSend(digest'));
    expect(mark).toBeGreaterThan(body.indexOf('aiSent = await tgSendRich('));
    expect(body.match(/markSeen\(\)/g) ?? []).toEqual([]);
    expect((body.match(/memory_type: 'seen_urls'/g) ?? []).length).toBe(1);
  });
});
