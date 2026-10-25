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
 * 2. Безопасность — та же дверь, что у Кузьмича на всех поверхностях
 *    (`finishKuzmichAnswer`, lib/kuzmich/answer-guards): километраж «от
 *    Петропавловска» сверяется с данными хода, утверждения о безопасности —
 *    со сводкой платформы, слова о доставке — с тем, что отправлять было
 *    нечем, а при признаках ЧП в вопросе сервер ставит блок 112 — в том числе
 *    к отказу модели (`withSosBlock`).
 * 3. Туры — только туры этого партнёра (lib/embed/widget-chat): виджет стоит
 *    на его сайте, это его витрина (§0).
 * 4. Модель — водопадом (`callAIWaterfallOrNull`, CLAUDE.md §4). Прежде первой
 *    шла отдельная ступень OpenRouter с ожиданием 15 с — с прода она
 *    гео-блокируется (§8), и человек ждал её отказа ни за что.
 * 5. Пределы входа — lib/embed/widget-chat-limits; прежние реплики из браузера
 *    идут в промпт цитатой, а не ролью помощника.
 * 6. Язык (аудит 15.10, WID-lang): окно шлёт `lang` ('ru' | 'en' | 'zh') — язык
 *    браузера посетителя. На нём сервер отдаёт свои фиксированные тексты:
 *    отказ модели, ошибки 400/404/500 и блок 112 при признаках ЧП — из словаря
 *    lib/embed/widget-i18n и `withSosBlock(…, lang)`. Нет поля — русский, как
 *    было. Ответ модели и без того идёт на языке вопроса (промпт).
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
import { mchsPromptBlock } from '@/lib/safety/active-warnings';
import { finishKuzmichAnswer } from '@/lib/kuzmich/answer-guards';
import { detectEmergency, withSosBlock } from '@/lib/safety/sos-detector';
import { getPublicBaseUrl } from '@/lib/config';
import { logText } from '@/lib/log/log-text';
import { recordKuzmichAnswer } from '@/lib/kuzmich/answer-timing';
import type { ToolRun } from '@/lib/agents/eval/grounding';
import {
  buildWidgetSystemPrompt,
  loadPartnerTours,
  partnerToursBlock,
  safetyBlock,
  widgetUserContent,
  type WidgetPartner,
} from '@/lib/embed/widget-chat';
import {
  WIDGET_HISTORY_MAX_ITEMS,
  WIDGET_HISTORY_TOTAL_MAX_CHARS,
  WIDGET_MESSAGE_MAX_CHARS,
} from '@/lib/embed/widget-chat-limits';
import { widgetOrigin } from '@/lib/embed/widget-origin';
import { WIDGET_CHAT_SESSION_SQL } from '@/lib/embed/widget-telemetry';
import { isWidgetLang, WIDGET_LANGS, widgetTexts, type WidgetLang, type WidgetTexts } from '@/lib/embed/widget-i18n';

export const dynamic = 'force-dynamic';

const widgetRateLimiter = createRateLimiter({ windowMs: 60_000, max: 15 });

/**
 * Схема запроса с сообщениями об ошибках на языке окна. Сообщения — из словаря
 * виджета: посетитель китайского окна увидит отказ по-китайски, русского — те
 * же русские строки, что и до 15.10 (аудит 15.10, WID-lang).
 */
function widgetChatSchema(t: WidgetTexts) {
  return z.object({
    partnerId: z.string().min(1, t.errPartnerMissing).max(100, t.errPartnerInvalid),
    sessionId: z.string().min(1, t.errSessionMissing).max(100, t.errSessionInvalid),
    message: z.string().trim()
      .min(1, t.errMessageEmpty)
      .max(WIDGET_MESSAGE_MAX_CHARS, t.errMessageTooLong(WIDGET_MESSAGE_MAX_CHARS)),
    history: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(WIDGET_MESSAGE_MAX_CHARS, t.errHistoryItemTooLong(WIDGET_MESSAGE_MAX_CHARS)),
    }))
      .max(WIDGET_HISTORY_MAX_ITEMS, t.errHistoryTooMany(WIDGET_HISTORY_MAX_ITEMS))
      .refine(
        (h) => h.reduce((sum, turn) => sum + turn.content.length, 0) <= WIDGET_HISTORY_TOTAL_MAX_CHARS,
        t.errHistoryTooLong(WIDGET_HISTORY_TOTAL_MAX_CHARS),
      )
      .optional(),
    // Хост и путь страницы партнёра (embed.js кладёт их в адрес окна чата).
    // Подделывается — сигнал для счёта, а не замок (аудит 15.10, WID-measure).
    origin: z.object({
      host: z.string().max(300).nullish(),
      path: z.string().max(1000).nullish(),
    }).optional(),
    // Язык окна (браузера посетителя). Необязателен: прежнее окно его не шлёт.
    // Незнакомый язык — русский, а не 400: отказ из-за подписи языка оставил
    // бы сообщение о беде без блока 112 (ревью WID-lang).
    lang: z.enum(WIDGET_LANGS).optional().catch(undefined),
  });
}

