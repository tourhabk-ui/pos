/**
 * Комиссия платформы: одна ставка, один источник, оба вебхука.
 *
 * Повод — аудит дублей 2026-08-03/04. Ставка жила в ЧЕТЫРЁХ местах и в трёх
 * разных значениях:
 *   • `partners.commission_current` — 15% (дефолт миграции 051);
 *   • `/api/payments/webhook` — захардкоженные 12% → `operator_commissions`;
 *   • поток бронирования и hub-вебхук — договорные ~15% → `tour_payments`;
 *   • финансовый экран оператора — захардкоженные 15% на показ.
 * Одна бронь получала разную комиссию в разных таблицах, а оператор видел в
 * кабинете цифру, не совпадающую с начисляемой.
 *
 * Вдобавок hub-вебхук не начислял комиссию ВООБЩЕ: попадёт ли оплата в учёт,
 * зависело от того, какой URL прописан в кабинете CloudPayments.
 *
 * Решение владельца 04.08: единая ставка 10%, источник истины — база
 * (`partners.commission_current`, миграция 811).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const MAIN = read('app/api/payments/webhook/route.ts');
const HUB = read('app/api/hub/operator/payments/webhook/route.ts');
const LIB = read('lib/payments/commission.ts');
const MIGRATION = read('migrations/811_platform_commission_10.sql');
const BOOKING = read('app/api/bookings/tour/route.ts');
const FINANCE = read('app/api/operator/finance/route.ts');

/** Исходник без строк-комментариев: пояснения не должны считаться кодом. */
function code(src: string): string {
  return src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
}

describe('комиссию начисляют оба вебхука', () => {
  it('основной вебхук записывает комиссию', () => {
    expect(MAIN).toMatch(/recordCommissionFromBooking\(/);
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
  it('вставка защищена ключом invoice_id', () => {
    // CloudPayments повторяет доставку, пока не получит code: 0 — без этого
    // одна оплата дала бы несколько начислений.
    expect(LIB).toMatch(/ON CONFLICT \(invoice_id\) DO NOTHING/);
  });

  it('сбой учёта не роняет платёж', () => {
    expect(LIB).toMatch(/catch\s*\{/);
  });
});

describe('ставка одна и берётся из базы', () => {
  it('единая ставка платформы — 10%', () => {
    expect(LIB).toMatch(/PLATFORM_COMMISSION_PERCENT\s*=\s*10\b/);
  });

  it('старые 12% из платёжного вебхука убраны', () => {
    expect(code(MAIN)).not.toMatch(/0\.12/);
    expect(code(LIB)).not.toMatch(/0\.12/);
  });

  it('источник истины — partners.commission_current, а не константа', () => {
    expect(LIB).toMatch(/COALESCE\(p\.commission_current/);
    // Ставка в БД в ПРОЦЕНТАХ (10), колонка rate — в ДОЛЯХ (0.10).
    expect(LIB).toMatch(/\/\s*100/);
  });

  it('запасные значения нигде не остались 15%', () => {
    expect(code(BOOKING)).not.toMatch(/commission_current,\s*15\b/);
    expect(code(FINANCE)).not.toMatch(/\*\s*0\.15\b/);
  });

  it('финансовый экран оператора считает по договорной ставке', () => {
    expect(FINANCE).toMatch(/commission_current/);
  });
});

describe('миграция 811 приводит данные к 10%', () => {
  it('меняет дефолты обеих колонок ставки', () => {
    expect(MIGRATION).toMatch(/commission_current SET DEFAULT 10/);
    expect(MIGRATION).toMatch(/commission_start\s+SET DEFAULT 10/);
  });

  it('обновляет действующих партнёров', () => {
    expect(MIGRATION).toMatch(/UPDATE partners/);
    expect(MIGRATION).toMatch(/commission_current = 10/);
  });

  it('трогает commission_start — иначе спящая скользящая шкала вернёт старое', () => {
    // recalculate_commission (051) берёт базу из commission_start. Функцию
    // сейчас никто не вызывает, но если включат — 10% молча уехали бы.
    expect(MIGRATION).toMatch(/commission_start\s*=\s*10/);
  });

  it('идемпотентна', () => {
    expect(MIGRATION).toMatch(/IS DISTINCT FROM/);
  });
});
