/**
 * Рельеф маршрута: набор, сброс, профиль — и право сказать «высот нет».
 *
 * Владелец 09.08: «без профиля в данных блок „На маршруте“ останется
 * декоративным». Проверка показала худшее: график на экране рисовал ШИРОТУ
 * точек по вертикали. Маршрут с севера на юг давал ровную нисходящую линию,
 * которая читается как спуск — рельеф, которого нет. Красивая ложь опаснее
 * пустого места: пустое заставляет достать карту.
 *
 * Тесты держат три свойства: порог шума (без него набор раздувается в разы),
 * честный флаг достоверности и срез «что впереди», а не «сколько всего».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accumulateRelief, remainingRelief, haversineM, distanceAlongTrack,
  ELEVATION_NOISE_M, PROFILE_STEP_M,
} from '@/lib/routes/relief';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Точки вдоль меридиана: шаг по широте ≈ 111 м на 0.001°. */
function line(elevations: (number | undefined)[], stepDeg = 0.001) {
  return elevations.map((e, i) => ({ lat: 53 + i * stepDeg, lng: 158, elevation: e }));
}

describe('накопление рельефа', () => {
  it('набор и сброс считаются раздельно', () => {
    const r = accumulateRelief(line([100, 200, 300, 250, 150]));
    expect(r.ascentM).toBe(200);
    expect(r.descentM).toBe(150);
    expect(r.minM).toBe(100);
    expect(r.maxM).toBe(300);
    expect(r.reliable).toBe(true);
  });

  it('шум датчика не превращается в набор высоты', () => {
    // «Пила» ±2 м вокруг сотни: без порога это дало бы десятки метров набора
    // на ровном месте, а на тридцати километрах — сотни.
    const saw = [100, 102, 99, 101, 98, 102, 100, 101];
    const r = accumulateRelief(line(saw));
    expect(r.ascentM).toBe(0);
    expect(r.descentM).toBe(0);
  });

  it('порог не съедает настоящий склон, набранный мелкими шагами', () => {
    // Ровный подъём по два метра: опора — последняя ПРИНЯТАЯ высота, поэтому
    // склон в сорок метров виден, хотя каждый шаг ниже порога.
    const climb = Array.from({ length: 21 }, (_, i) => 100 + i * 2);
    const r = accumulateRelief(line(climb));
    expect(r.ascentM).toBeGreaterThanOrEqual(36);
    expect(r.ascentM).toBeLessThanOrEqual(40);
  });

  it('порог именно такой, как объявлен', () => {
    const below = accumulateRelief(line([100, 100 + ELEVATION_NOISE_M - 1]));
    expect(below.ascentM).toBe(0);
    const at = accumulateRelief(line([100, 100 + ELEVATION_NOISE_M]));
    expect(at.ascentM).toBe(ELEVATION_NOISE_M);
  });

  it('нет высот — профиль пуст и честно помечен недостоверным', () => {
    const r = accumulateRelief(line([undefined, undefined, undefined, undefined]));
    expect(r.reliable).toBe(false);
    expect(r.points).toEqual([]);
    // Дистанция считается всё равно: она известна из координат.
    expect(r.distanceM).toBeGreaterThan(0);
  });

  it('редкие высоты в треке — тоже недостоверно', () => {
    const r = accumulateRelief(line([100, undefined, undefined, undefined, 300]));
    expect(r.reliable).toBe(false);
  });

  it('нулевая высота — законная (уровень моря), а не «нет данных»', () => {
    const r = accumulateRelief(line([0, 30, 0]));
    expect(r.reliable).toBe(true);
    expect(r.ascentM).toBe(30);
    expect(r.minM).toBe(0);
  });

  it('абсурдные высоты отбрасываются', () => {
    const r = accumulateRelief(line([100, 99999, 130]));
    expect(r.maxM).toBe(130);
  });

  it('профиль прорежен, но финиш маршрута в нём есть', () => {
    const pts = Array.from({ length: 60 }, (_, i) => ({
      lat: 53 + i * 0.0002, lng: 158, elevation: 100 + i * 5,
    }));
    const r = accumulateRelief(pts);
    expect(r.points.length).toBeGreaterThan(1);
    expect(r.points.length).toBeLessThan(pts.length);
    expect(r.points[r.points.length - 1].dM).toBe(r.distanceM);
    for (let i = 1; i < r.points.length - 1; i++) {
      expect(r.points[i].dM - r.points[i - 1].dM).toBeGreaterThanOrEqual(PROFILE_STEP_M - 1);
    }
  });

  it('одна точка или пусто — не ошибка', () => {
    expect(accumulateRelief([]).distanceM).toBe(0);
    expect(accumulateRelief(line([100])).reliable).toBe(false);
  });

  it('расстояние по большому кругу считается верно', () => {
    const m = haversineM({ lat: 53, lng: 158 }, { lat: 53.001, lng: 158 });
    expect(m).toBeGreaterThan(105);
    expect(m).toBeLessThan(115);
  });
});

