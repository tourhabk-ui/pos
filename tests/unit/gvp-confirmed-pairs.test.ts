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

  // 12.09: семь пар (имя+расстояние верны, volcanoNumber — чужой) дошли до
  // боевых черновиков и были пойманы только ручной сверкой текста (#1830,
  // шаг 2) — Remarks соседнего вулкана читались как факт о нашем месте.
  // Числа ниже перепроверены свежим прогоном `places-gvp-crosscheck`
  // (расстояние + совпадение английского имени), не взяты из памяти о
  // прошлой расшифровке отчёта.
  it('семь ранее перепутанных volcanoNumber исправлены (12.09)', () => {
    const byId = new Map(GVP_CONFIRMED_PAIRS.map(p => [p.placeId, p]));
    const corrected: Array<[string, number, string]> = [
      ['00a71c01-6a76-4227-91ba-c62ec50aefc1', 300040, 'Желтовская Сопка → Zheltovsky'],
      ['164f612c-32da-4f0f-b261-c45c09dc2933', 300083, 'Вулкан Вилючинский → Vilyuchinsky'],
      ['f4fa9a04-a746-491e-871c-bcef3725f7d0', 300125, 'Вулкан Академии Наук → Akademia Nauk'],
      ['f2260dcf-a94b-4532-abb0-8ba55a1c5781', 300160, 'Вулкан Тауншиц → Taunshits'],
      ['44be8f5a-809d-47aa-bfa9-858e65cdfe77', 300200, 'Вулкан Кроноцкий → Kronotsky'],
      ['a41cf39b-5a64-43da-89f1-3ad5b9d5887c', 300512, 'Терпук → Terpuk'],
      ['347377fb-7e57-46f1-8ce5-e09d5b997106', 300671, 'Спокойный → Spokoiny'],
    ];
    for (const [placeId, expectedNumber, label] of corrected) {
      expect(byId.get(placeId)?.volcanoNumber, label).toBe(expectedNumber);
    }
  });

  it('volcanoNumber не переиспользуется двумя РАЗНЫМИ вулканами (кластеры вроде Толбачика — исключение по gvpName)', () => {
    // Ловит ровно класс дефекта 12.09: если у одного volcanoNumber разошлись
    // gvpName — значит хотя бы одна запись показывает Remarks чужого вулкана.
    // Единственное легитимное совпадение — комплекс, где несколько places
    // намеренно делят общее имя ГВП (Толбачик, Зимина).
    const byVolcano = new Map<number, Set<string>>();
    for (const p of GVP_CONFIRMED_PAIRS) {
      const names = byVolcano.get(p.volcanoNumber) ?? new Set<string>();
      names.add(p.gvpName);
      byVolcano.set(p.volcanoNumber, names);
    }
    for (const [volcanoNumber, names] of byVolcano) {
      expect(names.size, `volcanoNumber ${volcanoNumber} держит разные gvpName: ${[...names].join(', ')}`).toBe(1);
    }
  });
});
