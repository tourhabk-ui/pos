/**
 * Стандарт линии на карте: линия называет своё происхождение видом.
 *
 * На карте линия — обещание. Сплошная зелёная в четыре пикселя читается как
 * «здесь идут», и человек по ней пойдёт. У полутора сотен маршрутов geometry
 * построена миграцией 168 прямыми между точками — такая линия проходит через
 * каньон и реку.
 *
 * Правило это жило на одном экране из трёх. Карточка маршрута рисовала ту же
 * ломаную сплошной красной, планер соединял дни плана в разных зонах — сотни
 * километров через хребты — сплошной оранжевой под словом «Маршрут». Одно
 * правило, реализованное трижды, — это три правила, и они разошлись.
 *
 * Здесь проверяется, что правило одно и что оно доехало до всех поверхностей.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackLine, connectorLine, CONNECTOR_TITLES } from '@/lib/map/line-standard';
import type { LatLng } from '@/lib/routes/track-fidelity';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Снятый трек: густо, десятки точек на километр. */
const SURVEYED: LatLng[] = Array.from({ length: 400 }, (_, i) => [53 + i * 0.0002, 158] as LatLng);
/** Набросок миграции 168: три точки на два десятка километров. */
const SKETCH: LatLng[] = [[53, 158], [53.1, 158.1], [53.2, 158.05]];

describe('вид линии следует за происхождением', () => {
  it('снятый трек — сплошной и толстый', () => {
    const l = trackLine(SURVEYED)!;
    expect(l.fidelity).toBe('surveyed');
    expect(l.style.dashArray).toBeUndefined();
    expect(l.style.weight).toBeGreaterThanOrEqual(4);
  });

  it('набросок — пунктир и тоньше', () => {
    const l = trackLine(SKETCH)!;
    expect(l.fidelity).toBe('sketch');
    expect(l.style.dashArray).toBeDefined();
    expect(l.style.weight).toBeLessThan(4);
  });

  it('у наброска есть подпись, у трека её нет', () => {
    // Вид несёт то же самое, но на карточке в 240 пикселей пунктир от
    // сплошной отличит не каждый глаз. Подпись — второй канал, не дубль.
    expect(trackLine(SKETCH)!.caption).not.toBe('');
    expect(trackLine(SURVEYED)!.caption).toBe('');
  });

  it('линии нет — нет и стиля, а не стиль по умолчанию', () => {
    // Стиль «на всякий случай» нарисовал бы линию там, где её нет.
    expect(trackLine(null)).toBeNull();
    expect(trackLine([])).toBeNull();
    expect(trackLine([[53, 158]])).toBeNull();
  });
});

describe('построение — линия другой природы, а не «менее важная»', () => {
  it('всегда пунктир и приглушённое', () => {
    const c = connectorLine();
    expect(c.dashArray).toBeDefined();
    expect(c.weight).toBeLessThan(4);
  });

  it('никогда не выглядит как снятый трек', () => {
    const c = connectorLine();
    const s = trackLine(SURVEYED)!.style;
    expect(c.color).not.toBe(s.color);
    expect(c.dashArray).not.toBe(s.dashArray);
  });

  it('имя не называет построение маршрутом', () => {
    // Слово решает не меньше вида: «Маршрут» между Петропавловском и Ключами
    // человек поймёт как проход, а там триста километров и хребет.
    for (const t of Object.values(CONNECTOR_TITLES)) {
      expect(t.toLowerCase()).not.toMatch(/^маршрут$/);
    }
    expect(CONNECTOR_TITLES.planOrder.toLowerCase()).toContain('не маршрут');
  });
});

describe('правило доехало до всех поверхностей, где рисуется путь', () => {
  const surfaces = [
    ['карточка маршрута', 'app/routes/[id]/_RouteDetailClient.tsx'],
    ['на маршруте', 'app/planning/_PlanningClient.tsx'],
    ['планер', 'app/planner/_PlannerClient.tsx'],
  ] as const;

  it('каждая берёт вид линии из общего стандарта, а не собирает свой', () => {
    for (const [name, path] of surfaces) {
      expect(read(path), name).toMatch(/from '@\/lib\/(map\/line-standard|routes\/track-fidelity)'/);
    }
  });

  it('нигде не осталось сплошной толстой линии, собранной вручную', () => {
    // Именно так выглядел дефект: color+weight прямо в объекте геометрии.
    // Ищем толстую линию с явным цветом — признак обещания тропы в обход
    // правила. Тонкие и пунктирные к стандарту приводятся отдельно.
    for (const [name, path] of surfaces) {
      const src = read(path);
      const handmade = src.match(/type: 'polyline'[^}]*color: '[^']+'[^}]*weight: [4-9]/g) ?? [];
      expect(handmade, `${name}: ${handmade.join(' | ')}`).toHaveLength(0);
    }
  });

  it('карточка маршрута говорит происхождение словами, а не только видом', () => {
    // Решение «идти по этой линии» человек принимает на карточке.
    expect(read('app/routes/[id]/_RouteDetailClient.tsx')).toMatch(/track\.caption/);
  });
});
