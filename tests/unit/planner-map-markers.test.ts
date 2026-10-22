/**
 * Сторож: карта планировщика рисует то, что обещает легенда (владелец 22.10:
 * «как работает карта в Планировщике не пойму?» → «карта да»).
 *
 * Было: фоновые точки красились строками пресетов Яндекс-карт в поле
 * `preset`, которого LeafletMap не читал, — все точки синие; дни плана —
 * синие и красный, такой же формы, без номера; плашка обещала четыре цвета
 * зон кружками токенов темы.
 *
 * Держит правило вызовом (lib/planner/map-markers, lib/planner/zone-style,
 * lib/map/label-pin, lib/map/fit-when-sized):
 *   — у каждой фоновой точки цвет своей зоны, у разных зон цвета разные, и
 *     ни одна зона не носит цвет дня плана;
 *   — при замене дня яркие только точки той же зоны, остальные серые;
 *   — дни плана — кружки с номерами 1..n по порядку плана, одним цветом,
 *     которого нет у точек; день, который правят, выделен;
 *   — легенда — только нарисованные зоны и ровно тот hex, каким LeafletMap
 *     нарисует пин;
 *   — запрет: пресетов Яндекс-карт и поля `preset` у маркеров нет нигде.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPlannerMarkers, plannerLegend, parseDayPinId, nextDayOnPin, dayPinLabel, sameZoneCount,
  type PlannerMapRoute, type PlannerMapDay,
} from '@/lib/planner/map-markers';
import { ZONE_PIN, NO_ZONE_PIN, PLAN_DAY_PIN, zoneName, ZONE_NOT_RECORDED, ZONE_OUTSIDE } from '@/lib/planner/zone-style';
import { resolveMarkerColor, MARKER_HEX } from '@/lib/map/marker-colors';
import { labelPinHtml, labelPinSize, labelPinBox, PLAIN_PIN_DIAMETER } from '@/lib/map/label-pin';
import { fitDecision } from '@/lib/map/fit-when-sized';
import { ZONE_IDS } from '@/lib/planner/constants';

const ROUTES: PlannerMapRoute[] = [
  { id: 'r-ava', title: 'Вулкан Авачинский', lat: 53.25, lng: 158.83, zone: 'avachinsky' },
  { id: 'r-ava2', title: 'Вулкан Мутновский', lat: 52.45, lng: 158.19, zone: 'avachinsky' },
  { id: 'r-west', title: 'Курильское озеро', lat: 51.45, lng: 157.1, zone: 'western' },
  { id: 'r-east', title: 'Долина гейзеров', lat: 54.43, lng: 160.14, zone: 'eastern' },
  { id: 'r-north', title: 'Вулкан Толбачик', lat: 55.83, lng: 160.33, zone: 'northern' },
  { id: 'r-none', title: 'Без зоны', lat: 53.1, lng: 158.4, zone: null },
];

const DAYS: PlannerMapDay[] = [
  { day: 7, title: 'Прилёт', zone: 'avachinsky', coords: [53.01, 158.65] },
  { day: 3, title: 'Курильское озеро', zone: 'western', coords: [51.45, 157.1] },
  { day: 5, title: 'Толбачик', zone: 'northern', coords: [55.83, 160.33] },
];

/** Hex, которым LeafletMap нарисует пин этого маркера (тот же вызов, что в нём). */
const pinHex = (color: string | undefined) => resolveMarkerColor(color, 'blue');

describe('фоновые точки — цветом своей зоны', () => {
  const markers = buildPlannerMarkers({ routes: ROUTES, days: [], editingDayId: null });
  const byId = new Map(markers.map(m => [m.id, m]));

  it('у каждой точки цвет её зоны из базы, без зоны — серый', () => {
    expect(byId.get('r-ava')?.color).toBe(ZONE_PIN.avachinsky);
    expect(byId.get('r-west')?.color).toBe(ZONE_PIN.western);
    expect(byId.get('r-east')?.color).toBe(ZONE_PIN.eastern);
    expect(byId.get('r-north')?.color).toBe(ZONE_PIN.northern);
    expect(byId.get('r-none')?.color).toBe(NO_ZONE_PIN);
  });

  it('четыре зоны — четыре разных цвета пина, и ни один не серый и не цвет дня', () => {
    const hexes = ZONE_IDS.map(z => pinHex(ZONE_PIN[z]));
    expect(new Set(hexes).size).toBe(4);
    expect(hexes).not.toContain(MARKER_HEX[NO_ZONE_PIN]);
    expect(hexes).not.toContain(MARKER_HEX[PLAN_DAY_PIN]);
    // Синий был цветом ВСЕХ точек (22.10), красный — опасность.
    expect(hexes).not.toContain(MARKER_HEX.blue);
    expect(hexes).not.toContain(MARKER_HEX.red);
  });

  it('цвет точки — имя из таблицы пинов, LeafletMap его не теряет', () => {
    for (const m of markers) {
      expect(m.color && m.color in MARKER_HEX, String(m.id)).toBe(true);
    }
  });

  it('ни у одного маркера нет поля preset — его никто не читает', () => {
    for (const m of markers) expect(Object.keys(m)).not.toContain('preset');
  });
});

