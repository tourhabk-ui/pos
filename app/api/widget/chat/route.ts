/**
 * POST /api/widget/chat — чат виджета на сайте партнёра (окно `/widget/<slug>`).
 * Без входа: партнёр узнаётся по slug и включённому виджету.
 *
 * ── Аудит 15.10, WID-safety (карт-бланш владельца 15.10) ──────────────────
 *
 * 1. Лид чат больше не создаёт. До 15.10 первое же сообщение становилось
 *    «лидом» без телефона, без согласия на ПД и без адресата, и через 2 часа
 *    крон добивки отдавал его другому оператору — вопрос с сайта партнёра
 *    уходил конкуренту. Заявка теперь — только формой `/widget/lead-form/<slug>`
 *    (телефон, согласие, operator_id партнёра), её открывает кнопка
 *    «Оставить заявку» в окне чата. Записанные до 15.10 псевдолиды исключены
 *    из добивки и счёта сторожа — lib/leads/widget-chat-pseudo.
 * 2. Безопасность — та же дверь, что у веб-Кузьмича и A2A: ответ модели
 *    сверяется со сводкой платформы (`guardSafetyClaims`), слова о доставке —
 *    с тем, что отправлять было нечем (`guardDeliveryClaims`), а при признаках
 *    ЧП в вопросе сервер ставит блок 112 (`withSosBlock`) — в том числе к
 *    отказу модели.
 * 3. Туры — только туры этого партнёра (lib/embed/widget-chat): виджет стоит
 *    на его сайте, это его витрина (§0).
 * 4. Модель — водопадом (`callAIWaterfallOrNull`, CLAUDE.md §4). Прежде первой
 *    шла отдельная ступень OpenRouter с ожиданием 15 с — с прода она
 *    гео-блокируется (§8), и человек ждал её отказа ни за что.
 * 5. Пределы входа — lib/embed/widget-chat-limits; прежние реплики из браузера
 *    идут в промпт цитатой, а не ролью помощника.
 *
 * Сторож: tests/unit/widget-chat-route.test.ts (вызов роута с моками пула и
 * модели).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { callAIWaterfallOrNull } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { safeMsg } from '@/lib/errors/sanitize';
import { buildRAGContext } from '@/lib/ai/rag-context';
import { getCurrentSafetyStatus, formatSafetyStatusForAgent } from '@/lib/safety/current-status';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';
import { guardDeliveryClaims } from '@/lib/kuzmich/delivery-claim-guard';
import { recordSafetyReview } from '@/lib/kuzmich/safety-review-log';
import { detectEmergency, withSosBlock } from '@/lib/safety/sos-detector';
import { getPublicBaseUrl } from '@/lib/config';
import { logText } from '@/lib/log/log-text';
import type { ToolRun } from '@/lib/agents/eval/grounding';
import {
  buildWidgetSystemPrompt,
  loadPartnerTours,
  partnerToursBlock,
  safetyBlock,
  widgetUserContent,
  WIDGET_CHAT_FAILED_TEXT,
  type WidgetPartner,
} from '@/lib/embed/widget-chat';
import {
  WIDGET_HISTORY_MAX_ITEMS,
  WIDGET_HISTORY_TOTAL_MAX_CHARS,
  WIDGET_MESSAGE_MAX_CHARS,
} from '@/lib/embed/widget-chat-limits';
import { widgetOrigin } from '@/lib/embed/widget-origin';
import { WIDGET_CHAT_SESSION_SQL } from '@/lib/embed/widget-telemetry';

export const dynamic = 'force-dynamic';

const widgetRateLimiter = createRateLimiter({ windowMs: 60_000, max: 15 });

const WidgetChatSchema = z.object({
  partnerId: z.string().min(1, 'Не указан партнёр').max(100, 'Некорректный партнёр'),
  sessionId: z.string().min(1, 'Не указан разговор').max(100, 'Некорректный разговор'),
  message: z.string().trim()
    .min(1, 'Сообщение пустое')
    .max(WIDGET_MESSAGE_MAX_CHARS, `Сообщение длиннее ${WIDGET_MESSAGE_MAX_CHARS} знаков`),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(WIDGET_MESSAGE_MAX_CHARS, `Реплика в истории длиннее ${WIDGET_MESSAGE_MAX_CHARS} знаков`),
  }))
    .max(WIDGET_HISTORY_MAX_ITEMS, `В истории больше ${WIDGET_HISTORY_MAX_ITEMS} реплик`)
    .refine(
      (h) => h.reduce((sum, t) => sum + t.content.length, 0) <= WIDGET_HISTORY_TOTAL_MAX_CHARS,
      `История разговора длиннее ${WIDGET_HISTORY_TOTAL_MAX_CHARS} знаков`,
    )
    .optional(),
    // Хост и путь страницы партнёра (embed.js кладёт их в адрес окна чата).
    // Подделывается — сигнал для счёта, а не замок (аудит 15.10, WID-measure).
    origin: z.object({
      host: z.string().max(300).nullish(),
      path: z.string().max(1000).nullish(),
    }).optional(),
});

interface PartnerRow extends WidgetPartner {
  widget_domains: string[] | null;
}

function getCorsHeaders(origin: string | null, allowedDomains: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (!origin) return headers;

  try {
    const originHost = new URL(origin).hostname;
    const isAllowed = allowedDomains.some(d => {
      const clean = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return originHost === clean || originHost.endsWith(`.${clean}`);
    });
    if (isAllowed) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
  } catch {
    // Invalid origin — skip
  }

  return headers;
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  // For OPTIONS preflight, allow all widget origins
  const headers = getCorsHeaders(origin, ['*']);
  headers['Access-Control-Allow-Origin'] = origin || '*';
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!widgetRateLimiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много запросов' },
      { status: 429 }
    );
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = WidgetChatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' },
        { status: 400 }
      );
    }

    const { partnerId, sessionId, message, history = [], origin: page } = parsed.data;

    const partnerResult = await query<PartnerRow>(
      `SELECT id::text AS id, name, category, description, widget_domains
       FROM partners
       WHERE slug = $1 AND widget_enabled = true
       LIMIT 1`,
      [partnerId]
    );

    const partner = partnerResult.rows[0];
    if (!partner) {
      return NextResponse.json(
        { success: false, error: 'Чат этого партнёра не найден или выключен' },
        { status: 404 }
      );
    }

    const origin = request.headers.get('origin');
    const corsHeaders = getCorsHeaders(origin, partner.widget_domains ?? []);

    const emergency = detectEmergency(message).detected;

    // Три источника данных порознь: отказ одного не отменяет ответ, но
    // называется — в логе и в промпте («не загрузился», а не «нет»).
    const [routesCtx, tours, safetyStatus] = await Promise.all([
      buildRAGContext(message, 'tourist', undefined, { tours: false }).catch((err: unknown) => {
        console.error('[widget-chat] контекст маршрутов не собран:', logText(err instanceof Error ? err.message : err, 200));
        return '';
      }),
      emergency ? Promise.resolve(null) : loadPartnerTours(partner.id),
      getCurrentSafetyStatus(),
    ]);
    const safetyText = formatSafetyStatusForAgent(safetyStatus);
    const toolRuns: ToolRun[] = [
      { name: 'safety_status', producedData: safetyStatus !== null, output: safetyText },
    ];

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildWidgetSystemPrompt(partner)
          + partnerToursBlock(partner.name, tours, getPublicBaseUrl(), emergency)
          + safetyBlock(safetyText)
          + routesCtx,
      },
      { role: 'user', content: widgetUserContent(history, message) },
    ];

    const modelAnswer = await callAIWaterfallOrNull(messages);
    const modelFailed = modelAnswer === null || !modelAnswer.trim();
    let answer: string;
    if (modelFailed) {
      console.error('[widget-chat] ни одна модель не ответила', { partner: partnerId });
      answer = WIDGET_CHAT_FAILED_TEXT;
    } else {
      const guard = guardSafetyClaims(modelAnswer, toolRuns);
      if (guard.flagged.length > 0) {
        console.error('[kuzmich-safety-claim-guard] widget: утверждение о безопасности без опоры', {
          verdict: guard.verdict, flagged: guard.flagged.map((c) => c.phrase),
        });
      }
      void recordSafetyReview('other', guard, toolRuns);
      const delivery = guardDeliveryClaims(guard.text, toolRuns);
      if (delivery.verdict === 'unbacked') {
        console.error('[kuzmich-delivery-claim-guard] widget: отчёт о доставке без инструмента заявки', {
          phrases: delivery.phrases,
        });
      }
      answer = delivery.text;
    }
    // Блок 112 — и к ответу, и к отказу модели: человеку в беде он нужнее
    // всего именно тогда, когда помощник не ответил.
    const sos = withSosBlock(answer, message);

    // Разговор — в chat_sessions (без ожидания ответа базы, но не молча).
    const widgetSessionId = `widget_${partnerId}_${sessionId}`;
    const allMessages = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: sos.text },
    ];

    // Откуда пришёл человек: хост сверен со списком доменов партнёра —
    // listed / unlisted / not_sent. Пишется первым сообщением и дальше не
    // переписывается (аудит 15.10, WID-measure). Подделываемо — только счёт.
    const pageOrigin = widgetOrigin(page?.host, page?.path, partner.widget_domains);

    // Число реплик человека сервер считает сам (+1 за это сообщение), а не
    // по присланной истории: окно урезает её до 20 реплик, и счёт по ней
    // занижал разговорную активность в переписи (аудит 15.10, R-chat).
    void query(
      WIDGET_CHAT_SESSION_SQL,
      [widgetSessionId, JSON.stringify(allMessages.slice(-20)), JSON.stringify(pageOrigin)]
    ).catch((err: unknown) => {
      const e = err as { code?: string; message?: string } | null;
      console.error('[widget-chat] разговор не сохранён:', `SQLSTATE=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    });

    return NextResponse.json(
      { success: true, data: { answer: sos.text, emergency: sos.emergency, modelFailed } },
      { headers: corsHeaders }
    );
  } catch (error: unknown) {
    // Причина — только в лог. Публичному чату на чужом сайте детали отказа
    // (имена таблиц, тексты базы) не нужны: посетителю хватает «не получилось»,
    // а разбору — строки лога (аудит 15.10, W3-widget, ревью WID-safety).
    const msg = safeMsg(error);
    console.error('[widget-chat] запрос не обработан:', logText(msg, 300));
    return NextResponse.json(
      { success: false, error: 'Ошибка обработки запроса' },
      { status: 500 }
    );
  }
}