/**
 * Язык ответа об ошибке ещё до разбора схемы: ошибка в самом сообщении не
 * должна лишать посетителя его языка. Неизвестный или чужой `lang` — русский
 * (схема ниже тоже читает его как русский, а не отвергает запрос).
 */
function requestLang(body: unknown): WidgetLang {
  const raw = body && typeof body === 'object' ? (body as { lang?: unknown }).lang : undefined;
  return isWidgetLang(raw) ? raw : 'ru';
}

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

  // Язык ответа об отказе 500 — известен, как только прочитано тело.
  let t = widgetTexts('ru');
  try {
    const body: unknown = await request.json().catch(() => null);
    t = widgetTexts(requestLang(body));
    // Сообщения схемы — на языке окна; для отказов без своего сообщения (не
    // тот тип, не то значение) — общее «некорректные данные» на том же языке,
    // а не английская заготовка Zod.
    const parsed = widgetChatSchema(t).safeParse(body, { error: () => t.errInvalid });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || t.errInvalid },
        { status: 400 }
      );
    }

    const { partnerId, sessionId, message, history = [], origin: page, lang = 'ru' } = parsed.data;

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
        { success: false, error: t.notFound },
        { status: 404 }
      );
    }

    const origin = request.headers.get('origin');
    const corsHeaders = getCorsHeaders(origin, partner.widget_domains ?? []);

    const emergency = detectEmergency(message).detected;

    // Три источника данных порознь: отказ одного не отменяет ответ, но
    // называется — в логе и в промпте («не загрузился», а не «нет»).
    const [routesCtx, tours, safetyStatus, mchsBlock] = await Promise.all([
      buildRAGContext(message, 'tourist', undefined, { tours: false }).catch((err: unknown) => {
        console.error('[widget-chat] контекст маршрутов не собран:', logText(err instanceof Error ? err.message : err, 200));
        return '';
      }),
      emergency ? Promise.resolve(null) : loadPartnerTours(partner.id),
      getCurrentSafetyStatus(),
      mchsPromptBlock(),
    ]);
    const safetyText = formatSafetyStatusForAgent(safetyStatus);
    const toolRuns: ToolRun[] = [
      { name: 'safety_status', producedData: safetyStatus !== null, output: safetyText },
    ];

    // Данные хода: туры партнёра, сводка, маршруты. Ими же сверяется
    // километраж в ответе (аудит 15.10, 1.14).
    const widgetContext = partnerToursBlock(partner.name, tours, getPublicBaseUrl(), emergency)
      + safetyBlock(safetyText)
      + (mchsBlock ? `\n${mchsBlock}\n` : '')
      + routesCtx;
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildWidgetSystemPrompt(partner, lang) + widgetContext,
      },
      { role: 'user', content: widgetUserContent(history, message) },
    ];

    // Замер ответа (аудит 15.10, A19): цикла инструментов у виджета нет —
    // один вызов модели водопадом, значит и ход один. Часы — от вызова модели
    // до готового ответа, как у цикла на других поверхностях.
    const answerStartedAt = Date.now();
    const modelAnswer = await callAIWaterfallOrNull(messages);
    const modelFailed = modelAnswer === null || !modelAnswer.trim();
    // Один выход ответа (аудит 15.10, 1.14): расстояния → безопасность →
    // доставка → блок 112, как у Кузьмича на всех поверхностях. Блок 112 — и
    // к ответу, и к отказу модели: человеку в беде он нужнее всего именно
    // тогда, когда помощник не ответил. На языке окна: русский блок
    // китайскому туристу в беде не поможет (WID-lang).
    let sos: { text: string; emergency: boolean };
    if (modelFailed) {
      console.error('[widget-chat] ни одна модель не ответила', { partner: partnerId });
      sos = withSosBlock(t.chatFailed, message, lang);
    } else {
      const finished = finishKuzmichAnswer({
        surface: 'widget',
        answer: modelAnswer,
        question: message,
        toolRuns,
        context: widgetContext,
        lang,
      });
      sos = { text: finished.text, emergency: finished.emergency };
    }

    void recordKuzmichAnswer({
      surface: 'widget',
      elapsedMs: Date.now() - answerStartedAt,
      turns: 1,
      toolRounds: 0,
      path: 'single',
      // Водопад виджета имени ответившего провайдера наружу не отдаёт.
      provider: null,
      ceilingHit: false,
    });

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
      { success: false, error: t.errServer },
      { status: 500 }
    );
  }
}
