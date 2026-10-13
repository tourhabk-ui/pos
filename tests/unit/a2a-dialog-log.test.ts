/**
 * Журнал общения A2A (решение владельца 13.10: «заведем журнал общения для
 * A2A»; миграция 1225, lib/a2a/dialog-log).
 *
 * Повод — строки журнала запросов от незнакомых агентов (TaifoonHarvester,
 * brick.blue-proxy): кто пришёл, было видно, а что спросили и что Кузьмич
 * ответил — нет. Сторож держит связку целиком:
 *
 * 1. Писатель: телефоны и почты вычищены ДО записи, длина ограничена; сырых
 *    IP, User-Agent и contextId в параметрах нет; старше RETENTION_DAYS
 *    удаляется перед каждой записью, окно — параметром, без склейки строк.
 * 2. Отказ записи назван в логе с SQLSTATE, ответ агенту не страдает.
 * 3. Текстовый путь A2A пишет реплику после ответа Кузьмича — вопрос, ответ,
 *    исход, номер реплики; отказ по лимиту адреса НЕ пишется.
 * 4. Миграция: текст есть, сырых заголовков нет; журнал запросов (1219)
 *    по-прежнему без текста.
 * 5. Страница показывает карточку «Журнал общения» и её отказ — отказом.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const { query, answerAgentMessage, runPublicTool } = vi.hoisted(() => ({
  query: vi.fn(),
  answerAgentMessage: vi.fn(),
  runPublicTool: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/a2a/chat', () => ({ answerAgentMessage }));
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool }));

import { logA2aDialog, dialogText, RETENTION_DAYS, QUESTION_MAX, ANSWER_MAX } from '@/lib/a2a/dialog-log';
import { contextKey } from '@/lib/a2a/journal';
import { buildExecutors, CHAT_RATE_LIMITED_TEXT } from '@/app/api/a2a/_shared';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const flush = () => new Promise((r) => setTimeout(r, 0));

function inserts(): Array<{ sql: string; params: unknown[] }> {
  return query.mock.calls
    .filter((c) => /INSERT INTO a2a_dialogs/.test(String(c[0])))
    .map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }));
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  answerAgentMessage.mockReset();
  answerAgentMessage.mockResolvedValue({ ok: true, text: 'На Горелом ветер 12 м/с, перевал открыт.' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('писатель журнала общения', () => {
  it('телефоны и почты вычищены до записи, длина ограничена', () => {
    expect(dialogText('Иван, +7 914 111-22-33, ivan@mail.ru, группа 12 человек', 200))
      .toBe('Иван, [телефон], [email], группа 12 человек');
    expect(dialogText('x'.repeat(QUESTION_MAX + 50), QUESTION_MAX)).toHaveLength(QUESTION_MAX);
    expect(dialogText('  ответ  ', ANSWER_MAX)).toBe('ответ');
  });

  it('INSERT: фиксированные колонки, текст вычищен, вместо contextId — hash; IP и заголовка целиком нет', async () => {
    logA2aDialog({
      question: 'Позвоните +79141112233, что на Горелом?',
      answer: 'Пишите на guide@example.com',
      state: 'completed',
      contextId: 'ctx-secret',
      turn: 2,
      durationMs: 8085.4,
      ip: '203.0.113.7',
      userAgent: 'brick.blue-proxy/1.0 (+https://brick.blue)',
      self: false,
    });
    await flush();
    const [ins] = inserts();
    expect(ins).toBeDefined();
    expect(ins!.sql).toMatch(/\(agent, ua_family, caller_hash, context_key, turn, question, answer, state, duration_ms, is_self\)/);
    const p = ins!.params;
    expect(p[0]).toBe('brick.blue-proxy');
    expect(p[3]).toBe(contextKey('ctx-secret'));
    expect(p[4]).toBe(2);
    expect(p[5]).toBe('Позвоните [телефон], что на Горелом?');
    expect(p[6]).toBe('Пишите на [email]');
    expect(p[7]).toBe('completed');
    expect(p[8]).toBe(8085);
    const flat = JSON.stringify(p);
    expect(flat).not.toMatch(/203\.0\.113|ctx-secret|brick\.blue\)|79141112233|guide@/);
  });

  it(`старше ${RETENTION_DAYS} суток удаляется ПЕРЕД каждой записью; окно — параметром`, async () => {
    logA2aDialog({ question: 'q', answer: 'a', state: 'failed', turn: 1, ip: '', userAgent: '', self: false });
    await flush();
    const sqls = query.mock.calls.map((c) => String(c[0]));
    const del = sqls.findIndex((s) => /DELETE FROM a2a_dialogs/.test(s));
    const ins = sqls.findIndex((s) => /INSERT INTO a2a_dialogs/.test(s));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(del).toBeLessThan(ins);
    expect(sqls[del]).toContain("created_at < NOW() - ($1::int * INTERVAL '1 day')");
    expect(query.mock.calls[del]![1]).toEqual([RETENTION_DAYS]);
  });

  it('отказ записи — в лог с SQLSTATE, наружу не бросает; отказ уборки не отменяет запись', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql: unknown) => {
      if (/DELETE FROM a2a_dialogs/.test(String(sql))) throw Object.assign(new Error('lock timeout'), { code: '55P03' });
      throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    });
    expect(() => logA2aDialog({ question: 'q', answer: 'a', state: 'completed', turn: 1, ip: '', userAgent: '', self: false })).not.toThrow();
    await flush();
    await flush();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[a2a-dialog] уборка'), 'SQLSTATE=55P03', expect.any(String));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[a2a-dialog] разговор не записан'), 'SQLSTATE=42P01', expect.any(String));
  });
});

describe('текстовый путь A2A пишет разговор', () => {
  let n = 0;
  const request = (ua = 'TaifoonHarvester/0.1') => {
    n += 1;
    return new NextRequest('http://localhost/api/a2a', { headers: { 'x-real-ip': `10.77.0.${n}`, 'user-agent': ua } });
  };

  it('после ответа Кузьмича — вопрос, ответ, исход и номер реплики', async () => {
    const ex = buildExecutors(request());
    const out = await ex.chat('Что на Горелом?', [
      { role: 'user', content: 'Привет' }, { role: 'assistant', content: 'Слушаю' },
    ], 'ctx-1');
    expect(out.ok).toBe(true);
    await flush();
    const [ins] = inserts();
    expect(ins!.params[0]).toBe('TaifoonHarvester');
    expect(ins!.params[3]).toBe(contextKey('ctx-1'));
    expect(ins!.params[4]).toBe(2);
    expect(ins!.params[5]).toBe('Что на Горелом?');
    expect(ins!.params[6]).toBe('На Горелом ветер 12 м/с, перевал открыт.');
    expect(ins!.params[7]).toBe('completed');
  });

  it('сбой модели пишется как failed с текстом отказа', async () => {
    answerAgentMessage.mockResolvedValue({ ok: false, text: 'Кузьмич сейчас не смог ответить' });
    await buildExecutors(request()).chat('Погода?', [], 'ctx-2');
    await flush();
    expect(inserts()[0]!.params[7]).toBe('failed');
  });

  it('отказ по лимиту адреса в журнал общения не пишется', async () => {
    const ex = buildExecutors(request());
    for (let i = 0; i < 10; i += 1) await ex.chat(`вопрос ${i}`, [], 'ctx-3');
    const over = await ex.chat('одиннадцатый', [], 'ctx-3');
    expect(over).toMatchObject({ ok: false, text: CHAT_RATE_LIMITED_TEXT, rejected: true });
    await flush();
    expect(inserts()).toHaveLength(10);
    expect(JSON.stringify(inserts().map((i) => i.params))).not.toContain('одиннадцатый');
  });
});

describe('схема и страница', () => {
  it('миграция 1225: текст вопроса и ответа есть, сырых заголовков и адреса нет', () => {
    const sql = read('migrations/1225_a2a_dialogs.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS a2a_dialogs/);
    // Конец оператора ищется ПОСЛЕ CREATE TABLE: в шапке миграции «);» встречается в тексте.
    const at = sql.indexOf('CREATE TABLE');
    const ddl = sql.slice(at, sql.indexOf(');', at)).replace(/--.*$/gm, '');
    expect(ddl).toMatch(/\bquestion\s+TEXT\b/);
    expect(ddl).toMatch(/\banswer\s+TEXT\b/);
    expect(ddl).not.toMatch(/user_agent|\bip\b|context_id|contextid/i);
    // Журнал запросов остаётся без текста: текст живёт только здесь.
    const journalDdl = read('migrations/1219_a2a_requests.sql');
    const jAt = journalDdl.indexOf('CREATE TABLE');
    expect(journalDdl.slice(jAt, journalDdl.indexOf(');', jAt)).replace(/--.*$/gm, '')).not.toMatch(/question|answer/);
  });

  it('писатель один — lib/a2a/dialog-log; обработчики A2A SQL не содержат', () => {
    expect(read('lib/a2a/dialog-log.ts').match(/INSERT INTO a2a_dialogs/g)).toHaveLength(1);
    expect(read('lib/a2a/dialog-log.ts')).toMatch(/redactPII/);
    expect(read('app/api/a2a/_shared.ts')).toMatch(/logA2aDialog\(/);
    for (const f of ['app/api/a2a/_shared.ts', 'lib/a2a/handle.ts', 'lib/a2a/journal.ts']) {
      expect(read(f), f).not.toMatch(/a2a_dialogs/);
    }
  });

  it('страница: карточка «Журнал общения», отказ чтения — отказом, ответ свёрнут', () => {
    const client = read('app/hub/admin/a2a/_A2aClient.tsx');
    expect(client).toMatch(/Журнал общения A2A/);
    expect(client).toMatch(/Журнал общения не прочитался/);
    expect(client).toMatch(/<details/);
    expect(client).not.toMatch(/FROM a2a_dialogs|pool\.query/);
    expect(read('app/api/admin/analytics/a2a/route.ts')).toMatch(/block\('dialogs', \(\) => readDialogs\(\)\)/);
  });
});
