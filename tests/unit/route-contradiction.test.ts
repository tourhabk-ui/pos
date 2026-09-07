/**
 * Сторож судьи противоречий (lib/routes/route-contradiction).
 *
 * Проверяется НАСТОЯЩИМИ записями из разбора корпуса 07.09: если судья не
 * ловит то, что модель нашла за 600 ₽, он бесполезен, а если ловит лишнее —
 * вреден. Улики в тестах — дословно из вывода прогона, не сочинённые.
 */
import { describe, it, expect } from 'vitest';
import {
  judgePace,
  judgeRoute,
  paceIsShowable,
  type RouteFacts,
} from '../../lib/routes/route-contradiction';

const bare: RouteFacts = {
  title: null,
  activityType: null,
  season: null,
  distanceKm: null,
  durationHours: null,
  elevationGainM: null,
  description: null,
};

const facts = (over: Partial<RouteFacts>): RouteFacts => ({ ...bare, ...over });

describe('темп: ловит то, что нашёл разбор корпуса', () => {
  it('Подножье Козельского — 80 км за 4 часа треккинга', () => {
    const v = judgePace(facts({
      title: 'Подножье Козельского вулкана',
      activityType: 'trekking',
      distanceKm: 80,
      durationHours: 4,
    }));
    expect(v.state).toBe('contradiction');
    if (v.state === 'contradiction') {
      expect(v.kmh).toBeCloseTo(20, 1);
      expect(v.mode).toBe('foot');
    }
  });

  it('Озеро Тёплое — 44 км за 3 часа треккинга', () => {
    const v = judgePace(facts({
      title: 'Озеро Тёплое', activityType: 'trekking', distanceKm: 44, durationHours: 3,
    }));
    expect(v.state).toBe('contradiction');
  });

  it('Центральный–Таловские — 12 км за час по бродам', () => {
    const v = judgePace(facts({
      title: 'Центральный–Таловские источники',
      activityType: 'trekking', distanceKm: 12, durationHours: 1,
    }));
    expect(v.state).toBe('contradiction');
  });
});

describe('темп: не судит того, что судить нельзя', () => {
  it('обычный пеший темп проходит', () => {
    const v = judgePace(facts({
      title: 'Вулкан Горелый', activityType: 'trekking', distanceKm: 12, durationHours: 5,
    }));
    expect(v.state).toBe('ok');
  });

  it('облёт не судится темпом — линию не проходят сами', () => {
    const v = judgePace(facts({
      title: 'Облет Мутновского и Горелого',
      activityType: 'helicopter', distanceKm: 11, durationHours: 0.2,
    }));
    expect(v.state).toBe('unknown');
    if (v.state === 'unknown') expect(v.why).toContain('линию не проходят');
  });

  it('морская прогулка не судится темпом', () => {
    const v = judgePace(facts({
      title: 'Морская прогулка к острову Старичков', distanceKm: 68, durationHours: 4,
    }));
    expect(v.state).toBe('unknown');
  });

  it('снегоход на 25 км/ч проходит: потолок снега не пеший', () => {
    const v = judgePace(facts({
      title: 'Снегоходный выезд к Вачкажцу', activityType: 'snowmobile',
      distanceKm: 50, durationHours: 2,
    }));
    expect(v.state).toBe('ok');
  });
});

describe('третий исход обязателен и не равен «в порядке»', () => {
  it('нет длины — «не смог», а не «ok»', () => {
    const v = judgePace(facts({ title: 'Х', activityType: 'trekking', durationHours: 4 }));
    expect(v.state).toBe('unknown');
    if (v.state === 'unknown') expect(v.why).toContain('длина');
  });

  it('нет длительности — «не смог»', () => {
    const v = judgePace(facts({ title: 'Х', activityType: 'trekking', distanceKm: 40 }));
    expect(v.state).toBe('unknown');
    if (v.state === 'unknown') expect(v.why).toContain('длительность');
  });

  it('ноль часов — отсутствие данных, а не мгновенный маршрут', () => {
    const v = judgePace(facts({
      title: 'Х', activityType: 'trekking', distanceKm: 40, durationHours: 0,
    }));
    expect(v.state).toBe('unknown');
  });

  it('пустая запись: противоречий нет, но и «в порядке» не сказано', () => {
    const { contradictions, unchecked } = judgeRoute(bare);
    expect(contradictions).toEqual([]);
    expect(unchecked.length).toBeGreaterThan(0);
  });
});

