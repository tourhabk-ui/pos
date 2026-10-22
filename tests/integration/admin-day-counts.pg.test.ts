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
 *    род вызова, исход, пропуск суток, хвост тем числом.
 *
 * Своя база `admin_day_counts_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { a2aAgentKind } from '@/lib/a2a/agent-kind';

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
    ];
    const { rows } = await pool.query<{ i: number; ext: boolean }>(
      `SELECT v.i, ${a2aExternalSql('v', '$1', '$2')} AS ext
         FROM (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(i int, agent text, ua_family text, is_self boolean)) v
        ORDER BY v.i`,
      [...A2A_EXTERNAL_PARAMS, JSON.stringify(samples.map(([agent, ua_family, is_self], i) => ({ i, agent, ua_family, is_self })))],
    );
    expect(rows.map((r) => r.ext)).toEqual(samples.map(([a, f, self]) => a2aAgentKind(a, f, self) === 'external'));
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
      // Тест последний в файле: роуты, уже загруженные с подменой админа,
      // дальше никто не зовёт; проверка «без админа — отказ» идёт раньше.
      vi.doUnmock('@/lib/auth/middleware');
    }
  });
});
