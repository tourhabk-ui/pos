// @vitest-environment node
/**
 * Обрыв соединения — не «Прод 500» (слово владельца 19.11 «1»).
 *
 * Проверка прода 19.11 прочитала журнал серверных ошибок: у /catalog одна
 * ошибка, у /map девять, и у всех текст «controller[kState].transformAlgorithm
 * is not a function» со стеком целиком во внутренностях Node.js. Так Node.js
 * отвечает, когда посетитель ушёл посреди ответа. Дайджест владельцу и
 * объектив эволюции звали это ошибкой страницы.
 *
 * Здесь — вызовом:
 *  - правило узнаёт настоящую строку журнала прода и не узнаёт тот же текст
 *    с кадром нашего кода, кадром вне Node.js без скобок, другой текст;
 *  - перепись отдаёт обрывы отдельным списком, в `total` они не входят;
 *  - одни обрывы дайджест не шлют; рядом с ошибками — одна строка о них.
 *
 * SQL того же правила на настоящем PostgreSQL — сцена «обрыв соединения в
 * журнале ошибок» в tests/integration/admin-day-counts.pg.test.ts: там же
 * объектив эволюции и перепись попыток брони.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let poolAnswer: () => unknown[] = () => [];
const poolQuery = vi.fn(async () => {
  const out = poolAnswer();
  return { rows: out, rowCount: out.length };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...(a as [])) } }));

import { GET } from '@/app/api/cron/prod-errors/route';
import { isConnectionAbort } from '@/lib/server-errors/connection-abort';
import { connectionAbortsLine, serverErrorsDigestText, type ServerErrorRow } from '@/lib/server-errors/digest';

/** Строка журнала прода 19.11 слово в слово (проверка прода, прогон 195). */
const PROD_MESSAGE = 'controller[kState].transformAlgorithm is not a function';
const PROD_STACK =
  'at transformStreamDefaultControllerPerformTransform (node:internal/webstreams/transformstream:527:37) | ' +
  'at node:internal/webstreams/transformstream:568:16 | ' +
  'at process.processTicksAndRejections (node:internal/process/task_queues:103:5)';

describe('isConnectionAbort — правило', () => {
  it('настоящая строка журнала прода — обрыв', () => {
    expect(isConnectionAbort(PROD_MESSAGE, PROD_STACK)).toBe(true);
    expect(isConnectionAbort(`TypeError: ${PROD_MESSAGE}`, `  ${PROD_STACK}`)).toBe(true);
  });

  it('тот же текст с кадром нашего кода — ошибка, не обрыв', () => {
    const ours = PROD_STACK.replace(
      'at node:internal/webstreams/transformstream:568:16',
      'at renderPage (/app/.next/server/chunks/4512.js:1:2)',
    );
    expect(isConnectionAbort(PROD_MESSAGE, ours)).toBe(false);
  });

  it('кадр вне Node.js без скобок — ошибка, не обрыв', () => {
    const bare = PROD_STACK.replace(
      'at node:internal/webstreams/transformstream:568:16',
      'at /app/.next/server/app/map/page.js:1:1',
    );
    expect(isConnectionAbort(PROD_MESSAGE, bare)).toBe(false);
  });

  it('внутренний кадр, за которым в скобках не Node.js, — ошибка', () => {
    const mixed = PROD_STACK.replace(
      'at node:internal/webstreams/transformstream:568:16',
      'at node:internal/x (/app/lib/stream.js:1:1)',
    );
    expect(isConnectionAbort(PROD_MESSAGE, mixed)).toBe(false);
  });

  it('стек начат не во внутренностях потоков — ошибка', () => {
    const other = 'at handler (node:internal/process/task_queues:103:5)';
    expect(isConnectionAbort(PROD_MESSAGE, other)).toBe(false);
  });

  it('другой текст с тем же стеком — ошибка', () => {
    expect(isConnectionAbort('Cannot read properties of undefined', PROD_STACK)).toBe(false);
  });

  it('нет текста или стека — не обрыв: сказать нечем', () => {
    expect(isConnectionAbort(null, PROD_STACK)).toBe(false);
    expect(isConnectionAbort(PROD_MESSAGE, null)).toBe(false);
    expect(isConnectionAbort(PROD_MESSAGE, '')).toBe(false);
  });
});

