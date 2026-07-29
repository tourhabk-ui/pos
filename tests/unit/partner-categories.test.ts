/**
 * Категория партнёра — одна на всю платформу.
 *
 * Повод: форма самостоятельной регистрации оператора предлагала `hotel`,
 * `rent` и `fishing`. Ни одного из этих значений нет ни в `PARTNER_ROLES`, ни
 * в карте кабинетов `ROLE_HUB`, ни в CHECK колонки `partners.category`
 * (`lib/database/schema.sql:42`). Три варианта из шести вели в отказ базы уже
 * после нажатия «Зарегистрироваться»: выбор был, услуги за ним не было.
 *
 * Второй след того же расхождения: пользователю при регистрации всегда
 * ставилась роль `operator`, какую категорию бы он ни выбрал. Гид заводил
 * правильную партнёрскую запись и попадал в кабинет оператора.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PARTNER_CATEGORIES,
  PARTNER_CATEGORY_LABELS,
  LEGACY_CATEGORY_ALIASES,
  normalizePartnerCategory,
  isPartnerCategory,
} from '@/lib/partners/categories';
import { PARTNER_ROLES, ROLE_HUB } from '@/lib/auth/role-routes';

const ROOT = process.cwd();

/** Значения CHECK-ограничения partners.category из файла схемы. */
function schemaCheckValues(): string[] {
  const sql = readFileSync(join(ROOT, 'lib/database/schema.sql'), 'utf-8');
  const line = /category\s+VARCHAR\(\d+\)\s+NOT NULL\s+CHECK\s*\(category IN \(([^)]*)\)\)/i.exec(sql)?.[1];
  if (!line) throw new Error('не разобрать CHECK у partners.category');
  return [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('справочник категорий согласован', () => {
  it('совпадает с PARTNER_ROLES — второго списка нет', () => {
    expect([...PARTNER_CATEGORIES]).toEqual([...PARTNER_ROLES]);
  });

  it('у каждой категории есть кабинет', () => {
    // Иначе заведём партнёра, которому некуда войти.
    for (const c of PARTNER_CATEGORIES) {
      expect(ROLE_HUB[c], `нет кабинета для ${c}`).toBeTruthy();
    }
  });

  it('у каждой категории есть человеческое название', () => {
    for (const c of PARTNER_CATEGORIES) {
      expect(PARTNER_CATEGORY_LABELS[c]?.length ?? 0).toBeGreaterThan(2);
    }
  });

  it('каждая категория проходит CHECK колонки в схеме', () => {
    // Ровно та проверка, которой не было: hotel/rent/fishing её не проходили.
    const allowed = new Set(schemaCheckValues());
    for (const c of PARTNER_CATEGORIES) {
      expect(allowed, `${c} не пройдёт CHECK partners.category`).toContain(c);
    }
  });
});

describe('старые значения формы приземляются, а не падают', () => {
  it('hotel, rent и fishing переводятся в существующие категории', () => {
    expect(normalizePartnerCategory('hotel')).toBe('stay');
    expect(normalizePartnerCategory('rent')).toBe('gear');
    expect(normalizePartnerCategory('fishing')).toBe('operator');
  });

  it('каждый алиас указывает на настоящую категорию', () => {
    for (const [legacy, target] of Object.entries(LEGACY_CATEGORY_ALIASES)) {
      expect(isPartnerCategory(target), `${legacy} → ${target}: такой категории нет`).toBe(true);
    }
  });

  it('незнакомое значение отвергается, а не подменяется по умолчанию', () => {
    // Тихая подмена на 'operator' и была бы возвращением к прежней поломке.
    expect(normalizePartnerCategory('helicopter')).toBeNull();
    expect(normalizePartnerCategory('')).toBeNull();
  });
});

describe('регистрация оператора больше не расходится с моделью', () => {
  const SRC = readFileSync(join(ROOT, 'app/api/auth/register-operator/route.ts'), 'utf-8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('свой список категорий из файла убран', () => {
    expect(CODE).not.toMatch(/const CATEGORIES\s*=\s*\[/);
    expect(CODE).toMatch(/PARTNER_CATEGORIES/);
  });

  it('роль пользователя берётся из категории, а не зашита как operator', () => {
    expect(CODE, 'снова всем ставится роль оператора').not.toMatch(/'\{"roles":\["operator"\]\}'::jsonb/);
  });
});

describe('кабинет находит партнёра своей категории', () => {
  it('ensurePartnerExists ищет с фильтром по категории', () => {
    // У физлица с экскурсиями и трансфером две записи под одним user_id.
    // Прежний `WHERE user_id = $1 LIMIT 1` возвращал произвольную из них.
    const SRC = readFileSync(join(ROOT, 'lib/auth/operator-helpers.ts'), 'utf-8');
    const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(CODE).not.toMatch(/FROM partners WHERE user_id = \$1 LIMIT 1/);
    expect(CODE).toMatch(/user_id = \$1 AND category = \$2/);
  });
});
