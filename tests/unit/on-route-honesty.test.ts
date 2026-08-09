/**
 * «На маршруте» — прибор, а не витрина.
 *
 * Владелец 09.08: «это же навигация без связи и может спасти либо убить
 * человека». Аудит того же дня нашёл пять умолчаний, каждое из которых делает
 * экран уверенным при мёртвом датчике:
 *   1. на iOS разрешение на компас не запрашивалось (`requestPermission` не
 *      вызывался нигде) — события не приходили, `heading` навечно оставался
 *      нулём, и стрелка показывала «север» при любом повороте телефона;
 *   2. относительный `alpha` части Android выдавался за истинный азимут —
 *      флаг `absolute` не проверялся;
 *   3. `pos.timestamp` и `pos.coords.accuracy` не использовались нигде: после
 *      потери фикса экран вечно показывал последние координаты как живые, а
 *      ошибки геолокации кода 2 и 3 проходили молча;
 *   4. плашка «Онлайн • GPS активен» отчитывалась за спутники, зная только
 *      про сеть;
 *   5. переход на следующую точку срабатывал при 50 м независимо от точности
 *      фикса — при точности 300 м это уводит человека от цели.
 *
 * Тесты стерегут не вид экрана, а именно право прибора молчать и признаваться.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fixInfo, fixLabel, figuresAreLive, canAdvanceWaypoint, readHeading,
  compassLabel, formatAge, FIX_STALE_MS, FIX_DEAD_MS, ARRIVAL_MAX_ACCURACY_M,
} from '@/lib/on-route/fix-quality';

const SCREEN = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
const NOW = 1_700_000_000_000;

describe('свежесть фикса', () => {
  it('свежий — живой, и точность названа', () => {
    const f = fixInfo(NOW - 5_000, 12, NOW);
    expect(f.state).toBe('live');
    expect(fixLabel(f)).toContain('12 м');
    expect(figuresAreLive(f)).toBe(true);
  });

  it('полминуты без сигнала — цифры ещё показываем, но говорим о возрасте', () => {
    const f = fixInfo(NOW - FIX_STALE_MS - 1, 20, NOW);
    expect(f.state).toBe('stale');
    expect(fixLabel(f)).toContain('Последний сигнал');
    expect(figuresAreLive(f)).toBe(true);
  });

  it('две минуты без сигнала — цифры объявлены устаревшими', () => {
    const f = fixInfo(NOW - FIX_DEAD_MS, 20, NOW);
    expect(f.state).toBe('dead');
    expect(fixLabel(f)).toContain('устарели');
    expect(figuresAreLive(f)).toBe(false);
  });

  it('фикса не было вовсе — так и сказано', () => {
    const f = fixInfo(null, null, NOW);
    expect(f.state).toBe('none');
    expect(fixLabel(f)).toBe('GPS не получен');
    expect(figuresAreLive(f)).toBe(false);
  });

  it('возраст читается словами', () => {
    expect(formatAge(30)).toBe('30 с');
    expect(formatAge(120)).toBe('2 мин');
    expect(formatAge(3900)).toBe('1 ч 5 мин');
    expect(formatAge(null)).toBe('—');
  });
});

describe('«мы дошли» — решение только по надёжному фиксу', () => {
  it('рядом и точность хорошая — переходим', () => {
    expect(canAdvanceWaypoint(fixInfo(NOW - 1000, 15, NOW), 0.03)).toBe(true);
  });

  it('точность хуже полусотни метров — не переходим, даже если «рядом»', () => {
    const f = fixInfo(NOW - 1000, ARRIVAL_MAX_ACCURACY_M + 1, NOW);
    expect(canAdvanceWaypoint(f, 0.01)).toBe(false);
  });

  it('фикс устарел — маршрут не двигается сам', () => {
    expect(canAdvanceWaypoint(fixInfo(NOW - FIX_STALE_MS - 1, 5, NOW), 0.01)).toBe(false);
    expect(canAdvanceWaypoint(fixInfo(null, null, NOW), 0.01)).toBe(false);
  });

  it('далеко — не переходим', () => {
    expect(canAdvanceWaypoint(fixInfo(NOW, 5, NOW), 1.2)).toBe(false);
  });
});

describe('компасу верим только там, где азимут привязан к земле', () => {
  it('iOS webkitCompassHeading — истинный север', () => {
    expect(readHeading({ webkitCompassHeading: 123 })).toEqual({ heading: 123, state: 'ok' });
  });

  it('alpha с флагом absolute — истинный север', () => {
    const r = readHeading({ alpha: 90, absolute: true });
    expect(r).toEqual({ heading: 270, state: 'ok' });
  });

  it('alpha без флага — НЕ азимут: помечаем неподтверждённым', () => {
    expect(readHeading({ alpha: 90 })?.state).toBe('unconfirmed');
    expect(readHeading({ alpha: 90, absolute: false })?.state).toBe('unconfirmed');
  });

  it('пустое событие не даёт направления вовсе', () => {
    expect(readHeading({})).toBeNull();
    expect(readHeading({ alpha: null })).toBeNull();
  });

  it('каждое состояние объясняется словами', () => {
    expect(compassLabel('blocked')).toContain('включите');
    expect(compassLabel('unconfirmed')).toContain('сверяйтесь с картой');
    expect(compassLabel('off')).toContain('недоступен');
  });
});

describe('экран пользуется этим, а не рисует уверенность', () => {
  it('стрелка гаснет и не крутится, пока азимут не подтверждён', () => {
    expect(SCREEN).toMatch(/const trusted = state === 'ok'/);
    expect(SCREEN).toMatch(/rotate\(\$\{trusted \? -heading : 0\}deg\)/);
  });

  it('на iOS разрешение компаса запрашивается жестом', () => {
    expect(SCREEN).toMatch(/compassNeedsPermission\(\)/);
    expect(SCREEN).toMatch(/requestPermission\?\.\(\)/);
    expect(SCREEN).toMatch(/Включить/);
  });

  it('плашка сети больше не отчитывается за спутники', () => {
    expect(SCREEN).not.toMatch(/Онлайн • GPS активен/);
    expect(SCREEN).toMatch(/fixLabel\(fix\)/);
  });

  it('ошибки геолокации кода 2 и 3 больше не молчат', () => {
    expect(SCREEN).toMatch(/err\.code === 3/);
    expect(SCREEN).toMatch(/gpsMessage/);
  });

  it('возраст фикса стареет по таймеру — мёртвый GPS событий не шлёт', () => {
    expect(SCREEN).toMatch(/setNowTick\(Date\.now\(\)\)/);
  });

  it('переход точки идёт через проверку доверия, а не по одному расстоянию', () => {
    expect(SCREEN).toMatch(/canAdvanceWaypoint\(info, dist\)/);
    expect(SCREEN).not.toMatch(/dist < 0\.05 && currentWpIdx/);
  });

  it('расстояние признаётся прямой линией и гаснет на мёртвом фиксе', () => {
    expect(SCREEN).toMatch(/по прямой/);
    expect(SCREEN).toMatch(/figuresLive \? 'var\(--success\)' : 'var\(--text-muted\)'/);
  });
});
