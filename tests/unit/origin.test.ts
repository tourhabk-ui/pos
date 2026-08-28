/**
 * lib/on-route/origin.ts — «откуда» отдельно от «куда» (владелец 27.08, PR 4).
 *
 * Origin — третья независимая сущность рядом с Destination/RouteOption:
 * текущая позиция, точка на карте или сохранённое место — три честных
 * способа назвать старт, ни один не подделывает данные другого.
 */
import { describe, it, expect } from 'vitest';
import { originLabel, type Origin } from '@/lib/on-route/origin';

describe('originLabel — человеческая подпись старта', () => {
  it('текущая позиция называется словами, не координатами', () => {
    const o: Origin = { kind: 'current', lat: 53.25, lon: 158.83 };
    expect(originLabel(o)).toBe('Текущая позиция');
  });

  it('место — своим названием', () => {
    const o: Origin = { kind: 'place', id: 'p1', title: 'Кордон «Центральный»', lat: 53, lon: 158 };
    expect(originLabel(o)).toBe('Кордон «Центральный»');
  });

  it('координата с названием — берёт название', () => {
    const o: Origin = { kind: 'coordinate', lat: 53, lon: 158, title: 'Моя стоянка' };
    expect(originLabel(o)).toBe('Моя стоянка');
  });

  it('координата без названия — честная заглушка, не выдуманное имя', () => {
    const o: Origin = { kind: 'coordinate', lat: 53, lon: 158 };
    expect(originLabel(o)).toBe('Точка на карте');
  });
});
