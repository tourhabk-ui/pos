/**
 * Экран «На маршруте» показывает первую точку сразу (03.10).
 *
 * Владелец: «SOS открывает координаты моментально, а на маршруте долго
 * ищет». SOS спрашивает последнюю известную точку телефона и сетевую рядом
 * со спутниками; экран маршрута ждал только точный фикс не старше 5 с.
 * Держится связка: оба быстрых запроса есть, идут ДО слежения, свежая точка
 * не затирается старой, отбраковка грубых фиксов та же, что у слежения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf8');
const seedAt = SRC.indexOf('const seedFix = (pos: GeolocationPosition)');
const watchAt = SRC.indexOf('watchRef.current = navigator.geolocation.watchPosition(');
const seed = SRC.slice(seedAt, watchAt);

describe('первая точка на маршруте — без ожидания спутников', () => {
  it('быстрые запросы стоят до слежения', () => {
    expect(seedAt).toBeGreaterThan(-1);
    expect(watchAt).toBeGreaterThan(seedAt);
  });

  it('последняя известная точка и сетевая — оба', () => {
    expect(seed).toMatch(/maximumAge: Infinity, timeout: 1_000/);
    expect(seed).toMatch(/enableHighAccuracy: false, maximumAge: 300_000/);
  });

  it('возраст точки — её собственный timestamp, и свежая не затирается старой', () => {
    expect(seed).toMatch(/const t = pos\.timestamp \?\? Date\.now\(\);/);
    expect(seed).toMatch(/prev && prev\.t >= t\) \? prev/);
  });

  it('грубый фикс (десятки км) отбрасывается тем же правилом, что у слежения', () => {
    expect(seed).toContain('fixAccuracyPlausible(pos.coords.accuracy)');
  });

  it('в след и крошки быстрые точки не идут — это не движение', () => {
    expect(seed).not.toMatch(/trackRef|addCrumb|crumbsRef/);
  });
});
