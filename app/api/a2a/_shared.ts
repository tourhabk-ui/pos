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
import type { A2AExecutors } from '@/lib/a2a/handle';
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
    chat: async (text, history) => {
      if (!chatLimiter.check(`a2a-chat:${ip}`)) return { ok: false, text: CHAT_RATE_LIMITED_TEXT, rejected: true };
      return answerAgentMessage(text, history);
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
