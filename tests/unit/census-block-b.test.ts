/**
 * Решения по блоку B переписи («Деньги и обязательства»), 22.08.2026.
 *
 * Блок собирал расчёты, написанные и не подключённые к деньгам. Разбор
 * показал, что половина из них была написана против схемы, КОТОРОЙ НЕТ, — и
 * не звалась ни разу, поэтому расхождение никого не побеспокоило.
 *
 * Сторож держит решения: удалённое не вернётся, подключённое не отвяжется.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/** Значение из разбора — в шаблон только экранированным. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
const migrations = () => fs.readdirSync(path.join(ROOT, 'migrations'))
  .filter(f => f.endsWith('.sql'))
  .map(f => read(`migrations/${f}`))
  .join('\n');

describe('удержание мест трансфера не возвращается', () => {
  it('функций удержания нет', () => {
    const src = code('lib/transfers/booking.ts');
    expect(src).not.toMatch(/\bholdSeats\b/);
    expect(src).not.toMatch(/\breleaseHold\b/);
    expect(src).not.toMatch(/\bcleanupExpiredHolds\b/);
  });

  it('гонку за место по-прежнему закрывает блокировка строки', () => {
    // Это и есть причина, по которой удержание не нужно.
    const src = code('lib/transfers/booking.ts');
    expect(src).toMatch(/createBookingWithLock/);
    expect(src).toMatch(/FOR UPDATE NOWAIT/);
  });

  it('бронь создаётся ДО платежа — окна для удержания нет', () => {
    const route = code('app/api/transfers/book/route.ts');
    expect(route.indexOf('createBookingWithLock')).toBeLessThan(route.indexOf('createPayment'));
  });
});

describe('схема гидов сведена к одной таблице', () => {
  it('писателя заработка, написанного против призрака, нет', () => {
    const src = code('lib/auth/guide-helpers.ts');
    expect(src).not.toMatch(/\brecordGuideEarnings\b/);
    expect(src).not.toMatch(/\bcalculateGuideEarnings\b/);
  });

  it('читателей пустой таблицы доступности нет', () => {
    // В guide_availability не пишет никто: читатели гарантированно возвращали
    // «гид недоступен».
    const src = code('lib/auth/guide-helpers.ts');
    expect(src).not.toMatch(/\bfindAvailableGuides\b/);
    expect(src).not.toMatch(/\bisGuideAvailable\b/);
    expect(src).not.toMatch(/\bgetGuideAvailability\b/);
  });

  it('колонки, которые использует вторая половина кабинета гида, объявлены', () => {
    // Они жили только в призрачном объявлении. Миграция 902 сводит таблицы к
    // объединению колонок — иначе половина кабинета обращается в пустоту.
    const all = migrations();
    for (const col of ['title', 'location_name', 'booking_id']) {
      expect(all, `guide_schedule.${col}`).toMatch(new RegExp(`guide_schedule ADD COLUMN IF NOT EXISTS ${col}\\b`));
    }
    for (const col of ['status', 'date']) {
      expect(all, `guide_earnings.${col}`).toMatch(new RegExp(`guide_earnings ADD COLUMN IF NOT EXISTS ${col}\\b`));
    }
  });

  it('NOT NULL новым колонкам не ставится — значения взять неоткуда', () => {
    const m = read('migrations/902_guide_schema_reconcile.sql');
    expect(m).not.toMatch(/ADD COLUMN IF NOT EXISTS[^;]*NOT NULL/);
  });
});

describe('эко-обязательство фиксируется при списании', () => {
  const src = code('lib/loyalty/loyalty-system.ts');

  it('списание записывает обязательство', () => {
    expect(src).toMatch(/\brecordClaim\b/);
  });

  it('повтор проводки обязательства не удваивает', () => {
    expect(src).toMatch(/result\.applied/);
  });

  it('незаписанное обязательство не проглатывается', () => {
    expect(src).toMatch(/обязательство по эко-скидке не записано/);
  });

  it('отказ фиксации не роняет уже состоявшееся списание', () => {
    // Эко списаны; уронить ответ из-за ненаписанного обязательства значит
    // показать человеку ошибку при успешной операции.
    const fn = src.slice(src.indexOf('async redeemPoints'));
    const body = fn.slice(0, fn.indexOf('async generateReferralCode'));
    expect(body).toMatch(/try \{[\s\S]{0,400}recordClaim[\s\S]{0,400}\} catch/);
  });

  it('потолок стока проверяется, а непроверенность названа', () => {
    expect(src).toMatch(/\bmaxEcoForCheck\b/);
    expect(src).toMatch(/\bcapChecked\b/);
  });

  it('долг по скидкам виден на экране финансов', () => {
    expect(code('app/api/admin/finance/route.ts')).toMatch(/\bpendingCompensation\b/);
  });
});

describe('документы туриста', () => {
  it('крон напоминаний существует и зовёт обе функции', () => {
    const src = code('app/api/cron/document-expiry/route.ts');
    expect(src).toMatch(/\bgetExpiringDocuments\b/);
    expect(src).toMatch(/\bmarkDocumentReminderSent\b/);
  });

  it('крон внесён в реестр и объявил смысл своего нуля', () => {
    const reg = read('lib/agents/cron-registry.ts');
    expect(reg).toMatch(/key: 'document-expiry'/);
    expect(reg).toMatch(/'document-expiry':\s*'(normal|broken|unknown)'/);
  });

  it('нашли кого предупредить и не предупредили — это отказ, а не успех', () => {
    expect(code('app/api/cron/document-expiry/route.ts')).toMatch(/owners\.length === 0 \|\| notified > 0/);
  });

  it('номер документа в Telegram не уходит — это ПД в зарубежном канале', () => {
    const src = code('lib/telegram/booking-notify.ts');
    const fn = src.slice(src.indexOf('export function notifyTouristDocumentExpiring'));
    expect(fn.slice(0, 1200)).not.toMatch(/documentNumber|document_number/);
  });

  it('таблица документов объявлена, а не держится на памяти о проде', () => {
    expect(migrations()).toMatch(/CREATE TABLE IF NOT EXISTS tourist_documents/);
  });
});

describe('скидка лояльности не возвращается константой', () => {
  it('лестницы процентов в утилите профиля нет', () => {
    expect(code('lib/auth/tourist-helpers.ts')).not.toMatch(/\bcalculateLoyaltyDiscount\b/);
  });
});

describe('инструмент проверки приёмника оплаты имеет потребителя', () => {
  it('сборщик подписанного вебхука проверяется тестом', () => {
    const t = read('tests/unit/cloudpayments-signature.test.ts');
    expect(t).toMatch(/\bcreateTestWebhook\b/);
    expect(t).toMatch(/\bvalidateCloudPaymentsSignature\b/);
  });
});
