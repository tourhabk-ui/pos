/**
 * Сторож: прибор поля знает состояние «ты ещё не на маршруте» (#1847).
 *
 * Скрин владельца 13.09, экран «На маршруте». В одной строке одновременно:
 * «138.0 км до следующей точки», «~39 ч 25 мин» и «всего 64.3 км». До точки
 * вдвое дальше, чем весь маршрут целиком.
 *
 * Врало не число. `approach.totalKm` = подход + вдоль тропы + выход, и 137 из
 * 138 километров там — прямая ОТ ЧЕЛОВЕКА до линии через край. Врал расчёт
 * времени: 39 часов получены пешей моделью, применённой туда, где её
 * предпосылка («человек идёт по тропе») не выполняется. Число при этом
 * выглядит ровно так же, как настоящее, — тот же класс ошибки, что уверенная
 * стрелка компаса при мёртвом датчике (09.08).
 *
 * Порог не изобретён: `ON_ROUTE_ENTRY_KM` уже был решён и уже описан в
 * approach.ts как радиус «человек считается УЖЕ НА МАРШРУТЕ». Вторая ветвь
 * обходится вовсе без порога — она ловит противоречие в самих данных.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notOnRoute, ON_ROUTE_ENTRY_KM, type ApproachPlan } from '@/lib/on-route/approach';

/** План подхода с нужным отходом от линии; прочие поля к делу не относятся. */
function planWithApproach(approachKm: number): ApproachPlan {
  return {
    joinAt: { lat: 53, lng: 158 },
    approachKm,
    alongTrackKm: 1,
    exitKm: 0,
    totalKm: approachKm + 1,
    targetOffTrack: false,
    userOffTrack: approachKm > 0.1,
    dataConflict: false,
  };
}

describe('notOnRoute — измеренный отход от линии', () => {
  it('случай со скрина 13.09: 137 км до линии — человек не на маршруте', () => {
    const state = notOnRoute({ plan: planWithApproach(137), straightToNextKm: null, routeTotalKm: 64.3 });
    expect(state).not.toBeNull();
    expect(state?.basis).toBe('off_line');
    expect(state?.approachKm).toBe(137);
  });

  it('человек на тропе — состояния нет, экран работает как работал', () => {
    expect(notOnRoute({ plan: planWithApproach(0.05), straightToNextKm: null, routeTotalKm: 64.3 })).toBeNull();
  });

  it('граница — ровно радиус входа, и он не изобретён здесь заново', () => {
    // Строго больше радиуса: стоящий ровно на границе считается вошедшим.
    expect(notOnRoute({ plan: planWithApproach(ON_ROUTE_ENTRY_KM), straightToNextKm: null, routeTotalKm: 10 })).toBeNull();
    expect(
      notOnRoute({ plan: planWithApproach(ON_ROUTE_ENTRY_KM + 0.01), straightToNextKm: null, routeTotalKm: 10 })?.basis,
    ).toBe('off_line');
  });

  it('при живом плане арифметика не подменяет измерение', () => {
    // Человек на тропе, но прямая до точки почему-то больше длины маршрута —
    // судит ПЛАН, а не вторая ветвь: она работает только когда линии нет.
    expect(notOnRoute({ plan: planWithApproach(0.05), straightToNextKm: 999, routeTotalKm: 10 })).toBeNull();
  });
});

describe('notOnRoute — противоречие в данных, без порога', () => {
  it('до точки дальше, чем весь маршрут — на маршруте так стоять нельзя', () => {
    const state = notOnRoute({ plan: null, straightToNextKm: 138, routeTotalKm: 64.3 });
    expect(state?.basis).toBe('farther_than_route');
    // До линии не мерили — трека нет. Здесь обязано быть «не знаю», а не число.
    expect(state?.approachKm).toBeNull();
  });

  it('до точки ближе длины маршрута — обычное положение на пути', () => {
    expect(notOnRoute({ plan: null, straightToNextKm: 12, routeTotalKm: 64.3 })).toBeNull();
  });
});

describe('notOnRoute — отсутствие улик не равно «человек на маршруте»', () => {
  it('нет ни плана, ни длины маршрута — null как «не знаю», а не вердикт', () => {
    expect(notOnRoute({ plan: null, straightToNextKm: 138, routeTotalKm: null })).toBeNull();
    expect(notOnRoute({ plan: null, straightToNextKm: null, routeTotalKm: 64.3 })).toBeNull();
    expect(notOnRoute({ plan: null, straightToNextKm: null, routeTotalKm: null })).toBeNull();
  });

  it('нечисловой вход не превращается в состояние', () => {
    expect(notOnRoute({ plan: null, straightToNextKm: NaN, routeTotalKm: 64.3 })).toBeNull();
    expect(notOnRoute({ plan: null, straightToNextKm: 138, routeTotalKm: 0 })).toBeNull();
    expect(notOnRoute({ plan: planWithApproach(NaN), straightToNextKm: null, routeTotalKm: null })).toBeNull();
  });
});

describe('экран поля пользуется этим состоянием', () => {
  const screen = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('время в пути снимается, когда человек не на маршруте', () => {
    // Прямая подстановка eta.hours в обе карточки — код до правки: пешая
    // модель уходила на экран независимо от того, применима ли она.
    expect(screen).not.toMatch(/etaLabel=\{eta\.hours !== null \? `~\$\{formatEta\(eta\.hours\)\}` : null\}/);
    expect(screen).toMatch(/const etaShown = offRoute === null && eta\.hours !== null/);
    expect((screen.match(/etaLabel=\{etaShown\}/g) ?? []).length).toBe(2);
  });

  it('оговорка о происхождении времени не остаётся без самого времени', () => {
    expect(screen).toMatch(/distLabel !== null && etaShown !== null && etaNote/);
  });

  it('причина названа словами и стоит в ОБОИХ видах листа', () => {
    expect(screen).toContain('Вы ещё не на маршруте');
    // Свёрнутый лист — то, что было на скрине; развёрнутый — где подробности.
    expect((screen.match(/\{offRouteNote\}/g) ?? []).length).toBe(2);
  });

  it('подпись главной цифры не обещает «следующую точку» сошедшему с пути', () => {
    expect(screen).toMatch(/const distCaption = offRoute !== null/);
    expect((screen.match(/caption=\{distCaption\}/g) ?? []).length).toBe(2);
  });
});
