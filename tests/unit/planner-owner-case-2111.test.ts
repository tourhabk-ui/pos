/**
 * Регрессия по реальному кейсу владельца 21.11 («полный провал»): /planner,
 * 24.11–04.12, 11 дней, двое взрослых. Без персональных данных — только
 * форма плана, которую показал экран.
 *
 * Было: дни 1–5 — один тур «Камчатка: термальный маршрут», и каждый день
 * отдельной карточкой с тем же предупреждением; термам в Авачинской зоне —
 * «Мутновский: не приближаться»; истёкшие сводки на каждом дне; дни 8, 9,
 * 11 — «Идея · тура нет» (рыбалка в декабре, снегоходы, вертолёт) с
 * переездом 7 ч на запад и вертолётом 600 км на север; смета 170 000 ₽ при
 * шести «цены нет».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DayPlan } from '@/lib/planner/engine';
import { replaceIdeaDays, NO_TOUR_DAY_TITLE, isIdeaDay } from '@/lib/planner/honest-days';
import {
  dayCardWarning, planShapeWarnings, runLabel, safetyBlock, safetyItemText, shortWeather, tourRuns,
} from '@/lib/planner/day-card-view';
import { countedLine } from '@/lib/planner/estimate';
import { notesForPlanDay, type ActiveWarning } from '@/lib/safety/mchs-bulletin';

const MUTNOVSKY_ENDED = 'Турпортал края о вулкане Мутновский: не приближаться (сводка на 06:00 19.11–06:00 20.11 — её срок истёк, обстановку на сегодня проверьте в свежей сводке).';
const BEARS = 'Медведи: в походе держитесь группой, еду храните в контейнере.';
const NO_SIGNAL = 'Связи нет на большей части маршрута — возьмите спутниковый коммуникатор.';
const KIT = 'Прогноз для зоны дня: пасмурно, −18…−9 °C, без осадков, ветер до 6 м/с. Возьмите тёплый слой — флис или пуховку, шапку и перчатки.';

function base(day: number, over: Partial<DayPlan>): DayPlan {
  return {
    day, type: 'activity', zone: 'avachinsky', title: '', description: '', activityType: 'hot_spring',
    priceFrom: 0, priceTo: 0, coords: [53.0, 158.6], defaultTransport: 'jeep', allowedTransports: ['jeep'],
    difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...over,
  } as DayPlan;
}

const thermal = (day: number) => base(day, {
  title: 'Камчатка: термальный маршрут', activityMode: 'operator',
  realTour: { tourId: 't-thermal', title: 'Камчатка: термальный маршрут' } as DayPlan['realTour'],
  dayWarnings: [MUTNOVSKY_ENDED, BEARS, NO_SIGNAL],
  weatherKit: KIT,
  weatherForecast: { tempMax: -9, tempMin: -18, precipMm: 0, windKmh: 20, code: 3, description: 'Пасмурно' },
});

const OWNER_PLAN: DayPlan[] = [
  thermal(1), thermal(2), thermal(3), thermal(4), thermal(5),
  base(6, { title: 'Свободный день. Город, сувениры, рыбный рынок', activityMode: 'self', dayWarnings: [MUTNOVSKY_ENDED] }),
  base(7, { type: 'travel', title: 'Переезд: Авачинская зона → Западная зона', activityType: 'travel', dayWarnings: [MUTNOVSKY_ENDED] }),
  base(8, { zone: 'western', title: 'Рыбалка — Западная зона', activityType: 'fishing', activityMode: 'open', dayWarnings: ['Сезон июль–сентябрь.', BEARS] }),
  base(9, { zone: 'western', title: 'Снегоходы — Западная зона', activityType: 'snowmobile', activityMode: 'open', dayWarnings: [NO_SIGNAL] }),
  base(10, { type: 'travel', title: 'Перелёт на вертолёте (600 км)', activityType: 'travel', defaultTransport: 'helicopter' }),
  base(11, { zone: 'northern', title: 'Вертолётные экскурсии — Северная зона', activityType: 'helicopter', activityMode: 'open', defaultTransport: 'helicopter' }),
];

describe('кейс владельца 21.11: план 24.11–04.12, 11 дней, двое', () => {
  it('дни без тура (рыбалка в декабре, снегоходы, вертолёт) — честный пустой слот, не «идея»', () => {
    const { days, replaced } = replaceIdeaDays(OWNER_PLAN);
    expect(replaced).toEqual([8, 9, 11]);
    expect(days.some(isIdeaDay)).toBe(false);
    for (const n of [8, 9, 11]) {
      const d = days.find((x) => x.day === n)!;
      expect(d.title).toBe(NO_TOUR_DAY_TITLE);
      expect(d.description).toMatch(/отдохнуть|удлинить реальный тур/);
      expect(d.dayWarnings).toEqual([]);
    }
    // Реальный тур и самостоятельный день остаются как были.
    expect(days.filter((d) => d.realTour?.tourId === 't-thermal')).toHaveLength(5);
    expect(days.find((d) => d.day === 6)?.activityMode).toBe('self');
  });

  it('пятидневный тур — один блок «Дни 1–5»', () => {
    const runs = tourRuns(OWNER_PLAN);
    for (const n of [1, 2, 3, 4, 5]) expect(runs.get(n)).toEqual({ tourId: 't-thermal', first: 1, last: 5 });
    expect(runs.has(6)).toBe(false);
    expect(runLabel(runs.get(1)!)).toBe('Дни 1–5');
  });

  it('в карточке дня не больше одного предупреждения, и термам не пишется «Мутновский»', () => {
    for (const d of replaceIdeaDays(OWNER_PLAN).days) {
      const w = dayCardWarning(d);
      expect(w === null || typeof w === 'string').toBe(true);
      if (w) expect(w.length).toBeLessThanOrEqual(140);
    }
    for (const n of [1, 2, 3, 4, 5]) expect(dayCardWarning(OWNER_PLAN[n - 1])).toBeNull();
    // Предупреждение о месте из программы дня — остаётся одной строкой.
    const climb = base(12, { title: 'Восхождение на Мутновский', dayWarnings: [BEARS, 'Турпортал края о вулкане Мутновский: не приближаться. Подробности в сводке.'] });
    expect(dayCardWarning(climb)).toBe('Турпортал края о вулкане Мутновский: не приближаться.');
  });

  it('погода дня — коротко; совет по одежде — один раз в общем блоке', () => {
    expect(shortWeather(OWNER_PLAN[0])).toBe('−18…−9 °C, пасмурно');
    const items = safetyBlock(OWNER_PLAN, []).map(safetyItemText);
    expect(items.filter((t) => t.startsWith('Одежда по прогнозу'))).toHaveLength(1);
  });

  it('блок «Безопасность и разрешения»: каждая строка один раз, с днями', () => {
    const warnings = [
      { type: 'mchs', severity: 'important', message: 'Сводки (МЧС, Турпортал края) о вулканах — Мутновский: не приближаться.' },
      { type: 'permit', severity: 'important', message: 'Кроноцкий заповедник — нужен пропуск.' },
      { type: 'season', severity: 'critical', message: 'Гейзеры: недоступно в выбранный период.' },
    ];
    const items = safetyBlock(OWNER_PLAN, warnings).map(safetyItemText);
    expect(items.filter((t) => t.startsWith('Турпортал края о вулкане Мутновский'))).toEqual([`${MUTNOVSKY_ENDED} (дни 1–7)`]);
    expect(items.filter((t) => t.startsWith('Медведи'))).toEqual([`${BEARS} (дни 1–5, 8)`]);
    expect(items.some((t) => t.startsWith('Кроноцкий'))).toBe(true);
    // Сезон — про сам план: над днями, не в блоке безопасности.
    expect(items.some((t) => t.startsWith('Гейзеры'))).toBe(false);
    expect(planShapeWarnings(warnings).map((w) => w.type)).toEqual(['season']);
    expect(new Set(items).size).toBe(items.length);
  });

  it('сводка о Мутновском не красит термы Авачинской зоны; восхождение на него — красит', () => {
    const w: ActiveWarning = { kind: 'volcano', place: 'Мутновский', stems: ['мутновск'], statement: 'не приближаться', period: null, sourceUrl: null } as ActiveWarning;
    expect(notesForPlanDay('Камчатка: термальный маршрут', ['avachinsky'], [w])).toEqual([]);
    expect(notesForPlanDay('Восхождение на Мутновский', ['avachinsky'], [w])).toHaveLength(1);
    expect(notesForPlanDay('Восхождение на Мутновский', ['avachinsky'], [{ ...w, ended: true } as ActiveWarning])).toEqual([]);
  });

  it('смета говорит, сколько позиций посчитано', () => {
    const lines = [{ total: [170000, 170000] as [number, number] }, ...Array.from({ length: 6 }, () => ({ total: null }))];
    expect(countedLine(lines as never)).toBe('Посчитано 1 из 7 позиций');
  });

  it('экран: карточка дня берёт одну строку (dayCardWarning), а не весь список dayWarnings', () => {
    const src = readFileSync(join(process.cwd(), 'app/planner/_PlannerClient.tsx'), 'utf8');
    const card = src.slice(src.indexOf('function DayCard('), src.indexOf('// Route detail card'));
    expect(card).toContain('dayCardWarning(day)');
    expect(card).not.toMatch(/day\.dayWarnings\.map\(/);
    expect(card).not.toMatch(/\{day\.weatherKit\}/);
    expect(src).toContain('SafetyBlock items={safetyBlock(days, recommendation.warnings ?? [])}');
  });
});
