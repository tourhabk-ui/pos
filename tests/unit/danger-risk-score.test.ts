/**
 * Сторож расчёта риска зоны (вопрос владельца 02.10: «как считает 100, из чего
 * это складывается?»).
 *
 * Авачинская зона стояла «Критической» с командой «Немедленная эвакуация»:
 * каждый толчок за 48 часов добавлял баллы, и рой афтершоков в океане за
 * 170-200 км от Петропавловска (ML 6.2 и семнадцать слабее) набрал 189 → 100.
 * KVERT при этом был зелёным, сейсмичность по КФ ЕГС — фоновой.
 *
 * Сторож держит три свойства: расстояние снижает балл, число толчков почти
 * не растит его, землетрясение без вулкана эвакуацию не объявляет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  quickRiskScore, riskLevel, seismicScore, seismicEventPoints, shakingIntensity,
  volcanicScore, extractAshHeight, extractDepthKm, recommendedAction,
  SEISMIC_MAX, type SeismicInput,
} from '@/lib/agents/agencies/danger-analyst-agency';

function quake(magnitude: number, distance_km: number | null): SeismicInput {
  return {
    title: `Землетрясение ML ${magnitude}`, description: '', magnitude, distance_km,
    published_at: '2026-10-02T00:00:00Z', severity: 1,
  };
}

// Рой 02.10 в той форме, в какой его видел `get_guardian_context`: расстояния —
// от Петропавловска, до ближайшего района они того же порядка.
const SWARM_0210: SeismicInput[] = [
  quake(6.2, 182), quake(5.0, 185), quake(5.2, 196), quake(5.3, 190), quake(5.6, 176),
  quake(4.0, 178), quake(4.0, 195), quake(4.2, 190), quake(4.2, 197), quake(4.3, 194),
  quake(4.5, 178), quake(4.5, 188), quake(4.5, 194), quake(4.5, 195), quake(4.7, 169),
  quake(4.8, 173), quake(4.8, 179), quake(4.8, 37),
];

describe('рой 02.10 больше не объявляет эвакуацию', () => {
  it('зона — «Внимание», а не «Критическая»', () => {
    const score = quickRiskScore({ seismic_events: SWARM_0210, volcanic_alerts: [], tourists_in_zone: 0 });
    expect(riskLevel(score)).toBe('moderate');
  });

  it('M6.2 за 182 км — «Внимание», не тревога', () => {
    expect(riskLevel(seismicScore([quake(6.2, 182)]))).toBe('moderate');
  });
});

describe('расстояние снижает балл', () => {
  it('тот же толчок ближе — сильнее', () => {
    expect(shakingIntensity(6, 20)).toBeGreaterThan(shakingIntensity(6, 200));
    expect(seismicEventPoints(6, 20)).toBeGreaterThan(seismicEventPoints(6, 200));
  });

  it('далёкий слабый толчок не ощущается и почти ничего не весит', () => {
    expect(seismicEventPoints(4.0, 190)).toBeLessThan(10);
  });

  it('сильный близкий толчок поднимает зону до «высокой»', () => {
    expect(riskLevel(seismicScore([quake(7.0, 30)]))).toBe('high');
  });

  it('на нулевом расстоянии балл конечен', () => {
    expect(Number.isFinite(shakingIntensity(5, 0))).toBe(true);
  });
});

describe('рой не складывается в тревогу', () => {
  it('двенадцать одинаковых толчков весят чуть больше одного', () => {
    const one = seismicScore([quake(4.8, 30)]);
    const many = seismicScore(Array.from({ length: 12 }, () => quake(4.8, 30)));
    expect(many).toBeGreaterThan(one);
    expect(many - one).toBeLessThanOrEqual(5);
  });

  it('неощутимые толчки к рою не прибавляют', () => {
    const one = seismicScore([quake(4.8, 30)]);
    const withFar = seismicScore([quake(4.8, 30), ...Array.from({ length: 10 }, () => quake(4.0, 190))]);
    expect(withFar).toBe(one);
  });
});

describe('землетрясение само «немедленную эвакуацию» не объявляет', () => {
  it('сейсмика ограничена «высокой»', () => {
    expect(seismicScore([quake(8.5, 10), quake(8.0, 10)])).toBeLessThanOrEqual(SEISMIC_MAX);
    expect(riskLevel(SEISMIC_MAX)).toBe('high');
  });

  it('и надбавка за туристов не дотягивает её до «критической»', () => {
    const score = quickRiskScore({ seismic_events: [quake(8.5, 10)], volcanic_alerts: [], tourists_in_zone: 500 });
    expect(riskLevel(score)).toBe('high');
  });

  it('вулкан «критическую» по-прежнему даёт', () => {
    const volcanic = { title: 'Извержение', description: '', ash_height: 12000, published_at: '', severity: 3 };
    const score = quickRiskScore({ seismic_events: [quake(6, 50)], volcanic_alerts: [volcanic], tourists_in_zone: 0 });
    expect(riskLevel(score)).toBe('critical');
  });
});

describe('расстояние неизвестно — не выдумывается', () => {
  it('без координат — прежняя шкала по магнитуде, и она ниже «высокой»', () => {
    expect(seismicEventPoints(6.2, null)).toBe(25);
    expect(seismicEventPoints(7.5, null)).toBe(40);
    expect(riskLevel(seismicScore([quake(7.5, null)]))).not.toBe('high');
  });

  it('загрузчик берёт координаты и магнитуду из колонок', () => {
    const SRC = readFileSync(join(process.cwd(), 'lib/agents/agencies/danger-analyst-agency.ts'), 'utf-8');
    expect(SRC).toMatch(/lat::float8 AS lat, lng::float8 AS lng/);
    expect(SRC).toMatch(/kmToNearestTouristArea\(a\.lat, a\.lng\)/);
  });
});

describe('18.10.2026: рутинные вулканы и глубокий толчок эвакуацию не объявляют', () => {
  const routine = (title: string) => ({
    title, description: '', ash_height: extractAshHeight(title), published_at: '', severity: 1,
  });

  it('«не ближе 10 км к вершине» — не пепел на 10 км', () => {
    expect(extractAshHeight('Вулкан Шивелуч: не ближе 10 км к вершине')).toBeUndefined();
    expect(extractAshHeight('Вулкан Безымянный: не приближаться')).toBeUndefined();
  });

  it('настоящий пепел по-прежнему читается', () => {
    expect(extractAshHeight('Пепел до 12 км')).toBe(12000);
    expect(extractAshHeight('Выброс пепла на 8 км')).toBe(8000);
    expect(extractAshHeight('Пепловый выброс до 6 000 м')).toBe(6000);
  });

  it('северная зона 18.10: три «не приближаться» — не 80 и не критическая', () => {
    const volcanic_alerts = [
      routine('Вулкан Шивелуч: не ближе 10 км к вершине'),
      routine('Вулкан Безымянный: не приближаться'),
      routine('Вулкан Ключевской: не приближаться'),
    ];
    const score = quickRiskScore({ seismic_events: [], volcanic_alerts, tourists_in_zone: 0 });
    expect(score).toBeLessThan(30);
    expect(riskLevel(score)).toBe('low');
    expect(recommendedAction(riskLevel(score), 0)).not.toMatch(/EVACUATE/);
  });

  it('вулканы складываются по самому сильному, а не суммой', () => {
    const three = [routine('А'), routine('Б'), routine('В')];
    expect(volcanicScore(three)).toBeLessThan(30);
    expect(volcanicScore(three)).toBeLessThan(3 * 15);
  });

  it('глубина 128 км снижает балл далёкого ML 6.5', () => {
    expect(extractDepthKm('Землетрясение, глубина 127,8 км')).toBeCloseTo(127.8);
    const deep = seismicEventPoints(6.5, 41, 128);
    const shallow = seismicEventPoints(6.5, 41);
    expect(deep).toBeLessThan(shallow);
    expect(deep).toBe(35);
  });

  it('авачинская зона 18.10: глубокий ML 6.5 + Мутновский — умеренная, без эвакуации', () => {
    const events: SeismicInput[] = [{
      title: 'Землетрясение ML 6.5', description: 'глубина 127,8 км', magnitude: 6.5,
      distance_km: 41, depth_km: 128, published_at: '2026-10-16T00:00:00Z', severity: 1,
    }];
    const score = quickRiskScore({
      seismic_events: events,
      volcanic_alerts: [routine('Вулкан Мутновский: не приближаться')],
      tourists_in_zone: 0,
    });
    expect(riskLevel(score)).toBe('moderate');
    expect(recommendedAction(riskLevel(score), 0)).not.toMatch(/EVACUATE/);
  });

  it('EVACUATE_* требует туристов в зоне или официальный источник', () => {
    expect(recommendedAction('critical', 0)).not.toMatch(/EVACUATE/);
    expect(recommendedAction('high', 0)).not.toMatch(/EVACUATE/);
    expect(recommendedAction('critical', 12)).toBe('EVACUATE_IMMEDIATE');
    expect(recommendedAction('critical', 0, true)).toBe('EVACUATE_IMMEDIATE');
  });
});
