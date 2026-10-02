/**
 * Своё положение на карте и плашка тревог (владелец 02.10, скрин /map):
 *   - «тревоги перекрывают кнопку масштаб» — плашка обстановки стояла в том
 *     же левом верхнем углу, что колонка «+ / зум / −»;
 *   - «моя геолокация плохо различима» — точка 18 px без ореола терялась
 *     среди кружков мест;
 *   - «при нажатии приближать масштаб хотя бы 7.5 с центром моя локация» —
 *     камера центрировалась один раз за жизнь карты и масштаб не трогала.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_FOCUS_ZOOM } from '@/components/shared/VedarMap';

const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');
const PAGE = readFileSync(join(process.cwd(), 'app/map/_MapPageClient.tsx'), 'utf-8');

describe('«вот вы» — центр и масштаб', () => {
  it('масштаб «вот вы» — 7.5', () => {
    expect(USER_FOCUS_ZOOM).toBe(7.5);
  });

  it('камера приближается до него, но ближе, чем стоит, не отдаляет', () => {
    expect(MAP).toMatch(/map\.easeTo\(\{ center: \[lng, lat\], zoom: Math\.max\(map\.getZoom\(\), USER_FOCUS_ZOOM\)/);
  });

  it('каждое включение снова центрирует: флаг сбрасывается в начале эффекта', () => {
    const eff = MAP.slice(MAP.indexOf('// ── Своё положение'), MAP.indexOf('navigator.geolocation.watchPosition'));
    expect(eff).toMatch(/autoCenterDoneRef\.current = false;/);
  });
});

describe('точка «я» различима', () => {
  const eff = MAP.slice(MAP.indexOf('// ── Своё положение'), MAP.indexOf('navigator.geolocation.clearWatch'));

  it('ореол 44 px и точка 22 px — крупнее кружка места', () => {
    expect(eff).toMatch(/width:44px;height:44px/);
    expect(eff).toMatch(/width:22px;height:22px/);
  });

  it('цвета — токены, не hex', () => {
    expect(eff).toMatch(/var\(--ocean\)/);
    expect(eff).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe('плашка тревог не накрывает масштаб', () => {
  it('встаёт правее колонки масштаба (left 12 + 44) и левее кнопки «моё место»', () => {
    const at = PAGE.indexOf('<MapThreatChip />');
    const wrap = PAGE.slice(PAGE.lastIndexOf('<div', at), at);
    expect(wrap).toMatch(/left-16 right-16/);
    expect(wrap).not.toMatch(/left-3/);
    // Колонка масштаба там, где плашка её обходит.
    expect(MAP).toMatch(/position: 'absolute', left: 12, top: 12/);
  });
});
