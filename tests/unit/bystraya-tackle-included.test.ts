/**
 * Снасти входят в стоимость — и не встречаются в «не входит».
 *
 * Замечание Катерины («Камчатка Рафтинг», 05.08): снасти бесплатные, аренды за
 * 500 рублей нет. Цена ошибки прямая: турист платит на месте за уже оплаченное,
 * а это разрушает доверие быстрее, чем любой дизайн его строит.
 *
 * Почему миграция чинит «по смыслу», а не по точному тексту: строки про аренду
 * снастей в репозитории НЕТ. 796 честно кладёт снасти в included, но она — одна
 * из трёх миграций, не применившихся на проде, поэтому реальное содержимое
 * полей отсюда не видно. Значит поля надо приводить к правильному состоянию из
 * ЛЮБОГО текущего, не опираясь на знание старого.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const M = read('migrations/819_bystraya_tackle_included.sql');

/** SQL без строк-комментариев: пояснения не должны считаться кодом. */
const sql = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('миграция 819: снасти', () => {
  it('убирает аренду снастей из «не входит» в любой формулировке', () => {
    expect(sql).toMatch(/\(аренд\|прокат\)/);
    expect(sql).toMatch(/\(снаст\|удоч\|спиннинг\)/);
  });

  it('добавляет снасти в «входит в стоимость», если их там нет', () => {
    expect(sql).toMatch(/Удочки и снасти для рыбалки/);
    expect(sql).toMatch(/NOT EXISTS/);
  });

  it('не переписывает массивы целиком — посторонние пункты остаются', () => {
    // Слепая перезапись стёрла бы то, что оператор добавил через кабинет и
    // чего в репозитории не видно.
    expect(sql).not.toMatch(/SET not_included = ARRAY\[/);
    expect(sql).not.toMatch(/SET included = ARRAY\[/);
    expect(sql).toMatch(/unnest\(COALESCE\(ot\.not_included/);
  });

  it('порядок пунктов сохраняется', () => {
    // array_agg без ORDER BY может перемешать список — турист читает его как
    // последовательность.
    expect(sql).toMatch(/WITH ORDINALITY/);
    expect(sql).toMatch(/array_agg\(x ORDER BY ord\)/);
  });

  it('срабатывает, только пока есть что чинить', () => {
    expect(sql).toMatch(/AND \(\s*\n?\s*(--[^\n]*\n\s*)?EXISTS/);
  });

  it('без INSERT и матч по содержанию', () => {
    expect(sql).not.toMatch(/INSERT INTO/i);
    expect(sql).toMatch(/title ILIKE '%быстр%'/);
  });
});
