/**
 * Вероятностный прогноз (ансамбль WeatherNext 2, находка #1787).
 *
 * Главное, что здесь держится, — третий исход (§4.0): день, про который у
 * ансамбля нет данных, обязан отличаться от спокойного дня, а величина,
 * которую модель отдаёт пустой (порывы, видимость), — от величины в норме.
 * Соблазн ровно обратный: посчитать null нулём, и тогда «данных нет»
 * превратится в «ветра нет».
 */

import { describe, it, expect } from 'vitest';
import {
  parseEnsemble, consensusOf, ensembleDayFor, describeEnsembleDay,
  hazardBreakdown, isoDate, HAZARD_THRESHOLDS, PROBED_EMPTY_VARS,
  ENSEMBLE_MODEL,
} from '@/lib/weather/ensemble';
import { DANGEROUS_WMO_CODES, wmoHazardLabel } from '@/lib/weather/wmo-hazard';
import { classifyDivergence } from '@/app/api/cron/weathernext-probe/route';

/** Ответ Ensemble API: часы одного дня, члены заданы поимённо. */
function response(opts: {
  times: string[];
  wind?: Record<string, (number | null)[]>;
  code?: Record<string, (number | null)[]>;
  precipitation?: Record<string, (number | null)[]>;
  snowfall?: Record<string, (number | null)[]>;
  gusts?: Record<string, (number | null)[]>;
}) {
  const hourly: Record<string, unknown> = { time: opts.times };
  const put = (variable: string, series?: Record<string, (number | null)[]>) => {
    for (const [member, values] of Object.entries(series ?? {})) {
      hourly[`${variable}_member${member}`] = values;
    }
  };
  put('wind_speed_10m', opts.wind);
  put('weather_code', opts.code);
  put('precipitation', opts.precipitation);
  put('snowfall', opts.snowfall);
  put('wind_gusts_10m', opts.gusts);
  return { hourly };
}

const DAY = ['2026-09-10T00:00', '2026-09-10T01:00', '2026-09-10T02:00'];

describe('parseEnsemble: счёт членов', () => {
  it('число членов читается из ответа, а не зашито', () => {
    const out = parseEnsemble(response({
      times: DAY,
      wind: { '01': [5, 5, 5], '02': [5, 5, 5], '03': [50, 5, 5] },
    }));
    expect(out).not.toBeNull();
    expect(out?.members).toBe(3);
    expect(out?.model).toBe(ENSEMBLE_MODEL);
  });

  it('доля считается по членам с данными: один опасный из трёх', () => {
    const out = parseEnsemble(response({
      times: DAY,
      wind: { '01': [5, 5, 5], '02': [5, 5, 5], '03': [50, 5, 5] },
    }));
    const day = out?.days[0];
    expect(day?.membersCounted).toBe(3);
    expect(day?.membersDangerous).toBe(1);
    expect(day?.share).toBeCloseTo(1 / 3);
    expect(day?.consensus).toBe('split');
  });

  it('член без данных за день не идёт в знаменатель — и не считается спокойным', () => {
    const out = parseEnsemble(response({
      times: DAY,
      wind: { '01': [50, 50, 50], '02': [null, null, null], '03': [5, 5, 5] },
    }));
    const day = out?.days[0];
    // Членов в ответе три, с данными за день — два (второй пуст целиком).
    expect(day?.membersCounted).toBe(2);
    expect(day?.membersDangerous).toBe(1);
    expect(day?.share).toBeCloseTo(0.5);
  });
});

