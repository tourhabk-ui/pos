/**
 * Ставку комиссии назначает владелец, а не объём продаж оператора.
 *
 * ── Что нашлось 11.09 на разборе денежного пути ───────────────────────────
 *
 * `partners.commission_current` — источник истины для КАЖДОГО начисления:
 * по нему считает `recordCommissionFromBooking` (единственный способ записать
 * комиссию), экран «Финансы оператора», комиссия перевозчика и сухой прогон.
 *
 * А функция `recalculate_commission(operator_id)` (миграция 051) эту колонку
 * ПЕРЕЗАПИСЫВАЕТ — по лестнице за объём завершённых броней, отсчитываемой от
 * `commission_start`:
 *
 *     завершённых броней   ставка при start = 10%
 *     0-9                  10%
 *     10-49                 7%   GREATEST(5, 10 - 3)
 *     50 и больше           5%   GREATEST(5, 10 - 6)
 *
 * То есть первый же оператор, который начнёт по-настоящему продавать, уводил
 * платформу с 10% на 7%, а дальше на 5%. Решения об этом не принимал никто:
 * владелец 04.08 сказал «пока нет партнёров делаем 10%», и миграция 811
 * привела к десяти и `commission_current`, и `commission_start`.
 *
 * Автор 811 эту опасность ВИДЕЛ и записал в шапке миграции:
 *
 *     «Её сейчас никто не вызывает, но если однажды включат — она вернула бы
 *      ставку к commission_start, и 10% молча уехали бы.»
 *
 * Ошибок в этой фразе две. Первая: звали — из `app/api/cron/payouts` (каждый
 * прогон релиза) и из `app/api/admin/finance/payouts` (каждое нажатие
 * «выплатить»). Вторая: лестница уводит ставку не К `commission_start`, а
 * НИЖЕ него, поэтому защита «сделаем start равным current» не защищала.
 *
 * Это правило 10.09 наоборот: не объявление без механизма, а механизм без
 * объявления. Описание пережило код и утверждало о нём неправду — а читающий
 * верит описанию.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Что ставку никто не меняет сам собой. Лестница из 051 остаётся в базе и
 * может быть включена — но это решение владельца, и включаться оно должно
 * видимым коммитом, а не возвратом строки, которую один раз уже убрали.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Где ставка вообще может измениться: код приложения, не миграции. */
function callersOfRecalculate(): string[] {
  const out = execSync(
    'grep -rln "recalculate_commission" app lib components hooks --include=*.ts --include=*.tsx || true',
    { cwd: ROOT, encoding: 'utf-8' },
  ).trim().split('\n').filter(Boolean);

  // Упоминание в комментарии — не вызов. Ищем именно исполняемый SELECT.
  return out.filter((f) => {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return /recalculate_commission/.test(code);
  });
}

describe('ставка комиссии не меняется сама собой', () => {
  it('recalculate_commission не зовёт ни один роут и ни один сервис', () => {
    const callers = callersOfRecalculate();
    expect(
      callers,
      'Вызов recalculate_commission перезаписывает partners.commission_current — ставку, по которой ' +
      'считается каждое начисление — по лестнице за объём. Владелец назначил единую ставку (миграция 811). ' +
      'Если лестница за объём нужна, это отдельное решение владельца: включать её видимым коммитом, ' +
      'который меняет и этот сторож, и запись в CLAUDE.md.\n' +
      `Нашлось в: ${callers.join(', ')}`,
    ).toEqual([]);
  });

  it('сама функция из базы не удалена: отключено — не то же самое, что снесено', () => {
    const sql = readFileSync(join(ROOT, 'migrations/051_financial_tables.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION recalculate_commission/);
  });

  it('обе точки, где вызов стоял, помнят почему его убрали', () => {
    for (const f of [
      'app/api/cron/payouts/route.ts',
      'app/api/admin/finance/payouts/route.ts',
    ]) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      expect(src, `${f}: без объяснения строку вернут обратно первым же «почему тут этого нет»`)
        .toMatch(/commission_current/);
    }
  });
});

describe('единственный способ начислить комиссию читает ставку из базы', () => {
  const SRC = readFileSync(join(ROOT, 'lib/payments/commission.ts'), 'utf-8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('ставка берётся из partners.commission_current, константа — только запас', () => {
    expect(CODE).toMatch(/COALESCE\(p\.commission_current, \$3\)/);
    expect(CODE).toMatch(/PLATFORM_COMMISSION_PERCENT/);
  });

  it('исход «ставка не записана» объявлен одной функцией', () => {
    expect(CODE).toMatch(/export function effectiveCommissionPercent/);
    // Ноль сквозь запас НЕ подменяется: это записанная ставка, а не пустота.
    expect(CODE).toMatch(/raw === null \|\| raw === undefined \|\| raw === ''/);
  });
});

