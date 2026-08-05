/**
 * Один факт — одно поле.
 *
 * Владелец на живой карточке 05.08: блок «О туре» повторяет сам себя, а под ним
 * ещё раз идёт вся программа дня — та же, что нарисована аккордеоном ниже.
 *
 * Как накопилось: 793 положила в `description` весь анонс оператора (тогда
 * других полей не было), 796 завела included/not_included/what_to_bring, 809 —
 * program. Каждая наполнила своё поле и ни одна не убрала то, что теперь
 * дублировала. Хуже дубля оказалось расхождение: в описании остался старый
 * оборот про сбор в Паратунке, который 814 исправила только в program, — и
 * турист читал две разные версии одного дня.
 *
 * Тот же класс, что имя оператора в partners и users: факт в двух местах,
 * чинят одно. Поэтому проверяется не текст, а правило: перечисления,
 * переехавшие в свои поля, не возвращаются в описание.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const M = read('migrations/817_bystraya_description_dedup.sql');
const CARD = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
const CLAUDE = read('CLAUDE.md');

/** SQL без строк-комментариев: пояснения не должны считаться кодом. */
const sql = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('миграция 817: описание очищено от чужих полей', () => {
  it('новое описание не содержит списка программы', () => {
    const value = sql.match(/SET description = '([^']*)'/)?.[1] ?? '';
    expect(value.length, 'описание не найдено').toBeGreaterThan(0);
    expect(value).not.toMatch(/В программе/);
    expect(value).not.toMatch(/В стоимость входит/);
    expect(value).not.toMatch(/Выезд из Петропавловска/);
    expect(value).not.toMatch(/Сокочи|Малкинские|инструктаж/);
  });

  it('сохраняет факт, которого нет больше нигде — скидку детям', () => {
    expect(sql).toMatch(/Детям до 14 лет/);
  });

  it('срабатывает только пока дубли есть', () => {
    expect(sql).toMatch(/description LIKE '%В программе%'/);
    expect(sql).toMatch(/description LIKE '%В стоимость входит%'/);
  });

  it('шаг программы правится точечно и по совпадению содержимого', () => {
    // Слепой jsonb_set по индексу переписал бы чужой шаг, если состав менялся.
    expect(sql).toMatch(/program #>> '\{3,title\}' = 'Сплав с гидом и рыбалка'/);
    expect(sql).toMatch(/jsonb_array_length\(ot\.program\) > 3/);
  });

  it('без INSERT — partners старше системы миграций', () => {
    expect(sql).not.toMatch(/INSERT INTO/i);
  });
});

describe('карточка не рисует один факт дважды', () => {
  it('программа берётся из program, а не из описания', () => {
    expect(CARD).toMatch(/tour\.program/);
  });

  it('состав берётся из included/not_included', () => {
    expect(CARD).toMatch(/included/);
    expect(CARD).toMatch(/not_included/);
  });

  it('правило записано в стандарте карточки', () => {
    // Иначе следующая миграция снова положит весь анонс в описание.
    expect(CLAUDE).toMatch(/описание не пересказывает программу и состав/i);
  });
});
