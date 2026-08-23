/**
 * Сухая проверка начисления комиссии.
 *
 * «Таблица есть» и «комиссия начисляется» — разные утверждения. Первое
 * доказано замером после миграции 907, второе не доказано ничем: с момента
 * починки не было ни одной оплаты.
 *
 * Начисление — это `INSERT ... SELECT` с двумя JOIN и ставкой из
 * `partners.commission_current`. Порвётся любое звено — вставка молча даст
 * ноль строк, и узнается это уже после оплаты, при разборе «куда делись
 * деньги». Сторож держит главное свойство проверки: она обязана НАЗЫВАТЬ
 * порвавшееся звено, а не возвращать пустоту.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/cron/commission-dry-run/route.ts'), 'utf-8',
);

describe('проверка не притворяется вставкой', () => {
  it('ничего не пишет', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i);
  });

  it('считает ту же арифметику, что и настоящее начисление', () => {
    // Процент в partners.commission_current, доли в operator_commissions.rate:
    // отсюда деление на 100. Разойдись эти два места — сухая проверка
    // показывала бы не то, что запишется.
    expect(SRC).toMatch(/PLATFORM_COMMISSION_PERCENT/);
    expect(SRC).toMatch(/\* effectiveRate\) \/ 100/);
  });
});

describe('порвавшееся звено называется', () => {
  it('цепочка разбирается ЛЕВЫМИ соединениями', () => {
    // Внутренние просто не вернули бы строку, и звено осталось бы
    // неназванным — ровно тот второй исход вместо третьего.
    expect(SRC).toMatch(/LEFT JOIN operator_tours/);
    expect(SRC).toMatch(/LEFT JOIN partners/);
  });

  it('у каждого звена свой текст отказа', () => {
    for (const needle of [
      'нет operator_tour_id',
      'тур по operator_tour_id не найден',
      'у тура нет operator_id',
      'партнёр по operator_id не найден',
      'final_price пуст',
    ]) {
      expect(SRC, `не назван отказ: ${needle}`).toContain(needle);
    }
  });

  it('запасная ставка видна как запасная', () => {
    // Если сработала константа вместо partners.commission_current, это надо
    // видеть: иначе «ставка есть» скроет, что договорной ставки нет.
    expect(SRC).toMatch(/rate_source/);
    expect(SRC).toMatch(/запасная константа/);
  });
});

describe('третье состояние', () => {
  it('«броней нет» не выдаётся за «комиссия работает»', () => {
    expect(SRC).toMatch(/это не «комиссия работает»/);
  });

  it('отказ базы называет SQLSTATE', () => {
    expect(SRC).toMatch(/sqlstate/);
    expect(SRC).toMatch(/ok: false/);
    expect(SRC).toMatch(/console\.error/);
  });

  it('след в данных считается отдельно от наличия таблицы', () => {
    // Именно оплаченные брони без строки комиссии отвечают на вопрос
    // «начисляется ли», а не сам факт существования таблицы.
    expect(SRC).toMatch(/paid_without_commission/);
  });
});

describe('персональные данные наружу не уходят', () => {
  it('ни имени, ни почты, ни телефона туриста', () => {
    expect(SRC).not.toMatch(/tourist_email|tourist_phone|tourist_name/);
  });
});
