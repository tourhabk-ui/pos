/**
 * Сводка дня для гидов: источник один с Кузьмичом, отказ источника назван
 * словами. Шапка — lib/svodka/svodka.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { svodkaText, volcanoPhrase, weatherPhrase, type Svodka } from '@/lib/svodka/svodka';
import { elevatedVolcanoes, composeVolcanoReport, type VolcanoInput } from '@/lib/kuzmich/volcano-tool';

const base: Svodka = {
  dateLabel: '30 сентября',
  generatedAt: '2026-09-30T07:00:00.000Z',
  safety: {
    hasAlert: true, maxSeverity: 1, activeCount: 10, topTitle: 'Подъём воды на реках юга',
    topType: 'flood', dataUpdatedAt: null, source: 'МЧС России по Камчатскому краю',
    feedCount: 2, feedTitles: ['Подъём воды на реках юга', 'Халактырский пляж: дорога со стороны Дальнего перекрыта'],
  },
  volcanoes: {
    sources: 'Источники — …', complete: true, more: 0,
    items: [{ name: 'Шивелуч', ash: 'оранжевый', ashKm: 12, tremor: 'жёлтый', level: 'orange' }],
  },
  weather: [
    { name: 'Авачинский', days: [{ date: '2026-09-30', tempMin: -11, tempMax: -10, precipMm: 29.9, windKmh: 18, weatherCode: 75, description: 'Сильный снег' }], reason: null },
    { name: 'Эссо', days: null, reason: 'timeout' },
  ],
};

describe('текст сводки', () => {
  const text = svodkaText(base);

  it('предупреждения — как в ленте сайта, с датой и ссылкой', () => {
    expect(text).toContain('Сводка Ведара для гидов · 30 сентября');
    expect(text).toContain('— Халактырский пляж: дорога со стороны Дальнего перекрыта');
    expect(text).toContain('https://vedarai.ru/svodka');
  });

  it('вулкан — оба кода и высота пепла', () => {
    expect(volcanoPhrase(base.volcanoes!.items[0])).toBe('Шивелуч: пепел оранжевый, до 12 км; сейсмичность жёлтый');
  });

  it('погода по-русски, минус — типографский', () => {
    expect(weatherPhrase(base.weather[0].days![0])).toBe('−11…−10°, сильный снег, осадки 30 мм, ветер до 18 км/ч');
  });

  it('прогноз не получили — так и сказано, а не пусто', () => {
    expect(text).toContain('— Эссо: прогноз не получили');
  });

  it('обстановку не прочитали — это не «всё спокойно» (§4.0)', () => {
    const t = svodkaText({ ...base, safety: null, volcanoes: null });
    expect(t).toContain('обстановку получить не удалось');
    expect(t).toContain('сводки вулканов получить не удалось');
    expect(t).not.toContain('предупреждений, меняющих планы, нет');
    expect(t).not.toContain('повышенной активности нет');
  });

  it('неполные источники вулканов — оговорка, а не «нет активности»', () => {
    const t = svodkaText({ ...base, volcanoes: { sources: '', complete: false, items: [], more: 0 } });
    expect(t).toContain('не все источники проверены');
  });

  it('никакой разметки и эмодзи — текст уходит в любой мессенджер', () => {
    expect(text).not.toMatch(/[*_<>]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('вулканы: один отбор с Кузьмичом', () => {
  const input: VolcanoInput = {
    kvert: [
      { ark: null, place_name: 'Шивелуч', name: 'SHEVELUCH', acc: 'orange', ash_height_m: 12000, observed_at: '2026-09-25T00:00:00Z' },
      { ark: null, place_name: 'Авачинский', name: 'AVACHINSKY', acc: 'green', ash_height_m: null, observed_at: '2026-09-25T00:00:00Z' },
      { ark: null, place_name: 'Безымянный', name: 'BEZYMIANNY', acc: 'yellow', ash_height_m: null, observed_at: '2026-09-25T00:00:00Z' },
    ],
    kfegsDate: null,
    kfegs: [],
  };
  const now = Date.parse('2026-09-30T00:00:00Z');

  it('спокойный не попадает, опаснейший первым', () => {
    expect(elevatedVolcanoes(input, now).items.map((m) => m.name)).toEqual(['Шивелуч', 'Безымянный']);
  });

  it('ответ Кузьмича перечисляет тех же и в том же порядке', () => {
    const report = composeVolcanoReport(input, undefined, now);
    expect(report.indexOf('Шивелуч')).toBeLessThan(report.indexOf('Безымянный'));
    expect(report).not.toContain('Авачинский');
  });

  it('страница и сборщик не считают своего — только общие функции', () => {
    const src = readFileSync(join(process.cwd(), 'lib/svodka/svodka.ts'), 'utf-8');
    expect(src).toContain('getCurrentSafetyStatus');
    expect(src).toContain('elevatedVolcanoes(');
    expect(src).toContain('fetchForecastDays(');
    expect(src).not.toMatch(/FROM\s+external_alerts|FROM\s+volcano_status/i);
    const page = readFileSync(join(process.cwd(), 'app/svodka/page.tsx'), 'utf-8');
    expect(page).toContain('svodkaText(s)');
  });
});
