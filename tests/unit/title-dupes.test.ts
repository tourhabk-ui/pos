/**
 * Записи-близнецы среди самих маршрутов.
 *
 * `twins.ts` убирает «маршруты», которые на самом деле места: он сравнивает
 * маршрут С МЕСТОМ. Маршруты друг с другом не сравнивал никто — и сухой
 * прогон импорта OSM 18.08 показал цену: в одной партии из восьми стояли
 * «Вулкан Дыгерен-Оленгендэ» и «Вулкан Дыгерен–Оленгендэ», одна сопка двумя
 * записями. Турист видит два одинаковых маршрута, агрегаты врут, разметка
 * точек делается дважды.
 *
 * Главное в этом правиле — не что оно склеивает, а что НЕ склеивает.
 */
import { describe, it, expect } from 'vitest';
import { normalizeTitle, findTitleDupes } from '@/lib/routes/title-dupes';

describe('незначащее не различает', () => {
  it('дефис и тире — одно слово, разбитое типографикой', () => {
    expect(normalizeTitle('Вулкан Дыгерен-Оленгендэ'))
      .toBe(normalizeTitle('Вулкан Дыгерен–Оленгендэ'));
  });

  it('регистр, ё, повторные пробелы, кавычки, хвостовая точка', () => {
    const k = normalizeTitle('Ключевская сопка');
    expect(normalizeTitle('КЛЮЧЕВСКАЯ  СОПКА.')).toBe(k);
    expect(normalizeTitle('«Ключевская сопка»')).toBe(k);
    expect(normalizeTitle('Ключевскaя сопка')).not.toBe(k); // латинская «a» — другое слово
    expect(normalizeTitle('Река Тёплая')).toBe(normalizeTitle('Река Теплая'));
  });

  it('пробелы вокруг дефиса ничего не значат', () => {
    expect(normalizeTitle('Долина Гейзеров - Долина Смерти'))
      .toBe(normalizeTitle('Долина Гейзеров-Долина Смерти'));
  });
});

describe('значащее различает — и это важнее', () => {
  it('способ прохождения не склеивается', () => {
    // Склеить их значило бы потерять зимний способ прохождения массива.
    expect(normalizeTitle('Горный массив Вачкажец (лыжный)'))
      .not.toBe(normalizeTitle('Горный массив Вачкажец (снегоходный)'));
  });

  it('разные маршруты по одному объекту остаются разными', () => {
    expect(normalizeTitle('Вулкан Авачинский')).not.toBe(normalizeTitle('Вулкан Авачинский, северный склон'));
    expect(normalizeTitle('Толбачик за 1 день')).not.toBe(normalizeTitle('Толбачик за 3 дня'));
  });
});

describe('группировка отвечает на вопрос «что открывать»', () => {
  const rows = [
    { id: 'a', title: 'Вулкан Дыгерен-Оленгендэ' },
    { id: 'b', title: 'Вулкан Дыгерен–Оленгендэ' },
    { id: 'c', title: 'Горный массив Вачкажец (лыжный)' },
    { id: 'd', title: 'Горный массив Вачкажец (снегоходный)' },
    { id: 'e', title: 'Курильское озеро' },
    { id: 'f', title: 'курильское  озеро' },
    { id: 'g', title: 'Курильское озеро.' },
  ];

  it('одиночки в отчёт не идут — иначе находка утонет в шуме', () => {
    const groups = findTitleDupes(rows);
    expect(groups.every((g) => g.members.length > 1)).toBe(true);
    expect(groups.flatMap((g) => g.members.map((m) => m.id))).not.toContain('c');
  });

  it('крупные группы впереди', () => {
    const groups = findTitleDupes(rows);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(['e', 'f', 'g']);
  });

  it('пустые и безымянные записи не образуют группу пустоты', () => {
    const groups = findTitleDupes([
      { id: '1', title: null }, { id: '2', title: '   ' }, { id: '3', title: '' },
    ]);
    expect(groups).toEqual([]);
  });
});

describe('модуль ничего не сливает', () => {
  it('только группирует — выбор записи решается по данным, не по имени', () => {
    // Слияние вслепую по имени — способ потерять единственную запись с
    // настоящим треком. Какую оставить, решают линия, точки и туры.
    const groups = findTitleDupes([
      { id: 'a', title: 'Вулкан Кизимен' }, { id: 'b', title: 'вулкан кизимен' },
    ]);
    expect(groups[0].members).toHaveLength(2);
    expect(Object.keys(groups[0])).toEqual(['key', 'members']);
  });
});