describe('что впереди, а не сколько всего', () => {
  const profile = [
    { dM: 0, zM: 100 }, { dM: 100, zM: 150 }, { dM: 200, zM: 200 },
    { dM: 300, zM: 150 }, { dM: 400, zM: 100 },
  ];

  it('срез считает только оставшийся кусок', () => {
    const r = remainingRelief(profile, 200, 400);
    expect(r.ascentM).toBe(0);
    expect(r.descentM).toBe(100);
  });

  it('координата отсчитывается от «я здесь»', () => {
    const r = remainingRelief(profile, 100, 300);
    expect(r.points[0].dM).toBe(0);
    expect(r.points[r.points.length - 1].dM).toBe(200);
  });

  it('пустой или перевёрнутый отрезок не даёт мусора', () => {
    expect(remainingRelief(profile, 300, 100).points).toEqual([]);
    expect(remainingRelief([], 0, 100).points).toEqual([]);
    expect(remainingRelief(profile, 0, 0).points).toEqual([]);
  });
});

describe('данные доезжают до экрана, а экран не выдаёт схему за рельеф', () => {
  it('API маршрута отдаёт готовый профиль по ПОЛНОМУ треку', () => {
    const api = read('app/api/routes/[id]/route.ts');
    expect(api).toMatch(/accumulateRelief\(pts\)/);
    // Прореженный для карты трек сюда не годится: прореживание выбрасывает
    // как раз перегибы, из которых состоит рельеф.
    expect(api).toMatch(/relief: \(\(\) => \{[\s\S]{0,400}extractTrackpoints/);
  });

  it('экран считает рельеф впереди и кормит им расчёт времени', () => {
    const screen = read('app/planning/_PlanningClient.tsx');
    expect(screen).toMatch(/remainingRelief\(relief\.points, fromM, toM\)/);
    expect(screen).toMatch(/ascentM: ahead\?\.ascentM/);
  });

  it('нет высот — нижний график не выдаётся за профиль высот', () => {
    const screen = read('app/planning/_PlanningClient.tsx');
    // Гард держит СМЫСЛ, а не формулировку: профиль появляется только при
    // достоверных высотах, а нижняя схема подписана тем, что она есть на
    // самом деле — точками или треком. Прежняя редакция закрепляла точный
    // текст «рельефа нет в данных маршрута», и правка копирайта (09.08:
    // «голос разработчика, не продукта») ломала тест вместо инварианта.
    expect(screen).toMatch(/\{ahead && \(/);
    expect(screen).toMatch(/Точки маршрута|Трек маршрута/);
    expect(screen).not.toMatch(/Профиль[^]{0,40}схема/i);
  });

  it('профиль показывается только на достоверных высотах', () => {
    const screen = read('app/planning/_PlanningClient.tsx');
    expect(screen).toMatch(/rel\.reliable === true/);
    expect(screen).toMatch(/\{ahead && \(/);
  });
});

describe('замер покрытия высотами — вместо рассуждений о нём', () => {
  const COV = read('app/api/cron/relief-coverage/route.ts');

  it('под секретом и read-only', () => {
    expect(COV).toMatch(/verifyCronSecret/);
    expect(COV).not.toMatch(/INSERT|UPDATE|DELETE|DROP|CREATE/);
  });

  it('порог достоверности берётся из движка, а не заводится второй', () => {
    expect(COV).toMatch(/MIN_ELEVATION_COVERAGE/);
    expect(COV).not.toMatch(/0\.6/);
  });

  it('наружу уходят только счётчики: ни координат, ни названий', () => {
    expect(COV).not.toMatch(/title/);
    expect(COV).not.toMatch(/coordinates'\s*\)?\s*AS (geom|coords)/);
  });

  it('разбивка по источникам трека — видно, кто дал высоты', () => {
    expect(COV).toMatch(/geometry->>'source'/);
    expect(COV).toMatch(/GROUP BY source/);
  });
});

describe('положение переводится в шкалу трека, а не прямых', () => {
  // Трек-«зигзаг»: путь заметно длиннее прямой между концами — ровно тот
  // случай, где смешение шкал давало срез профиля не в том месте.
  const track: Array<[number, number]> = [
    [53.000, 158.000],
    [53.002, 158.002],
    [53.004, 158.000],
    [53.006, 158.002],
  ];

  it('старт трека — ноль', () => {
    expect(distanceAlongTrack(track, 53.0, 158.0)).toBe(0);
  });

  it('дальше по треку — больше метров', () => {
    const a = distanceAlongTrack(track, 53.002, 158.002)!;
    const b = distanceAlongTrack(track, 53.006, 158.002)!;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it('путь по треку длиннее прямой между концами — это и есть причина правки', () => {
    const along = distanceAlongTrack(track, 53.006, 158.002)!;
    const straight = haversineM({ lat: 53.0, lng: 158.0 }, { lat: 53.006, lng: 158.002 });
    expect(along).toBeGreaterThan(straight);
  });

  it('точка в стороне привязывается к ближайшей вершине, а не роняет расчёт', () => {
    const d = distanceAlongTrack(track, 53.0041, 157.9990);
    expect(d).not.toBeNull();
    expect(Number.isFinite(d!)).toBe(true);
  });

  it('без трека или с мусором — null, а не выдуманное число', () => {
    expect(distanceAlongTrack([], 53, 158)).toBeNull();
    expect(distanceAlongTrack([[53, 158]], 53, 158)).toBeNull();
    expect(distanceAlongTrack(track, NaN, 158)).toBeNull();
  });

  it('экран режет профиль обеими границами по треку', () => {
    const screen = read('app/planning/_PlanningClient.tsx');
    expect(screen).toMatch(/distanceAlongTrack\(track, coords\.lat, coords\.lng\)/);
    expect(screen).toMatch(/distanceAlongTrack\(track, nextWp\.lat, nextWp\.lng\)/);
    // Прежняя смешанная шкала (пройдено по прямым) больше не участвует.
    expect(screen).not.toMatch(/fromM = progress\.doneKm/);
  });
});

describe('высоты источника не теряются на импорте', () => {
  const IMP = read('lib/services/ingest/idilesom-importer.ts');

  it('третий элемент переживает ОБА порядка координат', () => {
    // Замер прода 09.08: 289 маршрутов из idilesom, 119 683 точки, ноль высот.
    // Причина — ветка «широта первой» выбрасывала p[2], пока соседняя его
    // сохраняла. Порядок на Камчатке определяется первым числом: широта 50-64,
    // долгота 155-167, поэтому lat-first уходил именно в теряющую ветку.
    expect(IMP).toMatch(/p\.length >= 3 \? \[p\[0\], p\[1\], p\[2\]\] : \[p\[0\], p\[1\]\]/);
    expect(IMP).toMatch(/p\.length >= 3 \? \[p\[1\], p\[0\], p\[2\]\] : \[p\[1\], p\[0\]\]/);
    // Прежняя безусловная перестановка без высоты больше не встречается.
    expect(IMP).not.toMatch(/map\(p => \[p\[1\], p\[0\]\]\)/);
  });

  it('форму источника можно проверить, а не предполагать', () => {
    expect(IMP).toMatch(/export async function inspectIdilesomShape/);
    // Наружу — форма, а не содержимое: длина точки, порядок, диапазон высот.
    expect(IMP).toMatch(/tupleLength/);
    expect(IMP).toMatch(/'lng-first' \| 'lat-first'/);
  });

  it('диагностика ничего не пишет в базу', () => {
    const route = read('app/api/cron/idilesom-tracks/route.ts');
    expect(route).toMatch(/get\('mode'\) === 'inspect'/);
    const start = route.indexOf("=== 'inspect'");
    const inspectBlock = route.slice(start, route.indexOf("=== 'link'", start));
    expect(inspectBlock).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

describe('схема внизу экрана показывает трек, если он есть', () => {
  const SCREEN = read('app/planning/_PlanningClient.tsx');

  it('маршрут с одной точкой больше не остаётся без схемы', () => {
    // «Мыс Маячный» (скрин владельца 09.08): точка одна, схема строилась
    // только из точек и требовала двух — экран показывал пустоту.
    expect(SCREEN).toMatch(/track && track\.length >= 2\n\s*\? track\.map/);
  });

  it('кружки — путевые точки, а не вершины трека', () => {
    expect(SCREEN).toMatch(/dots: waypoints\.map/);
    expect(SCREEN).toMatch(/\(sketch\?\.dots \?\? \[\]\)\.map/);
  });

  it('схема подписана видом сверху и не выдаётся за профиль', () => {
    // Держим смысл, а не формулировку: подпись обязана говорить «вид сверху»
    // (это план, а не рельеф), а точный текст правится копирайтом.
    expect(SCREEN).toMatch(/вид сверху/);
    expect(SCREEN).not.toMatch(/[Пп]рофиль[^\n]{0,30}вид сверху/);
  });

  it('выбранный маршрут без трека говорит о данных, а не о выборе', () => {
    expect(SCREEN).toMatch(/У маршрута нет трека в данных/);
  });
});
