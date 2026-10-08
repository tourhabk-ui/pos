// @vitest-environment node
/**
 * Прогресс по маршруту переживает закрытие экрана (владелец 09.10, «На
 * маршруте»: «повторное открытие не сохраняет точку, а ставит её в рандомном
 * месте»).
 *
 * Номер текущей точки жил только в памяти экрана, а при открытии прилипал к
 * ближайшей точке по GPS. Теперь он сохраняется по маршруту, а положение —
 * запасной путь, когда сохранённого нет или ему нельзя верить.
 *
 * Держится:
 * 1. исходы чтения: годен / нет записи / устарела / маршрут стал другим / побита;
 * 2. запись и стирание, отказ хранилища не ломает экран;
 * 3. привязка к экрану: восстановление раньше прилипания к GPS, запись после
 *    решения, «начать заново» стирает, прежнее правило входа на маршрут цело.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WP_PROGRESS_MAX_AGE_MS, wpProgressKey, readWpProgress, writeWpProgress, clearWpProgress,
  type StorageLike,
} from '@/lib/on-route/wp-progress';

const NOW = Date.UTC(2026, 9, 9, 7, 0, 0);

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

describe('чтение прогресса: три исхода, а не два', () => {
  it('записано и свежо — точка восстанавливается', () => {
    const st = memory();
    writeWpProgress(st, 'r1', 3, 5, NOW - 3_600_000);
    expect(readWpProgress(st, 'r1', 5, NOW)).toEqual({ ok: true, idx: 3 });
  });

  it('ничего не записано — «нет», а не нулевая точка', () => {
    expect(readWpProgress(memory(), 'r1', 5, NOW)).toEqual({ ok: false, reason: 'none' });
  });

  it('старше суток — это другой поход: «устарел»', () => {
    const st = memory();
    writeWpProgress(st, 'r1', 3, 5, NOW - WP_PROGRESS_MAX_AGE_MS - 1);
    expect(readWpProgress(st, 'r1', 5, NOW)).toEqual({ ok: false, reason: 'stale' });
    writeWpProgress(st, 'r1', 3, 5, NOW - WP_PROGRESS_MAX_AGE_MS + 60_000);
    expect(readWpProgress(st, 'r1', 5, NOW).ok).toBe(true);
  });

  it('запись «из будущего» (часы переведены) не годится так же, как старая', () => {
    const st = memory();
    writeWpProgress(st, 'r1', 2, 5, NOW + 3_600_000);
    expect(readWpProgress(st, 'r1', 5, NOW)).toEqual({ ok: false, reason: 'stale' });
  });

  it('число точек другое — маршрут стал другим, индексу веры нет', () => {
    const st = memory();
    writeWpProgress(st, 'r1', 3, 5, NOW);
    expect(readWpProgress(st, 'r1', 8, NOW)).toEqual({ ok: false, reason: 'route_changed' });
  });

  it('побитая запись — «побита», а не исключение и не ноль', () => {
    const st = memory();
    for (const bad of ['not json', '{}', '{"idx":"3","n":5,"at":1}', '{"idx":-1,"n":5,"at":1}', 'null', '[]']) {
      st.data.set(wpProgressKey('r1'), bad);
      expect(readWpProgress(st, 'r1', 5, NOW), bad).toEqual({ ok: false, reason: 'broken' });
    }
    // Индекс за пределами маршрута при том же числе точек.
    st.data.set(wpProgressKey('r1'), JSON.stringify({ idx: 5, n: 5, at: NOW }));
    expect(readWpProgress(st, 'r1', 5, NOW)).toEqual({ ok: false, reason: 'broken' });
  });

  it('хранилище бросает — «побита», экран не падает', () => {
    const boom: StorageLike = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(readWpProgress(boom, 'r1', 5, NOW)).toEqual({ ok: false, reason: 'broken' });
    expect(() => writeWpProgress(boom, 'r1', 1, 5, NOW)).not.toThrow();
    expect(() => clearWpProgress(boom, 'r1')).not.toThrow();
  });
});

describe('запись и стирание', () => {
  it('у каждого маршрута своя запись', () => {
    const st = memory();
    writeWpProgress(st, 'a', 1, 4, NOW);
    writeWpProgress(st, 'b', 3, 4, NOW);
    expect(readWpProgress(st, 'a', 4, NOW)).toEqual({ ok: true, idx: 1 });
    expect(readWpProgress(st, 'b', 4, NOW)).toEqual({ ok: true, idx: 3 });
  });

  it('индекс вне маршрута не пишется вовсе', () => {
    const st = memory();
    writeWpProgress(st, 'a', 4, 4, NOW);
    writeWpProgress(st, 'a', -1, 4, NOW);
    writeWpProgress(st, 'a', 1.5, 4, NOW);
    expect(st.data.size).toBe(0);
  });

  it('«начать заново» стирает', () => {
    const st = memory();
    writeWpProgress(st, 'a', 2, 4, NOW);
    clearWpProgress(st, 'a');
    expect(readWpProgress(st, 'a', 4, NOW)).toEqual({ ok: false, reason: 'none' });
  });
});

describe('привязка к экрану «На маршруте»', () => {
  const SRC = readFileSync('app/planning/_PlanningClient.tsx', 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('при загрузке точек сперва ищется сохранённый прогресс', () => {
    expect(CODE).toMatch(/readWpProgress\(localStorage, rid, waypoints\.length, Date\.now\(\)\)/);
    expect(CODE).toMatch(/if \(res\.ok\) \{[\s\S]{0,200}setCurrentWpIdx\(res\.idx\);[\s\S]{0,120}snappedRef\.current = true;/);
  });

  it('прилипание к ближайшей точке по GPS осталось запасным путём — правило входа на маршрут цело', () => {
    expect(CODE).toMatch(/setCurrentWpIdx\(bestD <= ON_ROUTE_ENTRY_KM \? best : 0\)/);
  });

  it('номер точки пишется при каждой смене, но не раньше решения и не поверх только что поднятого', () => {
    expect(CODE).toMatch(/writeWpProgress\(localStorage, rid, currentWpIdx, waypoints\.length, Date\.now\(\)\)/);
    expect(CODE).toMatch(/if \(!wpProgressReadyRef\.current \|\| waypoints\.length === 0\) return;/);
    expect(CODE).toMatch(/if \(currentWpIdx !== expect\) return;/);
  });

  it('повторная подстановка того же списка не затирает шаги после первой', () => {
    expect(CODE).toMatch(/const tag = `\$\{rid\}:\$\{waypoints\.length\}`;\s*if \(wpRestoredForRef\.current === tag\) return;/);
  });

  it('явный выбор маршрута стирает прогресс; «Начать» по тому же маршруту — продолжает', () => {
    expect(CODE).toMatch(/function selectRoute\(r: \{ id: string \}\) \{\s*try \{ clearWpProgress\(localStorage, r\.id\); \}/);
    expect(CODE).toMatch(/if \(localStorage\.getItem\('active_trail_route_id'\) !== routeId\) clearWpProgress\(localStorage, routeId\);/);
  });

  it('невозможность восстановить не молчит: причина в консоли', () => {
    expect(CODE).toMatch(/прогресс маршрута не восстановлен: \$\{res\.reason\}/);
  });
});
