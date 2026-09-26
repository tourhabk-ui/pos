/**
 * Сторож: отказ kamgov.ru — это отказ, а не пустая лента (#2064, 26.09).
 *
 * Сводки Минтура («маршрут закрыт», «посещение не рекомендуется») приходят
 * лентами kamgov.ru, и тянет их только раннер. 26.09 проба 605: все адреса
 * отвечают раннеру 403. Workflow тогда не присылал XML, а отчёт прогона писал
 * «источник ответил, постов нет» — сводка неделями не доходила до статуса
 * мест, и никто об этом не знал.
 *
 * Держится связка целиком (§10.09): раннер меряет каждый адрес и присылает
 * коды → сервер превращает «ни один не отдал RSS» в ошибку → здоровье
 * источника kamgov пишется и судится порогом тишины → мёртвый kamgov доходит
 * до Telegram, а не прячется.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kamgovUnreachable } from '@/lib/services/safety/kamgov-fetch';
import { ingestOutcome } from '@/lib/services/safety/ingest-outcome';
import { SAFETY_SOURCE_EXPECTATIONS } from '@/lib/services/safety/source-health';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('kamgovUnreachable — коды словами, исход «отказ»', () => {
  const r = kamgovUnreachable([
    { url: 'https://www.kamgov.ru/rss', http: 403, rss: false },
    { url: 'https://www.kamgov.ru/mintur/rss', http: 0, rss: false },
    { url: 'https://www.kamgov.ru/mintur/news/rss', http: 200, rss: false },
  ]);

  it('называет каждый адрес и что он ответил', () => {
    expect(r.errors).toEqual([
      'kamgov.ru не отдал RSS раннеру: /rss HTTP 403, /mintur/rss нет ответа, /mintur/news/rss HTTP 200, но не RSS',
    ]);
  });

  it('«сходили, ничего не получили» — отказ, не «постов нет» и не «не запускали»', () => {
    expect(r.rawItems).toBe(0);
    expect(ingestOutcome({ result: r })).toBe('fetch_failed');
  });
});

describe('раннер меряет каждый адрес и присылает коды', () => {
  const WF = read('.github/workflows/cron-safety-ingest.yml');

  it('код ответа снимается у каждого адреса, а не глушится curl -f', () => {
    expect(WF).toMatch(/code=\$\(curl -s --max-time 30 -o \/tmp\/kamgov_one\.xml -w "%\{http_code\}"/);
    expect(WF).not.toMatch(/"\$u" > \/tmp\/kamgov_one\.xml \|\| continue/);
    expect(WF).toContain("'{url: $url, http: $http, rss: $rss}' >> /tmp/kamgov_fetch.jsonl");
  });

  it('коды уходят в тело POST полем kamgov_fetch', () => {
    expect(WF).toContain('--slurpfile kamgov_fetch /tmp/kamgov_fetch.json');
    expect(WF).toContain('{kamgov_fetch: $kamgov_fetch[0]}');
  });
});

describe('сервер различает отказ и пустоту', () => {
  const ROUTE = read('app/api/cron/safety-ingest/route.ts');

  it('схема принимает kamgov_fetch', () => {
    expect(ROUTE).toMatch(/kamgov_fetch: z\.array\(z\.object\(\{\s*url: z\.string\(\)\.max\(300\),\s*http: z\.number\(\)\.int\(\),\s*rss: z\.boolean\(\),/);
  });

  it('XML нет, а раннер ходил — результат-отказ с кодами', () => {
    expect(ROUTE).toContain('Promise.resolve(kamgovFetch && kamgovFetch.length > 0 ? kamgovUnreachable(kamgovFetch) : undefined)');
  });

  it('здоровье kamgov пишется только когда раннер сообщил, что ходил', () => {
    expect(ROUTE).toMatch(/\.\.\.\(kamgovFetch && kamgovFetch\.length > 0\s*\? \[entryFor\('kamgov', 'kamgov\.ru — сводки Минтура', kamgovResult\)\]\s*: \[\]\)/);
  });

  it('разбор RSS считает сырые посты: живая лента без угроз — не молчание', () => {
    const P = read('lib/services/safety/seismic-parser.ts');
    const fn = P.slice(P.indexOf('export async function ingestNewsFeedXmls'), P.indexOf('export async function ingestTelegramNewsHtml'));
    expect(fn).toContain('result.rawItems = (result.rawItems ?? 0) + items.length;');
  });
});

describe('мёртвый kamgov судится порогом тишины и не принят молчащим', () => {
  const exp = SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === 'kamgov');

  it('в реестре ожиданий, 48 ч', () => {
    expect(exp?.maxSilenceHours).toBe(48);
  });

  it('knownDormant нет: принять его молчание — решение владельца, не кода', () => {
    expect(exp?.knownDormant).toBeUndefined();
  });
});
