/**
 * Описания маршрутов, написанные агентом по одному названию, снимаются с
 * карточек до переписи по источникам (15.10, слово владельца «5 скрой»;
 * миграция 1261).
 *
 * Держится:
 *  - миграция переносит текст в архивную колонку, а не стирает его, — ровно
 *    у тех, кого назвала перепись (метка enriched_by = 'admin_api'), и только
 *    пока текст на месте;
 *  - карточка маршрута говорит словами, что описание убрано и
 *    переписывается, — не молчит пустым местом; переписанное снова
 *    показывается обычным текстом, без объяснения;
 *  - писатель enrich-routes не заполняет освободившееся описание новым
 *    текстом по тому же названию.
 * Экран и загрузчик судятся вызовом, SQL — по смыслу условий.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQuery = vi.fn();
// С 22.10 модель тексты мест не пишет — слово владельца
// (model-place-text-paused.test.ts держит выключенное). Здесь судится путь
// записи на день, когда его включат снова: проверки после модели должны
// стоять на месте.
vi.mock('@/lib/places/model-place-text', () => ({ MODEL_WRITES_PLACE_TEXT: true, MODEL_PLACE_TEXT_PAUSED_MESSAGE: '' }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
const dbQuery = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin' })) }));
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: vi.fn(async () => ''),
  callAIQualityOrNull: vi.fn(async () => null),
}));

import RouteDescriptionNotice from '@/components/routes/RouteDescriptionNotice';
import { enrichDescriptions } from '@/app/api/admin/enrich-routes/route';
import { loadRouteDetail } from '@/lib/routes/route-detail';

afterEach(cleanup);
beforeEach(() => { poolQuery.mockReset(); dbQuery.mockReset(); });

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1261_route_title_only_descriptions_withdrawn.sql'), 'utf-8');
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const NOTICE = /Описание этого маршрута было написано не по источникам — мы его убрали и переписываем по\s+справочникам/;

describe('миграция 1261', () => {
  it('текст переезжает в архив с причиной, а не стирается; ничего не удаляется', () => {
    expect(BODY).toMatch(/ADD COLUMN IF NOT EXISTS description_withdrawn TEXT/);
    expect(BODY).toMatch(/SET description_withdrawn = description,/);
    expect(BODY).toMatch(/description_withdrawn_reason = '[^']*по одному названию[^']*миграция 1261'/);
    expect(BODY).toMatch(/description = NULL,/);
    expect(BODY).not.toMatch(/DELETE FROM/);
  });

  it('отбор — метка агента, которой перепись назвала эти 150; повтор ничего не трогает', () => {
    const update = BODY.slice(BODY.indexOf('UPDATE kamchatka_routes'), BODY.indexOf('DO $$'));
    expect(update).toMatch(/WHERE metadata->>'enriched_by' = 'admin_api'/);
    expect(update).toMatch(/AND description IS NOT NULL/);
    expect(update).toMatch(/AND description_withdrawn IS NULL/);
    // Метку ставит только этот агент — иначе отбор задел бы чужие тексты.
    expect(readFileSync(join(ROOT, 'app/api/admin/enrich-routes/route.ts'), 'utf-8')).toMatch(/enriched_by: 'admin_api'/);
  });
});

describe('карточка маршрута', () => {
  it('снятое описание — словами, не тишиной', () => {
    const { container } = render(<RouteDescriptionNotice withdrawn hasDescription={false} />);
    expect(container.textContent).toMatch(NOTICE);
    expect(container.textContent).toMatch(/Факты ниже — из данных платформы/);
  });

  it('переписанное по источникам — без объяснения; не снятое — тоже', () => {
    expect(render(<RouteDescriptionNotice withdrawn hasDescription />).container.textContent).toBe('');
    cleanup();
    expect(render(<RouteDescriptionNotice withdrawn={false} hasDescription={false} />).container.textContent).toBe('');
  });

  it('загрузчик карточки отдаёт признак снятия, только пока описания нет', async () => {
    const row = (description: string | null) => ({
      id: 'r1', route_dedupe_key: 'r1', category: 'trekking', title: 'Маршрут', description,
      lat: null, lng: null, payload: {}, description_withdrawn: true, kr_id: 'r1', geometry: null,
    });
    for (const [description, expected] of [[null, true], ['Текст по паспорту маршрута.', false]] as const) {
      dbQuery.mockReset();
      dbQuery.mockImplementation(async (sql: string) =>
        /FROM agent_route_knowledge ark/.test(sql) ? { rows: [row(description)] } : { rows: [] });
      poolQuery.mockResolvedValue({ rows: [] });
      const res = await loadRouteDetail('r1', { explain: false, countView: false });
      expect(res.kind).toBe('found');
      const data = (res as { data: { descriptionWithdrawn?: boolean; description: string } }).data;
      expect(data.descriptionWithdrawn, String(description)).toBe(expected);
    }
  });

  it('загрузчик читает признак снятия, а сам снятый текст — нет', () => {
    const src = readFileSync(join(ROOT, 'lib/routes/route-detail.ts'), 'utf-8');
    expect(src).toMatch(/\(kr\.description_withdrawn IS NOT NULL\) AS description_withdrawn/);
    expect(src).not.toMatch(/kr\.description_withdrawn,/);
  });
});

describe('перепись описаний маршрутов называет снятые', () => {
  it('снятые считаются отдельно: «агент написал 0» не выдаётся за «таких не было»', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const route = (id: string, description: string | null, withdrawn: boolean) => ({
      id, title: `Маршрут ${id}`, description, lat: null, lng: null,
      distance_km: null, duration_hours: null, elevation_gain_m: null, has_line: false,
      enriched_by: null, park_name: null, hazards: null, withdrawn,
    });
    poolQuery.mockImplementation(async (sql: string) =>
      /FROM kamchatka_routes r/.test(sql)
        ? { rows: [route('a', null, true), route('b', 'Переписано по паспорту маршрута.', true), route('c', 'Обычный текст.', false)] }
        : { rows: [] });
    const { GET } = await import('@/app/api/cron/route-desc-census/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://localhost/api/cron/route-desc-census', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const body = await res.json() as { withdrawn: { total: number; rewritten: number }; with_description: number };
    expect(body.withdrawn).toEqual({ total: 2, rewritten: 1 });
    expect(body.with_description).toBe(2);
  });
});

describe('писатель не заполняет снятое описание маршрута текстом по названию', () => {
  it('enrich-routes выводит такие маршруты из очереди и из счёта', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\) as cnt/.test(sql)) return { rows: [{ cnt: '0' }] };
      return { rows: [] };
    });
    await enrichDescriptions(20, false, false);
    const pick = String(poolQuery.mock.calls.find((c) => /SELECT id, title/.test(String(c[0])))?.[0] ?? '');
    expect(pick).toMatch(/COALESCE\(wr\.ark_id, wr\.id\) = agent_route_knowledge\.id\s+AND wr\.description_withdrawn IS NOT NULL/);
    // Места (1247) — по-прежнему.
    expect(pick).toMatch(/w\.ark_id = agent_route_knowledge\.id\s+AND w\.description_withdrawn IS NOT NULL/);
  });

  it('маршрутам писатель не пишет вовсе: ни в очередь, ни в счёт остатка (15.10)', async () => {
    // Одна строка в партии: при пустой счёт остатка не спрашивается. Модель
    // отвечает null (мок выше) — запись не случается, счёт остатка идёт.
    poolQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\) as cnt/.test(sql)) return { rows: [{ cnt: '0' }] };
      if (/SELECT id, title/.test(sql)) {
        return { rows: [{ id: 'p1', title: 'Озеро Тестовое', description: null, category: null, location_type: 'lake', activity_type: null, lat: null, lng: null, payload: {} }] };
      }
      return { rows: [] };
    });
    await enrichDescriptions(20, false, false);
    const sqls = poolQuery.mock.calls.map((c) => String(c[0]));
    const pick = sqls.find((s) => /SELECT id, title/.test(s)) ?? '';
    const remaining = sqls.find((s) => /COUNT\(\*\) as cnt/.test(s)) ?? '';
    for (const s of [pick, remaining]) expect(s).toMatch(/AND kind = 'place'/);
  });
});
