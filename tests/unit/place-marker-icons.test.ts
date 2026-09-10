/**
 * lib/map/place-marker-icons.ts — общий источник форм маркеров места.
 *
 * Владелец 07.09: «геоточки были все со своими маркерами» — на старой
 * Leaflet-карте у каждого типа места была своя форма (SVG-иконка), у новой
 * VedarMap все места рисовались одним кружком. Форма переносится в общий
 * модуль, чтобы обе карты рисовали ОДНУ форму на тип, а не рисковали
 * разъехаться при следующей правке одной из двух.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeMarkerSvg, PLACE_MARKER_KINDS, PLACE_MARKER_SIZE, PLACE_KIND_COLOR } from '@/lib/map/place-marker-icons';

const LEAFLET = readFileSync(join(process.cwd(), 'components/shared/LeafletMap.tsx'), 'utf-8');
const MAP_CLIENT = readFileSync(join(process.cwd(), 'app/map/_MapPageClient.tsx'), 'utf-8');
const PLACE_SHEET = readFileSync(join(process.cwd(), 'components/map/PlaceMapSheet.tsx'), 'utf-8');

describe('placeMarkerSvg', () => {
  it('известный тип — своя форма, залитая переданным цветом', () => {
    const svg = placeMarkerSvg('#D44A0C', 'volcano');
    expect(svg).toContain('#D44A0C');
    expect(svg).toMatch(/^<svg /);
  });

  it('разные типы дают разную форму (не один кружок на всех)', () => {
    const volcano = placeMarkerSvg('#000', 'volcano');
    const lake = placeMarkerSvg('#000', 'lake');
    const museum = placeMarkerSvg('#000', 'museum');
    expect(volcano).not.toBe(lake);
    expect(lake).not.toBe(museum);
  });

  it('неизвестный, null и undefined тип — падают на форму other', () => {
    const other = placeMarkerSvg('#000', 'other');
    expect(placeMarkerSvg('#000', 'бигфут')).toBe(other);
    expect(placeMarkerSvg('#000', null)).toBe(other);
    expect(placeMarkerSvg('#000', undefined)).toBe(other);
  });

  it('набор форм покрывает все категории фильтра /map', () => {
    // Список — из чипсов фильтра на /map (app/map/_MapPageClient.tsx):
    // Вулканы/Источники/Озёра/Горы/Реки/Гейзеры/Водопады/Смотровые/Скалы/
    // Острова/Пляжи/Леса и парки/Музеи/История.
    for (const kind of [
      'volcano', 'hot_spring', 'lake', 'mountain', 'river', 'geyser',
      'waterfall', 'viewpoint', 'rock', 'island', 'beach', 'forest',
      'museum', 'historical',
    ]) {
      expect(PLACE_MARKER_KINDS, kind).toContain(kind);
    }
  });

  /**
   * Каждый ключ, которому платформа сама даёт имя в UI (фильтр /map или
   * заголовок карточки места), обязан иметь СВОЮ форму — иначе подпись
   * называет одно («Мыс», «Пещера»), а значок молча показывает общий
   * кружок «other». Разрыв ровно такого рода нашёлся 07.09: cape,
   * settlement, valley и cave были подписаны словом в обоих словарях, но
   * падали на общую форму — сторож ловит эту рассинхронизацию впредь,
   * читая ключи прямо из словарей, а не переписывая их список руками.
   *
   * LOCATION_TYPE_CONFIG (/map) убран 10.09 — стал мёртвым кодом после
   * удаления панели «Маршрут», которая была единственным его читателем.
   * Реестр категорий фильтра теперь только один — LOCATION_FILTERS.
   */
  it('каждый location_type-фильтр LOCATION_FILTERS (/map) имеет свою форму', () => {
    const block = MAP_CLIENT.slice(
      MAP_CLIENT.indexOf('const LOCATION_FILTERS'),
      MAP_CLIENT.indexOf('];', MAP_CLIENT.indexOf('const LOCATION_FILTERS')),
    );
    const ids = [...block.matchAll(/id:\s*'([\w:]+)',\s*label:/g)]
      .map((m) => m[1])
      .filter((id) => id !== 'all' && !id.startsWith('activity:'));
    expect(ids.length).toBeGreaterThan(10);
    for (const kind of ids) {
      expect(PLACE_MARKER_KINDS, kind).toContain(kind);
    }
  });

  it('каждый ключ LOCATION_LABELS (карточка места) имеет свою форму', () => {
    const block = PLACE_SHEET.slice(
      PLACE_SHEET.indexOf('const LOCATION_LABELS'),
      PLACE_SHEET.indexOf('};', PLACE_SHEET.indexOf('const LOCATION_LABELS')),
    );
    const keys = [...block.matchAll(/(\w+):\s*'[^']+'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const kind of keys) {
      if (kind === 'other') continue;
      expect(PLACE_MARKER_KINDS, kind).toContain(kind);
    }
  });

  it('размер маркера один на обе карты', () => {
    expect(PLACE_MARKER_SIZE).toEqual({ width: 24, height: 28 });
  });

  /**
   * Владелец 07.09: «цвета геоточек не отличаются от цветов высот» — заливка
   * маркера (peak/cliff) и гипсометрия склона на VedarMap делят одну тёплую
   * земляную гамму, а кромка была захардкожена в белый. Кромка кастомным
   * цветом (VedarMap передаёт p.background) — единственное, что гарантирует
   * контраст с ЛЮБОЙ ступенью рельефа, не подбором цвета заливки на глаз.
   */
  it('кромка — параметр, по умолчанию белая (не меняет LeafletMap)', () => {
    const svg = placeMarkerSvg('#D44A0C', 'volcano');
    expect(svg).toContain('stroke="#fff"');
  });

  it('кромка передаётся в SVG вместо белой, когда указана явно', () => {
    const svg = placeMarkerSvg('#D44A0C', 'volcano', '#0D1117');
    expect(svg).toContain('stroke="#0D1117"');
    expect(svg).not.toContain('stroke="#fff"');
  });

  it('кромка не красит декоративные внутренние штрихи (пар, волна) — только внешний контур', () => {
    // hot_spring: внешний контур (fill=hex) — кромка; внутренний штрих пара — всегда белый декор.
    const svg = placeMarkerSvg('#D44A0C', 'hot_spring', '#0D1117');
    const outerMatch = svg.match(/fill="#D44A0C" stroke="([^"]+)"/);
    expect(outerMatch?.[1]).toBe('#0D1117');
    expect(svg).toContain('stroke="#fff" stroke-width="1.5" stroke-linecap="round"');
  });
});

