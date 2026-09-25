/**
 * Запрос выплаты агенту нельзя выполнить дважды на одни деньги.
 *
 * Находка эволюции #1238 (17.08): чтение, создание выплаты и перевод статуса
 * шли отдельными запросами, и в окно между ними помещался второй такой же
 * запрос. Кнопку «запросить выплату» нажимают дважды буднично.
 *
 * С 26.09 заявка собирается из продаж (единственная функция денег агента,
 * lib/payments/agent-commission.ts), но правило то же: всё в одной
 * транзакции, запись агента берётся FOR UPDATE (без SKIP LOCKED — второй
 * запрос обязан дождаться и получить честный отказ, а не пустую заявку), и
 * страховка в базе — уникальные индексы миграции 1026.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/agent/commissions/request-payout/route.ts'), 'utf-8');
const LIB = readFileSync(join(process.cwd(), 'lib/payments/agent-commission.ts'), 'utf-8');
const MIGRATION = readFileSync(join(process.cwd(), 'migrations/1026_agent_payouts.sql'), 'utf-8');
/** Код без комментариев: прежний дефект в них описан намеренно. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = strip(SRC);
const LIB_CODE = strip(LIB);

describe('чтение, создание и позиции — одна транзакция', () => {
  it('обработчик работает через transaction(), а не отдельными query()', () => {
    expect(CODE).toMatch(/await transaction<Outcome>\(async \(client\) =>/);
    expect(CODE).not.toMatch(/\bawait query\(/);
    expect(CODE).not.toMatch(/\bpool\.query\(/);
  });

  it('продажи читаются на клиенте транзакции и под замком', () => {
    expect(CODE).toMatch(/loadAgentMoney\(client, auth\.userId, true\)/);
    expect(CODE).toMatch(/client\.query<\{ id: string \}>\(AGENT_MONEY_SQL\.openPayout/);
    expect(CODE).toMatch(/client\.query\(AGENT_MONEY_SQL\.insertItems/);
  });
});

describe('строки берутся под замок', () => {
  it('запись агента читается FOR UPDATE', () => {
    expect(LIB_CODE).toMatch(/lockAgentProfile:[\s\S]{0,300}FOR UPDATE/);
  });

  it('без SKIP LOCKED — второй запрос ждёт и получает отказ', () => {
    expect(LIB_CODE).not.toMatch(/SKIP LOCKED/);
    expect(CODE).not.toMatch(/SKIP LOCKED/);
  });

  it('страховка в базе: одна открытая заявка и одна живая позиция на бронь', () => {
    expect(MIGRATION).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_commission_payouts_open_per_agent[\s\S]{0,120}WHERE status = 'pending' AND from_sales/);
    expect(MIGRATION).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_agent_payout_items_booking_live[\s\S]{0,120}WHERE released_at IS NULL/);
  });
});

describe('отказ остаётся отказом', () => {
  it('нечего выплачивать — 400 с понятным текстом', () => {
    expect(CODE).toMatch(/Нет продаж, готовых к выплате/);
    expect(CODE).toMatch(/status: 400/);
  });

  it('сработавший уникальный индекс — 409, прочие отказы — в лог с SQLSTATE', () => {
    expect(CODE).toMatch(/=== '23505'/);
    expect(CODE).toMatch(/logAgentMoneyFailure\(/);
  });
});
