/**
 * Перепись задержки сейсмики (01.10): по каждому толчку — время очага, время
 * записи и задержка против нормы 15 минут; разрывы прогонов приёма; пары
 * записей, похожие на один толчок дважды.
 *
 * Повод: M5.0 30.09 18:36 UTC владелец увидел через пять часов, и «опоздал
 * приём» от «не перечитался экран» по ленте было не отличить — в ленте время
 * очага, а не записи.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  seismicSourceOf,
  quakeLatency,
  summarizeBySource,
  suspectedDuplicates,
  SEISMIC_DELIVERY_NORM_MIN,
  SUSPECT_WINDOW_MIN,
  type QuakeRow,
} from '@/lib/safety/seismic-latency';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/seismic-latency-census/route.ts'), 'utf-8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/--[^\n]*/g, '');

const row = (over: Partial<QuakeRow>): QuakeRow => ({
  id: '1', externalId: 't.me/eqkam/1', magnitude: 5, lat: 52.2028, lng: 160.6734,
  eventAt: '2026-09-30T18:36:18.000Z', ingestedAt: '2026-09-30T18:45:00.000Z', ...over,
});

describe('источник — по внешнему id записи', () => {
  it('каждый путь приёма узнаётся', () => {
    expect(seismicSourceOf('t.me/eqkam/9001')).toBe('eqkam');
    expect(seismicSourceOf('t.me/kbgsras/12')).toBe('kbgsras');
    expect(seismicSourceOf('usgs/us7000abcd')).toBe('usgs');
    expect(seismicSourceOf('www.emsd.ru/eq/2026-09-30T18:36:18Z')).toBe('emsd');
    expect(seismicSourceOf(null)).toBe('other');
  });
});

describe('задержка — от очага до записи', () => {
  it('минуты и суждение против нормы', () => {
    const fast = quakeLatency(row({}));
    expect(fast.latencyMin).toBe(9);
    expect(fast.late).toBe(false);
    const slow = quakeLatency(row({ ingestedAt: '2026-09-30T23:30:00.000Z' }));
    expect(slow.latencyMin).toBe(294);
    expect(slow.late).toBe(true);
  });

  it('нет записи в журнале — задержка неизвестна, а не ноль', () => {
    const q = quakeLatency(row({ ingestedAt: null }));
    expect(q.latencyMin).toBeNull();
    expect(q.late).toBeNull();
  });

  it('норма — пятнадцать минут, из самого воркфлоу приёма', () => {
    expect(SEISMIC_DELIVERY_NORM_MIN).toBe(15);
  });
});

describe('сводка по источникам', () => {
  it('медиана и максимум — только по измеренному', () => {
    const items = [
      quakeLatency(row({ id: 'a', ingestedAt: '2026-09-30T18:41:18.000Z' })), // 5
      quakeLatency(row({ id: 'b', ingestedAt: '2026-09-30T18:46:18.000Z' })), // 10
      quakeLatency(row({ id: 'c', ingestedAt: '2026-09-30T23:36:18.000Z' })), // 300
      quakeLatency(row({ id: 'd', ingestedAt: null })),
    ];
    const [s] = summarizeBySource(items);
    expect(s).toMatchObject({ source: 'eqkam', quakes: 4, measured: 3, medianMin: 10, maxMin: 300, late: 1 });
  });

  it('ничего не измерено — медианы нет, а не ноль', () => {
    const [s] = summarizeBySource([quakeLatency(row({ ingestedAt: null }))]);
    expect(s.medianMin).toBeNull();
    expect(s.maxMin).toBeNull();
  });
});

describe('один толчок, записанный дважды', () => {
  // Снимок владельца 01.10: M5.5 и M5.0, оба «5 ч назад». Бюллетень EQKam шёл
  // временем поста (18:42), агентство — временем очага (18:36).
  const eqkam = quakeLatency(row({ id: 'e', eventAt: '2026-09-30T18:42:10.000Z', magnitude: 5 }));
  const usgs = quakeLatency(row({
    id: 'u', externalId: 'usgs/us7000abcd', eventAt: '2026-09-30T18:36:21.000Z', magnitude: 5.5, lat: 52.15, lng: 160.6,
  }));

  it('пара разных источников в шесть минут и десяток километров — подозрение', () => {
    const d = suspectedDuplicates([eqkam, usgs]);
    expect(d).toHaveLength(1);
    expect(d[0].minutesApart).toBeCloseTo(5.8, 1);
    expect(d[0].kmApart).toBeLessThan(15);
  });

  it('тот же источник дважды — не пара: это два толчка одного агентства', () => {
    expect(suspectedDuplicates([eqkam, quakeLatency(row({ id: 'e2', eventAt: '2026-09-30T18:44:00.000Z' }))])).toEqual([]);
  });

  it('далеко по времени или по месту — не пара', () => {
    const later = quakeLatency(row({ id: 'u2', externalId: 'usgs/x', eventAt: '2026-09-30T19:10:00.000Z' }));
    const far = quakeLatency(row({ id: 'u3', externalId: 'usgs/y', lat: 55.9, lng: 160.6 }));
    expect(SUSPECT_WINDOW_MIN).toBe(15);
    expect(suspectedDuplicates([eqkam, later])).toEqual([]);
    expect(suspectedDuplicates([eqkam, far])).toEqual([]);
  });

  it('без координат судить не по чему — не пара', () => {
    expect(suspectedDuplicates([eqkam, quakeLatency(row({ id: 'n', externalId: 'usgs/z', lat: null, lng: null }))])).toEqual([]);
  });
});

describe('роут переписи', () => {
  const src = code(ROUTE);

  it('только читает', () => {
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
  });

  it('время записи — из журнала 925, событие published', () => {
    expect(src).toMatch(/FROM safety_decision_events e/);
    expect(src).toMatch(/e\.event_type = 'published'/);
  });

  it('время очага приводится к поясу в самой базе, а не в процессе Node', () => {
    expect(src).toMatch(/ea\.created_at::timestamptz AS event_at/);
  });

  it('окно — через Zod и умножение интервала, без склейки строки', () => {
    expect(src).toMatch(/z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(168\)/);
    expect(src).toMatch(/\$1::int \* INTERVAL '1 hour'/);
  });

  it('отказ запроса — названная причина, а не пустой список', () => {
    expect(src).toMatch(/return \{ ok: false, error:/);
  });

  it('вердикт без измерений — «не знаем», а не «в норме»', () => {
    expect(src).toMatch(/measured\.length === 0\s*\n?\s*\? 'unknown'/);
  });

  it('401 объясняет, чего не хватило', () => {
    expect(src).toMatch(/\{ error: 'Unauthorized', \.\.\.diagnoseCronAuth\(request\) \}/);
  });
});
