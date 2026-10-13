/**
 * Общее для двух биндингов A2A (JSON-RPC в ./route.ts, HTTP+JSON в ./v1):
 * версия из заголовка, исполнители и CORS. Не роут (без HTTP-методов).
 *
 * Исполнение инструмента — ровно то же, что у MCP `tools/call`
 * (runPublicTool): лимиты, журнал mcp_tool_calls, стражи записи, ссылка
 * «продолжить в Ведаре». Один мозг — три протокола (чат, MCP, A2A).
 *
 * Свободный текст идёт к Кузьмичу (lib/a2a/chat) под своим лимитом: каждый
 * такой вопрос — вызов модели, и анонимный агент не должен уметь жечь его
 * бесконечно. Чтение инструментов — 30 в минуту на адрес (как MCP), текст —
 * 10 в минуту.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runPublicTool } from '@/app/api/mcp/route';
import { answerAgentMessage } from '@/lib/a2a/chat';
import type { A2AExecutors, A2AResult } from '@/lib/a2a/handle';
import { logA2aRequest, sendMessageFacts, type A2aBinding, type A2aJournalOp } from '@/lib/a2a/journal';
import { logA2aDialog } from '@/lib/a2a/dialog-log';
import { readVersion, type VersionRead } from '@/lib/a2a/wire';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { isSelfMcpCaller } from '@/lib/analytics/self-visit';
import { getPublicBaseUrl } from '@/lib/config';

const chatLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

export const CHAT_RATE_LIMITED_TEXT = 'Слишком много вопросов с этого адреса — подождите минуту и повторите.';

export function buildExecutors(request: NextRequest): A2AExecutors {
  // IP — из заголовка прокси (x-real-ip), не из X-Forwarded-For: тот пишет
  // сам клиент (сверка MCP 29.09).
  const ip = getTrustedClientIp(request.headers);
  const userAgent = request.headers.get('user-agent') ?? '';
  // Свой клиент (метка владельца в адресе) — вне счёта спроса, как у MCP.
  const self = isSelfMcpCaller(request.nextUrl);
  return {
    runTool: (toolName, rawArguments) => runPublicTool({ toolName, rawArguments, ip, userAgent, self }),
    chat: async (text, history, contextId) => {
      // Отказ по лимиту — без записи в журнал общения: он виден в журнале
      // запросов, а его текст дал бы спамеру писать в базу без предела.
      if (!chatLimiter.check(`a2a-chat:${ip}`)) return { ok: false, text: CHAT_RATE_LIMITED_TEXT, rejected: true };
      const startedAt = Date.now();
      const answer = await answerAgentMessage(text, history);
      // Журнал общения (решение владельца 13.10): что спросили и что ответили,
      // после redactPII и на 90 суток — lib/a2a/dialog-log.
      logA2aDialog({
        question: text,
        answer: answer.text,
        state: answer.ok ? 'completed' : (answer.rejected ? 'rejected' : 'failed'),
        contextId,
        turn: history.filter((t) => t.role === 'user').length + 1,
        durationMs: Date.now() - startedAt,
        ip,
        userAgent,
        self,
      });
      return answer;
    },
  };
}

/** Версия протокола: заголовок `A2A-Version`, либо тот же query-параметр. */
export function versionOf(request: NextRequest): VersionRead {
  const raw = request.headers.get('a2a-version')
    ?? request.nextUrl.searchParams.get('A2A-Version')
    ?? request.nextUrl.searchParams.get('a2a-version');
  return readVersion(raw);
}

export interface JournalFields {
  op: A2aJournalOp;
  version: VersionRead;
  /** Ответ диспетчера; нет — отказ до него (errorCode) или визитка. */
  out?: A2AResult | null;
  errorCode?: string | null;
  /** Имя неизвестного метода или «ГЛАГОЛ /путь» — только при MethodNotFound. */
  method?: string | null;
}

/**
 * Факт запроса — в журнал A2A (lib/a2a/journal): кто пришёл, что просил, чем
 * кончилось, сколько заняло. Зовётся на КАЖДОМ исходе роута, включая отказы
 * до диспетчера: агент, упёршийся в версию или в размер тела, — тоже
 * «заходит из ИИ», и панель обязана его видеть.
 */
export function journalA2a(request: NextRequest, binding: A2aBinding, startedAt: number, f: JournalFields): void {
  const facts = f.out?.ok && f.op === 'SendMessage' ? sendMessageFacts(f.out.result) : null;
  const ok = f.out ? f.out.ok : !f.errorCode;
  logA2aRequest({
    binding,
    op: f.op,
    version: f.version.ok ? f.version.version : f.version.requested,
    versionDeclared: f.version.ok ? f.version.declared : true,
    ok,
    errorCode: ok ? null : (f.out && !f.out.ok ? f.out.error.kind : (f.errorCode ?? null)),
    input: facts?.input ?? null,
    tool: facts?.tool ?? null,
    state: facts?.state ?? null,
    contextId: facts?.contextId ?? null,
    durationMs: Date.now() - startedAt,
    method: f.method ?? null,
    ip: getTrustedClientIp(request.headers),
    userAgent: request.headers.get('user-agent') ?? '',
    self: isSelfMcpCaller(request.nextUrl),
  });
}

export function publicBase(): string {
  return getPublicBaseUrl().replace(/\/$/, '');
}

/**
 * CORS на КАЖДОМ ответе, не только на предполёте — как у MCP (проверка
 * 29.09): предполёт без заголовка на самом ответе — обещание без исполнения.
 * Origin не проверяется по той же причине, что у MCP: сервер публичный и
 * анонимный, rebinding чужой странице не даёт ничего сверх прямого запроса.
 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, A2A-Version, A2A-Extensions',
};

export function withCors(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

export function optionsResponse(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { Allow: 'GET, POST, DELETE, OPTIONS', ...CORS_HEADERS } });
}
