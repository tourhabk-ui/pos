/**
 * Комиссия платформы: одна ставка, один источник, ВСЕ приёмники платежей.
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
 * Почему тест переименован из «оба вебхука» (04.08). Сторож перечислял два
 * файла и этим сам себя обманывал: живых приёмников платежей три — два
 * CloudPayments и СБП Точка (`/api/payments/tochka/webhook`, QR выдаётся из
 * чата Кузьмича). Третий не начислял комиссию вовсе, а название сторожа
 * утверждало, что покрыты все. Поэтому ниже приёмники не перечисляются
 * руками, а НАХОДЯТСЯ: роут, проставляющий `paid_at` брони, — это приём
 * оплаты, и он обязан начислить комиссию.
 *
 * Решение владельца 04.08: единая ставка 10%, источник истины — база
 * (`partners.commission_current`, миграция 811).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const MAIN = 'app/api/payments/webhook/route.ts';
const HUB = 'app/api/hub/operator/payments/webhook/route.ts';
const TOCHKA = 'app/api/payments/tochka/webhook/route.ts';

const LIB = read('lib/payments/commission.ts');
const MIGRATION = read('migrations/811_platform_commission_10.sql');
const BOOKING = read('app/api/bookings/tour/route.ts');
const FINANCE = read('app/api/operator/finance/route.ts');

/** Исходник без строк-комментариев: пояснения не должны считаться кодом. */
function code(src: string): string {
  return src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (name.endsWith('.ts')) out.push(relative('.', rel));
  }
  return out;
}

/**
 * Приёмники оплаты, найденные по коду: роут проставляет броне `paid_at` —
 * значит принимает деньги. Ручное подтверждение оператором этого не делает.
 */
const receivers = walk('app/api').filter((f) => {
  const src = code(read(f));
  return /paid_at\s*=/.test(src) && /operator_bookings/.test(src);
});

describe('комиссию начисляет каждый приёмник оплаты', () => {
  it('приёмники находятся по коду, а не по списку в тесте', () => {
    // Если поиск сломается, все проверки ниже станут пустыми и зелёными.
    expect(receivers).toEqual(expect.arrayContaining([MAIN, HUB, TOCHKA]));
  });

  it('каждый найденный приёмник записывает комиссию', () => {
    for (const f of receivers) {
      expect(read(f), `${f}: принимает оплату, но комиссию не начисляет`)
        .toMatch(/recordCommissionFromBooking\(/);
    }
  });

  it('вставка одна на всех — своего INSERT в приёмниках нет', () => {
    for (const f of receivers) {
      expect(read(f), `${f}: снова свой INSERT комиссии — копии разойдутся`)
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

  it('у СБП ключ идемпотентности — QR оплаты', () => {
    // Своего InvoiceId у Точки нет; qrcId уникален на оплату и не может
    // столкнуться с номерами счетов CloudPayments из-за префикса.
    expect(code(read(TOCHKA))).toMatch(/recordCommissionFromBooking\([^)]*tochka:\$\{qrId\}/);
  });
});

describe('СБП-вебхук не теряет оплату молча', () => {
  const src = code(read(TOCHKA));

  it('банк не ответил — просим повтор, а не закрываем 200', () => {
    // 200 для банка означает «больше не присылай». Раньше маршрут отвечал 200
    // всегда, включая catch: деньги пришли, бронь навсегда в pending_payment.
    expect(src).toMatch(/if \(!status\) return retryLater\(/);
  });

  it('сбой обработки — тоже повтор', () => {
    expect(src).toMatch(/catch\s*\{\s*return retryLater\(/);
  });

  it('повтор — это не-2xx, иначе банк его не пришлёт', () => {
    expect(src).toMatch(/status:\s*503/);
  });

  it('после подтверждения 503 больше не возвращается', () => {
    // Повтор увидит бронь не в pending_payment и уйдёт в 200, ничего не доделав,
    // поэтому учёт и уведомления обязаны гасить свои ошибки сами.
    const start = src.indexOf('async function afterConfirmed');
    expect(start, 'работа после подтверждения вынесена из обработчика').toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const end = rest.indexOf('\nasync function ');
    const body = end === -1 ? rest : rest.slice(0, end);
    expect(body).not.toMatch(/retryLater\(|NextResponse/);
    expect(body).toMatch(/recordCommissionFromBooking\(/);
  });

  it('расхождение суммы не проходит молча', () => {
    expect(src).toMatch(/notifyOwnerAmountMismatch\(/);
  });
});

describe('ставка одна и берётся из базы', () => {
  it('единая ставка платформы — 10%', () => {
    expect(LIB).toMatch(/PLATFORM_COMMISSION_PERCENT\s*=\s*10\b/);
  });

  it('старые 12% из платёжного вебхука убраны', () => {
    expect(code(read(MAIN))).not.toMatch(/0\.12/);
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
