/**
 * Погода и «план Б» на публичном плане («Мой план 2.0», B-5; владелец:
 * «действуй»).
 *
 * План перестаёт быть картинкой: у дня — прогноз Open-Meteo по его
 * координатам (только в горизонте 16 суток), а у погодозависимого тура при
 * плохом прогнозе — запасные варианты. «План Б» — не сочинение модели:
 * запасные туры заводят операторы в contingency_rules; триггер
 * детерминированный (ветер ≥ 40 км/ч или осадки ≥ 10 мм).
 * Ни у одного из 84 планировщиков TAAFT этого нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SHARE_API = readFileSync(join(ROOT, 'app/api/trips/share/[token]/route.ts'), 'utf-8');
const SHARE_UI = readFileSync(join(ROOT, 'app/trip/[token]/_TripShareClient.tsx'), 'utf-8');
const RESOLVER = readFileSync(join(ROOT, 'lib/tours/top-tour-by-activity.ts'), 'utf-8');

describe('B-5: погода в дне плана', () => {
  it('прогноз — из движка (Open-Meteo), только в горизонте 16 суток', () => {
    expect(SHARE_API).toMatch(/fetchWeatherForecast/);
    expect(SHARE_API).toMatch(/16 \* 86400000/);
    expect(SHARE_API).toMatch(/if \(dateMs < todayMs \|\| dateMs >= horizonMs\) return;/);
  });

  it('порог «плохой погоды» детерминированный: ветер ≥ 40 или осадки ≥ 10', () => {
    expect(SHARE_API).toMatch(/f\.windKmh >= 40 \|\| f\.precipMm >= 10/);
  });

  it('клиент показывает прогноз и подсвечивает плохую погоду warning-цветом', () => {
    expect(SHARE_UI).toMatch(/Прогноз на \{shortDate\(w\.date\)\}/);
    expect(SHARE_UI).toMatch(/w\.bad \? 'var\(--warning\)'/);
  });
});

describe('B-5: «план Б» при непогоде', () => {
  it('только для погодозависимых туров и только из contingency_rules операторов', () => {
    expect(SHARE_API).toMatch(/bad && tour\?\.weather_dependent/);
    expect(SHARE_API).toMatch(/fetchContingencyAlternatives/);
    expect(RESOLVER).toMatch(/COALESCE\(ot\.weather_dependent, FALSE\) AS weather_dependent/);
  });

  it('клиент рендерит запасные туры ссылками на бронь', () => {
    expect(SHARE_UI).toMatch(/План Б при непогоде/);
    expect(SHARE_UI).toMatch(/\/catalog\/tours\/\$\{a\.tour_id\}/);
  });

  it('все сбои — fail-soft: блока нет, план жив', () => {
    expect(SHARE_API).toMatch(/catch \{ \/\* погода и план Б необязательны \*\/ \}/);
    expect(SHARE_API).toMatch(/catch \{ \/\* движок недоступен — план живёт без погоды \*\/ \}/);
  });
});
