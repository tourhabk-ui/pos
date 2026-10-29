/**
 * POST /api/ai/chat-stream
 * 
 * Server-Sent Events (SSE) streaming for AI responses.
 * Streams tokens as they arrive from OpenRouter API.
 * 
 * Usage:
 *   const response = await fetch('/api/ai/chat-stream', {
 *     method: 'POST',
 *     body: JSON.stringify({ message: '...', sessionId: '...', role: 'tourist' })
 *   });
 *   const reader = response.body.getReader();
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     const chunk = new TextDecoder().decode(value);
 *     events.push(chunk); // data: token format
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { safeMsg } from '@/lib/errors/sanitize';
import { query } from '@/lib/database';
import { getSystemPrompt, buildMessageHistory, type ChatMessage, type ChatRole } from '@/lib/ai/prompts';
import { buildRAGContext, buildGeoContext } from '@/lib/ai/rag-context';
import { getOpenRouterKey } from '@/lib/ai/provider-config';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { getModelForAgent } from '@/lib/ai/agent-models';
import { callAIWithModelDirect } from '@/lib/ai/providers';
import { extractAndEncryptInterests } from '@/lib/ai/interest-extractor';
import {
  loadUserMemory,
  loadTripHistory,
  extractMemoryFromMessage,
  buildMemoryContext,
  buildAgentInsightsForTourist,
  upsertUserMemory,
  synthesizeUserNotes,
} from '@/lib/ai/user-memory';
import { aiChatAgentLoop, KUZMICH_SYSTEM } from '@/lib/kuzmich/core';
import { dropUnsourcedPrices } from '@/lib/kuzmich/answer-quality';
import { resolveCommercialTurn } from '@/lib/kuzmich/commercial-turn';
import { kamchatkaDateContext } from '@/lib/kuzmich/date-context';
import { finishKuzmichAnswer, correctShownAnswer } from '@/lib/kuzmich/answer-guards';
import { mchsPromptBlock } from '@/lib/safety/active-warnings';
import { recordKuzmichAnswer } from '@/lib/kuzmich/answer-timing';
import { saveChatSession } from '@/lib/kuzmich/chat-session-save';
import { newLoopTiming, answerTokens } from '@/lib/kuzmich/answer-ceiling';
import { gradeKuzmichResponse, fingerprintPrompt } from '@/lib/agents/managed/kuzmich-outcomes';
import { KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import type { ToolRun } from '@/lib/agents/eval/grounding';
import { detectEmergency, buildSosBlock } from '@/lib/safety/sos-detector';
import { openRouterAttribution } from '@/lib/ai/attribution';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FREE_MESSAGE_LIMIT = 3;

const streamLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const Schema = z.object({
  message: z.string().min(1).max(1000),
  sessionId: z.string().optional(),
  role: z.string().default('tourist'),
  history: z.array(ChatMessageSchema).max(20).optional(),
  // Geo: user coordinates (from browser geolocation)
  userLocation: z.object({
    lat: z.number(),
    lng: z.number(),
    accuracy: z.number().optional(),
    timestamp: z.number().optional(),
  }).optional(),
});

interface SessionRow {
  messages: ChatMessage[];
  user_message_count: number;
  interests_encrypted: string | null;
  user_id: string | null;
}

/**
 * Сессия ЧУЖАЯ, если за ней закреплён аккаунт, а спрашивает не он — то же
 * правило, что в /api/ai/chat. Стрим его не применял: зная id чужой сессии,
 * можно было получить её переписку в контекст ответа и затереть её своей
 * (аудит 15.10, 1.14 — найдено при сведении выходов Кузьмича).
 */
function isForeignSession(session: SessionRow | null, requesterId: string | null): boolean {
  return !!session && session.user_id !== null && session.user_id !== requesterId;
}

