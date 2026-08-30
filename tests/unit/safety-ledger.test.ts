/**
 * Safety Decision Ledger (925) — сторожа формы кода и поведения.
 *
 * Реальная атомарность append-only триггера и настоящее нарушение
 * констрейнта проверяются в tests/integration/safety-ledger.pg.test.ts
 * (моки такое не доказывают, прецедент 42P08 из CLAUDE.md). Здесь —
 * fail-soft поведение appendSafetyEvent (мок pool.query) и текстовые
 * сторожа на точки врезки/осознанные исключения.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { appendSafetyEvent, hashPayload, type SafetyLedgerEventType } from '@/lib/safety/ledger';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIGRATION = read('migrations/925_safety_decision_events.sql');
const SEISMIC = read('lib/services/safety/seismic-parser.ts');
const INGEST_ROUTE = read('app/api/cron/safety-ingest/route.ts');

beforeEach(() => {
  queryMock.mockReset();
});

describe('appendSafetyEvent — fail-soft', () => {
  it('успех: возвращает {ok:true, id}', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: '42' }] });
    const res = await appendSafetyEvent({ entityId: null, eventType: 'source_observed', actorType: 'source' });
    expect(res).toEqual({ ok: true, id: 42 });
  });

  it('отказ БД ловится сам — не бросает исключение, возвращает {ok:false, reason}', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appendSafetyEvent({ entityId: null, eventType: 'fetch_failed', actorType: 'source' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('connection refused');
    // §4.0: «не смог записать» не молчит — причина в логе, не в пустом catch.
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('hashPayload', () => {
  it('детерминирован независимо от порядка ключей', () => {
    const a = hashPayload({ title: 'X', alert_type: 'flood' });
    const b = hashPayload({ alert_type: 'flood', title: 'X' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('разный payload — разный hash', () => {
    expect(hashPayload({ title: 'X' })).not.toBe(hashPayload({ title: 'Y' }));
  });
});

describe('фаза 1: закрытый список событий БЕЗ выдуманных переходов (§4.0)', () => {
  it('human_approved/human_rejected/superseded/expired НЕ в TS union — нет реального писателя', () => {
    // Компиляция уже проверяет типы; здесь — явный текстовый сторож, чтобы
    // случайное добавление одного из этих значений в lib/safety/ledger.ts
    // без реального emit-кода упало явно, а не осталось незамеченным.
    const src = read('lib/safety/ledger.ts');
    const unionBlock = src.slice(src.indexOf('export type SafetyLedgerEventType'), src.indexOf(';', src.indexOf('export type SafetyLedgerEventType')));
    for (const forbidden of ['human_approved', 'human_rejected', 'superseded', 'expired']) {
      expect(unionBlock).not.toContain(`'${forbidden}'`);
    }
  });

  it('geo_unmatched объявлен в типе, но НЕ эмитится из saveEvent — mchs_zones маскирует fallback (§4.0)', () => {
    // Тип остаётся в union для будущего (когда появится инструментирование
    // mchs_zones), но фаза 1 честно не претендует на различение match/fallback.
    const type: SafetyLedgerEventType = 'geo_unmatched';
    expect(type).toBe('geo_unmatched');
    expect(SEISMIC).not.toMatch(/eventType:\s*'geo_unmatched'/);
  });
});

describe('точки врезки: seismic-parser.ts saveEvent — единственный choke-point', () => {
  it('signal_normalized/risk_classified/geo_matched эмитятся до дедуп-развилки', () => {
    expect(SEISMIC).toContain("eventType: 'signal_normalized'");
    expect(SEISMIC).toContain("eventType: 'risk_classified'");
    expect(SEISMIC).toContain("eventType: 'geo_matched'");
  });

  it('dedup_skipped — и на content-дедупе, и на ON CONFLICT DO NOTHING', () => {
    const matches = SEISMIC.match(/'dedup_skipped'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('published — только на реальной вставке', () => {
    expect(SEISMIC).toContain("eventType: inserted ? 'published' : 'dedup_skipped'");
  });

  it('wildfire-firms.ts переиспользует saveEvent — отдельной врезки не заводит', () => {
    const wildfire = read('lib/services/safety/wildfire-firms.ts');
    expect(wildfire).toMatch(/saveEvent/);
    expect(wildfire).not.toMatch(/appendSafetyEvent/);
  });
});

describe('точки врезки: safety-ingest/route.ts', () => {
  it('entryFor эмитит source_observed/fetch_failed, не для not_configured/not_fetched', () => {
    expect(INGEST_ROUTE).toContain("eventType: 'source_observed'");
    expect(INGEST_ROUTE).toContain("eventType: 'fetch_failed'");
    expect(INGEST_ROUTE).toMatch(/status === 'ok' \|\| status === 'empty'/);
  });

  it('updateRealTimeStatus эмитит route_or_tour_impact_calculated ОДИН раз на прогон (агрегат, не per-alert)', () => {
    expect(INGEST_ROUTE).toContain("eventType: 'route_or_tour_impact_calculated'");
  });

  it('dispatchPushAlerts эмитит traveller_notified на КАЖДЫЙ разосланный алерт', () => {
    expect(INGEST_ROUTE).toContain("eventType: 'traveller_notified'");
    // entityId = String(alert.id) — привязан к конкретному алерту, не к прогону.
    expect(INGEST_ROUTE).toMatch(/entityId:\s*String\(alert\.id\)/);
  });
});

describe('миграция 925: append-only по прецеденту agent_events (917)', () => {
  it('таблица + триггер BEFORE UPDATE OR DELETE ... RAISE EXCEPTION', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS safety_decision_events/);
    expect(MIGRATION).toMatch(/BEFORE UPDATE OR DELETE ON safety_decision_events/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'safety_decision_events append-only/);
  });

  it('event_type БЕЗ CHECK-констрейнта — контроль в TS union (прецедент agent_events.event_type)', () => {
    const ddlStart = MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS safety_decision_events');
    const col = MIGRATION.slice(MIGRATION.indexOf('event_type', ddlStart), MIGRATION.indexOf('\n', MIGRATION.indexOf('event_type', ddlStart)));
    expect(col).not.toMatch(/CHECK/);
  });

  it('entity_id без FK — entity_type подразумевает несколько типов сущности в будущем', () => {
    const ddlStart = MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS safety_decision_events');
    const col = MIGRATION.slice(MIGRATION.indexOf('entity_id', ddlStart), MIGRATION.indexOf('\n', MIGRATION.indexOf('entity_id', ddlStart)));
    expect(col).not.toMatch(/REFERENCES/);
  });
});

describe('API кокпита журнала: только чтение', () => {
  const API = read('app/api/admin/safety/ledger/route.ts');
  it('только GET, requireAdmin до первого запроса', () => {
    expect(API).toMatch(/export async function GET/);
    expect(API).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(API.indexOf('requireAdmin')).toBeLessThan(API.indexOf('pool.query'));
  });

  it('ни одной мутации в SQL', () => {
    const code = API.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/INSERT\s+INTO|UPDATE\s+safety|DELETE\s+FROM/i);
  });
});
