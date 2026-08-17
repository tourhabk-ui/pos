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
import { trackLine, connectorLine, CONNECTOR_TITLES, gradeFromSource } from '@/lib/map/line-standard';
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

/**
 * Источник важнее плотности.
 *
 * До 11.08 род линии определяла одна эвристика — плотность точек. Проба 55
 * показала, чего она стоит: источник ЗАПИСАН у 295 записей из 301
 * (idilesom 257, waypoints_synthetic 19, osm 13, visitkamchatka 6,
 * не указан 6), и эвристика расходится с записью в семи случаях.
 *
 * Один из семи опасен: «Вулкан Жупановский» — синтетика, но точек столько,
 * что плотность выдаёт набросок за снятый трек. Сплошная зелёная означает
 * «здесь идут»; это ровно та ложь, ради которой писался §12.
 */
describe('род линии спрашивается у записи, а не угадывается', () => {
  /** Плотная линия: по одной плотности сошла бы за снятый трек. */
  const DENSE: LatLng[] = Array.from({ length: 200 }, (_, i) => [53 + i * 0.0003, 158.6 + i * 0.0005]);
  /** Редкая линия: по плотности — набросок. */
  const SPARSE: LatLng[] = [[53, 158.6], [53.4, 159.0], [53.8, 159.4]];

  it('синтетика остаётся наброском при любой плотности', () => {
    // Тот самый «Вулкан Жупановский».
    const line = trackLine(DENSE, 'waypoints_synthetic');
    expect(line!.fidelity).toBe('sketch');
    expect(line!.style.dashArray).toBeTruthy();
    expect(line!.caption).toContain('прямыми между точками');
  });

  it('снятый источник даёт трек, даже если точек мало', () => {
    // Шесть настоящих треков рисовались пунктиром из-за редких точек:
    // ошибка в сторону осторожности, но всё равно ошибка.
    const line = trackLine(SPARSE, 'idilesom');
    expect(line!.fidelity).toBe('surveyed');
    expect(line!.style.dashArray).toBeFalsy();
    // Снятому треку оговорка не нужна.
    expect(line!.caption).toBe('');
  });

  it('незнакомый источник треком НЕ считается', () => {
    // Список замкнутый: ошибиться в эту сторону дороже — сплошная зовёт идти.
    const line = trackLine(SPARSE, 'какой-то-новый-импорт');
    expect(line!.fidelity).toBe('sketch');
  });

  it('источника нет — эвристика остаётся, но называет себя догадкой', () => {
    // Два вида линии на три состояния означали бы, что «неизвестно» рисуется
    // как одно из известных. Тот же класс, что Number(null) === 0.
    const line = trackLine(DENSE, null);
    expect(line!.fidelity).toBe('surveyed');
    expect(line!.caption).toContain('не записано');
  });

  it('поведение без источника не изменилось для наброска', () => {
    // Старые вызовы trackLine(coords) продолжают работать так же.
    expect(trackLine(SPARSE)!.fidelity).toBe('sketch');
    expect(trackLine(SPARSE)!.caption).toBeTruthy();
  });

  it('нет линии — по-прежнему null, а не стиль по умолчанию', () => {
    expect(trackLine(null, 'idilesom')).toBeNull();
    expect(trackLine([[53, 158]], 'idilesom')).toBeNull();
  });
});

/**
 * Источник ПЕРЕДАЁТСЯ, а не только принимается.
 *
 * Правило «род линии — по записи» мертво, пока экраны зовут trackLine без
 * второго аргумента: undefined означает «не спрашивали», и всё продолжает
 * решать плотность. Каждый потребитель обязан передать источник — иначе
 * договорённость живёт только в этом файле.
 */
describe('каждый потребитель передаёт источник', () => {
  const read = (p: string) => require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), p), 'utf-8',
  ) as string;

  it('API отдаёт geometrySource рядом с track', () => {
    const src = read('app/api/routes/[id]/route.ts');
    expect(src).toMatch(/geometrySource/);
  });

  it('планер: превью по точкам — синтетика по построению', () => {
    const src = read('app/planning/_PlanningClient.tsx');
    expect(src).toMatch(/trackLine\(line, 'waypoints_synthetic'\)/);
  });

  it('полевой режим: род линии спрашивается у записи, не у плотности', () => {
    // На «Вулкане Жупановском» плотностная эвристика выдавала синтетику за
    // снятый трек: fidelity полевого экрана обязана идти через trackLine
    // с источником из API, эвристика — только когда источник не записан.
    const src = read('app/planning/_PlanningClient.tsx');
    expect(src).toMatch(/trackLine\(track, geometrySource\)/);
    expect(src).toMatch(/setGeometrySource\(/);
    // Голого плотностного вызова в полевом экране не осталось.
    expect(src).not.toMatch(/trackFidelity\(track\)/);
  });

  it('карточка маршрута различает серверный трек и ломаную по точкам', () => {
    const src = read('app/routes/[id]/_RouteDetailClient.tsx');
    expect(src).toMatch(/geometrySource \?\? null/);
    expect(src).toMatch(/'waypoints_synthetic'/);
    // Вызова без источника не осталось.
    expect(src).not.toMatch(/trackLine\(trackCoords\)/);
  });
});

/**
 * Реестр синтетических источников — один на всю систему.
 *
 * Перепись геометрии 17.08 нашла в базе слог `road_graph_astar` (линия
 * проложена A* по графу дорог, `/api/cron/route-lay`) и заодно нашла
 * расхождение: `lib/routes/twins.ts` уже считал его синтетикой, а стандарт
 * линии о нём не знал — и такая линия попадала под плотностную эвристику.
 *
 * У проложенной по дорогам линии вершины частые. Эвристика на ней даёт
 * «снятый трек», то есть сплошную зелёную в четыре пикселя — приглашение идти
 * по дороге, которую никто не проверял. Один слог, два модуля, два ответа:
 * ровно тот класс, ради которого §12 и писался.
 */
describe('реестр синтетики не разъезжается по модулям', () => {
  it('A* по графу дорог — построение, а не снятый путь', () => {
    expect(gradeFromSource('road_graph_astar')).toBe('sketch');
  });

  it('twins берёт реестр из стандарта, а не заводит свой', () => {
    const twins = readFileSync(join(process.cwd(), 'lib/routes/twins.ts'), 'utf-8');
    expect(twins).toMatch(/import \{ SYNTHETIC_SOURCES \} from '@\/lib\/map\/line-standard'/);
    expect(twins).not.toMatch(/const SYNTHETIC_SOURCES = new Set/);
  });
});
