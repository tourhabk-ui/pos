/**
 * Перепись нагрузки Кузьмича (#1995): только читает, только числа, и не
 * выдаёт смещённую выборку за долю «простых» вопросов.
 *
 * Роутер намерений экономит деньги пропорционально объёму. Прежде чем его
 * строить, эта перепись отвечает, сколько обращений и сколько они стоят.
 * Сторожу держать три обещания её шапки:
 *
 * 1. Не пишет — ни при каких аргументах (по исходнику, как у соседних переписей).
 * 2. Не отдаёт переписку: хранится она сырой (без redactPII), а ответ переписи
 *    уходит в лог GitHub Actions. Только числа.
 * 3. Не считает «долю простых» по agent_knowledge (type='outcome'): туда
 *    попадают только вопросы с ключевыми словами о местах и только плохие или
 *    каждый десятый хороший ответ. Число по такой выборке выглядело бы
 *    измерением, будучи артефактом фильтра (§4.0).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { MANUAL_ENDPOINTS, DECLARED } from '@/lib/agents/cron-schedulers';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { GET } from '@/app/api/cron/kuzmich-load-census/route';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/kuzmich-load-census/route.ts'), 'utf-8');

/** Код без комментариев: в шапке слова вроде agent_knowledge стоят по делу. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const at = l.indexOf('//'); return at === -1 ? l : l.slice(0, at); })
    .join('\n');
}

const SECRET = 'test-cron-secret';
const req = (qs = '', auth = true) => new NextRequest(
  `https://vedarai.ru/api/cron/kuzmich-load-census${qs}`,
  { headers: auth ? { authorization: `Bearer ${SECRET}` } : {} },
);

/** Ответы БД по признаку в SQL — порядок Promise.all не важен. */
function mockDb(overrides: Partial<Record<'tg' | 'tgDaily' | 'web' | 'llm' | 'llmModels', unknown[] | Error>> = {}) {
  const pick = (key: keyof typeof overrides, def: unknown[]) => {
    const v = overrides[key];
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve({ rows: v ?? def });
  };
  query.mockImplementation((sql: string) => {
    if (sql.includes('FROM tg_conversations') && sql.includes('GROUP BY 1')) return pick('tgDaily', []);
    if (sql.includes('FROM tg_conversations')) return pick('tg', []);
    if (sql.includes('FROM chat_sessions')) return pick('web', []);
    if (sql.includes('FROM llm_usage_log') && sql.includes('GROUP BY route')) return pick('llmModels', []);
    if (sql.includes('FROM llm_usage_log')) return pick('llm', []);
    return Promise.reject(new Error(`непредусмотренный запрос: ${sql.slice(0, 60)}`));
  });
}

