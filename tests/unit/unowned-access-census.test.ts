/**
 * Перепись «кто проходил к заявкам без адресата» (14.11) — только числа.
 *
 * Заявку без адресата до 14.11 читал любой вошедший с ролью оператора. Читал ли
 * кто-то на деле, узнать нечем; перепись называет то, что узнать можно, и то,
 * чего узнать нельзя, — словами. Здесь судится:
 *   - сборка ответа — вызовом: сумма закрытых, слова итога, список «неизвестно»;
 *   - роут — вызовом: без секрета 401, отказ базы и пустой ответ — 500, а не
 *     «доступа ни у кого не было»; в ответе нет полей с именами, почтой,
 *     телефоном и id;
 *   - запросы только читают (запрет — по тексту самих запросов).
 * Что запросы выполняются и считают верно — сцена «заявка без адресата —
 * только допущенному кабинету» в tests/integration/tourist-cabinet.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import {
  ACCESS_ACCOUNTS_SQL, CARD_DEFAULT_SQL, HELD_BY_NOT_SHOWN_SQL, UNOWNED_LEADS_SQL, buildUnownedAccessCensus, shownByDefault,
} from '@/lib/leads/unowned-access-census';

const ACCOUNTS = { accounts_total: 20, admitted: 9, own_card_not_shown: 6, team_card_not_shown: 1, no_card: 4, closed_registered_90d: 3 };
const UNOWNED = { leads_total: 300, unowned_total: 41, unowned_not_own_probe: 38, unowned_30d: 7, unowned_90d: 19 };
const HELD = { leads: 12, cards: 2 };
const DEFAULT_OFF = { column_default: 'false' };

function answerWith(rows: { accounts?: unknown[]; unowned?: unknown[]; held?: unknown[]; cardDefault?: unknown[] }) {
  query.mockImplementation(async (sql: string) => {
    if (sql === ACCESS_ACCOUNTS_SQL) return { rows: rows.accounts ?? [ACCOUNTS] };
    if (sql === UNOWNED_LEADS_SQL) return { rows: rows.unowned ?? [UNOWNED] };
    if (sql === HELD_BY_NOT_SHOWN_SQL) return { rows: rows.held ?? [HELD] };
    if (sql === CARD_DEFAULT_SQL) return { rows: rows.cardDefault ?? [DEFAULT_OFF] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  });
}

const get = (secret?: string) => new NextRequest('http://localhost/api/cron/unowned-leads-access-census', {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const route = async () => (await import('@/app/api/cron/unowned-leads-access-census/route')).GET;

beforeEach(() => {
  query.mockReset();
  process.env.CRON_SECRET = 'census-secret';
});

describe('сборка ответа переписи', () => {
  it('закрытые сейчас — сумма трёх групп; итог называет каждую и заявки', () => {
    const c = buildUnownedAccessCensus(ACCOUNTS, UNOWNED, HELD, DEFAULT_OFF);
    expect(c.accounts.closed_now).toBe(11);
    expect(c.accounts.admitted + c.accounts.closed_now).toBe(c.accounts.accounts_total);
    expect(c.verdict).toContain('Аккаунтов с ролью оператора 20');
    expect(c.verdict).toContain('по-прежнему видят 9');
    expect(c.verdict).toContain('Закрыто с 14.11: 11 — своя карточка не на витрине 6, карточка команды не на витрине 1, без карточки 4');
    expect(c.verdict).toContain('за 90 дней 3');
    expect(c.verdict).toContain('Заявок без адресата в базе 41 (за 30 дней 7, за 90 дней 19)');
    expect(c.held_by_not_shown_cards).toEqual(HELD);
  });

  it('чего перепись не знает, названо словами: чтение не записывалось, занятая и адресованная не различаются', () => {
    const c = buildUnownedAccessCensus(ACCOUNTS, UNOWNED, HELD, DEFAULT_OFF);
    expect(c.not_known.join(' ')).toContain('чтение не записывалось');
    expect(c.not_known.join(' ')).toContain('не различаются');
  });

  it('нули — тоже ответ: закрытых нет, и это сказано числом, а не пропуском', () => {
    const c = buildUnownedAccessCensus(
      { accounts_total: 3, admitted: 3, own_card_not_shown: 0, team_card_not_shown: 0, no_card: 0, closed_registered_90d: 0 },
      { leads_total: 0, unowned_total: 0, unowned_not_own_probe: 0, unowned_30d: 0, unowned_90d: 0 },
      { leads: 0, cards: 0 },
      DEFAULT_OFF,
    );
    expect(c.accounts.closed_now).toBe(0);
    expect(c.verdict).toContain('Закрыто с 14.11: 0');
  });

  it('умолчание колонки «на витрине»: выключено, включено и «не прочитано» — три разных ответа', () => {
    for (const d of ['false', "'f'::boolean", 'FALSE']) expect(shownByDefault({ column_default: d }), d).toBe(false);
    // Умолчания нет вовсе — в колонку ляжет NULL, а дверь считает NULL «не на витрине».
    expect(shownByDefault({ column_default: null })).toBe(false);
    for (const d of ['true', "'t'::boolean"]) expect(shownByDefault({ column_default: d }), d).toBe(true);
    expect(shownByDefault({ column_default: 'some_function()' })).toBeNull();

    const off = buildUnownedAccessCensus(ACCOUNTS, UNOWNED, HELD, DEFAULT_OFF);
    expect(off.new_card_default).toEqual({ column_default: 'false', shown_by_default: false });
    expect(off.verdict).toContain('Новая карточка без слова администратора на витрину не попадает.');
    expect(off.verdict).not.toContain('ВНИМАНИЕ');

    const on = buildUnownedAccessCensus(ACCOUNTS, UNOWNED, HELD, { column_default: 'true' });
    expect(on.new_card_default.shown_by_default).toBe(true);
    expect(on.verdict).toContain('ВНИМАНИЕ: новая карточка по умолчанию попадает на витрину');

    const odd = buildUnownedAccessCensus(ACCOUNTS, UNOWNED, HELD, { column_default: 'some_function()' });
    expect(odd.new_card_default.shown_by_default).toBeNull();
    expect(odd.verdict).toContain('ВНИМАНИЕ: умолчание колонки «на витрине» не прочитано (some_function())');
  });
});

describe('GET /api/cron/unowned-leads-access-census', () => {
  it('без секрета и с чужим секретом — 401, база не спрашивается', async () => {
    answerWith({});
    const GET = await route();
    expect((await GET(get())).status).toBe(401);
    expect((await GET(get('wrong-secret'))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('ответ — числа и слова; полей с именем, почтой, телефоном и id в нём нет', async () => {
    answerWith({});
    const res = await (await route())(get('census-secret'));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true, probe: 'unowned_leads_access_v1',
      accounts: { accounts_total: 20, admitted: 9, closed_now: 11 },
      unowned_leads: { unowned_total: 41 },
      held_by_not_shown_cards: { leads: 12, cards: 2 },
      new_card_default: { column_default: 'false', shown_by_default: false },
    });
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(body);
    expect(keys.filter((k) => /(^|_)(id|ids|name|email|phone|user|slug)$/i.test(k))).toEqual([]);
  });

  it('база не ответила — 500 с SQLSTATE, а не «доступа ни у кого не было»', async () => {
    query.mockRejectedValue(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    const res = await (await route())(get('census-secret'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, reason: 'база не ответила', sqlstate: '57P01' });
  });

  it('один из запросов вернул ноль строк — отказ, а не нули', async () => {
    for (const part of ['accounts', 'unowned', 'held', 'cardDefault'] as const) {
      answerWith({ [part]: [] });
      const res = await (await route())(get('census-secret'));
      expect(res.status, part).toBe(500);
      expect((await res.json() as { ok: boolean }).ok, part).toBe(false);
    }
  });
});

describe('перепись только читает', () => {
  it('в запросах нет записи и нет выборки личных полей', () => {
    for (const sql of [ACCESS_ACCOUNTS_SQL, UNOWNED_LEADS_SQL, HELD_BY_NOT_SHOWN_SQL, CARD_DEFAULT_SQL]) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
      expect(sql).not.toMatch(/\b(email|phone|password_hash|comment)\b/i);
    }
    for (const sql of [ACCESS_ACCOUNTS_SQL, UNOWNED_LEADS_SQL, HELD_BY_NOT_SHOWN_SQL]) {
      // Наружу — только счёт: в итоговом SELECT нет ни одной колонки без COUNT.
      const final = sql.slice(sql.lastIndexOf('SELECT COUNT'));
      expect(final.split('FROM')[0].split(',\n').every((part) => /COUNT\(/.test(part)), sql.slice(0, 40)).toBe(true);
    }
  });
});