/**
 * ── Один вопрос — один ответ ───────────────────────────────────────────────
 *
 * Колонка `commission_current` NULLABLE, и до 11.09 на пустое значение каждый
 * читатель отвечал по-своему: кто-то COALESCE до 10, `/api/bookings/tour` —
 * `Number(null)` = 0 (нулевая комиссия платформы, молча), а вставка в
 * `tour_payments` роняла всю транзакцию оплаты на NOT NULL.
 *
 * Реестр ниже замораживает, КАК каждый файл отвечает на «ставки нет». Новый
 * файл, тронувший колонку, обязан ответить тоже — иначе сборка красная.
 * Список самоустаревающий: файла нет — запись обязана уйти.
 */
const RATE_TOUCHERS: Record<string, 'fallback_sql' | 'fallback_ts' | 'display_only' | 'writer'> = {
  'lib/payments/commission.ts': 'fallback_sql',
  'lib/transfers/service.ts': 'fallback_sql',
  'app/api/operator/finance/route.ts': 'fallback_sql',
  'app/api/hub/operator/reports/route.ts': 'fallback_sql',
  'app/api/hub/operator/payments/webhook/route.ts': 'fallback_sql',
  'app/api/bookings/tour/route.ts': 'fallback_ts',
  'app/api/hub/operator/payouts/route.ts': 'fallback_ts',

  // Показывают ставку человеку или перечисляют её в переписи — денег из неё
  // не считают, поэтому пустое значение здесь просто пустое.
  'app/api/hub/operator/profile/route.ts': 'display_only',
  'app/api/cron/commission-dry-run/route.ts': 'display_only',
  'app/api/cron/sql-shape-check/route.ts': 'display_only',
  'app/api/cron/payouts/route.ts': 'display_only',
  'app/api/admin/finance/payouts/route.ts': 'display_only',
  // Агентская комиссия — СВОИ 10% от суммы брони, к ставке оператора
  // отношения не имеет; колонка тут только в списке SELECT под чужим алиасом.
  'app/api/agent/bookings/route.ts': 'display_only',
  'app/api/payments/webhook/route.ts': 'display_only',

  // Пишут ставку новым партнёрам. Сегодня пишут НОЛЬ — то есть «комиссии
  // нет» там, где договора не было вовсе. Сколько таких на проде, отвечает
  // перепись rate_drift в /api/cron/commission-dry-run; правится по числу.
  'lib/services/ingest/visitkamchatka-operators.ts': 'writer',
  'lib/services/ingest/visitkamchatka-guides.ts': 'writer',
  'lib/services/tours/tours-visitkamchatka.ts': 'writer',
  'app/api/cron/payment-test-setup/route.ts': 'writer',
};

describe('у «ставки нет» один исход на всех читателей', () => {
  it('реестр полон: новый файл с commission_current обязан объявить ответ', () => {
    const files = execSync(
      'grep -rln "commission_current" app lib components hooks --include=*.ts --include=*.tsx || true',
      { cwd: ROOT, encoding: 'utf-8' },
    ).trim().split('\n').filter(Boolean);

    const unregistered = files.filter((f) => !(f in RATE_TOUCHERS));
    expect(
      unregistered,
      'Файл читает или пишет partners.commission_current, но не сказал, что делает при пустой ставке. ' +
      'Внеси в RATE_TOUCHERS: fallback_sql (COALESCE), fallback_ts (effectiveCommissionPercent), ' +
      `display_only (денег не считает) или writer (записывает ставку).\n${unregistered.join('\n')}`,
    ).toEqual([]);
  });

  it('реестр самоустаревающий: записи про несуществующие файлы нет', () => {
    const stale = Object.keys(RATE_TOUCHERS).filter((f) => {
      try { readFileSync(join(ROOT, f)); return false; } catch { return true; }
    });
    expect(stale, `запись про несуществующий файл:\n${stale.join('\n')}`).toEqual([]);
  });

  it('объявленный запас на самом деле есть в коде', () => {
    const missing: string[] = [];
    for (const [f, kind] of Object.entries(RATE_TOUCHERS)) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (kind === 'fallback_sql' && !/COALESCE\([^)]*commission_current/i.test(code)) {
        missing.push(`${f}: объявлен COALESCE, а его нет`);
      }
      if (kind === 'fallback_ts'
        && !/effectiveCommissionPercent/.test(code)
        && !/commission_current[^\n]*\?\?/.test(code)) {
        missing.push(`${f}: объявлен запас в TS, а его нет`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
