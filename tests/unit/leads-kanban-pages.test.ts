/**
 * Доска лидов читает колонку через НАСТОЯЩИЙ роут (аудит 22.10).
 *
 * Канбан у администратора и у оператора просил `limit=200`, а схема
 * GET /api/leads пускает не больше 100 — каждая колонка получала 400, и доска
 * показывала ошибку загрузки. Тест рендера (leads-kanban.test.tsx) подменял
 * fetch готовым ответом 200 и расхождения двух чисел не видел.
 *
 * Здесь fetch доски уходит в сам обработчик роута: его Zod-схема судит адрес,
 * который строит доска. Подменены только вход администратора и база (таблица
 * лидов в памяти с LIMIT/OFFSET и счётом) — схему и разбор параметров не
 * подменяет ничто. Вернуть `limit=200` — 400 и красный тест; убрать чтение
 * страницами — колонка обрезана сотней и красный тест.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

interface Row { id: string; status: string; name: string; created_at: string }

const { table } = vi.hoisted(() => ({ table: { rows: [] as Row[] } }));

vi.mock('@/lib/auth/middleware', () => ({
  requireRole: vi.fn(async () => ({ userId: 'admin-test', role: 'admin', email: 'a@test' })),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, vals: unknown[] = []) => {
      const byStatus = /status = \$1/.test(sql) ? table.rows.filter((r) => r.status === vals[0]) : table.rows;
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: byStatus.length }] };
      const limit = Number(vals[vals.length - 2]);
      const offset = Number(vals[vals.length - 1]);
      return { rows: byStatus.slice(offset, offset + limit) };
    }),
  },
}));

import { GET } from '@/app/api/leads/route';
import { fetchColumn } from '@/app/hub/admin/leads/_LeadsKanban';
import { LEADS_PAGE_MAX } from '@/lib/leads/list-page';

function seed(status: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const ts = new Date(Date.UTC(2026, 9, 1) - (table.rows.length + i) * 60_000).toISOString();
    table.rows.push({ id: `${status}-${i}`, status, name: `Лид ${status} ${i}`, created_at: ts });
  }
}

let statuses: number[] = [];

beforeEach(() => {
  table.rows = [];
  statuses = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const res = await GET(new NextRequest(new URL(url, 'https://vedarai.ru')));
    statuses.push(res.status);
    return res;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('канбан лидов читает колонку настоящим роутом', () => {
  it('каждый запрос доски проходит схему роута — ни одного 400', async () => {
    seed('new', 3);
    const leads = await fetchColumn('new');
    expect(leads.map((l) => l.id)).toEqual(['new-0', 'new-1', 'new-2']);
    expect(statuses).toEqual([200]);
  });

  it('колонка длиннее страницы приходит целиком, страницами по потолку роута', async () => {
    seed('new', 230);
    seed('contacted', 4);
    const leads = await fetchColumn('new');
    expect(leads).toHaveLength(230);
    expect(new Set(leads.map((l) => l.id)).size).toBe(230);
    expect(leads.every((l) => l.status === 'new')).toBe(true);
    expect(statuses).toEqual([200, 200, 200]);
    for (const call of vi.mocked(fetch).mock.calls) {
      expect(new URL(String(call[0]), 'https://x').searchParams.get('limit')).toBe(String(LEADS_PAGE_MAX));
    }
  });

  it('ровно страница — второй запрос не нужен; пустая колонка — один запрос', async () => {
    seed('qualified', LEADS_PAGE_MAX);
    expect(await fetchColumn('qualified')).toHaveLength(LEADS_PAGE_MAX);
    expect(statuses).toEqual([200]);

    statuses = [];
    expect(await fetchColumn('lost')).toEqual([]);
    expect(statuses).toEqual([200]);
  });
});
