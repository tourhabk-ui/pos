/**
 * Решения по блоку E переписи («Инфраструктура и БД») и итог всей переписи.
 *
 * Блок был последним и самым разношёрстным: одиннадцать админ-инструментов
 * раннего этапа, две пары точных копий и два десятка одиночек. Разбор довёл
 * перепись до трёх сирот на всю платформу — и все три оставлены НАМЕРЕННО, с
 * причиной, записанной рядом с кодом.
 *
 * Этот сторож держит две вещи: решения блока и сам итог. Число сирот проверять
 * здесь нельзя — оно требует полного разбора импортов и живёт в
 * `scripts/export-census.ts`; здесь проверяется, что удалённое не вернулось,
 * а подключённое не отвязалось.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/** Значение из разбора — в шаблон только экранированным. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

describe('админ-инструменты БД', () => {
  const db = code('lib/database.ts');

  it('вторая дверь к пулу не возвращается', () => {
    // Пул живёт в lib/db-pool.ts. Две двери однажды дают два пула.
    expect(db).not.toMatch(/export (async )?function (getPool|closePool)\b/);
  });

  it('создание индексов мимо миграций не возвращается', () => {
    // Схему меняют миграцией — это правило платформы, а не предпочтение.
    expect(db).not.toMatch(/export (async )?function createIndexes\b/);
  });

  it('чистка с проглоченной ошибкой не возвращается', () => {
    // cleanupOldData удаляла старые сессии и логи, глуша каждую ошибку пустым
    // catch, и не имела крона: чистка не шла ни разу, и молчание читалось
    // как «нечего чистить».
    expect(db).not.toMatch(/export (async )?function cleanupOldData\b/);
  });

  it('getTableInfo осталась и отвечает на вопрос «что в базе на самом деле»', () => {
    expect(db).toMatch(/export (async )?function getTableInfo\b/);
    const drift = code('app/api/admin/health/schema-drift/route.ts');
    expect(drift).toMatch(/\bgetTableInfo\b/);
    expect(drift).toMatch(/\bbuildSchemaRegistry\b/);
  });

  it('расхождение схемы различает две стороны, а не считает их одним', () => {
    // «файлы обещают колонку, которой нет» опаснее, чем «в базе есть лишняя»:
    // по первому код падает, по второму — след правки мимо миграций.
    const drift = read('app/api/admin/health/schema-drift/route.ts');
    expect(drift).toMatch(/missing_in_db/);
    expect(drift).toMatch(/missing_in_files/);
  });

  it('отказ чтения боевой схемы не выдаётся за отсутствие расхождений', () => {
    expect(read('app/api/admin/health/schema-drift/route.ts'))
      .toMatch(/Боевую схему прочитать не удалось/);
  });
});

describe('точные копии убраны, отказ назван', () => {
  it('копий поиска партнёра в operator-helpers нет', () => {
    const src = code('lib/auth/operator-helpers.ts');
    expect(src).not.toMatch(/export (async )?function getGuidePartnerId\b/);
    expect(src).not.toMatch(/export (async )?function getTransferPartnerId\b/);
  });

  it('живые версии на месте', () => {
    expect(code('lib/auth/guide-helpers.ts')).toMatch(/export async function getGuidePartnerId\b/);
    expect(code('lib/auth/transfer-helpers.ts')).toMatch(/export async function getTransferPartnerId\b/);
  });

  it('отказ базы не выдаётся молча за отсутствие прав', () => {
    // Обе возвращают null и при «такой роли нет», и при отказе БД. Тип менять
    // нельзя, не тронув всех вызывающих, — поэтому отказ хотя бы называется.
    for (const f of ['lib/auth/guide-helpers.ts', 'lib/auth/transfer-helpers.ts']) {
      expect(read(f), f).toMatch(/запрос к partners не выполнился/);
    }
  });
});

describe('подключено', () => {
  it('род связи называется одним словом на всю платформу', () => {
    // «Рядом с маршрутом» было написано и в словаре, и в карточке.
    expect(code('app/routes/[id]/_RouteDetailClient.tsx')).toMatch(/\blinkKindLabel\b/);
  });

  it('турист узнаёт, что заявка дошла', () => {
    // Уведомление шло только оператору; человек молчал до подтверждения, а
    // Watchdog бьёт тревогу лишь через сутки.
    expect(code('app/api/hub/bookings/create/route.ts')).toMatch(/\bnotifyTouristBookingCreated\b/);
  });
});

describe('удалённое не возвращается', () => {
  const gone: Array<[string, string]> = [
    ['lib/errors/api-handler.ts', 'withErrorHandler'],
    ['lib/errors/sanitize.ts', 'isClientError'],
    ['lib/errors/sanitize.ts', 'logError'],
    ['lib/errors/sanitize.ts', 'isDatabaseError'],
    ['lib/monitoring/logger.ts', 'logApiRequest'],
    ['lib/monitoring/logger.ts', 'logApiError'],
    ['lib/config.ts', 'getClientConfig'],
    ['lib/auth.ts', 'getUserFromToken'],
    ['lib/auth/tourist-helpers.ts', 'getTouristRecommendations'],
    ['lib/transfers/booking.ts', 'checkAvailability'],
    ['lib/wishlist/client.ts', 'fetchWishlistedIds'],
  ];

  for (const [file, name] of gone) {
    it(`${name} не возвращается в ${file}`, () => {
      expect(code(file)).not.toMatch(new RegExp(`export (async )?function ${escapeRe(name)}\\b`));
    });
  }

  it('живое рядом с удалённым не задето', () => {
    // Соседи по файлам, которыми пользуются: если бы правка задела их,
    // проверка выше этого не заметила бы.
    expect(code('lib/errors/api-handler.ts')).toMatch(/export function classifyError\b/);
    expect(code('lib/errors/sanitize.ts')).toMatch(/export function safeMsg\b/);
    expect(code('lib/auth.ts')).toMatch(/export/);
    expect(code('lib/services/travelpayouts.ts')).toMatch(/export async function toAffiliateLink\b/);
    expect(code('lib/partners/kamchatka-fishing/tours-data.ts')).toMatch(/export const FISHING_TOURS\b/);
  });

  it('четвёртый движок подбора не возвращается', () => {
    // Платформа держит ровно три: lead-processor, lib/planner, lib/search.
    expect(code('lib/auth/tourist-helpers.ts')).not.toMatch(/\bgetTouristRecommendations\b/);
  });
});

describe('итог переписи', () => {
  it('оставшиеся сироты объявлены намеренными В КОДЕ, а не только в докладе', () => {
    // Три на всю платформу. Каждая обязана нести причину рядом с собой:
    // без неё следующий разбор снимет её как забытую.
    expect(read('lib/ai/embeddings.ts')).toMatch(/ВЫЗОВА НЕТ НАМЕРЕННО/);
    expect(read('lib/ai/interest-extractor.ts')).toMatch(/ВЫЗОВА НЕТ НАМЕРЕННО/);
    expect(read('lib/offline/map-file.ts')).toMatch(/ВЫЗОВА НЕТ НАМЕРЕННО/);
  });

  it('замер остаётся воспроизводимым', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts/export-census.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'lib/quality/export-census.ts'))).toBe(true);
  });
});
