/**
 * Слово оператора о собственном продукте — источник истины.
 *
 * Замечания Катерины («Камчатка Рафтинг», 05.08): вместо «фотоохоты на бурого
 * медведя» — «возможность увидеть бурого медведя в естественной среде»;
 * сложность лёгкая, а не средняя.
 *
 * Первая правка не косметическая. «Фотоохота» обещает охоту за кадром и
 * подталкивает подходить ближе; формулировка оператора описывает встречу,
 * которая может случиться, и ничего не обещает. Для платформы, чья первая цель
 * — безопасность туриста, это разница по существу.
 *
 * Формулировка живёт в двух полях — short_description и шаге программы. Урок
 * последних трёх суток (имя оператора в partners и users, программа в трёх
 * местах): факт в двух местах чинят в одном. Поэтому сторож проверяет, что
 * правка накрыла оба.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFFICULTY_LABELS, difficultyLabel } from '@/lib/tours/labels';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const M = read('migrations/818_bystraya_operator_wording.sql');

/** SQL без строк-комментариев: пояснения не должны считаться кодом. */
const sql = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('формулировка про медведя — как сказал оператор', () => {
  it('новая формулировка ничего не обещает', () => {
    expect(sql).toMatch(/возможность(ю)? увидеть бурого медведя в естественной среде/);
  });

  it('правка накрывает оба поля: короткое описание и шаг программы', () => {
    const shortDesc = sql.indexOf('SET short_description');
    const program = sql.indexOf('SET program');
    expect(shortDesc, 'короткое описание не правится').toBeGreaterThan(-1);
    expect(program, 'шаг программы не правится').toBeGreaterThan(-1);
  });

  it('срабатывает только там, где старое слово ещё есть', () => {
    const guards = sql.match(/LIKE '%фотоохот%'/g) ?? [];
    expect(guards.length, 'условие идемпотентности не на каждом UPDATE').toBeGreaterThanOrEqual(2);
  });

  it('шаг программы правится по совпадению заголовка, а не слепым индексом', () => {
    // Состав программы может меняться — jsonb_set по номеру переписал бы чужой шаг.
    expect(sql).toMatch(/program #>> '\{3,title\}' = 'Сплав с гидом и рыбалка'/);
  });
});

describe('сложность — лёгкая', () => {
  it('ставится значение из словаря, а не выдуманное', () => {
    expect(sql).toMatch(/difficulty = 'easy'/);
    expect(DIFFICULTY_LABELS.easy, 'значения easy нет в словаре — на карточке будет сырое слово').toBeTruthy();
  });

  it('в интерфейсе это читается по-русски', () => {
    expect(difficultyLabel('easy', true)).toBe('Лёгкий');
    expect(difficultyLabel('easy')).toBe('Подходит новичкам');
  });

  it('не переписывается повторно', () => {
    expect(sql).toMatch(/difficulty IS DISTINCT FROM 'easy'/);
  });
});

describe('миграция безопасна', () => {
  it('без INSERT — partners старше системы миграций', () => {
    expect(sql).not.toMatch(/INSERT INTO/i);
  });

  it('тур находится по содержанию, а не по хрупкому заголовку', () => {
    expect(sql).toMatch(/title ILIKE '%быстр%'/);
  });
});
