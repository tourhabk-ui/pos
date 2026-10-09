/**
 * Дальние округа края — по координатам места, а не зоной (решение владельца
 * 09.10, #2293).
 *
 * Гидро-тревога 7–12.10 называла Пенжинский и Олюторский районы; карта
 * округов относила их к `northern` и `eastern`, и тревога легла на все 355
 * мест — на Ключевскую, Шивелуч и Кроноцкий за 500–750 км. Охват по
 * координатам исполняет tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';
import {
  COMMANDER_BOX, KRAI_COMMANDER_ZONE, KRAI_FAR_MATCH_SQL, KRAI_FAR_ZONES, KRAI_KORYAK_MIN_LAT, KRAI_KORYAK_ZONE,
} from '@/lib/safety/krai-far';
import { ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';
import { zoneName } from '@/lib/safety/zone-names';
import { matchOfficialAlerts } from '@/lib/agents/evo/rescue-judge';

// Тексты — с прода (alerts-census, проба 728, 09.10).
const HYDRO_0710 =
  'На реках Елизовского муниципального округа ожидается подъём уровня воды интенсивностью до 20 сантиметров в сутки, '
  + 'на реках Усть-Большерецкого, Соболевского и Тигильского муниципальных округов — до 40 сантиметров в сутки, '
  + 'на реках Пенжинского и Олюторского муниципальных районов— до 50 сантиметров в сутки.';
const SEA_0809 =
  'Днём 8 октября в подрайоне 11314 (акватория Тихого океана) ожидается опасное волнение высотой 8-10 метров, '
  + 'с распространением вечером в подрайоны 11313 (акватория Тихого океана), 11311 (Алеутский муниципальный округ). '
  + 'В середине ночи 9 октября опасное волнение распространится в подрайоны 11291, 11292 (Олюторский муниципальный район), '
  + 'и район 11260 (Елизовский и Усть-Камчатский муниципальные округа).';

describe('разбор округов', () => {
  it('гидро-тревога 7–12.10: юг и Корякский округ — без северной и восточной зон', () => {
    const z = mchs_zones(HYDRO_0710);
    expect(new Set(z)).toEqual(new Set(['avachinsky', 'western', KRAI_KORYAK_ZONE]));
  });

  it('каждый из четырёх округов бывшего Корякского округа — метка, а не зона', () => {
    for (const t of [
      'подъём воды на реках Пенжинского района',
      'паводок в Олюторском районе',
      'штормовой ветер в Карагинском районе',
      'на реках Тигильского муниципального округа',
    ]) expect(mchs_zones(t), t).toEqual([KRAI_KORYAK_ZONE]);
  });

  it('Алеутский округ — Командоры, а не северная зона', () => {
    expect(mchs_zones('опасное волнение у побережья Алеутского муниципального округа')).toEqual([KRAI_COMMANDER_ZONE]);
  });

  it('волнение моря 8–9.10: Усть-Камчатский округ назван — северная зона остаётся (её уберёт морское правило)', () => {
    expect(new Set(mchs_zones(SEA_0809))).toEqual(
      new Set(['avachinsky', 'northern', KRAI_KORYAK_ZONE, KRAI_COMMANDER_ZONE]),
    );
  });
});

describe('черта охвата', () => {
  it('Корякский округ: Шивелуч, Ключи и Эссо южнее, сёла Тигильского района (Усть-Хайрюзово ~57,1) — севернее', () => {
    expect(KRAI_KORYAK_MIN_LAT).toBeGreaterThan(56.65);
    expect(KRAI_KORYAK_MIN_LAT).toBeLessThanOrEqual(57.05);
  });

  const inBox = (lat: number, lng: number) =>
    lat >= COMMANDER_BOX.minLat && lat <= COMMANDER_BOX.maxLat && lng >= COMMANDER_BOX.minLng && lng <= COMMANDER_BOX.maxLng;

  it('прямоугольник Командоров — оба острова и ни одного материкового места', () => {
    expect(inBox(55.20, 165.99)).toBe(true);   // Никольское, о. Беринга
    expect(inBox(54.70, 167.60)).toBe(true);   // о. Медный
    expect(inBox(54.75, 162.10)).toBe(false);  // Кроноцкий полуостров
    expect(inBox(56.22, 162.48)).toBe(false);  // Усть-Камчатск
    expect(inBox(56.65, 161.36)).toBe(false);  // Шивелуч
  });

  it('правило мест читает обе метки', () => {
    expect(ALERT_MATCH_SQL).toContain(KRAI_FAR_MATCH_SQL);
    expect(KRAI_FAR_MATCH_SQL).toContain(`'${KRAI_KORYAK_ZONE}' = ANY(ea.affected_zones)`);
    expect(KRAI_FAR_MATCH_SQL).toContain(`'${KRAI_COMMANDER_ZONE}' = ANY(ea.affected_zones)`);
  });
});

describe('метки у читателей зон', () => {
  it('экран /safety называет их словами, а не ключом', () => {
    expect(zoneName(KRAI_KORYAK_ZONE)).toBe('Корякский округ (север края)');
    expect(zoneName(KRAI_COMMANDER_ZONE)).toBe('Командорские острова');
  });

  const booking = {
    id: 7, booking_date: '2026-10-09', tour_title: 'Сплав по Паратунке', participants: 4,
    activity_type: 'rafting', location_type: 'river', zone: 'avachinsky',
  };
  const flood = (zones: string[]) => ({
    id: 1, alert_type: 'flood', severity: 2, title: 'Подъём воды', description: '',
    affected_zones: zones, expires_at: '2026-10-12T00:00:00Z', source_url: 'https://x',
  });

  it('Rescue: метка не сравнивается с зоной брони как зона', () => {
    for (const z of KRAI_FAR_ZONES) {
      const r = matchOfficialAlerts([booking] as never, [flood([z])] as never);
      // Только дальняя метка — неразмещённое, как «юг края», а не молча мимо.
      expect(r.matches.map((m) => m.unplaced), z).toEqual([true]);
    }
  });

  it('Rescue: южная зона рядом с меткой судится зоной как раньше', () => {
    const r = matchOfficialAlerts([booking] as never, [flood(['avachinsky', KRAI_KORYAK_ZONE])] as never);
    expect(r.matches.map((m) => m.unplaced)).toEqual([false]);
  });
});
