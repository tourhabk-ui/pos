/**
 * Реестр подтверждённых пар places↔VolcanoNumber (шаг 1, #1830) — держит
 * форму, а не решает за человека. Проверяет то, что можно проверить
 * механически (нет дублей, расстояния соответствуют заявленной уверенности);
 * само соответствие вулканов реестр не подтверждает — это сделано глазами по
 * отчёту `places-gvp-crosscheck` и подлежит проверке владельцем перед шагом 2
 * (перевод Remarks).
 */
import { describe, it, expect } from 'vitest';
import { GVP_CONFIRMED_PAIRS } from '@/lib/geo/gvp-confirmed-pairs';

describe('GVP_CONFIRMED_PAIRS', () => {
  it('не пустой и не превышает реально проверенных 117 мест-вулканов', () => {
    expect(GVP_CONFIRMED_PAIRS.length).toBeGreaterThan(0);
    expect(GVP_CONFIRMED_PAIRS.length).toBeLessThanOrEqual(117);
  });

  it('placeId не повторяется — одно место не может ждать двух переводов', () => {
    const ids = GVP_CONFIRMED_PAIRS.map(p => p.placeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('placeId — валидный UUID (в т.ч. рукописный тестовый — формат тот же)', () => {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const p of GVP_CONFIRMED_PAIRS) {
      expect(p.placeId, p.placeName).toMatch(uuidRe);
    }
  });

  it('distanceKm согласуется с заявленной уверенностью', () => {
    for (const p of GVP_CONFIRMED_PAIRS) {
      if (p.confidence === 'exact') {
        expect(p.distanceKm, `${p.placeName}: exact, но ${p.distanceKm} км`).toBeLessThanOrEqual(5);
      } else {
        expect(p.distanceKm, `${p.placeName}: ${p.confidence}, но ${p.distanceKm} км`).toBeLessThanOrEqual(6);
      }
    }
  });

  it('volcanoNumber — положительное целое (реальный номер ГВП)', () => {
    for (const p of GVP_CONFIRMED_PAIRS) {
      expect(Number.isInteger(p.volcanoNumber), p.placeName).toBe(true);
      expect(p.volcanoNumber, p.placeName).toBeGreaterThan(0);
    }
  });

  it('одному VolcanoNumber могут отвечать несколько places (сложные вулканы) — не дубли-ошибки', () => {
    const byVolcano = new Map<number, string[]>();
    for (const p of GVP_CONFIRMED_PAIRS) {
      const list = byVolcano.get(p.volcanoNumber) ?? [];
      list.push(p.placeName);
      byVolcano.set(p.volcanoNumber, list);
    }
    // Толбачик (300240) — заведомо кластер минимум из трёх вершин.
    expect(byVolcano.get(300240)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('distance-only явно помечен и не выдаётся за подтверждённое совпадение имени', () => {
    const distanceOnly = GVP_CONFIRMED_PAIRS.filter(p => p.confidence === 'distance-only');
    expect(distanceOnly.length).toBeGreaterThan(0);
    // Единственный сегодняшний случай — Крестовский/Ushkovsky: имя явно другое.
    for (const p of distanceOnly) {
      expect(p.placeName.toLowerCase()).not.toContain(p.gvpName.toLowerCase());
    }
  });
});