describe('замена дня: яркие — та же зона, серые — другие', () => {
  it('день в Авачинской — яркие только авачинские точки', () => {
    const markers = buildPlannerMarkers({ routes: ROUTES, days: DAYS, editingDayId: 7 });
    const color = (id: string) => markers.find(m => m.id === id)?.color;
    expect(color('r-ava')).toBe(ZONE_PIN.avachinsky);
    expect(color('r-ava2')).toBe(ZONE_PIN.avachinsky);
    expect(color('r-west')).toBe(NO_ZONE_PIN);
    expect(color('r-east')).toBe(NO_ZONE_PIN);
    expect(color('r-north')).toBe(NO_ZONE_PIN);
    expect(color('r-none')).toBe(NO_ZONE_PIN);
  });

  it('без замены дня серых точек с зоной нет', () => {
    const markers = buildPlannerMarkers({ routes: ROUTES, days: DAYS, editingDayId: null });
    const zoned = markers.filter(m => ROUTES.some(r => r.id === m.id && r.zone));
    for (const m of zoned) expect(m.color).not.toBe(NO_ZONE_PIN);
  });
});

describe('дни плана — кружки с номером, отличимые от точек', () => {
  const markers = buildPlannerMarkers({ routes: ROUTES, days: DAYS, editingDayId: 3 });
  const dayMarkers = markers.filter(m => m.id?.startsWith('day_'));
  const dots = markers.filter(m => ROUTES.some(r => r.id === m.id));

  it('номера 1..n в порядке плана, а не по ключу дня', () => {
    expect(dayMarkers.map(m => m.id)).toEqual(['day_7', 'day_3', 'day_5']);
    expect(dayMarkers.map(m => m.label)).toEqual(['1', '2', '3']);
    expect(dayMarkers[1].title).toBe('2. Курильское озеро');
  });

  it('у дня подпись и свой цвет, у точек — ни того, ни другого', () => {
    for (const d of dayMarkers) expect(d.color).toBe(PLAN_DAY_PIN);
    for (const p of dots) {
      expect(p.label).toBeUndefined();
      expect(p.color).not.toBe(PLAN_DAY_PIN);
    }
  });

  it('день, который правят, выделен — и только он', () => {
    expect(dayMarkers.map(m => m.emphasis)).toEqual([false, true, false]);
  });

  it('пин дня крупнее точки, с числом и цветом пина', () => {
    expect(labelPinSize()).toBeGreaterThan(PLAIN_PIN_DIAMETER);
    expect(labelPinSize(true)).toBeGreaterThan(labelPinSize());
    const hex = pinHex(PLAN_DAY_PIN);
    const html = labelPinHtml('2', hex);
    expect(html).toContain('>2</div>');
    expect(html).toContain(`background:${hex}`);
  });

  it('подпись экранируется, чужой цвет в стиль не попадает', () => {
    const html = labelPinHtml('<b>1</b>', '#123456" onclick="x');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;1&lt;/b&gt;');
    expect(html).not.toContain('onclick');
    expect(html).toContain(`background:${MARKER_HEX.darkBlue}`);
  });

  it('линия между зонами плана — без своего пина (держатель линии, не место)', () => {
    const line = markers.find(m => m.geometry);
    expect(line?.geometryOnly).toBe(true);
    expect(line?.label).toBeUndefined();
  });

  it('подпись дня в маркере — имя зоны словами', () => {
    expect(dayMarkers[0].description).toBe('Авачинская зона');
  });
});

/**
 * Дни в одной точке (ревью 22.10, второй круг). Движок ставит прилёт,
 * отъезд, свободный день, отдых, возвращение и авачинский день без маршрута
 * в одну точку Петропавловска (engine.ts, PKC_COORDS = [53.01, 158.65]), а
 * продолжения многодневного тура — в точку первого дня. Пины с равными
 * координатами Leaflet кладёт один на другой: «7» закрывала «1» на любом
 * зуме, и день прилёта с карты было не открыть.
 */
