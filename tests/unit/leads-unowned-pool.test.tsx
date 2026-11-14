/**
 * Заявка без адресата — только допущенному кабинету (14.11).
 *
 * До этого дня заявки без адресата (планер, главная, «подбор тура», сохранённая
 * поездка) с именем, телефоном и почтой читал ЛЮБОЙ вошедший с ролью оператора:
 * роль выдаётся обычной регистрацией, карточка партнёра создаётся там же. Теперь
 * их видит кабинет, чью карточку администратор поставил на витрину
 * (`partners.is_public`) — тот же признак, по которому добивка отдаёт такую
 * заявку оператору.
 *
 * Судится поведением:
 *  - дверь списка `GET /api/leads` — вызовом: что вернулось кабинету и что он
 *    узнал о закрытом списке;
 *  - экран заявок оператора — рендером через ту же дверь: чужого имени на экране
 *    нет, и сказано словами, почему список короче.
 *
 * База подменена таблицей в памяти, которая исполняет условие владения из
 * запроса (три его формы) — незнакомая форма условия роняет тест, а не читается
 * как «строк нет». На настоящем PostgreSQL то же держит сцена «заявка без
 * адресата — только допущенному кабинету» в
 * tests/integration/tourist-cabinet.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { NextRequest } from 'next/server';

interface Row {
  id: string; name: string; phone: string; email: string | null; comment: string | null;
  status: string; operator_id: string | null; created_at: string; updated_at: string;
  source_url: string | null; source_data: null; pd_consent_source: null;
  route_id: null; route_title: null; notes: null; ai_score: null; ai_summary: null;
  group_size: null; budget_rub: null; desired_dates: null; proposal_id: null;
}

const h = vi.hoisted(() => ({
  user: { userId: 'u-op', role: 'operator' } as { userId: string; role: string },
  access: { kind: 'owner', partnerId: 'P-OWN' } as Record<string, unknown>,
  /** Что записано в partners.is_public у кабинета; 'missing' — строки нет; 'down' — база не ответила. */
  isPublic: false as boolean | null | 'missing' | 'down',
  rows: [] as unknown[],
  leadQueries: 0,
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireRole: vi.fn(async () => h.user),
}));
vi.mock('@/lib/operators/team-access', () => ({
  operatorAccess: async () => h.access,
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, vals: unknown[] = []) => {
      if (/SELECT is_public FROM partners/.test(sql)) {
        if (h.isPublic === 'down') throw Object.assign(new Error('terminating connection'), { code: '57P01' });
        return { rows: h.isPublic === 'missing' ? [] : [{ is_public: h.isPublic }] };
      }
      if (!/FROM leads/.test(sql)) throw new Error(`неожиданный запрос: ${sql.slice(0, 80)}`);
      h.leadQueries += 1;
      let rows = h.rows as Row[];
      const where = sql.slice(sql.indexOf('FROM leads'));
      const st = /\bstatus = \$(\d+)/.exec(where);
      if (st) rows = rows.filter((r) => r.status === vals[Number(st[1]) - 1]);
      // Условие владения — одна из трёх форм lib/leads/ownership; иная — не «пусто», а отказ теста.
      const both = /\(operator_id = \$(\d+) OR operator_id IS NULL\)/.exec(where);
      const own = /\boperator_id = \$(\d+)/.exec(where);
      if (both) rows = rows.filter((r) => r.operator_id === vals[Number(both[1]) - 1] || r.operator_id === null);
      else if (own) rows = rows.filter((r) => r.operator_id === vals[Number(own[1]) - 1]);
      else if (/\bFALSE\b/.test(where)) rows = [];
      else if (/operator_id/.test(where)) throw new Error(`незнакомое условие владения: ${where.slice(0, 160)}`);
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: rows.length }] };
      const limit = Number(vals[vals.length - 2]);
      const offset = Number(vals[vals.length - 1]);
      return { rows: rows.slice(offset, offset + limit) };
    }),
  },
}));

import { GET } from '@/app/api/leads/route';
import OperatorLeadsClient, { UNOWNED_POOL_CLOSED_NOTE } from '@/app/hub/operator/leads/_LeadsClient';

function row(id: string, name: string, operatorId: string | null): Row {
  return {
    id, name, phone: '+70000000000', email: null, comment: null, status: 'new', operator_id: operatorId,
    created_at: '2026-11-14T00:00:00Z', updated_at: '2026-11-14T00:00:00Z',
    source_url: null, source_data: null, pd_consent_source: null,
    route_id: null, route_title: null, notes: null, ai_score: null, ai_summary: null,
    group_size: null, budget_rub: null, desired_dates: null, proposal_id: null,
  };
}

const OWN = 'Заявка своей компании';
const UNOWNED = 'Заявка без адресата';
const FOREIGN = 'Заявка чужой компании';

