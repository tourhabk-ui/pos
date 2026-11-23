/**
 * Сквозной тест цикла заявки не ходит в сеть и не знает настоящих адресатов
 * (план готовности 23.11, этап 6).
 *
 * Риск назван в плане: «тестовая заявка с реальным телефоном попадёт в логи
 * или в Telegram» и «проверим на живом партнёре». Сам файл цикла судит это
 * поведением — `fetch` подменён и обязан остаться невызванным. Этот сторож
 * держит то, чего поведением не поймать: что подмены на месте и что в файле
 * нет боевых адресов, токенов и чужих телефонов. Здесь уместен поиск по
 * тексту: это запреты («этого быть не должно»), а не правило экрана.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'tests/integration/request-cycle.pg.test.ts';
const src = readFileSync(join(process.cwd(), FILE), 'utf8');
/** Код без комментариев: слова шапки файла о сети и партнёрах — не вызовы. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('сквозной тест цикла заявки: сети и настоящих адресатов нет', () => {
  it('отправка в мессенджеры подменена во всех трёх дверях', () => {
    for (const mod of ['@/lib/notifications/pd-alert', '@/lib/notifications/max-channel', '@/lib/notifications/telegram']) {
      expect(code, mod).toContain(`vi.mock('${mod}'`);
    }
  });

  it('сеть закрыта подменой fetch, и файл сам проверяет, что её не трогали', () => {
    expect(code).toMatch(/vi\.stubGlobal\('fetch'/);
    expect(code).toMatch(/expect\(sent\.net\)\.toEqual\(\[\]\)/);
  });

  it('токены ботов и рабочий чат из окружения убраны до первого запроса', () => {
    for (const name of ['MAX_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'MAX_OPERATOR_CHAT_ID']) {
      expect(code, name).toContain(`'${name}'`);
    }
    expect(code).toMatch(/delete process\.env\[k\]/);
    // Значений токенов в файле нет: ни присваивания, ни строки похожей формы.
    expect(code).not.toMatch(/process\.env\.(MAX_BOT_TOKEN|TELEGRAM_BOT_TOKEN|MAX_API_TOKEN)\s*=/);
    expect(code).not.toMatch(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/);
  });

  it('боевых адресов в коде теста нет: ни сайта, ни API мессенджеров', () => {
    expect(code).not.toMatch(/vedarai\.ru/);
    expect(code).not.toMatch(/api\.telegram\.org|platform-api\.max\.ru|botapi\.max\.ru/);
    // Все запросы файла — к обработчикам роутов напрямую, по адресу localhost.
    const urls = [...code.matchAll(/https?:\/\/[^\s'"`/]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect([...new Set(urls)]).toEqual(['http://localhost']);
  });

  it('телефоны в файле — только стендовый и пробный номер; партнёр — стенд из списка', () => {
    const phones = [...code.matchAll(/\+7\d{10}/g)].map((m) => m[0]);
    expect([...new Set(phones)].sort()).toEqual(['+70000000000', '+79000000000']);
    expect(code).toContain('TEST_STAND_PARTNER_IDS[0]');
    // Живых пилотов тест не называет и их чатов не знает.
    expect(src).not.toMatch(/Кутх|Лагун|Шатун|Желтухин|Камчатская рыбалка/);
  });
});