describe('сезон против рода активности', () => {
  it('Вачкажец (лыжный): ski при season=all', () => {
    const { contradictions } = judgeRoute(facts({
      title: 'Горный массив Вачкажец (лыжный)', activityType: 'ski', season: 'all',
    }));
    expect(contradictions.some((c) => c.kind === 'season_conflict')).toBe(true);
  });

  it('лыжный маршрут зимой противоречием не считается', () => {
    const { contradictions } = judgeRoute(facts({
      title: 'Горный массив Вачкажец (лыжный)', activityType: 'ski', season: 'winter',
    }));
    expect(contradictions.some((c) => c.kind === 'season_conflict')).toBe(false);
  });

  it('нет сезона — «не смог», а не «согласовано»', () => {
    const { contradictions, unchecked } = judgeRoute(facts({ activityType: 'ski' }));
    expect(contradictions.some((c) => c.kind === 'season_conflict')).toBe(false);
    expect(unchecked.some((u) => u.startsWith('сезон'))).toBe(true);
  });
});

describe('описание против полей', () => {
  it('Гора Юрчик: «примерно 300 метров» против 1000 в поле', () => {
    const { contradictions } = judgeRoute(facts({
      title: 'Гора Юрчик', activityType: 'trekking', distanceKm: 32, elevationGainM: 1000,
      description: 'Маршрут подходит для туристов без специальной подготовки. Подъем занимает около 1,5-2 часов в зависимости от темпа, набор высоты — примерно 300 метров.',
    }));
    expect(contradictions.some((c) => c.kind === 'elevation_conflict')).toBe(true);
  });

  it('К озеру Зеленому: «до 150 метров» против 560 в поле', () => {
    const { contradictions } = judgeRoute(facts({
      title: 'К озеру Зеленому', activityType: 'winter_hiking', season: 'winter',
      distanceKm: 8, durationHours: 1, elevationGainM: 560,
      description: 'Протяженность маршрута в одну сторону — около 4 километров, набор высоты незначительный (до 150 метров)',
    }));
    expect(contradictions.some((c) => c.kind === 'elevation_conflict')).toBe(true);
  });

  it('Бухта Ольга–Мыс Козлова: «около 12 километров» против 45 в поле', () => {
    const { contradictions } = judgeRoute(facts({
      title: 'Бухта Ольга–Мыс Козлова', activityType: 'trekking', distanceKm: 45,
      description: 'Маршрут вдоль юго-восточного побережья Камчатки протяженностью около 12 километров в одну сторону.',
    }));
    expect(contradictions.some((c) => c.kind === 'distance_conflict')).toBe(true);
  });

  it('«в одну сторону» вдвое меньше поля — НЕ противоречие: это учёт обратного пути', () => {
    const { contradictions } = judgeRoute(facts({
      title: 'Х', activityType: 'trekking', distanceKm: 24,
      description: 'Протяженность маршрута около 12 километров в одну сторону.',
    }));
    expect(contradictions.some((c) => c.kind === 'distance_conflict')).toBe(false);
  });

  it('описания нет — «не смог», и это названо', () => {
    const { unchecked } = judgeRoute(facts({ activityType: 'trekking', distanceKm: 10 }));
    expect(unchecked.some((u) => u.startsWith('описание'))).toBe(true);
  });
});

describe('показывать ли пару «длина и время»', () => {
  it('противоречивую пару показывать нельзя', () => {
    expect(paceIsShowable(facts({
      title: 'Подножье Козельского вулкана', activityType: 'trekking',
      distanceKm: 80, durationHours: 4,
    }))).toBe(false);
  });

  it('несудимую пару показывать можно: запрет только по доказанному', () => {
    expect(paceIsShowable(facts({ title: 'Х', distanceKm: 10 }))).toBe(true);
  });
});

describe('судья не заводит своего классификатора способа', () => {
  it('способ берётся у travel-mode', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/routes/route-contradiction.ts', 'utf8'));
    expect(src).toContain("from './travel-mode'");
    // Запрещено не СЛОВО, а второй список признаков: объяснять порог в прозе
    // нужно, а опознавать способ своими регулярками — нельзя (§12).
    expect(src).not.toMatch(/MARKERS\s*[:=]/);
    expect(src).not.toMatch(/\/[^/\n]*(?:обл[еёя]т|вертол|катер|сплав|лыжн)[^/\n]*\/[gimsuy]*/i);
  });
});
