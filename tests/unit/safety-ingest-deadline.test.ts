/**
 * 03.11: GET safety-ingest висел дольше 120 с супервизора, heartbeat (пишется
 * в конце) не ложился четыре часа, и никто не знал, какой шаг висит.
 * Потолок прогона обязан быть меньше таймаута супервизора и писать heartbeat
 * «failed» с именами незавершённых шагов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ROUTE = readFileSync('app/api/cron/safety-ingest/route.ts', 'utf8');
const START = readFileSync('start.js', 'utf8');

describe('safety-ingest GET: потолок прогона', () => {
  it('потолок меньше таймаута супервизора', () => {
    const deadline = Number(ROUTE.match(/const GET_DEADLINE_MS = ([\d_]+)/)![1].replace(/_/g, ''));
    const sup = Number(START.match(/\/api\/cron\/safety-ingest',\s*everyMin: \d+,\s*timeoutMs: (\d+)/)![1]);
    expect(deadline).toBeLessThan(sup);
  });

  it('по потолку пишет heartbeat failed с висящими шагами и отвечает 504', () => {
    expect(ROUTE).toMatch(/Promise\.race\(\[run, deadline\]\)/);
    expect(ROUTE).toMatch(/logHeartbeat\(startedAt, Date\.now\(\) - t0, 0, 0, 'heartbeat_get', 'failed', detail\)/);
    expect(ROUTE).toMatch(/status: 504/);
  });

  it('каждый источник сбора отмечен трекером', () => {
    for (const n of ['ingestAll', 'FIRMS', 'meteoalert', 't.me/kbgsras', 't.me/eqkam', 'emsd.ru']) {
      expect(ROUTE).toContain(`tracked(pending, '${n}`);
    }
  });

  it('шаги после сбора тоже отмечены трекером', () => {
    for (const n of ['prune', 'dated-cap', 'road-anchor', 'volcano-anchor', 'статусы точек', 'push']) {
      expect(ROUTE).toContain(`tracked(pending, '${n}'`);
    }
  });

  it('пересчёт статусов точек — с потолком запроса в своей транзакции, меньше потолка прогона', () => {
    const deadline = Number(ROUTE.match(/const GET_DEADLINE_MS = ([\d_]+)/)![1].replace(/_/g, ''));
    const st = Number(ROUTE.match(/RT_STATUS_STATEMENT_TIMEOUT_MS = ([\d_]+)/)![1].replace(/_/g, ''));
    const lk = Number(ROUTE.match(/RT_STATUS_LOCK_TIMEOUT_MS = ([\d_]+)/)![1].replace(/_/g, ''));
    expect(st + lk).toBeLessThan(deadline);
    expect(ROUTE).toMatch(/SET LOCAL statement_timeout = \$\{RT_STATUS_STATEMENT_TIMEOUT_MS\}/);
    expect(ROUTE).toMatch(/SET LOCAL lock_timeout = \$\{RT_STATUS_LOCK_TIMEOUT_MS\}/);
    const fn = ROUTE.slice(ROUTE.indexOf('async function updateRealTimeStatus'));
    expect(fn.slice(0, 400)).toContain('transaction(async (client)');
  });
});