describe('parseEnsemble: третий исход', () => {
  it('день без данных ни у одного члена — неизвестен, а не спокоен', () => {
    const out = parseEnsemble(response({
      times: [...DAY, '2026-09-11T00:00'],
      wind: { '01': [5, 5, 5, null], '02': [5, 5, 5, null] },
    }));
    const second = out?.days.find((d) => d.date === '2026-09-11');
    expect(second).toBeDefined();
    expect(second?.membersCounted).toBe(0);
    expect(second?.membersDangerous).toBeNull();
    expect(second?.share).toBeNull();
    expect(second?.consensus).toBe('unknown');
    expect(second?.byHazard).toBeNull();
  });

  it('ни одного члена с данными вовсе — отказ разбора (null), не пустой прогноз', () => {
    expect(parseEnsemble(response({
      times: DAY,
      wind: { '01': [null, null, null] },
    }))).toBeNull();
  });

  it('ответ не той формы — null', () => {
    expect(parseEnsemble(null)).toBeNull();
    expect(parseEnsemble({})).toBeNull();
    expect(parseEnsemble({ hourly: { time: [] } })).toBeNull();
    expect(parseEnsemble({ hourly: { time: 'не массив' } })).toBeNull();
  });

  it('величина, пришедшая пустой, названа отсутствующей — а не безопасной', () => {
    const out = parseEnsemble(response({
      times: DAY,
      wind: { '01': [5, 5, 5] },
      gusts: { '01': [null, null, null] },
    }));
    expect(out?.unavailable).toContain('wind_gusts_10m');
  });

  it('порывы и видимость спрашиваются намеренно — чтобы их появление стало видно', () => {
    expect([...PROBED_EMPTY_VARS]).toEqual(['wind_gusts_10m', 'visibility']);
  });
});

describe('parseEnsemble: виды угроз', () => {
  it('опасный код WMO поднимает угрозу; безопасный — нет', () => {
    const dangerous = [...DANGEROUS_WMO_CODES][0];
    const out = parseEnsemble(response({
      times: DAY,
      code: { '01': [dangerous, 0, 0], '02': [0, 1, 2] },
    }));
    const day = out?.days[0];
    expect(day?.membersDangerous).toBe(1);
    expect(day?.byHazard?.weather_code).toBe(1);
  });

  it('порог ветра — из одного места, а не из числа в коде', () => {
    const below = parseEnsemble(response({
      times: DAY,
      wind: { '01': [HAZARD_THRESHOLDS.windKmh - 0.1, 0, 0] },
    }));
    const at = parseEnsemble(response({
      times: DAY,
      wind: { '01': [HAZARD_THRESHOLDS.windKmh, 0, 0] },
    }));
    expect(below?.days[0].membersDangerous).toBe(0);
    expect(at?.days[0].membersDangerous).toBe(1);
  });

  it('один член с двумя видами угроз считается один раз, но виден в обоих', () => {
    const out = parseEnsemble(response({
      times: DAY,
      wind: { '01': [50, 5, 5] },
      snowfall: { '01': [0, 0, HAZARD_THRESHOLDS.snowfallCmPerHour + 1] },
    }));
    const day = out?.days[0];
    expect(day?.membersDangerous).toBe(1);
    expect(day?.byHazard?.wind).toBe(1);
    expect(day?.byHazard?.snowfall).toBe(1);
    expect(hazardBreakdown(day!)).toHaveLength(2);
  });
});

describe('consensusOf: границы — трети', () => {
  it('две трети и выше — согласие на опасности', () => {
    expect(consensusOf(1)).toBe('danger');
    expect(consensusOf(2 / 3)).toBe('danger');
  });
  it('от трети до двух третей — расходятся', () => {
    expect(consensusOf(0.5)).toBe('split');
    expect(consensusOf(1 / 3)).toBe('split');
  });
  it('меньше трети — большинство спокойно', () => {
    expect(consensusOf(0.1)).toBe('calm');
    expect(consensusOf(0)).toBe('calm');
  });
  it('нет доли — нет вердикта', () => {
    expect(consensusOf(null)).toBe('unknown');
  });
});

