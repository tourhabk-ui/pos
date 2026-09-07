// @vitest-environment node
/**
 * Объектив «путь денег» в петле эволюции (05.09, решение владельца «усилить
 * ОС»: кормить эволюцию правдой прода, а не догадками модели).
 *
 * Все настоящие дефекты недели нашли переписи, которые дёргались руками:
 * operator-reach (0 из 2 операторов достижимы, 12 туров за ними) и
 * payment-config (ни карта, ни СБП). Воронка судит по следам — а этот
 * объектив по устройству: способен ли путь до денег сработать вообще.
 * Детерминированно, из базы и имён переменных; мимо тормоза точности.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickMoneyPathFindings, type MoneyPathFacts } from '@/lib/agents/evo/growth-agent';
import { OUTWARD_CATEGORIES, isAutoRunnable } from '@/lib/agents/evo/issue-reporter';

const GROWTH = readFileSync(join(process.cwd(), 'lib/agents/evo/growth-agent.ts'), 'utf-8');

const facts = (over: Partial<MoneyPathFacts>): MoneyPathFacts => ({
  unreachable_operators: [], operators_with_live_tours: 2, no_payment_way: false, ...over,
});

describe('pickMoneyPathFindings', () => {
  it('всё настроено — находок нет', () => {
    expect(pickMoneyPathFindings(facts({}))).toEqual([]);
  });

  it('оператор без канала — находка называет операторов и цену поимённо', () => {
    const [f] = pickMoneyPathFindings(facts({
      unreachable_operators: [
        { name: 'Камчатская рыбалка', live_tours: 11 },
        { name: 'Камчатка Семейный Рафтинг', live_tours: 1 },
      ],
    }));
    expect(f.title).toBe('Путь денег: заявка не доходит до оператора');
    expect(f.severity).toBe('high');
    expect(f.description).toContain('2 из 2');
    expect(f.description).toContain('«Камчатская рыбалка» (11)');
    expect(f.description).toContain('12 живых туров');
    expect(f.suggestion).toMatch(/боту Кузьмича в MAX/);
  });

  it('нечем платить — вторая находка, независимая от первой', () => {
    const list = pickMoneyPathFindings(facts({ no_payment_way: true }));
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Путь денег: ни один способ оплаты не настроен');
    expect(list[0].description).not.toMatch(/[A-Za-z0-9]{24,}/); // имена переменных, не значения
  });

  it('оба дефекта — две находки', () => {
    expect(pickMoneyPathFindings(facts({
      unreachable_operators: [{ name: 'X', live_tours: 1 }], no_payment_way: true,
    }))).toHaveLength(2);
  });
});

describe('находки идут наружу и не исполняются рукой', () => {
  const all = pickMoneyPathFindings(facts({
    unreachable_operators: [{ name: 'X', live_tours: 1 }], no_payment_way: true,
  }));

  it('категория funnel, детерминированно, suggested — выносится issue-reporter', () => {
    for (const f of all) {
      expect(OUTWARD_CATEGORIES.has(f.category)).toBe(true);
      expect(f.model).toBe('deterministic');
      expect(f.status).toBe('suggested');
      expect(isAutoRunnable(f)).toBe(false);
    }
  });
});

describe('объектив в петле', () => {
  it('зарегистрирован под честным именем и читает BIGINT-колонки как NOT NULL', () => {
    expect(GROWTH).toMatch(/lens\(lenses, 'путь денег', scanMoneyPath/);
    expect(GROWTH).toMatch(/p\.telegram_chat_id IS NOT NULL OR p\.max_chat_id IS NOT NULL/);
    expect(GROWTH).not.toMatch(/TRIM\(p\.(telegram|max)_chat_id\)/);
  });

  it('способ оплаты — из общего модуля имён, а не своим чтением env', () => {
    expect(GROWTH).toMatch(/paymentAvailability\(\)\.none/);
    expect(GROWTH).not.toMatch(/process\.env\.CLOUDPAYMENTS/);
  });
});