function row(over: Partial<ServerErrorRow> = {}): ServerErrorRow {
  return {
    route: '/routes/[id]',
    method: 'GET',
    kind: 'render',
    n: 3,
    first_at: '2026-11-18 20:00:00+00',
    last_at: '2026-11-19 06:10:00+00',
    last_message: 'Cannot read properties of undefined',
    paths: ['/routes/abc'],
    last_digest: '1',
    last_stack: 'at Page (/app/.next/server/app/routes/page.js:1:2)',
    connection_abort: false,
    ...over,
  };
}

const abortRow = (route: string, n: number) =>
  row({ route, n, kind: 'render', last_message: PROD_MESSAGE, last_stack: PROD_STACK, connection_abort: true });

describe('дайджест и строка об обрывах', () => {
  it('нет обрывов — строки нет', () => {
    expect(connectionAbortsLine([])).toBeNull();
    expect(serverErrorsDigestText(25, [row()], false)).not.toContain('Обрывы соединения');
  });

  it('обрывы — одной строкой с числом и маршрутами; в счёт ошибок не входят', () => {
    const text = serverErrorsDigestText(25, [row()], false, [abortRow('/map', 9), abortRow('/catalog', 1)]);
    expect(text).toContain('не меньше 3, маршрутов 1');
    expect(text).toContain('Обрывы соединения: не меньше 10 (/map, /catalog)');
    expect(text).toContain('страница не падала');
    expect(text).not.toContain(PROD_MESSAGE);
  });
});

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/cron/prod-errors${qs}`, {
    headers: { Authorization: 'Bearer cron-test' },
  }));
}

const sent: string[] = [];

beforeEach(() => {
  poolQuery.mockClear();
  poolAnswer = () => [];
  sent.length = 0;
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok');
  vi.stubEnv('TELEGRAM_CHAT_ID', '42');
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    sent.push(String((JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? ''));
    return new Response('{"ok":true}', { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('GET /api/cron/prod-errors — обрывы отдельно', () => {
  it('обрывы — своим списком, в total и routes не входят', async () => {
    poolAnswer = () => [abortRow('/map', 9), row(), abortRow('/catalog', 1)];
    const body = await (await get('?hours=25')).json();
    expect(body.ok).toBe(true);
    expect(body.total).toBe(3);
    expect(body.routes).toBe(1);
    expect(body.errors.map((r: ServerErrorRow) => r.route)).toEqual(['/routes/[id]']);
    expect(body.connection_aborts.map((r: ServerErrorRow) => r.route)).toEqual(['/map', '/catalog']);
    expect(body.connection_aborts_total).toBe(10);
    expect(body.connection_aborts_note).toContain('Обрывы соединения: не меньше 10');
    // Признак обрыва спрашивается у базы, а не выводится в коде роута.
    const sql = String((poolQuery.mock.calls[0] as unknown[])[0]);
    expect(sql).toMatch(/AS connection_abort/);
    expect(sql).toMatch(/GROUP BY 1, 2/);
  });

  it('одни обрывы — дайджест не шлётся, причина названа', async () => {
    poolAnswer = () => [abortRow('/map', 9)];
    const res = await get('?hours=25&notify=1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(body.notify).toEqual({ sent: false, reason: 'ошибок нет, только обрывы соединения' });
    expect(body.total).toBe(0);
  });

  it('ошибки и обрывы — дайджест об ошибках со строкой об обрывах', async () => {
    poolAnswer = () => [row(), abortRow('/map', 9)];
    const res = await get('?hours=25&notify=1');
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('не меньше 3, маршрутов 1');
    expect(sent[0]).toContain('Обрывы соединения: не меньше 9 (/map)');
  });

  it('ничего — «ошибок нет», как раньше', async () => {
    const body = await (await get('?hours=25&notify=1')).json();
    expect(sent).toHaveLength(0);
    expect(body.notify).toEqual({ sent: false, reason: 'ошибок нет' });
    expect(body.connection_aborts).toEqual([]);
    expect(body.connection_aborts_note).toBeNull();
  });
});
