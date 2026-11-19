/**
 * Числа суток в админке на настоящем PostgreSQL (слово владельца 22.10:
 * «нужна расшифровка по дням mcp кто звал чем интересовался при нажатии на
 * информационные кнопки с числами» и «в главной админской панели покажи
 * числа люди mcp и A2A и кол-во взаимодействий с Кузьмичем за сутки»).
 *
 * Судится то, что решает база, а мок ответил бы на любой SQL:
 *  - камчатские сутки: вызов в 23:59 по Камчатке — вчера, в 00:00 — сегодня;
 *  - люди: разные посетители без ботов и своих заходов;
 *  - MCP: без метки владельца и без проверок (соединение с mcp_clients по
 *    суточному ключу, как у числа на странице);
 *  - A2A: без чтения визитки, своих, реестра и проб — и SQL-правило совпадает
 *    с a2aAgentKind на тех же агентах;
 *  - Кузьмич: ответы по поверхностям, чужие записи журнала мимо;
 *  - отказ одного запроса — «не загрузилось» у одного числа, прочие стоят;
 *  - расшифровка MCP: программа, разных вызывающих, инструменты, темы,
 *    род вызова, исход, пропуск суток, хвост тем числом;
 *  - журнал ошибок прода: обрыв соединения узнаётся одинаково в SQL и в
 *    коде, в перепись ошибок, объектив эволюции и счёт сорванных броней не
 *    идёт (слово владельца 19.11 «1»);
 *  - попытки оценки Кузьмича: место под оценку отдаёт номер строки, исход
 *    пишется в неё же, перепись считает попытки по камчатским дням с исходами,
 *    строки до 19.11 — «не записан» (#3179, слово владельца 19.11 «1 да»).
 *
 * Своя база `admin_day_counts_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { a2aAgentKind } from '@/lib/a2a/agent-kind';
import type { TranslationOutcome } from '@/lib/ai/translate-text';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[admin-day-counts.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'admin_day_counts_test';

// 22.10 23:00 по Камчатке. Сегодня — с 21.10 12:00 UTC, вчера — с 20.10 12:00 UTC.
const NOW = new Date('2026-10-22T11:00:00Z');
const TODAY_AT = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 21, 12 + h, m)).toISOString();
const YESTERDAY_AT = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, 12 + h, m)).toISOString();

withPg('числа суток в админке', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    await pool.query('TRUNCATE page_views, mcp_tool_calls, mcp_clients, a2a_requests, ai_actions_log, a2a_dialogs, chat_sessions, tg_conversations CASCADE');

    const view = (at: string, hash: string, flags: { bot?: boolean; self?: boolean } = {}) =>
      pool.query(`INSERT INTO page_views (path, visitor_hash, created_at, is_bot, is_self) VALUES ('/', $1, $2, $3, $4)`,
        [hash, at, flags.bot ?? false, flags.self ?? false]);
    await view(TODAY_AT(0), 'vA');            // ровно полночь по Камчатке — сегодня
    await view(TODAY_AT(5), 'vA');
    await view(TODAY_AT(6), 'vB');
    await view(TODAY_AT(7), 'vBot', { bot: true });
    await view(TODAY_AT(8), 'vSelf', { self: true });
    await view(YESTERDAY_AT(23, 59), 'vC');   // 23:59 по Камчатке — вчера
    await view(YESTERDAY_AT(-1), 'vOld');     // позавчера — мимо

    // MCP: программа (суточный ключ), затем вызовы.
    const client = (hash: string, at: string, name: string | null, family: string | null) =>
      pool.query(`INSERT INTO mcp_clients (caller_hash, day, client_name, ua_family) VALUES ($1, ($2::timestamptz)::date, $3, $4)`,
        [hash, at, name, family]);
    const call = (hash: string, at: string, tool: string, o: { key?: string; value?: string; ok?: boolean; kind?: string; self?: boolean } = {}) =>
      pool.query(
        `INSERT INTO mcp_tool_calls (tool, ok, error_kind, caller_hash, created_at, is_self, arg_key, arg_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tool, o.ok ?? true, o.kind ?? null, hash, at, o.self ?? false, o.key ?? null, o.value ?? null],
      );
    await client('hClaude', TODAY_AT(1), 'claude-ai', 'other');
    await call('hClaude', TODAY_AT(1), 'get_place_info', { key: 'name', value: 'Мутновский' });
    await call('hClaude', TODAY_AT(2), 'get_place_info', { key: 'name', value: 'Мутновский' });
    await call('hClaude', TODAY_AT(3), 'get_weather', { key: 'place', value: 'Эссо' });
    await call('hClaude', TODAY_AT(4), 'create_lead', { key: 'name', ok: false, kind: 'refused' });
    await client('hCursor', TODAY_AT(2), null, 'node');
    await call('hCursor', TODAY_AT(2), 'get_tours', { key: 'query', value: 'рыбалка' });
    await call('hCursor', TODAY_AT(2, 30), 'get_tours', { ok: false, kind: 'execution' });
    await client('hSmoke', TODAY_AT(3), 'vedar-deploy-smoke', 'node');
    await call('hSmoke', TODAY_AT(3), 'safety_status');
    await client('hOwner', TODAY_AT(4), 'claude-ai', 'other');
    await call('hOwner', TODAY_AT(4), 'get_tours', { self: true });
    await call('hAnon', TODAY_AT(5), 'get_volcano_status', { key: 'volcano', value: 'Ключевская' }); // клиента не знаем
    await client('hYest', YESTERDAY_AT(23, 59), 'claude-ai', 'other');
    await call('hYest', YESTERDAY_AT(23, 59), 'search', { key: 'query', value: 'медведи' });
    // Хвост тем: у одной программы вчера 13 разных тем.
    await client('hMany', YESTERDAY_AT(10), 'many-topics', 'other');
    for (let i = 0; i < 13; i++) await call('hMany', YESTERDAY_AT(10, i), 'get_place_info', { key: 'name', value: `Место ${i}` });

    // A2A.
    const a2a = (at: string, agent: string, o: { family?: string; op?: string; self?: boolean; hash?: string } = {}) =>
      pool.query(
        `INSERT INTO a2a_requests (created_at, binding, op, version, ok, agent, ua_family, caller_hash, is_self)
         VALUES ($1, 'jsonrpc', $2, '1.0', TRUE, $3, $4, $5, $6)`,
        [at, o.op ?? 'SendMessage', agent, o.family ?? 'other', o.hash ?? `a-${agent}`, o.self ?? false],
      );
    await a2a(TODAY_AT(1), 'TravelAgent/2.1', { hash: 'aX' });
    await a2a(TODAY_AT(2), 'TravelAgent/2.1', { hash: 'aX', op: 'GetTask' });
    await a2a(TODAY_AT(2), 'TravelAgent/2.1', { hash: 'aX', op: 'card' });
    await a2a(TODAY_AT(3), 'A2A-Registry-TaskProbe/1.0');
    await a2a(TODAY_AT(3), 'agent-probe/0.1');
    // Своя проверка по имени (перепись 12.11): в счёт внешних не идёт.
    await a2a(TODAY_AT(3), 'vedar-eval', { hash: 'aE' });
    await a2a(TODAY_AT(3), 'curl/8.5', { family: 'curl' });
    await a2a(TODAY_AT(4), 'OwnerAgent/1', { self: true });
    await a2a(YESTERDAY_AT(12), 'OtherAgent/1', { hash: 'aY' });

    // Кузьмич.
    const answer = (at: string, surface: string | null, action = 'kuzmich_answer') =>
      pool.query(`INSERT INTO ai_actions_log (action_type, metadata, created_at) VALUES ($1, $2::jsonb, $3)`,
        [action, JSON.stringify(surface ? { surface } : {}), at]);
    await answer(TODAY_AT(1), 'web');
    await answer(TODAY_AT(2), 'web-stream');
    await answer(TODAY_AT(3), 'telegram');
    await answer(TODAY_AT(4), null);
    await answer(TODAY_AT(5), 'web', 'kuzmich_post');
    await answer(YESTERDAY_AT(20), 'widget');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('сводка суток: люди, MCP, A2A, Кузьмич — сегодня и вчера по Камчатке', async () => {
    const { readDaySummary } = await import('@/lib/analytics/day-summary');
    const s = await readDaySummary(NOW);
    expect({ today: s.today, yesterday: s.yesterday }).toEqual({ today: '2026-10-22', yesterday: '2026-10-21' });
    expect(s.people).toEqual({ ok: true, today: { visitors: 2, views: 3, bot_views: 1 }, yesterday: { visitors: 1, views: 1, bot_views: 0 } });
    // Внешние: claude-ai (4), node без имени (2), не представился (1); без смоука и своего.
    expect(s.mcp).toEqual({ ok: true, today: { calls: 7, callers: 3 }, yesterday: { calls: 14, callers: 2 } });
    expect(s.a2a).toEqual({ ok: true, today: { requests: 2, callers: 1 }, yesterday: { requests: 1, callers: 1 } });
    expect(s.kuzmich).toEqual({
      ok: true,
      today: { answers: 4, by_surface: { web: 1, 'web-stream': 1, telegram: 1, other: 1 } },
      yesterday: { answers: 1, by_surface: { widget: 1 } },
    });
  });

  it('A2A: правило SQL совпадает с a2aAgentKind на тех же агентах', async () => {
    const { A2A_EXTERNAL_PARAMS, a2aExternalSql } = await import('@/lib/a2a/agent-kind');
    const samples: Array<[string, string, boolean]> = [
      ['TravelAgent/2.1', 'other', false], ['A2A-Registry-TaskProbe/1.0', 'other', false],
      ['a2a-registry-smoke/1.0', 'other', false], ['agent-probe/0.1', 'other', false],
      ['TendleReview/1', 'other', false], ['curl/8.5', 'curl', false], ['OwnerAgent/1', 'other', true],
      ['Claude-User', 'browser', false],
      // Проверки по имени (перепись 12.11): образец ремесла их не узнаёт. Регистр не важен; похожее имя — не оно.
      ['vedar-eval', 'other', false], ['Vedar-Eval', 'other', false], ['vedar-evaluator', 'other', false],
      ['connectors-manager', 'node', false],
    ];
    const { rows } = await pool.query<{ i: number; ext: boolean }>(
      `SELECT v.i, ${a2aExternalSql('v', '$1', '$2', '$3')} AS ext
         FROM (SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(i int, agent text, ua_family text, is_self boolean)) v
        ORDER BY v.i`,
      [...A2A_EXTERNAL_PARAMS, JSON.stringify(samples.map(([agent, ua_family, is_self], i) => ({ i, agent, ua_family, is_self })))],
    );
    expect(rows.map((r) => r.ext)).toEqual(samples.map(([a, f, self]) => a2aAgentKind(a, f, self) === 'external'));
    // Правило не выродилось: свой экзамен — проверка, чужое похожее имя — внешний.
    expect(a2aAgentKind('vedar-eval', 'other', false)).toBe('probe');
    expect(a2aAgentKind('Vedar-Eval', 'other', false)).toBe('probe');
    expect(a2aAgentKind('vedar-evaluator', 'other', false)).toBe('external');
  });

  it('отказ одного запроса — «не загрузилось» у одного числа, остальные стоят', async () => {
    const { readDaySummary } = await import('@/lib/analytics/day-summary');
    await pool.query('ALTER TABLE a2a_requests RENAME TO a2a_requests_gone');
    try {
      const s = await readDaySummary(NOW);
      expect(s.a2a).toEqual({ ok: false, error: 'не загрузилось' });
      expect(s.people.ok && s.mcp.ok && s.kuzmich.ok).toBe(true);
    } finally {
      await pool.query('ALTER TABLE a2a_requests_gone RENAME TO a2a_requests');
    }
  });

  it('расшифровка «внешних сегодня»: кто звал, сколько разных, какими инструментами, о чём', async () => {
    const { readMcpBreakdown } = await import('@/lib/mcp/day-breakdown');
    const b = await readMcpBreakdown({ origin: 'external', outcome: 'all', days: 1, skip: 0 }, NOW);
    expect({ from: b.from, to: b.to }).toEqual({ from: '2026-10-22', to: '2026-10-22' });
    expect(b.days).toHaveLength(1);
    const d = b.days[0];
    expect({ day: d.day, calls: d.calls, callers: d.callers }).toEqual({ day: '2026-10-22', calls: 7, callers: 3 });
    expect(d.clients.map((c) => [c.client, c.kind, c.calls, c.callers])).toEqual([
      ['claude-ai', 'представился', 4, 1],
      ['node', 'по заголовку', 2, 1],
      ['не представился', 'неизвестно', 1, 1],
    ]);
    const claude = d.clients[0];
    expect(claude.tools).toEqual([{ tool: 'get_place_info', calls: 2 }, { tool: 'create_lead', calls: 1 }, { tool: 'get_weather', calls: 1 }]);
    expect(claude.topics[0]).toEqual({ tool: 'get_place_info', key: 'name', value: 'Мутновский', n: 2 });
    expect(claude.topics).toContainEqual({ tool: 'create_lead', key: 'name', value: null, n: 1 });
    expect({ failures: claude.failures, refusals: claude.refusals }).toEqual({ failures: 0, refusals: 1 });
    expect(d.clients[1]).toMatchObject({ failures: 1, refusals: 0 });
    expect(d.clients.every((c) => c.origin === 'external')).toBe(true);
  });

  it('свои и проверки — отдельно и с родом; вчера — по пропуску суток; хвост тем — числом', async () => {
    const { readMcpBreakdown, TOPICS_PER_CLIENT } = await import('@/lib/mcp/day-breakdown');
    const own = await readMcpBreakdown({ origin: 'own', outcome: 'all', days: 1, skip: 0 }, NOW);
    expect(own.days[0].clients.map((c) => [c.client, c.origin])).toEqual([['claude-ai', 'self'], ['vedar-deploy-smoke', 'probe']]);
    const self = await readMcpBreakdown({ origin: 'self', outcome: 'all', days: 1, skip: 0 }, NOW);
    expect(self.days[0].clients.map((c) => c.client)).toEqual(['claude-ai']);

    const y = await readMcpBreakdown({ origin: 'external', outcome: 'all', days: 1, skip: 1 }, NOW);
    expect(y.days.map((d) => d.day)).toEqual(['2026-10-21']);
    const many = y.days[0].clients.find((c) => c.client === 'many-topics')!;
    expect(many.topics).toHaveLength(TOPICS_PER_CLIENT);
    expect(many.topics_more).toBe(13 - TOPICS_PER_CLIENT);
    expect(y.days[0].clients.find((c) => c.client === 'claude-ai')?.topics).toEqual([{ tool: 'search', key: 'query', value: 'медведи', n: 1 }]);

    const both = await readMcpBreakdown({ origin: 'external', outcome: 'all', days: 2, skip: 0 }, NOW);
    expect(both.days.map((d) => d.day)).toEqual(['2026-10-22', '2026-10-21']);
  });

  it('исход: сбои и отказы — каждый своим списком', async () => {
    const { readMcpBreakdown } = await import('@/lib/mcp/day-breakdown');
    const fail = await readMcpBreakdown({ origin: 'external', outcome: 'failure', days: 1, skip: 0 }, NOW);
    expect(fail.days[0].clients.map((c) => [c.client, c.tools])).toEqual([['node', [{ tool: 'get_tours', calls: 1 }]]]);
    const refused = await readMcpBreakdown({ origin: 'external', outcome: 'refusal', days: 1, skip: 0 }, NOW);
    expect(refused.days[0].clients.map((c) => [c.client, c.tools])).toEqual([['claude-ai', [{ tool: 'create_lead', calls: 1 }]]]);
  });

  it('роуты: без админа — отказ; неверный параметр — 400 словами', async () => {
    const { GET } = await import('@/app/api/admin/analytics/mcp/breakdown/route');
    const { NextRequest } = await import('next/server');
    const anon = await GET(new NextRequest('http://localhost/api/admin/analytics/mcp/breakdown?days=1'));
    expect([401, 403]).toContain(anon.status);
    const { GET: SUMMARY } = await import('@/app/api/admin/analytics/day-summary/route');
    const anonSummary = await SUMMARY(new NextRequest('http://localhost/api/admin/analytics/day-summary'));
    expect([401, 403]).toContain(anonSummary.status);
  });

  it('«Переписки»: у каждого разговора вход — сайт, виджет с партнёром, проверка, TG, A2A с агентом', async () => {
    const { vi } = await import('vitest');
    vi.doMock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ userId: 'admin', role: 'admin' }) }));
    try {
      await pool.query(`INSERT INTO partners (name, slug, category, contact, contacts, is_public, status)
                        VALUES ('Камчатская рыбалка', 'fishingkam', 'operator', '{}'::jsonb, '{}'::jsonb, TRUE, 'active')`);
      const session = (id: string, n: number) => pool.query(
        `INSERT INTO chat_sessions (session_id, user_message_count, messages, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')`,
        [id, n, JSON.stringify([{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: 'ответ' }])],
      );
      await session('a1b2c3d4-guest', 2);
      await session('widget_fishingkam_abc123', 1);
      await session('safety-eval-1760900000000-benign-medkit', 1);
      await pool.query(`INSERT INTO tg_conversations (chat_id, mode, role, content, platform, user_name)
                        VALUES (171, 'tourist', 'user', 'привет', 'telegram', 'Иван'), (171, 'tourist', 'assistant', 'здравствуйте', 'telegram', NULL)`);
      const dialog = (key: string | null, turn: number, q: string, agent = 'TravelAgent/2.1', self = false) => pool.query(
        `INSERT INTO a2a_dialogs (agent, ua_family, caller_hash, context_key, turn, question, answer, state, is_self, created_at)
         VALUES ($1, 'other', 'h', $2, $3::int, $4, $5, 'completed', $6, NOW() - INTERVAL '10 minutes' + ($3::int * INTERVAL '1 minute'))
         RETURNING id`,
        [agent, key, turn, q, `ответ на «${q}»`, self],
      );
      await dialog('ctx-1', 1, 'Какая погода на Авачинском?');
      await dialog('ctx-1', 2, 'А завтра?');
      const lone = await dialog(null, 1, 'Туры на рыбалку', 'A2A-Registry-TaskProbe/1.0');

      // Переписка партнёра и WhatsApp: до 1314 их род не проходил CHECK, а
      // пустой catch в saveMsg глотал отказ — строк не было, и Кузьмич
      // партнёра не помнил прошлой реплики.
      const { saveMsg, getHistory } = await import('@/lib/kuzmich/core');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await saveMsg(501, 'operator_tg', 'user', 'сколько броней на субботу?', null, 'Оператор');
      await saveMsg(501, 'operator_tg', 'assistant', 'две', null, null);
      await saveMsg(502, 'whatsapp', 'user', 'есть туры на рыбалку?', null, 'Гость WA');
      await saveMsg(503, 'tourist', 'user', 'привет', null, 'Турист');
      await saveMsg(504, 'max', 'user', 'привет', null, 'Турист MAX');
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
      expect((await getHistory(501, 'operator_tg')).map((m) => [m.role, m.content]))
        .toEqual([['user', 'сколько броней на субботу?'], ['assistant', 'две']]);
      expect(await getHistory(502, 'whatsapp')).toHaveLength(1);

      const { GET } = await import('@/app/api/admin/ai-analytics/chats/route');
      const { NextRequest } = await import('next/server');
      const list = await (await GET(new NextRequest('http://localhost/api/admin/ai-analytics/chats'))).json();
      const web = Object.fromEntries(list.webChats.map((c: { sessionId: string; source: string; partner: string | null }) => [c.sessionId, [c.source, c.partner]]));
      expect(web).toEqual({
        'a1b2c3d4-guest': ['web', null],
        'widget_fishingkam_abc123': ['widget', 'Камчатская рыбалка'],
        'safety-eval-1760900000000-benign-medkit': ['probe', null],
      });
      const tg = (list.tgChats as Array<{ chatId: string; platform: string; userName: string; userMsgs: number; partnerChat: boolean }>)
        .map((c) => [c.chatId, c.platform, c.userName, c.userMsgs, c.partnerChat])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      expect(tg).toEqual([
        ['171', 'telegram', 'Иван', 1, false],
        ['501', 'telegram', 'Оператор', 1, true],
        ['502', 'whatsapp', 'Гость WA', 1, false],
        ['503', 'telegram', 'Турист', 1, false],
        ['504', 'max', 'Турист MAX', 1, false],
      ]);
      expect(list.a2aChats.map((c: { dialogKey: string; agent: string; kind: string; turns: number }) => [c.dialogKey, c.agent, c.kind, c.turns]))
        .toEqual([['ctx-1', 'TravelAgent/2.1', 'external', 2], [`row:${lone.rows[0].id}`, 'A2A-Registry-TaskProbe/1.0', 'registry', 1]]);

      const hist = await (await GET(new NextRequest('http://localhost/api/admin/ai-analytics/chats?chat_id=ctx-1&platform=a2a'))).json();
      expect(hist.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
        ['user', 'Какая погода на Авачинском?'], ['assistant', 'ответ на «Какая погода на Авачинском?»'],
        ['user', 'А завтра?'], ['assistant', 'ответ на «А завтра?»'],
      ]);
      const one = await (await GET(new NextRequest(`http://localhost/api/admin/ai-analytics/chats?chat_id=row:${lone.rows[0].id}&platform=a2a`))).json();
      expect(one.messages).toHaveLength(2);
    } finally {
      // Последний тест, который зовёт роуты: уже загруженные с подменой админа
      // дальше никто не зовёт; проверка «без админа — отказ» идёт раньше.
      vi.doUnmock('@/lib/auth/middleware');
    }
  });

  /**
   * Перевод реплик журнала общения A2A (миграция 1437; слово владельца 13.11:
   * «нужно кнопку в журнал добавить перевести, много китайцев подключилось»).
   * Судится то, что решает база: ограничения миграции, типы параметров записи,
   * «пишется только пустое поле» при гонке двух администраторов, уборка
   * строки вместе с переводом. Переводчик подставной: модель здесь не нужна.
   * Сцены стоят в этом файле, а не в своём: таблица та же, а новый pg-файл —
   * это ещё одна база на каждый прогон CI (сторож pg-tests-run-in-ci).
   */
  describe('перевод реплик журнала A2A', () => {
    const ZH_Q = '我们2个人，想11月17日去穆特诺夫斯基火山';
    const RU_Q = 'Нас 2 человека, хотим 17 ноября на Мутновский вулкан';
    const RU_A = 'На Мутновском 17 ноября ветер 12 м/с, перевал открыт.';
    const fake = (map: Record<string, string>) => async (text: string): Promise<TranslationOutcome> =>
      map[text] ? { status: 'translated', text: map[text], model: 'ai-quality' } : { status: 'not_needed' };
    const insert = async (question: string, answer: string, at = 'NOW()'): Promise<number> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO a2a_dialogs (agent, ua_family, caller_hash, turn, question, answer, state, created_at)
         VALUES ('DeerFlow', 'other', 'h', 1, $1, $2, 'completed', ${at}) RETURNING id`,
        [question, answer],
      );
      return Number(rows[0].id);
    };

    it('миграция 1437: пустой перевод и перевод без отметки база не принимает', async () => {
      const id = await insert(ZH_Q, RU_A);
      await expect(pool.query(`UPDATE a2a_dialogs SET question_ru = '  ', translated_at = NOW(), translation_model = 'x' WHERE id = $1`, [id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'a2a_dialogs_question_ru_not_blank' });
      await expect(pool.query(`UPDATE a2a_dialogs SET answer_ru = '', translated_at = NOW(), translation_model = 'x' WHERE id = $1`, [id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'a2a_dialogs_answer_ru_not_blank' });
      await expect(pool.query(`UPDATE a2a_dialogs SET question_ru = 'Перевод' WHERE id = $1`, [id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'a2a_dialogs_translation_stamped' });
    });

    it('перевод записан в строку, а повтор и чужой перевод его не затирают', async () => {
      const { translateDialog } = await import('@/lib/a2a/dialog-translate');
      const id = await insert(ZH_Q, RU_A);

      expect(await translateDialog(id, fake({ [ZH_Q]: RU_Q }))).toEqual({
        found: true, id, question: { status: 'translated', text: RU_Q }, answer: { status: 'not_needed' },
      });
      const first = await pool.query(`SELECT question_ru, answer_ru, translated_at, translation_model FROM a2a_dialogs WHERE id = $1`, [id]);
      expect(first.rows[0]).toMatchObject({ question_ru: RU_Q, answer_ru: null, translation_model: 'ai-quality' });
      expect(first.rows[0].translated_at).toBeInstanceOf(Date);

      // Повтор: перевод уже лежит — отдаётся он, даже если модель теперь сказала бы иначе.
      expect(await translateDialog(id, fake({ [ZH_Q]: 'Другой перевод' }))).toMatchObject({
        found: true, question: { status: 'stored', text: RU_Q },
      });

      // Гонка двух администраторов: наш перевод опоздал — в строке остаётся первый.
      const raced = await insert(ZH_Q, RU_A);
      const late = async (text: string): Promise<TranslationOutcome> => {
        if (text !== ZH_Q) return { status: 'not_needed' };
        await pool.query(`UPDATE a2a_dialogs SET question_ru = 'Перевод первого', translated_at = NOW(), translation_model = 'ai-quality' WHERE id = $1`, [raced]);
        return { status: 'translated', text: RU_Q, model: 'ai-quality' };
      };
      expect(await translateDialog(raced, late)).toMatchObject({ found: true, question: { status: 'stored', text: 'Перевод первого' } });
      const kept = await pool.query(`SELECT question_ru FROM a2a_dialogs WHERE id = $1`, [raced]);
      expect(kept.rows[0].question_ru).toBe('Перевод первого');
    });

    it('строки нет — «не найдено»; срез журнала отдаёт номер строки и перевод', async () => {
      const { translateDialog } = await import('@/lib/a2a/dialog-translate');
      expect(await translateDialog(9_000_000_000, fake({}))).toEqual({ found: false });

      const { readDialogs } = await import('@/app/api/admin/analytics/a2a/route');
      const { items } = await readDialogs();
      const done = items.find((d) => d.question_ru === RU_Q);
      expect(done).toMatchObject({ question: ZH_Q, question_ru: RU_Q, answer_ru: null, question_foreign: true, answer_foreign: false });
      expect(Number.isInteger(done!.id)).toBe(true);
    });

    it('уборка писателя удаляет старую строку вместе с переводом', async () => {
      const { translateDialog } = await import('@/lib/a2a/dialog-translate');
      const { logA2aDialog, RETENTION_DAYS } = await import('@/lib/a2a/dialog-log');
      const old = await insert(ZH_Q, RU_A, `NOW() - INTERVAL '${RETENTION_DAYS + 1} days'`);
      expect(await translateDialog(old, fake({ [ZH_Q]: RU_Q }))).toMatchObject({ found: true, question: { status: 'translated' } });
      logA2aDialog({ question: 'Что на Горелом сегодня?', answer: 'Ветер.', state: 'completed', turn: 1, ip: '127.0.0.1', userAgent: 'curl/8', self: false });
      // Запись журнала — fire-and-forget: ждём, пока новая реплика ляжет.
      let written = false;
      for (let i = 0; i < 50 && !written; i += 1) {
        const { rows } = await pool.query(`SELECT 1 FROM a2a_dialogs WHERE question = 'Что на Горелом сегодня?'`);
        written = rows.length > 0;
        if (!written) await new Promise((r) => setTimeout(r, 100));
      }
      expect(written).toBe(true);
      const { rows } = await pool.query(`SELECT 1 FROM a2a_dialogs WHERE id = $1`, [old]);
      expect(rows).toHaveLength(0);
    });
  });

  /**
   * Причина отказа задаче A2A (миграция 1438, слово владельца 13.11: заявки
   * агентов «отклонены по причине нет согласия… может, согласие не доходит?»).
   *
   * Судится то, что решает база: ограничения колонки, запись настоящим
   * писателем журнала (17-й параметр доходит до своей колонки), сводка по
   * причинам настоящим запросом среза.
   */
  describe('причина отказа в журнале A2A', () => {
    const row = (state: string | null, code: string | null, agent = 'ReasonBot') => pool.query(
      `INSERT INTO a2a_requests (binding, op, version, ok, input, tool, state, agent, ua_family, caller_hash, is_self, reject_code)
       VALUES ('jsonrpc', 'SendMessage', '1.0', TRUE, 'tool', 'create_booking_request', $1, $2, 'other', 'h', FALSE, $3)`,
      [state, agent, code],
    );

    it('ограничения: причина только у отклонённой задачи и только кодом', async () => {
      await expect(row('completed', 'no_consent')).rejects.toMatchObject({ code: '23514', constraint: 'a2a_requests_reject_code_only_rejected' });
      await expect(row('failed', 'no_consent')).rejects.toMatchObject({ code: '23514', constraint: 'a2a_requests_reject_code_only_rejected' });
      await expect(row(null, 'no_consent')).rejects.toMatchObject({ code: '23514', constraint: 'a2a_requests_reject_code_only_rejected' });
      for (const bad of ['Нет согласия', 'NO_CONSENT', 'no consent', '', 'invalid_args:Tour', 'a:b:c']) {
        await expect(row('rejected', bad), bad).rejects.toMatchObject({ code: '23514', constraint: 'a2a_requests_reject_code_shape' });
      }
      // Отказ без причины допустим: так лежат строки до миграции.
      await expect(row('rejected', null, 'OldBot')).resolves.toBeTruthy();
    });

    it('писатель журнала кладёт код в свою колонку; у выполненной задачи колонка пуста', async () => {
      const { logA2aRequest } = await import('@/lib/a2a/journal');
      const base = { binding: 'jsonrpc' as const, op: 'SendMessage' as const, version: '1.0', versionDeclared: true, ok: true, input: 'tool' as const, tool: 'create_booking_request', ip: '127.0.0.1', self: false };
      logA2aRequest({ ...base, state: 'rejected', rejectCode: 'no_consent', userAgent: 'ReasonBot/1' });
      logA2aRequest({ ...base, state: 'rejected', rejectCode: 'no_consent', userAgent: 'ReasonBot/1' });
      logA2aRequest({ ...base, state: 'rejected', rejectCode: 'invalid_args:tour', userAgent: 'OtherBot/2' });
      logA2aRequest({ ...base, state: 'rejected', rejectCode: 'Иван +79001234567', userAgent: 'OtherBot/2' });
      logA2aRequest({ ...base, state: 'completed', rejectCode: 'no_consent', userAgent: 'ReasonBot/1' });
      // Запись журнала — fire-and-forget: ждём, пока лягут все пять.
      let written = 0;
      for (let i = 0; i < 50 && written < 5; i += 1) {
        const { rows } = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM a2a_requests WHERE agent IN ('ReasonBot', 'OtherBot')`);
        written = rows[0].n;
        if (written < 5) await new Promise((r) => setTimeout(r, 100));
      }
      expect(written).toBe(5);
      const { rows } = await pool.query<{ agent: string; state: string; reject_code: string | null; n: number }>(
        `SELECT agent, state, reject_code, COUNT(*)::int AS n FROM a2a_requests
          WHERE agent IN ('ReasonBot', 'OtherBot') GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 NULLS LAST`,
      );
      expect(rows).toEqual([
        { agent: 'OtherBot', state: 'rejected', reject_code: 'invalid_args:tour', n: 1 },
        // Не код — «other»: ни имени, ни телефона в колонке нет.
        { agent: 'OtherBot', state: 'rejected', reject_code: 'other', n: 1 },
        { agent: 'ReasonBot', state: 'completed', reject_code: null, n: 1 },
        { agent: 'ReasonBot', state: 'rejected', reject_code: 'no_consent', n: 2 },
      ]);
    });

    it('срез журнала: отказы по причинам с числами и словами; сумма равна отказам по агентам', async () => {
      const { readA2a } = await import('@/app/api/admin/analytics/a2a/route');
      const a2a = await readA2a(7);
      const mine = a2a.by_reason.filter((r) => r.tool === 'create_booking_request');
      expect(mine).toEqual([
        { code: 'no_consent', tool: 'create_booking_request', tasks: 2, agents: 1, label: 'нет согласия человека на обработку данных' },
        { code: 'invalid_args:tour', tool: 'create_booking_request', tasks: 1, agents: 1, label: 'не то в поле tour' },
        { code: 'other', tool: 'create_booking_request', tasks: 1, agents: 1, label: 'причина записана не кодом' },
        { code: null, tool: 'create_booking_request', tasks: 1, agents: 1, label: 'причина не записана' },
      ]);
      const byReason = a2a.by_reason.reduce((s, r) => s + r.tasks, 0);
      const byAgent = a2a.by_agent.reduce((s, r) => s + r.rejected, 0);
      expect(byReason).toBe(byAgent);
      // Последние запросы несут причину словами только у отказа.
      const recent = a2a.recent.filter((r) => r.agent === 'ReasonBot');
      expect(recent.filter((r) => r.state === 'rejected').map((r) => r.reject_label)).toEqual(['нет согласия человека на обработку данных', 'нет согласия человека на обработку данных']);
      expect(recent.find((r) => r.state === 'completed')?.reject_label).toBeNull();
    });
  });
  // Слово владельца 19.11 «1»: обрыв соединения в журнале ошибок прода — не
  // «Прод 500». Правило в SQL и в коде одно (lib/server-errors/connection-abort),
  // и здесь оба судят одни и те же строки на настоящей базе.
  describe('обрыв соединения в журнале ошибок', () => {
    const MSG = 'controller[kState].transformAlgorithm is not a function';
    const FRAME2 = 'at node:internal/webstreams/transformstream:568:16';
    // Строка журнала прода 19.11 слово в слово (проверка прода, прогон 195).
    const STACK =
      'at transformStreamDefaultControllerPerformTransform (node:internal/webstreams/transformstream:527:37) | ' +
      `${FRAME2} | at process.processTicksAndRejections (node:internal/process/task_queues:103:5)`;
    const log = (route: string, message: string, stack: string | null) => pool.query(
      `INSERT INTO ai_actions_log (action_type, metadata, created_at)
       VALUES ('server_error', $1::jsonb, NOW() - INTERVAL '1 hour')`,
      [JSON.stringify({ route, message, stack, method: 'GET', kind: 'render' })],
    );
    const saved = process.env.CRON_SECRET;

    beforeAll(async () => {
      process.env.CRON_SECRET = 'cron-pg-test';
      await pool.query(`DELETE FROM ai_actions_log WHERE action_type = 'server_error'`);
      await log('/map', MSG, STACK);
      await log('/map', MSG, `  ${STACK}`);
      await log('/catalog', MSG, STACK);
      await log('/map', 'Cannot read properties of undefined (reading x)', 'at Page (/app/.next/server/app/map/page.js:1:2)');
      await log('/routes/[id]', MSG, STACK.replace(FRAME2, 'at renderPage (/app/.next/server/chunks/1.js:1:2)'));
      await log('/places/[id]', MSG, STACK.replace(FRAME2, 'at /app/.next/server/app/places/page.js:1:1'));
      await log('/tours', MSG, null);
      await log('/weather', MSG, STACK.replace(FRAME2, 'at node:internal/x (/app/lib/stream.js:1:1)'));
      await log('/api/hub/bookings/create', MSG, STACK);
      await log('/api/hub/bookings/create', 'duplicate key', 'at create (/app/.next/server/app/api/hub/bookings/create/route.js:1:1)');
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    });

    it('правило SQL совпадает с правилом кода на каждой строке', async () => {
      const { CONNECTION_ABORT_SQL, isConnectionAbort } = await import('@/lib/server-errors/connection-abort');
      const { rows } = await pool.query<{ route: string; m: string | null; s: string | null; a: boolean }>(
        `SELECT metadata->>'route' AS route, metadata->>'message' AS m, metadata->>'stack' AS s,
                ${CONNECTION_ABORT_SQL} AS a
           FROM ai_actions_log WHERE action_type = 'server_error'`,
      );
      expect(rows).toHaveLength(10);
      for (const r of rows) expect(r.a, `${r.route}: ${r.s}`).toBe(isConnectionAbort(r.m, r.s));
      expect(rows.filter((r) => r.a).map((r) => r.route).sort())
        .toEqual(['/api/hub/bookings/create', '/catalog', '/map', '/map']);
    });

    it('перепись: обрывы своим списком, в счёт ошибок не входят', async () => {
      const { GET } = await import('@/app/api/cron/prod-errors/route');
      const { NextRequest } = await import('next/server');
      const body = await (await GET(new NextRequest('http://localhost/api/cron/prod-errors?hours=25', {
        headers: { Authorization: 'Bearer cron-pg-test' },
      }))).json() as {
        ok: boolean; total: number; errors: Array<{ route: string; n: number }>;
        connection_aborts: Array<{ route: string; n: number }>; connection_aborts_total: number;
      };
      expect(body.ok).toBe(true);
      const byRoute = (list: Array<{ route: string; n: number }>) =>
        Object.fromEntries(list.map((r) => [r.route, r.n]));
      expect(byRoute(body.errors)).toEqual({
        '/map': 1, '/routes/[id]': 1, '/places/[id]': 1, '/tours': 1, '/weather': 1, '/api/hub/bookings/create': 1,
      });
      expect(byRoute(body.connection_aborts)).toEqual({ '/map': 2, '/catalog': 1, '/api/hub/bookings/create': 1 });
      expect(body.total).toBe(6);
      expect(body.connection_aborts_total).toBe(4);
    });

    it('объектив эволюции: находки «Прод 500» из обрывов нет', async () => {
      const { scanProdErrors } = await import('@/lib/agents/evo/growth-agent');
      const found = await scanProdErrors();
      const titles = Object.fromEntries(found.map((f) => [f.title, f.description]));
      expect(Object.keys(titles).sort()).toEqual([
        'Прод 500: /api/hub/bookings/create', 'Прод 500: /map', 'Прод 500: /places/[id]',
        'Прод 500: /routes/[id]', 'Прод 500: /tours', 'Прод 500: /weather',
      ]);
      expect(titles['Прод 500: /map']).toContain('За сутки 1 серверных ошибок');
      // Модуль объектива большой: первый импорт на холодном раннере дольше 5 с.
    }, 60_000);

    it('перепись попыток брони: обрыв — не сорванная попытка', async () => {
      const { GET } = await import('@/app/api/cron/booking-attempts/route');
      const { NextRequest } = await import('next/server');
      const body = await (await GET(new NextRequest('http://localhost/api/cron/booking-attempts?days=7', {
        headers: { Authorization: 'Bearer cron-pg-test' },
      }))).json() as { failed_500_total: number | null; failed_with_500: Array<{ route: string; n: number }> | null };
      expect(body.failed_500_total).toBe(1);
      expect(body.failed_with_500).toEqual([expect.objectContaining({ route: '/api/hub/bookings/create', n: 1 })]);
    }, 30_000);
  });

  // #3179, слово владельца 19.11 «1 да»: сколько раз звали оценщика и чем это
  // кончилось. SQL берётся из исходника и исполняется здесь же.
  describe('попытки оценки Кузьмича', () => {
    const saved = process.env.CRON_SECRET;
    beforeAll(() => { process.env.CRON_SECRET = 'cron-pg-test'; });
    afterAll(() => {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    });

    it('место отдаёт номер строки, исход ложится в неё, перепись считает по дням', async () => {
      const { TAKE_GRADE_SLOT_SQL, GRADE_SLOT_LOCK_SQL, MARK_GRADE_RESULT_SQL } = await import('@/lib/agents/managed/kuzmich-outcomes');
      await pool.query(`DELETE FROM ai_actions_log WHERE action_type = 'kuzmich_grade'`);
      // Строка до 19.11: места занимались и раньше, исхода у них нет.
      await pool.query(`INSERT INTO ai_actions_log (action_type, metadata, created_at)
                        VALUES ('kuzmich_grade', '{"surface":"web"}'::jsonb, NOW() - INTERVAL '3 days')`);
      const take = async (cap: number) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(GRADE_SLOT_LOCK_SQL);
          const r = await c.query<{ id: string }>(TAKE_GRADE_SLOT_SQL, [JSON.stringify({ surface: 'max' }), cap]);
          await c.query('COMMIT');
          return r;
        } finally { c.release(); }
      };
      const a = await take(2);
      const b = await take(2);
      const over = await take(2);
      expect([a.rowCount, b.rowCount, over.rowCount]).toEqual([1, 1, 0]);
      expect(over.rows).toEqual([]);
      const idA = a.rows[0]!.id;
      const idB = b.rows[0]!.id;
      expect(idA).not.toBe(idB);

      await pool.query(MARK_GRADE_RESULT_SQL, [idA, 'saved']);
      await pool.query(MARK_GRADE_RESULT_SQL, [idB, 'judge_no_json']);
      // Чужая строка журнала с тем же номером рода не меняется.
      const other = await pool.query<{ id: string }>(`INSERT INTO ai_actions_log (action_type, metadata) VALUES ('server_error', '{}'::jsonb) RETURNING id`);
      const miss = await pool.query(MARK_GRADE_RESULT_SQL, [other.rows[0]!.id, 'saved']);
      expect(miss.rowCount).toBe(0);
      const { rows: marked } = await pool.query<{ id: string; metadata: Record<string, unknown> }>(
        `SELECT id::text, metadata FROM ai_actions_log WHERE id = ANY($1::bigint[]) ORDER BY id`, [[idA, idB]]);
      expect(marked.map((r) => r.metadata)).toEqual([
        { surface: 'max', result: 'saved' },
        { surface: 'max', result: 'judge_no_json' },
      ]);

      const { GET } = await import('@/app/api/cron/kuzmich-quality-census/route');
      const { NextRequest } = await import('next/server');
      const body = await (await GET(new NextRequest('http://localhost/api/cron/kuzmich-quality-census?days=7', {
        headers: { Authorization: 'Bearer cron-pg-test' },
      }))).json() as { ok: boolean; attempts_total: number; attempts_by_day: Array<Record<string, number | string>> };
      expect(body.ok).toBe(true);
      expect(body.attempts_total).toBe(3);
      expect(body.attempts_by_day).toHaveLength(2);
      const [today, older] = body.attempts_by_day;
      expect(today).toMatchObject({ attempts: 2, saved: 1, judge_no_answer: 1, good_not_saved: 0, failed: 0, not_recorded: 0 });
      expect(older).toMatchObject({ attempts: 1, saved: 0, not_recorded: 1 });
      expect(String(today.day) > String(older.day)).toBe(true);
      const { rows: [kam] } = await pool.query<{ d: string }>(
        `SELECT to_char((NOW() AT TIME ZONE 'Asia/Kamchatka')::date, 'YYYY-MM-DD') AS d`);
      expect(today.day).toBe(kam.d);
    }, 30_000);
  });

  // Слово владельца 19.11 «у судьи баланса нет возьми на себя его работу пока»:
  // выгрузка диалогов для оценки вместо судьи. Запросы — из исходника роута,
  // на схеме из миграций; тексты наружу — только шифром.
  describe('диалоги Кузьмича для оценки вместо судьи', () => {
    const saved = process.env.CRON_SECRET;
    beforeAll(() => { process.env.CRON_SECRET = 'cron-pg-test'; });
    afterAll(() => {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    });

    it('веб-чат без виджета и завершённый A2A за окно; старое, виджет и сбой — мимо', async () => {
      await pool.query('DELETE FROM chat_sessions');
      await pool.query('DELETE FROM a2a_dialogs');
      const msgs = (q: string, a: string) => JSON.stringify([{ role: 'user', content: q }, { role: 'assistant', content: a }]);
      await pool.query(
        `INSERT INTO chat_sessions (session_id, role, messages, updated_at, widget_origin) VALUES
           ('rv-web', 'tourist', $1::jsonb, NOW() - INTERVAL '1 day', NULL),
           ('rv-old', 'tourist', $2::jsonb, NOW() - INTERVAL '20 days', NULL),
           ('rv-widget', 'tourist', $3::jsonb, NOW() - INTERVAL '1 day', '{"host":"example.org"}'::jsonb)`,
        [msgs('Можно ли завтра на Горелый?', 'Завтра там ветер.'), msgs('старое', 'старый ответ'), msgs('виджет', 'ответ виджета')],
      );
      await pool.query(
        `INSERT INTO a2a_dialogs (agent, ua_family, caller_hash, context_key, turn, question, answer, state, created_at) VALUES
           ('TestAgent', 'other', 'h1', NULL, 1, 'volcano tours?', 'Туров к вулканам три.', 'completed', NOW() - INTERVAL '2 days'),
           ('TestAgent', 'other', 'h1', NULL, 2, 'second?', 'сбой', 'failed', NOW() - INTERVAL '2 days')`,
      );
      const { REVIEW_WEB_SQL, REVIEW_A2A_SQL } = await import('@/app/api/cron/kuzmich-review-batch/route');
      const web = await pool.query<{ day: string; role: string; messages: unknown }>(REVIEW_WEB_SQL, [7, 40]);
      expect(web.rows).toHaveLength(1);
      expect(web.rows[0]!.role).toBe('tourist');
      expect(Array.isArray(web.rows[0]!.messages)).toBe(true);
      expect(web.rows[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const a2a = await pool.query<{ agent: string; is_self: boolean; question: string }>(REVIEW_A2A_SQL, [7, 40]);
      expect(a2a.rows).toEqual([expect.objectContaining({ agent: 'TestAgent', is_self: false, question: 'volcano tours?' })]);
      // Предел — параметром.
      expect((await pool.query(REVIEW_WEB_SQL, [30, 1])).rows).toHaveLength(1);

      const { GET } = await import('@/app/api/cron/kuzmich-review-batch/route');
      const { NextRequest } = await import('next/server');
      const res = await GET(new NextRequest('http://localhost/api/cron/kuzmich-review-batch?days=7', {
        headers: { Authorization: 'Bearer cron-pg-test' },
      }));
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain('Горелый');
      expect(raw).not.toContain('Туров к вулканам');
      expect(JSON.parse(raw)).toMatchObject({ ok: true, web_sessions_read: 1, web_pairs: 1, a2a_read: 1, a2a_dialogs: 1 });
    }, 30_000);
  });
});