async function list(query = ''): Promise<{ status: number; names: string[]; total: number; pool: unknown }> {
  const res = await GET(new NextRequest(new URL(`/api/leads${query}`, 'https://vedarai.ru')));
  const body = await res.json() as { leads: Array<{ name: string }>; total: number; unowned_pool?: unknown };
  return { status: res.status, names: body.leads.map((l) => l.name), total: body.total, pool: body.unowned_pool };
}

beforeEach(() => {
  h.user = { userId: 'u-op', role: 'operator' };
  h.access = { kind: 'owner', partnerId: 'P-OWN' };
  h.isPublic = false;
  h.leadQueries = 0;
  h.rows = [row('l-own', OWN, 'P-OWN'), row('l-free', UNOWNED, null), row('l-other', FOREIGN, 'P-OTHER')];
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('GET /api/leads: заявка без адресата — только допущенному кабинету', () => {
  it('кабинет на витрине видит свои и заявки без адресата; чужих — нет', async () => {
    h.isPublic = true;
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.names.sort()).toEqual([UNOWNED, OWN].sort());
    expect(r.total).toBe(2);
    expect(r.pool).toBe('open');
  });

  it('кабинет не на витрине видит только свои — и в списке, и в счёте', async () => {
    for (const v of [false, null, 'missing'] as const) {
      h.isPublic = v;
      const r = await list();
      expect(r.names, String(v)).toEqual([OWN]);
      expect(r.total, String(v)).toBe(1);
      expect(r.pool, String(v)).toBe('closed');
    }
  });

  it('фильтр по статусу закрытый список не открывает', async () => {
    const r = await list('?status=new&limit=100');
    expect(r.names).toEqual([OWN]);
    expect(r.pool).toBe('closed');
  });

  it('вошедший с ролью оператора без карточки партнёра не видит ничего', async () => {
    h.access = { kind: 'none' };
    h.isPublic = true; // чужая строка в partners допуском ему не служит
    const r = await list();
    expect(r.names).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.pool).toBe('closed');
  });

  it('администратор видит все заявки', async () => {
    h.user = { userId: 'u-admin', role: 'admin' };
    const r = await list();
    expect(r.names.sort()).toEqual([UNOWNED, OWN, FOREIGN].sort());
    expect(r.pool).toBe('open');
  });

  it('допуск не прочитался — отказ, а не список: ни одного чтения заявок', async () => {
    h.isPublic = 'down';
    await expect(GET(new NextRequest(new URL('/api/leads', 'https://vedarai.ru'))))
      .rejects.toThrow(/допуск к заявкам без адресата не проверен: sqlstate 57P01/);
    expect(h.leadQueries).toBe(0);
  });

  it('кабинет не проверился — отказ, а не список', async () => {
    h.access = { kind: 'unavailable', reason: 'sqlstate 57P01' };
    await expect(GET(new NextRequest(new URL('/api/leads', 'https://vedarai.ru'))))
      .rejects.toThrow(/доступ к кабинету не проверен/);
    expect(h.leadQueries).toBe(0);
  });
});

describe('экран заявок оператора: закрытый список назван словами', () => {
  function throughTheDoor() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => GET(new NextRequest(new URL(String(url), 'https://vedarai.ru')))));
  }
  function renderFresh() {
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><OperatorLeadsClient /></SWRConfig>,
    );
  }
  const note = () => document.querySelector('[data-unowned-pool-closed]');

  it('кабинет не на витрине: своя заявка есть, заявки без адресата нет, причина названа', async () => {
    throughTheDoor();
    renderFresh();
    expect(await screen.findByText(OWN)).toBeTruthy();
    await waitFor(() => expect(note()?.textContent).toBe(UNOWNED_POOL_CLOSED_NOTE));
    expect(document.body.textContent).not.toContain(UNOWNED);
    expect(document.body.textContent).not.toContain(FOREIGN);
  });

  it('кабинет на витрине: заявка без адресата на экране, строки о закрытом списке нет', async () => {
    h.isPublic = true;
    throughTheDoor();
    renderFresh();
    expect(await screen.findByText(UNOWNED)).toBeTruthy();
    expect(screen.getByText(OWN)).toBeTruthy();
    expect(note()).toBeNull();
    expect(document.body.textContent).not.toContain(FOREIGN);
  });

  it('доска: закрытый список назван и там — доска грузит колонки сама', async () => {
    localStorage.setItem('operator-leads-view', 'board');
    throughTheDoor();
    renderFresh();
    expect(await screen.findByText(OWN)).toBeTruthy();
    await waitFor(() => expect(note()?.textContent).toBe(UNOWNED_POOL_CLOSED_NOTE));
    expect(document.body.textContent).not.toContain(UNOWNED);
  });

  it('строка говорит, что в таких заявках личные данные и кто даёт допуск', () => {
    expect(UNOWNED_POOL_CLOSED_NOTE).toContain('имя и телефон');
    expect(UNOWNED_POOL_CLOSED_NOTE).toContain('администратор Ведара');
  });
});