async function loadSession(sessionId: string): Promise<SessionRow | null> {
  if (!sessionId) return null;
  try {
    const result = await query<SessionRow>(
      `SELECT messages, user_message_count, interests_encrypted, user_id
       FROM chat_sessions WHERE session_id = $1 LIMIT 1`,
      [sessionId],
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  }
}

// Запись — одна на оба входа чата (lib/kuzmich/chat-session-save): там же
// хозяин ничьей сессии, продолженной после входа (#2327).
async function saveSession(
  sessionId: string,
  userId: string | null,
  role: ChatRole,
  messages: ChatMessage[],
  userMessageCount: number,
  isAuthenticated: boolean,
  interestsEncrypted: string | null,
): Promise<void> {
  await saveChatSession({ sessionId, userId, role, messages, userMessageCount, isAuthenticated, interestsEncrypted });
}

async function streamViaOpenRouter(messages: ChatMessage[]): Promise<Response | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;

  const payload = messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...openRouterAttribution('chat-stream'),
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: payload,
        temperature: 0.5,
        max_tokens: 800,
        stream: true,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok || !response.body) return null;
    return response;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!streamLimiter.check(ip)) {
    return NextResponse.json(
      { error: 'Слишком много запросов' },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const parsed = Schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });
    }

    const { message, sessionId, role = 'tourist', history: clientHistory, userLocation } = parsed.data;
    const validRoles: ChatRole[] = ['tourist', 'operator', 'guide', 'admin', 'agent', 'transfer'];
    const safeRole: ChatRole = validRoles.includes(role as ChatRole) ? (role as ChatRole) : 'tourist';
    const user = await getUserFromRequest(request);
    const isAuthenticated = !!user;

    const loaded = sessionId ? await loadSession(sessionId) : null;
    // Чужую сессию не читаем и не перезаписываем (см. isForeignSession).
    const foreign = isForeignSession(loaded, user?.userId ?? null);
    const session = foreign ? null : loaded;
    const storableSessionId = foreign ? null : (sessionId ?? null);
    const history: ChatMessage[] = (session?.messages?.length ? session.messages : null)
      ?? (clientHistory as ChatMessage[] | undefined)
      ?? [];
    const currentCount = session?.user_message_count ?? 0;
    const isNewSession = !session;

    if (!isAuthenticated && currentCount >= FREE_MESSAGE_LIMIT) {
      return NextResponse.json(
        {
          success: true,
          data: {
            limitReached: true,
            authRequired: true,
            message: 'Зарегистрируйтесь, чтобы продолжить общение с AI-помощником Кузьмичом. Это бесплатно!',
            registerUrl: '/auth/login',
            userMessageCount: currentCount,
            remainingFree: 0,
          },
        },
        { status: 200 },
      );
    }

    const userId = user?.userId ?? null; // UUID строка, не parseInt
    const [userMemory, tripHistory] = await Promise.all([
      userId ? loadUserMemory(userId) : Promise.resolve(null),
      userId ? loadTripHistory(userId) : Promise.resolve([]),
    ]);

    const userMsg: ChatMessage = { role: 'user', content: message.trim(), timestamp: Date.now() };
    history.push(userMsg);

    const basePrompt = getSystemPrompt(safeRole);
    const memContext = userMemory ? buildMemoryContext(userMemory, tripHistory) : '';

    // Geo-context: inject user location into system prompt + RAG boost
    // Normalize userLocation to full UserLocation type
    const geo = userLocation
      ? { lat: userLocation.lat, lng: userLocation.lng, accuracy: userLocation.accuracy ?? 0, timestamp: userLocation.timestamp ?? Date.now() }
      : undefined;

    const geoContext = geo ? await buildGeoContext(geo).catch(() => '') : '';

    const [ragContext, agentInsights, mchsBlock] = await Promise.all([
      buildRAGContext(message.trim(), safeRole, geo),
      safeRole === 'tourist' ? buildAgentInsightsForTourist() : Promise.resolve(''),
      safeRole === 'tourist' ? mchsPromptBlock() : Promise.resolve(''),
    ]);
    const systemPrompt = [basePrompt, mchsBlock, geoContext, ragContext, memContext, agentInsights].filter(Boolean).join('\n\n');
    const messagesForAI = buildMessageHistory(systemPrompt, history, 10);
    // Мозг Кузьмича для туристов — та же связка, что в /api/ai/chat:
    // KUZMICH_SYSTEM (обязательный get_guardian_context) + живые контексты
    const kuzmichSystem = [KUZMICH_SYSTEM, kamchatkaDateContext(), mchsBlock, geoContext, ragContext, memContext, agentInsights].filter(Boolean).join('\n\n');

    // Серверная SOS-страховка (как в /api/ai/chat): признаки ЧП известны из
    // вопроса ДО генерации — блок 112/МЧС уходит первыми токенами стрима,
    // независимо от того, что ответит (или не ответит) модель.
    const sosDetection = detectEmergency(message.trim());
    const sosHead = sosDetection.detected ? `${buildSosBlock(sosDetection.categories)}\n\n` : '';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start' })}\n\n`));

        let fullAnswer = '';

        // Готовый ответ (от agent loop или non-stream фолбэка) — по словам,
        // тем же псевдостримом, что и существующий фолбэк ниже
        const flushWords = (text: string) => {
          for (const word of text.split(/(\s+)/)) {
            if (!word) continue;
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'token', content: word })}\n\n`,
            ));
          }
        };
        const persistState = async () => {
          // В историю — то, что реально видел пользователь (с SOS-блоком)
          const assistantMsg: ChatMessage = { role: 'assistant', content: sosHead + fullAnswer, timestamp: Date.now() };
          history.push(assistantMsg);
          const newCount = currentCount + 1;
          const interestsEncrypted = extractAndEncryptInterests(message, session?.interests_encrypted ?? null);

          if (storableSessionId) {
            await saveSession(
              storableSessionId,
              user?.userId ?? null,
              safeRole,
              history,
              newCount,
              isAuthenticated,
              interestsEncrypted,
            );
          }

          const extracted = extractMemoryFromMessage(message.trim());
          if (userId) {
            void upsertUserMemory(userId, extracted, true, isNewSession);
            if (safeRole === 'tourist' && newCount % 5 === 0) {
              void synthesizeUserNotes(userId, history, userMemory?.ai_notes ?? null);
            }
          }
        };

        try {
          // SOS-блок — первыми токенами, до любой генерации
          if (sosHead) flushWords(sosHead);

          // Туристы (включая анонимов) — через agent loop core.ts:
          // get_guardian_context и персона Хранителя, как в Telegram/MAX и
          // /api/ai/chat (PR #333). Ответ приходит целиком — отдаём по словам.
          // Журнал инструментов хода — для сверки утверждений о безопасности (#2300).
          // Замер ответа (A19): от входа в цикл до готового ответа со сторожами.
          const answerStartedAt = Date.now();
          const streamToolRuns: ToolRun[] = [];
          const streamProvenance: { provider?: string } = {};
          const streamTiming = newLoopTiming();
          let commercialHit = false;
          if (safeRole === 'tourist' && !sosDetection.detected) {
            const historyText = history
              .filter((item) => item.role === 'assistant')
              .map((item) => item.content)
              .join('\n\n');
            try {
              const turn = await resolveCommercialTurn(message.trim(), { history: historyText, surface: 'web' });
              if (turn) {
                fullAnswer = turn.visible;
                commercialHit = true;
              }
            } catch (err) {
              logSwallowedFailure('ai-chat-stream', 'коммерческий ответ', err);
            }
          }
          let loopAnswered = false;
          if (safeRole === 'tourist' && !commercialHit) {
            try {
              fullAnswer = (await aiChatAgentLoop(message.trim(), kuzmichSystem, history.slice(-10), [], streamToolRuns, streamProvenance, streamTiming)) ?? '';
              loopAnswered = Boolean(fullAnswer.trim());
            } catch (err) {
              // Фолбэк на прежний стрим ниже; отказ цикла — в лог, не молча (§4.0).
              logSwallowedFailure('ai-chat-stream', 'цикл инструментов Кузьмича', err);
              fullAnswer = '';
            }
          }
          if (loopAnswered) {
            const priceSource = streamToolRuns
              .filter((run) => run.producedData && run.output)
              .map((run) => run.output)
              .join('\n');
            fullAnswer = dropUnsourcedPrices(fullAnswer, priceSource).text;
          }
          // Ответ модели до сторожей — его оценивает грейдер, как на сайте.
          let modelAnswer = fullAnswer;
          // Данные хода, которыми обосновывается километраж.
          const turnContext = [mchsBlock, geoContext, ragContext, memContext, agentInsights].filter(Boolean).join('\n\n');

          if (fullAnswer) {
            // Один выход ответа (аудит 15.10, 1.14) ДО отправки по словам:
            // после flushWords текст уже у человека. Блок 112 уже ушёл
            // первыми токенами — второй под ответом не ставится.
            const finished = finishKuzmichAnswer({
              surface: 'web-stream',
              answer: fullAnswer,
              question: message.trim(),
              toolRuns: streamToolRuns,
              context: turnContext,
              sos: false,
            });
            fullAnswer = finished.text;
            flushWords(fullAnswer);
          } else {
            // OpenRouter-стрим открываем ЛЕНИВО — только когда мозг не ответил,
            // иначе платили бы за две генерации на каждый запрос
            const orStreamResponse = await streamViaOpenRouter(messagesForAI);
            if (orStreamResponse?.body) {
            const reader = orStreamResponse.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const events = buffer.split('\n\n');
              buffer = events.pop() ?? '';

              for (const evt of events) {
                const line = evt
                  .split('\n')
                  .find((l) => l.startsWith('data: '));
                if (!line) continue;
                const payload = line.slice(6).trim();
                if (!payload || payload === '[DONE]') continue;

                try {
                  const parsedChunk = JSON.parse(payload) as {
                    choices?: Array<{ delta?: { content?: string } }>;
                  };
                  const token = parsedChunk.choices?.[0]?.delta?.content ?? '';
                  if (!token) continue;

                  fullAnswer += token;
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ type: 'token', content: token })}\n\n`,
                  ));
                } catch {
                  // Skip malformed chunk and continue streaming
                }
              }
            }
            } else {
              fullAnswer = await callAIWithModelDirect(messagesForAI, getModelForAgent('kuzmich'));
              flushWords(fullAnswer);
            }
            modelAnswer = fullAnswer;
            // Запасной стрим шёл без инструментов, и текст уже у человека:
            // вырезать нечем, поправки (километраж, «безопасно», «дошло»)
            // уходят хвостом в том же порядке (аудит 15.10, 1.14).
            const correction = correctShownAnswer({
              surface: 'web-stream',
              answer: fullAnswer,
              question: message.trim(),
              toolRuns: null,
              context: turnContext,
            });
            if (correction.tail) {
              flushWords(correction.tail);
              fullAnswer += correction.tail;
            }
          }

          if (safeRole === 'tourist') {
            void recordKuzmichAnswer({
              surface: 'web-stream',
              elapsedMs: Date.now() - answerStartedAt,
              turns: commercialHit ? 0 : (loopAnswered ? streamTiming.turns : null),
              toolRounds: commercialHit ? 0 : (loopAnswered ? streamTiming.toolRounds : null),
              path: commercialHit ? 'single' : (loopAnswered ? 'tools' : 'single'),
              provider: loopAnswered ? (streamProvenance.provider ?? null) : null,
              ceilingHit: streamTiming.ceilingHit,
              tokens: commercialHit ? null : answerTokens(streamTiming),
            });
          }
          if (safeRole === 'tourist' && !commercialHit) {
            // Исход ответа в стриме — грейдеру, как с сайта (аудит 15.10, 1.14):
            // ключ сессии грейдер хэширует сам, ПД чистит сам, потолок в сутки
            // общий. У запасного стрима инструментов не было — журнал пуст ([]).
            // Сборщик витрины модель не звал — оценивать его текст как ответ модели нельзя.
            void gradeKuzmichResponse(message.trim(), modelAnswer, storableSessionId, {
              surface: 'web-stream',
              toolRuns: loopAnswered ? streamToolRuns : [],
              promptFingerprint: loopAnswered ? fingerprintPrompt(KUZMICH_SYSTEM) : undefined,
              provider: loopAnswered ? (streamProvenance.provider ?? null) : null,
              answerPath: loopAnswered ? 'tools' : null,
              toolsOffered: loopAnswered ? KUZMICH_TOOLS.map((t) => t.function.name) : undefined,
            });
          }

          await persistState();
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'end', finalResponse: sosHead + fullAnswer, ...(sosDetection.detected ? { emergency: true } : {}) })}\n\n`,
          ));
          controller.close();
        } catch {
          // Даже при полном отказе генерации человек в ЧП уже получил
          // SOS-блок первыми токенами — теряется только ответ модели
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', message: 'Ошибка генерации ответа' })}\n\n`,
          ));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    const msg = safeMsg(error);
    return NextResponse.json({ error: 'Ошибка сервера', details: msg }, { status: 500 });
  }
}
