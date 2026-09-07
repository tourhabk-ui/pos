/**
 * VedarMap — форма маркера места собирается по запросу styleimagemissing.
 *
 * Владелец 07.09: «геоточки были все со своими маркерами». Стиль (§ форма и
 * цвет мест, lib/map/vedar-style.ts) лишь называет иконку строкой — растр
 * собирает сам компонент, когда MapLibre её впервые просит. Сторож держит
 * связку целиком: обработчик стоит, разбирает имя тем же модулем, что и
 * стиль его строит, цвет берёт из палитры темы этого инстанса, а не из
 * произвольного места, и не пытается собрать имя, которое не наше.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

describe('VedarMap — styleimagemissing собирает иконку места', () => {
  it('слушает styleimagemissing и разбирает имя общим модулем', () => {
    expect(MAP).toContain("map.on('styleimagemissing'");
    expect(MAP).toMatch(/import \{ parsePlaceIconImageId, rasterizePlaceIcon, PLACE_ICON_PIXEL_RATIO \} from '@\/lib\/map\/place-icon-raster'/);
    expect(MAP).toMatch(/import \{ placeMarkerSvg, PLACE_MARKER_SIZE \} from '@\/lib\/map\/place-marker-icons'/);
  });

  it('чужое имя (не наш спрайт) — parsePlaceIconImageId вернёт null, обработчик не полезет рисовать', () => {
    const handlerAt = MAP.indexOf("map.on('styleimagemissing'");
    const handlerBlock = MAP.slice(handlerAt, MAP.indexOf("map.on('load'", handlerAt));
    expect(handlerBlock).toMatch(/if \(!parsed\) return;/);
  });

  it('цвет иконки — из палитры ЭТОГО инстанса (той же темы, что у карты)', () => {
    const handlerAt = MAP.indexOf("map.on('styleimagemissing'");
    const handlerBlock = MAP.slice(handlerAt, MAP.indexOf("map.on('load'", handlerAt));
    expect(handlerBlock).toMatch(/parsed\.hazardous \? palette\.cliff : palette\.peak/);
    // palette собран из ТОГО ЖЕ theme, которым строится style этого инстанса,
    // а не пропа, снятого в другой момент жизни компонента.
    expect(MAP).toMatch(/const palette = vedarMapPalette\(theme\);/);
  });

  it('не рисует иконку, которая уже есть в спрайте (hasImage — стража от повторной работы)', () => {
    const handlerAt = MAP.indexOf("map.on('styleimagemissing'");
    const handlerBlock = MAP.slice(handlerAt, MAP.indexOf("map.on('load'", handlerAt));
    expect(handlerBlock).toMatch(/map\.hasImage\(id\)/);
  });

  it('добавляет растр с тем же pixelRatio, каким он собран', () => {
    const handlerAt = MAP.indexOf("map.on('styleimagemissing'");
    const handlerBlock = MAP.slice(handlerAt, MAP.indexOf("map.on('load'", handlerAt));
    expect(handlerBlock).toMatch(/rasterizePlaceIcon\(svg, PLACE_MARKER_SIZE\.width, PLACE_MARKER_SIZE\.height\)/);
    expect(handlerBlock).toMatch(/map\.addImage\(id, img, \{ pixelRatio: PLACE_ICON_PIXEL_RATIO \}\)/);
  });

  it('отказ растеризации — в лог с именем иконки, не проглочен молча', () => {
    const handlerAt = MAP.indexOf("map.on('styleimagemissing'");
    const handlerBlock = MAP.slice(handlerAt, MAP.indexOf("map.on('load'", handlerAt));
    expect(handlerBlock).toMatch(/console\.error\('\[VedarMap\] иконка места не собралась', id, err\)/);
  });
});
