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
