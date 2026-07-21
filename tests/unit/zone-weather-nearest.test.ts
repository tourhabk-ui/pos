/**
 * Ближайшая погодная зона для карточки места: точки юга и центра маппятся
 * в свои зоны, крайний север — честный null (погоду чужой зоны не показываем).
 */

import { describe, it, expect } from 'vitest';
import { nearestZoneKey } from '@/lib/services/safety/zone-weather';

describe('nearestZoneKey', () => {
  it('Авачинский вулкан → зона avachinsky', () => {
    expect(nearestZoneKey(53.2556, 158.8333)).toBe('avachinsky');
  });

  it('Курильское озеро → Южная Камчатка (mutnovsky_s)', () => {
    expect(nearestZoneKey(51.455, 157.0983)).toBe('mutnovsky_s');
  });

  it('Толбачик → tolbachik', () => {
    expect(nearestZoneKey(55.8333, 160.3333)).toBe('tolbachik');
  });

  it('крайний север (Дранкинские источники) → null, погоду зоны не подсовываем', () => {
    expect(nearestZoneKey(58.6, 161.9)).toBeNull();
  });
});
