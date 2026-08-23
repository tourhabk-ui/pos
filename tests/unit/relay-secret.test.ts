/**
 * Секрет релея доходит до КАЖДОГО апстрима, а не только до GitHub.
 *
 * Разрыв нашёлся 23.08 при подготовке VPS-релея: X-Relay-Secret слал
 * только github-fetch. У Cloudflare-воркера проверка секрета опциональна,
 * поэтому промах был невидим. На VPS она обязательна — публичный адрес
 * находят сканами за часы, — и релей ответил бы своим 403
 * {"error":"forbidden"}, до отвращения похожим на чужой 403
 * {"success":false,"error":"Access denied by security policy."}, ради
 * которого весь разбор и затевался. Два разных отказа с одним кодом —
 * лучший способ потерять ещё вечер.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8');

describe('секрет релея', () => {
  it('ни один вызов к базам релея не идёт мимо точки прохода', () => {
    // Голый fetch/fetchWithRetry по адресу релея — это забытый секрет.
    // Проверка структурная: неважно, сколько там вызовов сегодня.
    const bare = SRC.match(/(?<![A-Za-z])fetch(WithRetry)?\(`\$\{(OPENROUTER_BASE|ANTHROPIC_BASE)\}/g);
    expect(bare, `мимо relayFetch идут: ${bare?.join(', ')}`).toBeNull();
  });

  it('точка прохода существует и ставит заголовок', () => {
    expect(SRC).toMatch(/function withRelaySecret/);
    expect(SRC).toContain("h.set('X-Relay-Secret', secret)");
    expect(SRC).toMatch(/function relayFetch\(/);
    expect(SRC).toMatch(/function relayFetchWithRetry\(/);
  });

  it('на ПРЯМОЙ адрес апстрима секрет не уходит', () => {
    // Делиться секретом релея с посторонним хостом незачем: там он не нужен.
    expect(SRC).toMatch(/host === 'openrouter\.ai' \|\| host === 'api\.anthropic\.com'/);
    // Проверяем ПОРЯДОК, а не пробелы: отсечка прямого адреса обязана
    // стоять раньше чтения секрета. Сторож, привязанный к форматированию,
    // краснеет на переносе строки и ничего при этом не охраняет.
    const fn = SRC.slice(SRC.indexOf('function withRelaySecret'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const guardAt = body.indexOf("host === 'openrouter.ai'");
    const secretAt = body.indexOf('process.env.RELAY_SECRET');
    expect(guardAt, 'отсечка прямого адреса не найдена').toBeGreaterThan(-1);
    expect(secretAt, 'чтение секрета не найдено').toBeGreaterThan(-1);
    expect(guardAt, 'прямой адрес обязан отсекаться ДО чтения секрета').toBeLessThan(secretAt);
  });

  it('перечень моделей тоже идёт через точку прохода', () => {
    // ${OPENROUTER_BASE}/models уходит внутрь fetchModelIds параметром —
    // регулярка выше его не поймала бы, поэтому проверяем отдельно.
    expect(SRC).toMatch(/const res = await relayFetchWithRetry\(url,/);
  });
});
