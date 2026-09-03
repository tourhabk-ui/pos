// @vitest-environment node
/**
 * Проба реле разведчика (03.09): исход ответа реле читается по ФОРМЕ, а не
 * только по коду; вердикт различает «работает», «сломано», «не настроено»
 * и «не смог» (§4.0); роут только читает — ни модели, ни публикации, ни БД.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRelayResponse, verdict, type SourceProbe } from '@/app/api/cron/scout-relay-check/route';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/scout-relay-check/route.ts'), 'utf-8');

function probe(relay: SourceProbe['relay']): SourceProbe {
  return {
    key: 'k', url: 'https://t.me/s/k', direct_status: null, relay,
    relay_status: null, upstream_status: null, bytes: null, posts: null, detail: null,
  };
}

describe('classifyRelayResponse', () => {
  it('401 — воркер не принял секрет', () => {
    expect(classifyRelayResponse(401, null, '{"error":"unauthorized"}', 0)).toBe('relay_unauthorized');
  });
  it('403 с нашим текстом — хост не в белом списке', () => {
    expect(classifyRelayResponse(403, null, '{"error":"хост x не в белом списке RELAY_HOSTS"}', 0)).toBe('relay_host_refused');
  });
  it('без заголовка источника отвечал не наш воркер', () => {
    expect(classifyRelayResponse(200, null, '<html>', 0)).toBe('not_relay');
    expect(classifyRelayResponse(404, null, 'error code: 1042', 0)).toBe('not_relay');
  });
  it('с заголовком: 2xx и посты — ok, 2xx без постов — empty, иначе ответ источника', () => {
    expect(classifyRelayResponse(200, '200', '<div class="tgme_widget_message_wrap">', 3)).toBe('ok');
    expect(classifyRelayResponse(200, '200', '<html>', 0)).toBe('empty');
    expect(classifyRelayResponse(403, '403', 'forbidden', 0)).toBe('upstream_http');
  });
});

describe('verdict', () => {
  it('реле не настроено — мерить нечего', () => {
    expect(verdict('off', [])).toBe('not_configured');
    expect(verdict('bad_base', [])).toBe('not_configured');
  });
  it('хоть один источник прочитан — работает', () => {
    expect(verdict('on', [probe('relay_unauthorized'), probe('ok')])).toBe('works');
  });
  it('ответы есть, прочитанных нет — сломано', () => {
    expect(verdict('on', [probe('relay_unauthorized'), probe('unreachable')])).toBe('broken');
  });
  it('все «не смог» — неизвестно, а не сломано', () => {
    expect(verdict('on', [probe('unreachable'), probe('unreachable')])).toBe('unknown');
  });
});

describe('роут только читает', () => {
  it('секрет проверяется до первого fetch', () => {
    const auth = ROUTE.indexOf('timingSafeCompare(getCronSecret(request)');
    const firstFetch = ROUTE.indexOf('await fetch(');
    expect(auth).toBeGreaterThan(0);
    // Функции с fetch объявлены выше GET, но зовутся только после проверки.
    expect(ROUTE.indexOf('probeSource(s)', auth)).toBeGreaterThan(auth);
    expect(firstFetch).toBeGreaterThan(0);
  });
  it('ни модели, ни публикации, ни БД', () => {
    expect(ROUTE).not.toMatch(/callAI|sendMessage|db-pool|pool\.query|INSERT|UPDATE/);
  });
  it('адреса — только из RSS_SOURCES, не из запроса', () => {
    expect(ROUTE).not.toMatch(/searchParams\.get\(['"]url/);
    expect(ROUTE).toMatch(/RSS_SOURCES\.filter\(\(s\) => s\.kind === 'telegram'\)/);
  });
});