beforeEach(() => {
  query.mockReset();
  vi.stubEnv('CRON_SECRET', SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe('перепись только читает', () => {
  const code = codeOnly(ROUTE);

  it('в коде нет ни одного пишущего выражения', () => {
    for (const verb of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE', 'ALTER']) {
      expect(code, `найдено ${verb}`).not.toMatch(new RegExp(`\\b${verb}\\b`, 'i'));
    }
  });

  it('экспортирован только GET, закрыт CRON_SECRET', () => {
    expect(ROUTE).toMatch(/export async function GET\(/);
    expect(ROUTE).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\(/);
    expect(code).toMatch(/getCronSecret/);
    expect(code).toMatch(/timingSafeCompare/);
  });

  it('без секрета — 401 с причиной, и в БД не ходит', async () => {
    const res = await GET(req('', false));
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('missing');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('долю «простых» по смещённой выборке не считает', () => {
  it('agent_knowledge не запрашивается', () => {
    // Слово может стоять в предупреждении ответа — там объясняется, ПОЧЕМУ
    // таблицу не читают. Запрещён запрос, а не упоминание.
    expect(codeOnly(ROUTE)).not.toMatch(/(FROM|JOIN)\s+agent_knowledge/i);
  });

  it('короткие сообщения названы мерой длины, а не намерения', () => {
    expect(ROUTE).toMatch(/мера длины[^.]*а не намерения/);
  });
});

describe('переписку наружу не отдаёт', () => {
  it('ни текста, ни имени, ни идентификатора собеседника не выбирается', () => {
    const code = codeOnly(ROUTE);
    // content допустим только внутри char_length(...) — длина, не текст.
    expect(code.replace(/char_length\(content\)/g, '')).not.toMatch(/\bcontent\b/);
    expect(code).not.toMatch(/\buser_name\b|\bmessages\b|interests_encrypted|utm_/);
    // chat_id — только под COUNT(DISTINCT ...), не отдельной колонкой.
    expect(code.replace(/COUNT\(DISTINCT chat_id\)/g, '')).not.toMatch(/\bchat_id\b/);
  });

  it('в ответе нет ключей с текстом или идентификаторами', async () => {
    mockDb({
      tg: [{ platform: 'telegram', mode: 'tourist', user_messages: 5, assistant_messages: 5, chats: 2, short_user_messages: 1, first: '2026-09-01', last: '2026-09-20' }],
    });
    const body = JSON.stringify(await (await GET(req())).json());
    for (const key of ['"content"', '"messages"', '"chat_id"', '"user_name"', '"user_id"']) {
      expect(body, `в ответе ключ ${key}`).not.toContain(key);
    }
  });
});

describe('три исхода, а не два', () => {
  it('данные есть — 200, NULL канала назван словами', async () => {
    mockDb({
      tg: [
        { platform: 'telegram', mode: 'tourist', user_messages: 40, assistant_messages: 40, chats: 12, short_user_messages: 9, first: 'a', last: 'b' },
        { platform: null, mode: 'max', user_messages: 3, assistant_messages: 3, chats: 1, short_user_messages: 0, first: 'a', last: 'b' },
      ],
      llm: [
        { untracked: true, calls: 120, tokens: 90000, known_cost_usd: 0.42, calls_unknown_price: 7 },
        { untracked: false, calls: 30, tokens: 400000, known_cost_usd: 3.1, calls_unknown_price: 0 },
      ],
    });
    const res = await GET(req('?days=7'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.window_days).toBe(7);
    expect(body.telegram_max.data[1].platform).toBe('(platform не записан)');
    expect(body.llm.data.untracked_upper_bound_for_kuzmich).toEqual({ calls: 120, tokens: 90000, known_cost_usd: 0.42, calls_unknown_price: 7 });
    expect(body.llm.data.attributed_to_agents.calls).toBe(30);
  });

  it('вызовов не было — потрачен известный ноль, а не «цена неизвестна»', async () => {
    mockDb();
    const body = await (await GET(req())).json();
    expect(body.llm.data.untracked_upper_bound_for_kuzmich).toEqual({ calls: 0, tokens: 0, known_cost_usd: 0, calls_unknown_price: 0 });
  });

  it('цены у всех строк нет — null остаётся null, не превращается в ноль', async () => {
    mockDb({ llm: [{ untracked: true, calls: 4, tokens: 100, known_cost_usd: null, calls_unknown_price: 4 }] });
    const body = await (await GET(req())).json();
    expect(body.llm.data.untracked_upper_bound_for_kuzmich.known_cost_usd).toBeNull();
    expect(body.llm.data.untracked_upper_bound_for_kuzmich.calls_unknown_price).toBe(4);
  });

  it('отказ одного раздела — 502 и имя раздела, остальные на месте', async () => {
    mockDb({ web: new Error('relation "chat_sessions" does not exist') });
    const res = await GET(req());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.refused_sections).toEqual(['web']);
    expect(body.web).toEqual({ refused: true, error: 'relation "chat_sessions" does not exist' });
    expect(body.telegram_max.refused).toBe(false);
  });

  it('окно зажато в 1..365, мусор — умолчание 30', async () => {
    mockDb();
    expect((await (await GET(req('?days=9999'))).json()).window_days).toBe(365);
    expect((await (await GET(req('?days=abc'))).json()).window_days).toBe(30);
  });
});

describe('род роута объявлен', () => {
  it('ручная непишущая перепись в реестре планировщиков', () => {
    const decl = MANUAL_ENDPOINTS['kuzmich-load-census'];
    expect(decl, 'kuzmich-load-census не объявлен в cron-schedulers').toBeTruthy();
    expect(decl.kind).toBe('manual');
    expect(decl.writes).toBe(false);
    expect(DECLARED['kuzmich-load-census']).toBeTruthy();
  });
});
