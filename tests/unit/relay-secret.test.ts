/**
 * Секрет релея доходит до КАЖДОГО НАШЕГО релея — и ни до кого больше.
 *
 * Половина первая (23.08). Разрыв нашёлся при подготовке VPS-релея:
 * X-Relay-Secret слал только github-fetch. У Cloudflare-воркера проверка
 * секрета опциональна, поэтому промах был невидим. На VPS она обязательна —
 * публичный адрес находят сканами за часы, — и релей ответил бы своим 403
 * {"error":"forbidden"}, до отвращения похожим на чужой 403
 * {"success":false,"error":"Access denied by security policy."}, ради
 * которого весь разбор и затевался.
 *
 * Половина вторая (08.09, находка аудита). Чинили это ЗАПРЕТИТЕЛЬНЫМ списком
 * из двух имён — «всем, кроме openrouter.ai и api.anthropic.com», — и вот
 * этот самый файл его заморозил. Заголовок теста при этом обещал обратное:
 * «на прямой адрес апстрима секрет не уходит». Сторож охранял КОД, а не
 * правило, и потому не заметил, что `fetchModelIds` ходит той же дорогой на
 * https://api.x.ai/v1/models, https://api.deepseek.com/models, Moonshot и
 * базу резолвера Qwen — то есть наш секрет уезжал четырём посторонним. Свой
 * же тест про `fetchModelIds` это одобрял.
 *
 * Запрет тут не чинится добавлением имён: чужих хостов столько, сколько
 * провайдеров, и следующий появится без нас. Своих ровно столько, сколько
 * НАСТРОЕНО. Поэтому список разрешительный и выведен из конфигурации.
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

  it('секрет уходит только СВОИМ: список разрешительный, а не запретительный', () => {
    expect(SRC).toMatch(/const RELAY_HOSTS: ReadonlySet<string>/);
    expect(SRC).toMatch(/if \(host === null \|\| !RELAY_HOSTS\.has\(host\)\) return headers;/);
    // Прежняя форма — «всем, кроме двух» — запрещена как КОД, не как слово:
    // разбор в шапке этого файла те же имена называет.
    expect(SRC).not.toMatch(/if \(host === 'openrouter\.ai' \|\| host === 'api\.anthropic\.com'\) return headers;/);
  });

  it('проверка принадлежности стоит ДО чтения секрета', () => {
    // Порядок, а не пробелы: сторож, привязанный к форматированию, краснеет
    // на переносе строки и ничего при этом не охраняет.
    const fn = SRC.slice(SRC.indexOf('function withRelaySecret'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const guardAt = body.indexOf('RELAY_HOSTS.has(host)');
    const secretAt = body.indexOf('process.env.RELAY_SECRET');
    expect(guardAt, 'проверка принадлежности не найдена').toBeGreaterThan(-1);
    expect(secretAt, 'чтение секрета не найдено').toBeGreaterThan(-1);
    expect(guardAt, 'чужой хост обязан отсекаться ДО чтения секрета').toBeLessThan(secretAt);
  });

  it('множество своих выводится из конфигурации, а не пишется руками', () => {
    // Хост попадает туда, только если база задана переменной и увела нас с
    // домашнего адреса провайдера. Ничего не настроено — множество пусто.
    expect(SRC).toMatch(/\.filter\(\(\[base, direct\]\) => base !== direct\)/);
    expect(SRC).toContain('[OPENROUTER_BASE, OPENROUTER_DIRECT]');
    expect(SRC).toMatch(/h !== 'openrouter\.ai' && h !== 'api\.anthropic\.com'/);
  });

  it('перечень моделей идёт через ту же точку — значит она обязана быть узкой', () => {
    // ${OPENROUTER_BASE}/models уходит внутрь fetchModelIds параметром —
    // регулярка выше его не поймала бы, поэтому проверяем отдельно.
    expect(SRC).toMatch(/const res = await relayFetchWithRetry\(url,/);
    // И вот с чем ЕЩЁ её зовут. Прежняя редакция этого файла видела только
    // первую строку и считала проход через точку заслугой.
    expect(SRC).toContain("fetchModelIds('https://api.x.ai/v1/models'");
    expect(SRC).toContain("fetchModelIds('https://api.deepseek.com/models'");
  });
});
