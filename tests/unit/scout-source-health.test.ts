import { describe, it, expect } from 'vitest';
import {
  classifyFetch, applyRun, mapToRows, markAlertedInMap, formatScoutDeadSources,
  evaluateDeadSources, SCOUT_SOURCE_EXPECTATIONS,
  type ScoutHealthMap,
} from '@/lib/services/scout/source-health';
import type { SourceHealthEntry } from '@/lib/services/safety/source-health';

const HOUR = 3_600_000;

describe('classifyFetch — честный исход загрузки фида', () => {
  it('items>0 → ok, 0 → empty, ошибка → error', () => {
    expect(classifyFetch(5, false)).toBe('ok');
    expect(classifyFetch(0, false)).toBe('empty');
    expect(classifyFetch(0, true)).toBe('error');
    expect(classifyFetch(3, true)).toBe('error'); // ошибка приоритетнее
  });
});

describe('applyRun — обновление карты здоровья (чистая)', () => {
  const entry = (over: Partial<SourceHealthEntry> = {}): SourceHealthEntry =>
    ({ key: 'rata', label: 'RATA', status: 'empty', rawItems: 0, inserted: 0, ...over });

  it('первый прогон: ставит first_seen, last_nonempty=null при empty', () => {
    const t0 = new Date().toISOString();
    const map = applyRun({}, [entry()], t0);
    expect(map.rata.first_seen_at).toBe(t0);
    expect(map.rata.last_nonempty_at).toBeNull();
    expect(map.rata.last_status).toBe('empty');
  });

  it('ok двигает last_nonempty; first_seen сохраняется с первого раза', () => {
    const t0 = new Date(Date.now() - 100 * HOUR).toISOString();
    const t1 = new Date().toISOString();
    const m0 = applyRun({}, [entry({ status: 'empty' })], t0);
    const m1 = applyRun(m0, [entry({ status: 'ok', rawItems: 5 })], t1);
    expect(m1.rata.first_seen_at).toBe(t0);        // не перезаписан
    expect(m1.rata.last_nonempty_at).toBe(t1);     // подвинут на ok
    expect(m1.rata.raw_items).toBe(5);
  });

  it('empty после ok сохраняет прежний last_nonempty', () => {
    const t0 = new Date(Date.now() - 100 * HOUR).toISOString();
    const t1 = new Date().toISOString();
    const m0 = applyRun({}, [entry({ status: 'ok', rawItems: 4 })], t0);
    const m1 = applyRun(m0, [entry({ status: 'empty', rawItems: 0 })], t1);
    expect(m1.rata.last_nonempty_at).toBe(t0);     // не сбросился
    expect(m1.rata.last_status).toBe('empty');
  });
});

describe('evaluateDeadSources на scout-картах (переиспользование safety-логики)', () => {
  const now = Date.now();
  const mk = (over: Partial<ScoutHealthMap['x']>): ScoutHealthMap => ({
    hackernews: {
      label: 'Hacker News', last_status: 'empty', last_run_at: new Date(now).toISOString(),
      last_nonempty_at: null, first_seen_at: new Date(now).toISOString(), last_alerted_at: null, raw_items: 0,
      ...over,
    },
  });

  it('первый прогон пустого фида — НЕ мёртв (период привыкания)', () => {
    const dead = evaluateDeadSources(mapToRows(mk({})), SCOUT_SOURCE_EXPECTATIONS, now);
    expect(dead).toHaveLength(0);
  });

  it('фид ни разу не дал данных дольше порога — dead "never"', () => {
    // hackernews maxSilenceHours=96; наблюдаем 200ч
    const map = mk({ first_seen_at: new Date(now - 200 * HOUR).toISOString(), last_nonempty_at: null });
    const dead = evaluateDeadSources(mapToRows(map), SCOUT_SOURCE_EXPECTATIONS, now);
    expect(dead).toHaveLength(1);
    expect(dead[0].key).toBe('hackernews');
    expect(dead[0].reason).toBe('never');
  });

  it('фид давал данные, но молчит дольше порога — dead "silent"', () => {
    const map = mk({
      first_seen_at: new Date(now - 400 * HOUR).toISOString(),
      last_nonempty_at: new Date(now - 200 * HOUR).toISOString(),
      last_status: 'empty',
    });
    const dead = evaluateDeadSources(mapToRows(map), SCOUT_SOURCE_EXPECTATIONS, now);
    expect(dead[0].reason).toBe('silent');
    expect(dead[0].silentHours).toBeGreaterThanOrEqual(199);
  });

  it('живой фид (ok недавно) — не мёртв', () => {
    const map = mk({
      first_seen_at: new Date(now - 400 * HOUR).toISOString(),
      last_nonempty_at: new Date(now - 1 * HOUR).toISOString(),
      last_status: 'ok', raw_items: 5,
    });
    expect(evaluateDeadSources(mapToRows(map), SCOUT_SOURCE_EXPECTATIONS, now)).toHaveLength(0);
  });
});

describe('markAlertedInMap + formatScoutDeadSources', () => {
  it('markAlertedInMap проставляет last_alerted_at только заданным ключам', () => {
    const t = new Date().toISOString();
    const map = applyRun({}, [
      { key: 'rata', label: 'RATA', status: 'empty', rawItems: 0, inserted: 0 },
      { key: 'kamgov', label: 'Kamgov', status: 'ok', rawItems: 3, inserted: 0 },
    ], t);
    const marked = markAlertedInMap(map, ['rata'], t);
    expect(marked.rata.last_alerted_at).toBe(t);
    expect(marked.kamgov.last_alerted_at).toBeNull();
  });

  it('formatScoutDeadSources — формулировка разведки, перечисляет причины', () => {
    const text = formatScoutDeadSources([
      { key: 'rata', label: 'RATA', reason: 'silent', silentHours: 200 },
      { key: 'kamgov', label: 'Kamgov', reason: 'never', silentHours: null },
    ]);
    expect(text).toContain('Разведка Scout');
    expect(text).toContain('RATA: молчит 200 ч');
    expect(text).toContain('Kamgov: ни разу не дал данных');
    expect(text).toContain('фид мёртв');
  });
});
