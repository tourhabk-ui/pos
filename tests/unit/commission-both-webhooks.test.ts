/**
 * Комиссия платформы начисляется ОБОИМИ платёжными вебхуками.
 *
 * Повод — аудит дублей 2026-08-03. CloudPayments обрабатывают два живых
 * вебхука (оба зарегистрированы публичными в lib/auth/public-api-routes):
 *   • `/api/payments/webhook` — комиссию начислял;
 *   • `/api/hub/operator/payments/webhook` — НЕ начислял вовсе.
 * Попадёт ли оплата в учёт комиссий, зависело от того, какой URL прописан в
 * кабинете CloudPayments. Ошибка тихая: ни в логах, ни в интерфейсе не видна,
 * а в деньгах — недосчёт.
 *
 * Сторож держит три вещи: комиссию пишут оба; вставка одна на двоих;
 * идемпотентность не потеряна (CloudPayments повторяет вебхук до code: 0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const MAIN = read('app/api/payments/webhook/route.ts');
const HUB = read('app/api/hub/operator/payments/webhook/route.ts');
const LIB = read('lib/payments/commission.ts');

describe('комиссию начисляют оба вебхука', () => {
  it('основной вебхук записывает комиссию', () => {
    expect(MAIN).toMatch(/recordCommission\(/);
  });

  it('hub-вебхук записывает комиссию (раньше не записывал вовсе)', () => {
    expect(HUB).toMatch(/recordCommissionFromBooking\(/);
  });

  it('вставка одна на двоих — своего INSERT в вебхуках нет', () => {
    for (const [name, src] of [['main', MAIN], ['hub', HUB]] as const) {
      expect(src, `${name}: снова свой INSERT комиссии — копии разойдутся`)
        .not.toMatch(/INSERT INTO operator_commissions/);
    }
    expect(LIB).toMatch(/INSERT INTO operator_commissions/);
  });
});

describe('идемпотентность не потеряна', () => {
  it('обе вставки защищены ключом invoice_id', () => {
    const inserts = LIB.match(/INSERT INTO operator_commissions[\s\S]*?;/g) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const stmt of inserts) {
      expect(stmt).toMatch(/ON CONFLICT \(invoice_id\) DO NOTHING/);
    }
  });

  it('сбой учёта не роняет платёж', () => {
    // Вебхук уже принял деньги: исключение здесь заставило бы CloudPayments
    // повторять доставку сутки, а платёж от этого не станет лучше.
    expect(LIB).toMatch(/catch\s*\{/);
  });
});

describe('ставки не сведены молча', () => {
  it('основной вебхук сохранил свои 12%', () => {
    expect(LIB).toMatch(/LEGACY_PLATFORM_RATE\s*=\s*0\.12/);
    expect(MAIN).toMatch(/LEGACY_PLATFORM_RATE/);
  });

  it('hub считает по договорной ставке оператора, как и tour_payments рядом', () => {
    expect(LIB).toMatch(/commission_current/);
    // Ставка хранится в ПРОЦЕНТАХ (15), колонка rate — в ДОЛЯХ (0.15):
    // без деления на 100 в учёт уехала бы ставка в сто раз больше.
    expect(LIB).toMatch(/COALESCE\(p\.commission_current, 15\)\s*\/\s*100/);
  });

  it('расхождение ставок задокументировано, а не забыто', () => {
    expect(LIB).toMatch(/tour_payments/);
    expect(LIB).toMatch(/12%/);
  });
});
