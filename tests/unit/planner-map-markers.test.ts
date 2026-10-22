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
import { buildPlannerMarkers, plannerLegend, type PlannerMapRoute, type PlannerMapDay } from '@/lib/planner/map-markers';
import { ZONE_PIN, NO_ZONE_PIN, PLAN_DAY_PIN, zoneName, ZONE_NOT_RECORDED, ZONE_OUTSIDE } from '@/lib/planner/zone-style';
import { resolveMarkerColor, MARKER_HEX } from '@/lib/map/marker-colors';
import { labelPinHtml, labelPinSize, PLAIN_PIN_DIAMETER } from '@/lib/map/label-pin';
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