describe('LeafletMap — использует общий источник форм, не свою копию', () => {
  it('зовёт placeMarkerSvg из общего модуля', () => {
    expect(LEAFLET).toMatch(/import \{ placeMarkerSvg \} from '@\/lib\/map\/place-marker-icons'/);
    expect(LEAFLET).toMatch(/placeMarkerSvg\(hex, marker\.category\)/);
  });

  it('своей копии набора иконок больше нет', () => {
    expect(LEAFLET).not.toMatch(/function markerSvgIcons/);
  });
});

/**
 * PLACE_KIND_COLOR — владелец 10.09: «разделять цветами места по фильтрам».
 * Единый источник заливки на обе карты (см. vedar-map-place-icons.test.ts
 * для VedarMap; LeafletMap получает готовый hex через marker.color, собранный
 * в app/map/_MapPageClient.tsx).
 */
describe('PLACE_KIND_COLOR — заливка по категории', () => {
  const PRIMARY_FILTER_KINDS = [
    'volcano', 'hot_spring', 'bay', 'lake', 'mountain', 'river', 'geyser',
    'waterfall', 'viewpoint', 'rock', 'island', 'beach', 'forest', 'museum',
    'historical',
  ];

  it('у каждой из 15 категорий фильтра /map есть свой hex', () => {
    for (const kind of PRIMARY_FILTER_KINDS) {
      expect(PLACE_KIND_COLOR[kind], kind).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('15 категорий фильтра — 15 РАЗНЫХ цветов, иначе «разделять цветами» не читается глазом', () => {
    const colors = PRIMARY_FILTER_KINDS.map((k) => PLACE_KIND_COLOR[k]);
    expect(new Set(colors).size).toBe(PRIMARY_FILTER_KINDS.length);
  });

  it('неизвестная категория — падает на other, не на undefined', () => {
    expect(PLACE_KIND_COLOR.other).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(PLACE_KIND_COLOR['бигфут']).toBeUndefined();
  });
});
