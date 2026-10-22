/**
 * GET /api/admin/ai-analytics/chats
 * Список чатов Кузьмича с именами пользователей.
 * GET /api/admin/ai-analytics/chats?chat_id=X&platform=telegram — сообщения конкретного чата
 * GET /api/admin/ai-analytics/chats?chat_id=X&platform=a2a — диалог A2A по ключу контекста
 *
 * Вход у каждого разговора (вопрос владельца 22.10: «кузьмич вчера 3 ответа а в
 * переписках нету кто откуда»). Ответы Кузьмича считаются на семи входах
 * (lib/kuzmich/answer-timing), а список читал два места хранения и называл всё,
 * что в chat_sessions, «Сайтом»: виджет партнёра и прогон проверки безопасности
 * выглядели гостями сайта, а разговоры A2A (a2a_dialogs) не показывались вовсе.
 * Род веб-сессии — по её id: `widget_<slug партнёра>_…` пишет виджет
 * (app/api/widget/chat), `safety-eval-…` — еженедельная проверка
 * (scripts/kuzmich-safety-eval.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { a2aAgentKind } from '@/lib/a2a/agent-kind';
import { webChatSource } from '@/lib/kuzmich/chat-source';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (auth instanceof NextResponse) return auth;

    const { searchParams } = new URL(req.url);
    const chatId   = searchParams.get('chat_id');
    const platform = searchParams.get('platform');
    const days     = parseInt(searchParams.get('days') ?? '30', 10);

    // ── Конкретный чат: история сообщений ────────────────────────────────────
    if (chatId && platform === 'a2a') {
      // Ключ — context_key диалога; у вопроса без контекста — `row:<id>`.
      const byRow = /^row:(\d+)$/.exec(chatId);
      const { rows } = await pool.query<{ question: string; answer: string; created_at: string }>(
        `SELECT question, answer, created_at::text
           FROM a2a_dialogs
          WHERE ${byRow ? 'id = $1::bigint' : 'context_key = $1'}
          ORDER BY created_at ASC, turn ASC
          LIMIT 100`,
        [byRow ? byRow[1] : chatId],
      );
      return NextResponse.json({
        messages: rows.flatMap((r) => [
          { role: 'user', content: r.question, created_at: r.created_at },
          { role: 'assistant', content: r.answer, created_at: r.created_at },
        ]),
      });
    }
    if (chatId) {
      // Веб-чат: сообщения хранятся в JSON массиве в chat_sessions
      if (!platform || platform === 'web') {
        const { rows } = await pool.query<{
          messages: unknown;
          updated_at: string;
        }>(`
          SELECT messages, updated_at::text
          FROM chat_sessions
          WHERE session_id = $1
          LIMIT 1
        `, [chatId]);

        if (rows.length === 0) {
          return NextResponse.json({ messages: [] });
        }

        // messages — JSON массив [{role, content, created_at}, ...]
        const raw = rows[0].messages;
        let msgs: Array<{ role: string; content: string; created_at: string }> = [];
        if (Array.isArray(raw)) {
          msgs = raw.map((m: Record<string, unknown>) => ({
            role: (m.role as string | undefined) ?? 'user',
            content: (m.content as string | undefined) ?? '',
            created_at: (m.created_at as string | undefined) ?? rows[0].updated_at,
          }));
        }
        return NextResponse.json({ messages: msgs });
      }

      // Telegram / Max: сообщения в tg_conversations
      const { rows } = await pool.query<{
        role: string;
        content: string;
        created_at: string;
      }>(`
        SELECT role, content, created_at::text
        FROM tg_conversations
        WHERE chat_id = $1
          AND platform = $2
        ORDER BY created_at ASC
        LIMIT 200
      `, [chatId, platform]);

      return NextResponse.json({ messages: rows });
    }

    // ── Список чатов Telegram + Max ───────────────────────────────────────────
    const { rows: tgChats } = await pool.query<{
      chat_id: string;
      platform: string;
      user_name: string | null;
      user_msgs: string;
      total_msgs: string;
      first_msg: string;
      last_msg: string;
    }>(`
      SELECT
        chat_id::text,
        platform,
        MAX(user_name)                                      AS user_name,
        COUNT(*) FILTER (WHERE role = 'user')::text         AS user_msgs,
        COUNT(*)::text                                      AS total_msgs,
        MIN(created_at)::text                               AS first_msg,
        MAX(created_at)::text                               AS last_msg
      FROM tg_conversations
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY chat_id, platform
      ORDER BY MAX(created_at) DESC
      LIMIT 100
    `, [days]);

    // ── Список веб-сессий ────────────────────────────────────────────────────
    //
    // referrer_source / utm_source (миграция 136) добавлены сюда 03.09:
    // владелец, разбирая живую переписку гостя про Авачинский, спросил
    // «кто тестировал» — и не смог ответить сам, потому что sessionId
    // приходил в этом же ответе, но нигде не рендерился. Различить «реальный
    // турист» и «свои потыкали виджет» по данным всё равно нельзя (IP не
    // пишем), но источник перехода — уже что-то, и раньше он был виден
    // только прямым запросом к БД.
    const { rows: webChats } = await pool.query<{
      session_id: string;
      user_id: string | null;
      user_message_count: string;
      is_authenticated: boolean;
      created_at: string;
      updated_at: string;
      referrer_source: string | null;
      utm_source: string | null;
      widget_partner: string | null;
    }>(`
      SELECT
        cs.session_id,
        cs.user_id::text,
        cs.user_message_count::text,
        cs.is_authenticated,
        cs.created_at::text,
        cs.updated_at::text,
        cs.referrer_source,
        cs.utm_source,
        wp.name AS widget_partner
      FROM chat_sessions cs
      LEFT JOIN LATERAL (
        SELECT p.name FROM partners p
         WHERE p.slug IS NOT NULL AND cs.session_id LIKE 'widget\\_' || p.slug || '\\_%'
         ORDER BY length(p.slug) DESC
         LIMIT 1
      ) wp ON cs.session_id LIKE 'widget\\_%'
      WHERE cs.created_at >= NOW() - INTERVAL '1 day' * $1
      ORDER BY cs.updated_at DESC
      LIMIT 100
    `, [days]);

    // ── Диалоги A2A (агенты, a2a_dialogs; вопросы и ответы — после redactPII) ──
    const { rows: a2aChats } = await pool.query<{
      dialog_key: string;
      agent: string;
      ua_family: string;
      is_self: boolean;
      turns: number;
      first_msg: string;
      last_msg: string;
    }>(`
      SELECT COALESCE(context_key, 'row:' || MIN(id)::text) AS dialog_key,
             MAX(agent) AS agent, MAX(ua_family) AS ua_family, BOOL_OR(is_self) AS is_self,
             COUNT(*)::int AS turns,
             MIN(created_at)::text AS first_msg,
             MAX(created_at)::text AS last_msg
        FROM a2a_dialogs
       WHERE created_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY context_key, CASE WHEN context_key IS NULL THEN id END
       ORDER BY MAX(created_at) DESC
       LIMIT 100
    `, [days]);

    return NextResponse.json({
      tgChats: tgChats.map(r => ({
        chatId:    r.chat_id,
        platform:  r.platform,
        userName:  r.user_name ?? '—',
        userMsgs:  parseInt(r.user_msgs, 10),
        totalMsgs: parseInt(r.total_msgs, 10),
        firstMsg:  r.first_msg,
        lastMsg:   r.last_msg,
      })),
      webChats: webChats.map(r => ({
        sessionId:      r.session_id,
        userId:         r.user_id,
        userMsgs:       parseInt(r.user_message_count, 10),
        authenticated:  r.is_authenticated,
        createdAt:      r.created_at,
        updatedAt:      r.updated_at,
        referrerSource: r.referrer_source,
        utmSource:      r.utm_source,
        source:         webChatSource(r.session_id),
        partner:        r.widget_partner,
      })),
      a2aChats: a2aChats.map(r => ({
        dialogKey: r.dialog_key,
        agent:     r.agent,
        kind:      a2aAgentKind(r.agent, r.ua_family, r.is_self),
        turns:     r.turns,
        firstMsg:  r.first_msg,
        lastMsg:   r.last_msg,
      })),
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
