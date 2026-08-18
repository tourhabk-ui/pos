/**
 * «Какая именно AI обращалась к MCP — это возможно?»
 *
 * По журналу 861 — нет, и намеренно: там суточный hash от IP+UA, из которого
 * клиента не достать. Тот журнал отвечает «зовут ли, что зовут, ломается ли».
 *
 * Ответ при этом есть, и добывать его не надо: по протоколу MCP клиент
 * представляется САМ — `initialize` несёт `clientInfo: {name, version}`. Это
 * имя ПРОГРАММЫ («claude-ai», «cursor»), не человека: 152-ФЗ оно не касается,
 * суточную модель hash не ломает. Мы это поле просто выбрасывали.
 *
 * Сторож следит за двумя вещами сразу: что ответ появился и что цена ему —
 * не слежка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeClientName, normalizeClientVersion, uaFamily } from '@/lib/mcp/client-id';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/mcp/route.ts');
const LOG = read('lib/mcp/call-log.ts');
const ANALYTICS = read('app/api/admin/analytics/mcp/route.ts');
const MIGRATION = read('migrations/872_mcp_clients.sql');
const PAGE = read('app/hub/admin/mcp/page.tsx');

describe('имя клиента берётся из рукопожатия', () => {
  it('initialize записывает clientInfo', () => {
    const init = ROUTE.slice(ROUTE.indexOf("case 'initialize'"), ROUTE.indexOf("case 'notifications/initialized'"));
    expect(init).toMatch(/logMcpClient\(/);
    expect(init).toMatch(/clientInfo/);
  });

  it('вызов без рукопожатия тоже оставляет след — по заголовку', () => {
    // Не всякий клиент зовёт initialize: часть просто шлёт tools/call. Без
    // этой ветки такие остались бы полностью безымянными.
    const call = ROUTE.slice(ROUTE.indexOf("case 'tools/call'"));
    expect(call).toMatch(/logMcpClient\(\{ ip, userAgent \}\)/);
  });

  it('hash звонившего считается в ОДНОМ месте', () => {
    // Соль и состав входа обязаны совпадать у журнала вызовов и у записи
    // рукопожатия: разойдутся — таблицы не соединятся, и «кто звал» останется
    // без ответа при полном журнале.
    expect(LOG).toMatch(/export function mcpCallerHash/);
    expect((LOG.match(/visitorHash\(/g) ?? []).length).toBe(1);
  });
});

describe('приведение имени: строка приходит снаружи', () => {
  it('пробелы, регистр и переводы строк не плодят разных клиентов', () => {
    expect(normalizeClientName('  claude-ai  ')).toBe('claude-ai');
    expect(normalizeClientName('claude\nai')).toBe('claude ai');
    expect(normalizeClientName('a'.repeat(200))).toHaveLength(64);
  });

  it('пустое и не-строка дают null, а не пустую запись', () => {
    expect(normalizeClientName('')).toBeNull();
    expect(normalizeClientName('   ')).toBeNull();
    expect(normalizeClientName(42)).toBeNull();
    expect(normalizeClientName(undefined)).toBeNull();
  });

  it('версия чистится строже — в неё лезет что попало', () => {
    expect(normalizeClientVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeClientVersion('<script>')).toBe('script');
    expect(normalizeClientVersion({})).toBeNull();
  });

  it('незнакомый клиент виден как незнакомый, а не прячется в «прочее»', () => {
    // Whitelist имён скрыл бы ровно то, ради чего всё и делалось: кто новый
    // к нам приходит.
    expect(normalizeClientName('какой-то-новый-агент')).toBe('какой-то-новый-агент');
  });
});

describe('заголовок даёт РОД, а не отпечаток', () => {
  it('род опознаётся у известных семейств', () => {
    expect(uaFamily('Claude-User/1.0')).toBe('claude');
    expect(uaFamily('python-httpx/0.27')).toBe('python');
    expect(uaFamily('curl/8.4.0')).toBe('curl');
  });

  it('незнакомый заголовок не приписывается к ближайшему знакомому', () => {
    expect(uaFamily('SomeAgent/9')).toBe('неизвестен');
    expect(uaFamily('')).toBe('не представился');
  });
});

describe('цена ответа — не слежка', () => {
  it('суточная граница сохранена: ключ (caller_hash, day)', () => {
    expect(MIGRATION).toMatch(/PRIMARY KEY \(caller_hash, day\)/);
    expect(ANALYTICS).toMatch(/c\.day = t\.created_at::date/);
  });

  it('сырой User-Agent и IP в базу по-прежнему не пишутся', () => {
    // В таблице только род (ua_family) и имя программы. Строка заголовка
    // целиком — это отпечаток устройства.
    //
    // Проверяется СХЕМА, а не текст файла: пояснение выше по-русски объясняет,
    // что hash берётся от IP+UA, и слово «IP» в комментарии — не колонка.
    // Сторож, спотыкающийся о собственную документацию, учит её не писать.
    const ddl = MIGRATION.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    expect(ddl).not.toMatch(/user_agent|\bip\b/i);
  });

  it('аргументы инструментов в журнал не попадают', () => {
    // В create_lead лежат имя и телефон туриста (152-ФЗ).
    expect(LOG).not.toMatch(/toolArgs|arguments/);
  });
});

describe('ответ доходит до глаз', () => {
  it('срез считает вызовы по клиентам', () => {
    expect(ANALYTICS).toContain('by_client_30d');
    // LEFT JOIN намеренный: вызовы без известного клиента обязаны остаться в
    // счёте под честным «не представился», а не исчезнуть из отчёта.
    expect(ANALYTICS).toMatch(/LEFT JOIN mcp_clients/);
    expect(ANALYTICS).toMatch(/не представился/);
  });

  it('страница показывает и то, ОТКУДА известно имя', () => {
    // «Представился сам» и «опознан по заголовку» — ответы разной надёжности.
    expect(PAGE).toContain('by_client_30d');
    expect(PAGE).toMatch(/Кто звал/);
  });
});
