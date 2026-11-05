// @vitest-environment node
/**
 * Опасность по зонам доходит до спасателя (05.11).
 *
 * getZoneAssessment выбирал из представления v_current_danger колонку
 * similar_event. Она есть в таблице danger_assessments, но вьюха (миграция 069)
 * её не отдаёт: запрос отвечал 42703 на каждый вызов с 22.08. Rescue ловил
 * отказ, писал строку в лог и шёл дальше, а крон отвечал success — тревога
 * zone_danger не дошла до человека ни разу, и «не прочитали» выглядело как
 * «угроз нет» (§4.0).
 *
 * Сторож держит связку целиком:
 * 1. каждый читатель вьюхи просит только колонки, которые она отдаёт
 *    (вьюху реестр схемы считает wildcard — фантом там не ловится);
 * 2. отказ чтения оценки — failure проверки, а не тишина;
 * 3. скан Rescue кладёт этот отказ в failed_checks и тревогу check_failed;
 * 4. высокая оценка по-прежнему даёт тревогу zone_danger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
const poolQuery = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/planner/intelligence', () => ({ fetchForecastDays: vi.fn().mockResolvedValue([]) }));

import { getZoneAssessment, getFullDangerSummary, ZONES } from '@/lib/agents/agencies/danger-analyst-agency';
import { checkZoneDanger, runRescueScan } from '@/lib/agents/evo/rescue-agent';
import { ZONE_DANGER_SQL } from '@/lib/trips/situation-store';

const MIGRATIONS = join(process.cwd(), 'migrations');

/** Колонки последней редакции вьюхи v_current_danger — из самих миграций. */
function viewColumns(): Set<string> {
  const files = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  let body: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf-8');
    const m = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+v_current_danger\s+AS\s+SELECT\s+(?:DISTINCT\s+ON\s*\([^)]*\)\s*)?([\s\S]*?)\bFROM\b/i);
    if (m) body = m[1];
  }
  if (body === null) throw new Error('вьюха v_current_danger не найдена в migrations/');
  return new Set(body.split(',').map(c => c.trim().split(/\s+/).pop()!.toLowerCase()).filter(Boolean));
}

/** Список SELECT ... FROM v_current_danger — имена колонок. */
function selectedFromView(sql: string): string[] {
  const m = sql.match(/SELECT\s+([\s\S]*?)\s+FROM\s+v_current_danger/i);
  if (!m) throw new Error(`не SELECT из v_current_danger: ${sql.slice(0, 80)}`);
  return m[1].split(',').map(c => c.trim().toLowerCase());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  poolQuery.mockResolvedValue({ rows: [] });
});

describe('читатели v_current_danger просят только то, что вьюха отдаёт', () => {
  it('вьюха разобрана: в ней есть risk_level и нет similar_event', () => {
    const cols = viewColumns();
    expect(cols.has('risk_level')).toBe(true);
    expect(cols.has('similar_event')).toBe(false);
  });

  it('getZoneAssessment, getFullDangerSummary, сводка поездки', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await getZoneAssessment(ZONES[0]);
    await getFullDangerSummary();
    const sent = queryMock.mock.calls.map(c => String(c[0]));
    expect(sent).toHaveLength(2);
    const cols = viewColumns();
    for (const sql of [...sent, ZONE_DANGER_SQL]) {
      for (const col of selectedFromView(sql)) {
        expect(cols.has(col), `${col} нет во вьюхе v_current_danger`).toBe(true);
      }
    }
  });
});

describe('отказ чтения оценки — «не смог», а не «угроз нет»', () => {
  it('checkZoneDanger называет непрочитанные зоны', async () => {
    queryMock.mockRejectedValue(new Error('column "similar_event" does not exist'));
    const r = await checkZoneDanger();
    expect(r.alerts).toEqual([]);
    expect(r.failure).toMatch(/оценка не прочиталась/);
    expect(r.failure).toMatch(/similar_event/);
  });

  it('скан Rescue: отказ в failed_checks и тревога check_failed', async () => {
    queryMock.mockRejectedValue(new Error('column "similar_event" does not exist'));
    const scan = await runRescueScan();
    const zoneFail = scan.failed_checks.find(f => f.startsWith('опасность по зонам:'));
    expect(zoneFail).toBeDefined();
    expect(scan.alerts.some(a => a.type === 'check_failed' && a.body === zoneFail)).toBe(true);
  });

  it('высокая оценка — тревога zone_danger, failure нет', async () => {
    queryMock.mockImplementation((_sql: string, params: unknown[]) => Promise.resolve({
      rows: params[0] === ZONES[0]
        ? [{ zone: ZONES[0], risk_score: 81, risk_level: 'critical', threat_types: ['сейсмика'], tourists_at_risk: 12, active_tours_count: 2, confidence: 0.85 }]
        : [],
    }));
    const r = await checkZoneDanger();
    expect(r.failure).toBeNull();
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].type).toBe('zone_danger');
    expect(r.alerts[0].severity).toBe('critical');
    expect(r.alerts[0].body).toMatch(/Туристов в зоне риска: 12, активных туров: 2\./);
  });
});