describe('ensembleDayFor и isoDate', () => {
  const outlook = parseEnsemble(response({
    times: DAY,
    wind: { '01': [50, 5, 5], '02': [5, 5, 5] },
  }));

  it('дата строкой находит день', () => {
    expect(ensembleDayFor(outlook, '2026-09-10')?.membersCounted).toBe(2);
  });

  it('дата объектом Date не уезжает на сутки при TZ впереди UTC', () => {
    // node-postgres отдаёт колонку типа date локальной полночью.
    expect(isoDate(new Date(2026, 8, 10, 0, 0, 0))).toBe('2026-09-10');
  });

  it('дня вне горизонта нет — null, а не первый попавшийся день', () => {
    expect(ensembleDayFor(outlook, '2026-09-20')).toBeNull();
  });

  it('ансамбль не ответил — дня тоже нет', () => {
    expect(ensembleDayFor(null, '2026-09-10')).toBeNull();
  });

  it('мусор вместо даты — null', () => {
    expect(isoDate('вчера')).toBeNull();
    expect(isoDate(new Date('нет такой даты'))).toBeNull();
  });
});

describe('describeEnsembleDay: слова тревоги', () => {
  it('есть счёт — называет числа и согласие', () => {
    const out = parseEnsemble(response({
      times: DAY,
      wind: { '01': [50, 5, 5], '02': [50, 5, 5], '03': [5, 5, 5] },
    }));
    const text = describeEnsembleDay(out!.days[0]);
    // Двое из трёх — ровно граница согласия (2/3), отсюда «высокое».
    expect(text).toContain('2 из 3');
    expect(text).toContain('согласие высокое');
  });

  it('дня нет — говорит о неизвестности, а не молчит', () => {
    expect(describeEnsembleDay(null)).toMatch(/недоступен/);
  });

  it('день есть, данных нет — «уверенность неизвестна», не «спокойно»', () => {
    const out = parseEnsemble(response({
      times: [...DAY, '2026-09-11T00:00'],
      wind: { '01': [5, 5, 5, null] },
    }));
    const second = out!.days.find((d) => d.date === '2026-09-11')!;
    expect(describeEnsembleDay(second)).toMatch(/неизвестна/);
  });

  it('в словах тревоги нет эмодзи', () => {
    const out = parseEnsemble(response({ times: DAY, wind: { '01': [50, 5, 5] } }));
    const text = describeEnsembleDay(out!.days[0]) + describeEnsembleDay(null);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('classifyDivergence: исходов четыре, не два', () => {
  it('оба видят опасность', () => {
    expect(classifyDivergence(true, 0.9)).toBe('agree_danger');
  });
  it('оба спокойны', () => {
    expect(classifyDivergence(false, 0.1)).toBe('agree_calm');
  });
  it('опасен только детерминированный прогон', () => {
    expect(classifyDivergence(true, 0.1)).toBe('deterministic_only');
  });
  it('опасность видит только ансамбль — тот самый пропущенный день', () => {
    expect(classifyDivergence(false, 0.7)).toBe('ensemble_only');
  });
  it('молчит любой из источников — unknown, и это не «спокойно»', () => {
    expect(classifyDivergence(null, 0.9)).toBe('unknown');
    expect(classifyDivergence(false, null)).toBe('unknown');
    expect(classifyDivergence(null, null)).toBe('unknown');
  });
});

describe('wmo-hazard: один список на платформу', () => {
  it('коды опасной погоды названы', () => {
    for (const code of DANGEROUS_WMO_CODES) {
      expect(wmoHazardLabel(code)).toBeTruthy();
    }
  });
  it('безопасный код имени не получает — null, а не выдуманное слово', () => {
    expect(wmoHazardLabel(0)).toBeNull();
    expect(wmoHazardLabel(1)).toBeNull();
  });
  it('rescue-agent и ансамбль читают ОДИН список', async () => {
    const rescue = await import('@/lib/agents/evo/rescue-agent');
    expect(rescue).toBeDefined();
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/agents/evo/rescue-agent.ts', 'utf8'));
    // Своего множества кодов у агента быть не должно: разойдутся.
    expect(src).toContain("from '@/lib/weather/wmo-hazard'");
    expect(src).not.toMatch(/const DANGEROUS_WEATHER\s*=/);
  });
});
