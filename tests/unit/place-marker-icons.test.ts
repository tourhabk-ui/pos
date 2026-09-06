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
import { placeMarkerSvg, PLACE_MARKER_KINDS, PLACE_MARKER_SIZE } from '@/lib/map/place-marker-icons';

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
   */
  it('каждый ключ LOCATION_TYPE_CONFIG (/map) имеет свою форму', () => {
    const block = MAP_CLIENT.slice(
      MAP_CLIENT.indexOf('const LOCATION_TYPE_CONFIG'),
      MAP_CLIENT.indexOf('};', MAP_CLIENT.indexOf('const LOCATION_TYPE_CONFIG')),
    );
    const keys = [...block.matchAll(/^\s*(\w+):\s*\{ label:/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const kind of keys) {
      if (kind === 'other') continue;
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