describe('дни в одной точке — один пин со всеми номерами', () => {
  const PKC: [number, number] = [53.01, 158.65];
  // Семь дней из Москвы, как их собирает движок (ключи дней — не позиции).
  const TRIP: PlannerMapDay[] = [
    { day: 11, title: 'Прилёт', zone: 'avachinsky', coords: PKC },
    { day: 12, title: 'Авачинская зона', zone: 'avachinsky', coords: PKC },
    { day: 13, title: 'Переезд: Авачинская зона → Восточная зона', zone: 'eastern', coords: [54.5, 160.0] },
    { day: 14, title: 'Тур, день 1', zone: 'eastern', coords: [54.43, 160.14] },
    { day: 15, title: 'Тур — день 2 из 2', zone: 'eastern', coords: [54.43, 160.14] },
    { day: 16, title: 'Возвращение: Восточная зона → Петропавловск', zone: 'avachinsky', coords: PKC },
    { day: 17, title: 'Вылет', zone: 'avachinsky', coords: PKC },
  ];
  const pins = (editingDayId: number | null = null) =>
    buildPlannerMarkers({ routes: [], days: TRIP, editingDayId }).filter(m => m.label);

  it('каждый день плана достижим с карты: его ключ — в id пина, номер — в подписи', () => {
    const all = pins();
    TRIP.forEach((d, i) => {
      const pin = all.find(m => parseDayPinId(m.id ?? '')?.includes(d.day));
      expect(pin, `день ${i + 1}`).toBeDefined();
      expect(pin?.title, `день ${i + 1}`).toContain(`${i + 1}. ${d.title}`);
    });
    expect(all.map(m => m.label)).toEqual(['1·2·+2', '3', '4·5']);
  });

  it('двух пинов дней в одной точке нет', () => {
    const keys = pins().map(m => `${m.coords[0].toFixed(4)},${m.coords[1].toFixed(4)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('нажатия по пину перебирают его дни по кругу, после последнего — закрыть', () => {
    const pkc = parseDayPinId(pins()[0].id ?? '') ?? [];
    expect(pkc).toEqual([11, 12, 16, 17]);
    const seen: Array<number | null> = [];
    let editing: number | null = null;
    for (let i = 0; i < 5; i += 1) { editing = nextDayOnPin(pkc, editing); seen.push(editing); }
    expect(seen).toEqual([11, 12, 16, 17, null]);
    // Один день — переключатель: открыть, закрыть.
    expect(nextDayOnPin([13], null)).toBe(13);
    expect(nextDayOnPin([13], 13)).toBeNull();
    // Открыт день другого пина — нажатие открывает первый день этого.
    expect(nextDayOnPin(pkc, 13)).toBe(11);
  });

  it('пин выделен, если правят любой его день', () => {
    expect(pins(17).map(m => m.emphasis)).toEqual([true, false, false]);
    expect(pins(15).map(m => m.emphasis)).toEqual([false, false, true]);
  });

  it('подпись: подряд от трёх — диапазоном, длиннее трёх отрезков — «+N»', () => {
    expect(dayPinLabel([3])).toBe('3');
    expect(dayPinLabel([1, 7])).toBe('1·7');
    expect(dayPinLabel([1, 2])).toBe('1·2');
    expect(dayPinLabel([2, 3, 4])).toBe('2–4');
    expect(dayPinLabel([1, 2, 3, 6, 7])).toBe('1–3·6·7');
    expect(dayPinLabel([1, 2, 5, 7])).toBe('1·2·+2');
  });

  it('id пина читается обратно, чужой id — не пин дней', () => {
    expect(parseDayPinId('day_7')).toEqual([7]);
    expect(parseDayPinId('day_7_12')).toEqual([7, 12]);
    expect(parseDayPinId('r-ava')).toBeNull();
    expect(parseDayPinId('day_')).toBeNull();
    expect(parseDayPinId('route_line')).toBeNull();
  });

  it('длинная подпись — капсула шире круга, номера целиком', () => {
    const box = labelPinBox('1·2·+2');
    expect(box.width).toBeGreaterThan(box.height);
    expect(labelPinBox('7')).toEqual({ width: labelPinSize(), height: labelPinSize() });
    const html = labelPinHtml('1·7', MARKER_HEX.darkBlue);
    expect(html).toContain(`width:${labelPinBox('1·7').width}px`);
    expect(html).toContain('>1·7</div>');
  });
});

describe('замена дня, которого не заменяют, и зона, которой нет', () => {
  it('день прилёта открыт — точки не перекрашиваются: «та же зона» здесь ни к чему', () => {
    const markers = buildPlannerMarkers({ routes: ROUTES, days: DAYS, editingDayId: 7, editingReplaceable: false });
    expect(markers.find(m => m.id === 'r-west')?.color).toBe(ZONE_PIN.western);
    expect(markers.find(m => m.id === 'r-north')?.color).toBe(ZONE_PIN.northern);
    // А выделен день по-прежнему.
    expect(markers.find(m => m.id === 'day_7')?.emphasis).toBe(true);
  });

  it('сколько точек в зоне дня: зона не записана — ноль, а не «все»', () => {
    expect(sameZoneCount(ROUTES, 'avachinsky')).toBe(2);
    expect(sameZoneCount(ROUTES, 'western')).toBe(1);
    expect(sameZoneCount(ROUTES, null)).toBe(0);
    expect(sameZoneCount(ROUTES.filter(r => r.zone !== 'eastern'), 'eastern')).toBe(0);
  });

  it('день из маршрута без записанной зоны подписан «Зона не записана», а не догадкой', () => {
    const days: PlannerMapDay[] = [{ day: 1, title: 'Без зоны', zone: 'avachinsky', zoneShown: null, coords: [53.1, 158.4] }];
    const pin = buildPlannerMarkers({ routes: [], days, editingDayId: null }).find(m => m.label);
    expect(pin?.description).toBe(ZONE_NOT_RECORDED);
    const far: PlannerMapDay[] = [{ day: 1, title: 'Зимник', zone: 'northern', zoneShown: 'krai_koryak', coords: [57.8, 158.7] }];
    expect(buildPlannerMarkers({ routes: [], days: far, editingDayId: null }).find(m => m.label)?.description).toBe(ZONE_OUTSIDE);
  });
});

describe('легенда — только нарисованные зоны, тем же цветом, что пин', () => {
  it('порядок зон движка, серая строка в конце, числа сходятся', () => {
    const legend = plannerLegend(ROUTES);
    expect(legend.map(e => e.name)).toEqual(['Авачинская', 'Западная', 'Восточная', 'Северная', ZONE_NOT_RECORDED]);
    expect(legend.map(e => e.count)).toEqual([2, 1, 1, 1, 1]);
    expect(legend.reduce((a, e) => a + e.count, 0)).toBe(ROUTES.length);
  });

  it('hex строки легенды равен hex пина каждой её точки', () => {
    const legend = plannerLegend(ROUTES);
    const markers = buildPlannerMarkers({ routes: ROUTES, days: [], editingDayId: null });
    for (const r of ROUTES) {
      const marker = markers.find(m => m.id === r.id);
      const entry = legend.find(e => e.zone === (r.zone ?? null));
      expect(entry, r.id).toBeDefined();
      expect(pinHex(marker?.color), r.id).toBe(entry?.hex);
    }
  });

  it('зоны, которой нет среди точек, в легенде нет', () => {
    const legend = plannerLegend(ROUTES.filter(r => r.zone === 'avachinsky'));
    expect(legend.map(e => e.name)).toEqual(['Авачинская']);
  });

  it('район вне четырёх зон назван так, а не «не записана»', () => {
    const far: PlannerMapRoute = { id: 'far', title: 'Зимник Анавгай — Тигиль', lat: 57.8, lng: 158.7, zone: 'krai_koryak' };
    expect(plannerLegend([far]).map(e => e.name)).toEqual([ZONE_OUTSIDE]);
    expect(plannerLegend([far, ROUTES[5]])[0].name).toMatch(/Вне четырёх зон или не записана/);
    expect(zoneName('krai_koryak')).toBe(ZONE_OUTSIDE);
    expect(zoneName(null)).toBe(ZONE_NOT_RECORDED);
  });

  it('пусто — пустая легенда', () => {
    expect(plannerLegend([])).toEqual([]);
  });
});

describe('подгонка вида ждёт размера контейнера (вкладка «Карта» на телефоне)', () => {
  it('скрытый контейнер — ждать, а не подгонять на 0×0', () => {
    expect(fitDecision({ fitDone: false, points: 28, width: 0, height: 0 })).toBe('wait_for_size');
    expect(fitDecision({ fitDone: false, points: 28, width: 390, height: 0 })).toBe('wait_for_size');
  });
  it('видимый контейнер — подогнать один раз', () => {
    expect(fitDecision({ fitDone: false, points: 28, width: 390, height: 733 })).toBe('fit');
    expect(fitDecision({ fitDone: true, points: 28, width: 390, height: 733 })).toBe('done');
  });
  it('меньше двух точек — не по чему', () => {
    expect(fitDecision({ fitDone: false, points: 1, width: 390, height: 733 })).toBe('too_few');
  });
});

describe('запрет: пресеты Яндекс-карт и поле preset у маркеров', () => {
  const ROOTS = ['app', 'components', 'lib', 'hooks'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); }
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  for (const r of ROOTS) walk(join(process.cwd(), r));

  it('строк вида islands#… нет — Leaflet их не понимает, точка выходит синей', () => {
    const hits = files.filter(f => readFileSync(f, 'utf-8').includes('islands#'));
    expect(hits).toEqual([]);
  });

  it('у MapMarker нет поля preset', () => {
    const types = readFileSync(join(process.cwd(), 'components/shared/leaflet-types.ts'), 'utf-8');
    expect(types).not.toMatch(/\bpreset\??:/);
  });
});
