/**
 * lib/kuzmich/operator-chat.ts
 *
 * Кузьмич партнёра в его привязанном чате (Telegram, MAX). Имя файла
 * историческое — до 10.10 помощник знал только оператора; теперь он отвечает
 * партнёру любой роли CRM: оператору, гиду, перевозчику, жилью, прокату,
 * агенту (CRM #2325, шаг 1д).
 *
 * Умеет:
 * - «кто ждёт ответа?» — входящие и время первого ответа;
 * - «найди Анну, что у неё было?» — клиент, брони, лента, задачи;
 * - «запиши, что звонил» / «напомни перезвонить завтра» / «сделал» —
 *   касание, задача, выполнение;
 * - помочь составить ответ клиенту.
 * Данные о клиентах — только инструментами CRM (`lib/crm/tools.ts`), там же
 * правило «телефонов и почт модели не отдаём». Оператору вдобавок
 * подкладываются его туры и брони за неделю — без имён туристов.
 */

import { pool } from '@/lib/db-pool';
import { callAIWaterfallOrNull, callToolsWaterfall } from '@/lib/ai/providers';
import { getHistory, saveMsg } from '@/lib/kuzmich/core';
import { runTurnTools, wrapToolOutput } from '@/lib/kuzmich/tool-loop';
import type { ChatMessage } from '@/lib/ai/prompts';
import { crmCategoryFor, type PartnerCategory } from '@/lib/crm/partner-context';
import { partnerCategoryLabel } from '@/lib/crm/labels';
import {
  CRM_WRITE_TOOL_NAMES, crmToolDefinitions, crmToolText, crmWriteSummary, executeCrmTool, type CrmToolContext,
} from '@/lib/crm/tools';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';

type ToolMsg = Parameters<typeof callToolsWaterfall>[0][number];

export interface PartnerChatContext {
  partnerId: string;
  partnerName: string;
  /** `partners.category` как записан. */
  category: string;
  /**
   * Категория CRM, если инструменты CRM этому партнёру положены: роль из
   * шести и, для агента, одобренный профиль — то же правило, что у кабинета
   * (`partnerContextFor`). NULL — помощник без инструментов CRM.
   */
  crmCategory: PartnerCategory | null;
  /** `partners.user_id`; NULL — у записи нет аккаунта. */
  userId: string | null;
}

/**
 * Три исхода, как у кабинета (§4.0): партнёр / не партнёр / не смогли
 * проверить. Последний не равен «не партнёр»: вызывающий решает, что с ним
 * делать, но молча в него не превращает.
 */
export type PartnerChatLookup =
  | { outcome: 'found'; partner: PartnerChatContext }
  | { outcome: 'none' }
  | { outcome: 'unavailable' };

const CHAT_COLUMN = { telegram: 'telegram_chat_id', max: 'max_chat_id' } as const;

/**
 * Партнёр по привязанному чату. Статус партнёра не проверяется — как и в
 * кабинете: прежнее условие `status != 'blocked'` не отсекало никого (такого
 * статуса нет в CHECK, миграции его не заводили). Один человек с двумя
 * профилями на одном чате — берётся старший профиль, как у partnerContextFor.
 */
export async function findPartnerByChat(channel: keyof typeof CHAT_COLUMN, chatId: number): Promise<PartnerChatLookup> {
  try {
    const { rows } = await pool.query<{ id: string; name: string; category: string; user_id: string | null; profile_status: string | null }>(
      `SELECT id::text AS id, COALESCE(company_name, name) AS name, category,
              user_id::text AS user_id, profile_status
         FROM partners
        WHERE ${CHAT_COLUMN[channel]} = $1
        ORDER BY created_at ASC NULLS LAST, id ASC
        LIMIT 1`,
      [chatId],
    );
    const row = rows[0];
    if (!row) return { outcome: 'none' };
    return {
      outcome: 'found',
      partner: {
        partnerId: row.id,
        partnerName: row.name,
        category: row.category,
        crmCategory: crmCategoryFor(row.category, row.profile_status),
        userId: row.user_id,
      },
    };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error(`[partner-chat] партнёр по чату ${channel} не прочитан, SQLSTATE`, code);
    return { outcome: 'unavailable' };
  }
}

/**
 * Ответ бота на «/partner EMAIL» и «партнер EMAIL». Привязки по почте больше
 * нет (09.10): команда находила партнёра по `contact->>'email'` и молча
 * переписывала его `telegram_chat_id` / `max_chat_id` на того, кто её прислал.
 * Почта партнёра — не секрет (она на его сайте и в визитках), а этот адрес
 * решает, куда уходят имена и телефоны туристов из новых броней, и кому
 * помощник партнёра рассказывает о его клиентах. Правило владельца 29.09
 * (`lib/partners/channel-link.ts`): назначать такой адрес может только тот,
 * чьё право проверено, — вошедший в свой кабинет (ссылка из кабинета,
 * решение владельца 09.10) или администратор.
 *
 * Уже привязанные чаты не тронуты: findPartnerByChat читает колонки как раньше.
 */
export const PARTNER_EMAIL_BIND_CLOSED =
  'Подключить чат по почте больше нельзя: так его мог подключить любой, кто знает адрес, ' +
  'и заявки туристов ушли бы ему.\n\n' +
  'Войдите в кабинет на vedarai.ru: пока MAX не подключён, вверху будет кнопка «Подключить MAX» ' +
  '(и «Подключить Telegram»). Нажмите её и «Старт» в боте — чат подключится к карточке вашей компании.';

/** Приветствие на /start: что помощник умеет именно этому партнёру. */
export function partnerGreeting(partner: PartnerChatContext): string {
  return partner.crmCategory
    ? `Привет, ${partner.partnerName}! Я твой помощник.\n\n`
      + 'Подскажу, кто ждёт ответа, найду клиента и что у него было, запишу звонок или встречу, '
      + 'заведу задачу с напоминанием, помогу составить ответ. Пиши.'
    : `Привет, ${partner.partnerName}! Я твой помощник: помогу составить ответ клиенту или текст. Пиши.`;
}

/**
 * Туры и брони оператора для системного промпта.
 *
 * Две правки 22.08 (находка эволюции):
 *
 * 1. Связь тура с оператором идёт через `partners.id` — так объявлена
 *    внешним ключом сама колонка (миграция 040: `operator_id UUID
 *    REFERENCES partners(id)`). Запрос же сравнивал её с `partners.user_id`,
 *    то есть с идентификатором ЧЕЛОВЕКА, а не компании. Оператор всегда
 *    видел пустой список своих туров и своих броней.
 *
 * 2. Отказ запроса больше не выдаётся за пустоту. Прежде `allSettled`
 *    превращал упавший запрос в `[]`, и в системный промпт уходило
 *    «Бронирований на этой неделе нет» — Кузьмич уверенно сообщал оператору
 *    небылицу о его собственном бизнесе. Теперь у каждого блока есть третий
 *    исход: «не смог получить» (§4.0), и он отличается от «нет».
 *
 * Правка 10.10 (CRM 1д): имя туриста из брони в промпт не идёт. Промпт
 * уходит зарубежной модели (§8), а клиент у помощника теперь есть свой —
 * подписью «Анна П.» через инструменты CRM. Бронь называется номером.
 */
async function buildOperatorContext(partnerId: string): Promise<string> {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());

  const [toursResult, bookingsResult, pendingResult] = await Promise.allSettled([
    pool.query<{ id: number; title: string; base_price: number; is_active: boolean; available_slots: number | null }>(
      `SELECT id, title, base_price, is_active,
              available_slots, next_available_date::text
       FROM operator_tours
       WHERE operator_id = $1
         AND deleted_at IS NULL
       ORDER BY is_active DESC, created_at DESC
       LIMIT 10`,
      [partnerId],
    ),
    pool.query<{ id: string; booking_date: string; participants: number; final_price: number; booking_status: string }>(
      `SELECT ob.id::text AS id, ob.booking_date::text, ob.participants,
              ob.final_price, ob.booking_status
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ot.operator_id = $1
         AND ob.created_at >= $2
       ORDER BY ob.created_at DESC
       LIMIT 10`,
      [partnerId, weekStart.toISOString()],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ot.operator_id = $1
         AND ob.booking_status IN ('pending_payment','confirmed')
         AND ob.booking_date >= CURRENT_DATE`,
      [partnerId],
    ),
  ]);

  /** Отказ запроса — не пустой результат. Молчать о нём нельзя (§4.0). */
  const failed = (what: string, r: PromiseSettledResult<unknown>): boolean => {
    if (r.status !== 'rejected') return false;
    const code = (r.reason as { code?: string } | null)?.code ?? 'unknown';
    console.error(`[operator-chat] контекст оператора ${partnerId}: ${what} не прочитан, SQLSTATE ${code}`);
    return true;
  };

  const toursFailed = failed('туры', toursResult);
  const bookingsFailed = failed('брони за неделю', bookingsResult);
  const pendingFailed = failed('предстоящие брони', pendingResult);

  const tours = toursResult.status === 'fulfilled' ? toursResult.value.rows : [];
  const weekBookings = bookingsResult.status === 'fulfilled' ? bookingsResult.value.rows : [];
  const pendingCount =
    pendingResult.status === 'fulfilled'
      ? parseInt(pendingResult.value.rows[0]?.cnt ?? '0', 10)
      : null;

  const toursText = tours.length
    ? tours
        .map(
          t =>
            `- "${t.title}" | ${Number(t.base_price).toLocaleString('ru-RU')} ₽/чел | ${t.is_active ? 'активен' : 'неактивен'}${t.available_slots != null ? ` | мест: ${t.available_slots}` : ''}`,
        )
        .join('\n')
    : toursFailed
      ? 'НЕ УДАЛОСЬ ПРОЧИТАТЬ список туров — не утверждай, что туров нет.'
      : 'Туры не найдены.';

  const bookingsText = weekBookings.length
    ? weekBookings
        .map(
          b =>
            `- бронь №${b.id}, ${b.participants} чел, ${new Date(b.booking_date).toLocaleDateString('ru-RU')}, ${Number(b.final_price).toLocaleString('ru-RU')} ₽ [${b.booking_status}]`,
        )
        .join('\n')
    : bookingsFailed
      ? 'НЕ УДАЛОСЬ ПРОЧИТАТЬ брони — не утверждай, что броней нет.'
      : 'Бронирований на этой неделе нет.';

  return [
    pendingFailed || pendingCount === null
      ? 'Предстоящие активные бронирования: НЕ УДАЛОСЬ ПРОЧИТАТЬ.'
      : `Предстоящих активных бронирований: ${pendingCount}`,
    '',
    `МОИ ТУРЫ:`,
    toursText,
    '',
    `БРОНИРОВАНИЯ ЗА ПОСЛЕДНИЕ 7 ДНЕЙ:`,
    bookingsText,
  ].join('\n');
}

/** Системный промпт: кто партнёр, какой сегодня день и чем помощник знает факты. */
export function partnerSystemPrompt(partner: PartnerChatContext, nowMs: number, tools: boolean): string {
  const lines = [
    `Ты помощник партнёра туристической платформы Ведар (Камчатка). Партнёр: ${partner.partnerName}, роль — ${partnerCategoryLabel(partner.category)}.`,
    `Сегодня ${kamchatkaDate(new Date(nowMs))} по Камчатке (UTC+12).`,
    'Помогаешь вести дела и составлять ответы клиентам. Отвечай по-русски, коротко и по делу, без эмодзи.',
  ];
  if (tools) {
    lines.push(
      'О клиентах, входящих и задачах знаешь только то, что вернули инструменты crm_*. Чего инструмент не вернул — не утверждай.',
      'Клиента называй подписью из инструмента («Анна П.»). Телефонов и почт клиентов у тебя нет: связаться партнёр может из кабинета.',
      'Записывай в CRM (касание, задачу, выполнение) только когда партнёр об этом просит, и коротко скажи, что записал.',
    );
  } else if (partner.crmCategory) {
    lines.push('Данные CRM в этом ответе недоступны: о клиентах, входящих и задачах ничего не утверждай и ничего не обещай записать.');
  }
  return lines.join('\n');
}

const MAX_TOOL_TURNS = 4;

/**
 * Цикл инструментов CRM: тот же водопад, обёртка недоверенного вывода и
 * дедуп, что у Кузьмича туриста (`aiChatAgentLoop`), но набор инструментов —
 * только CRM, а партнёр в них — из привязанного чата, не из аргументов
 * модели. `writes` копит сделанные записи: если модель не дошла до ответа,
 * партнёр всё равно узнает, что записано, и не попросит второй раз.
 */
async function partnerToolLoop(
  system: string,
  history: ChatMessage[],
  ctx: CrmToolContext,
  writes: string[],
): Promise<string | null> {
  const msgs: ToolMsg[] = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content } as ToolMsg)),
  ];
  const tools = crmToolDefinitions(ctx.canWrite);
  const seen = new Set<string>();

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const result = await callToolsWaterfall(msgs, tools);
    if (!result) return null;
    if (!result.tool_calls?.length) return result.content;

    msgs.push({ role: 'assistant', content: result.content, tool_calls: result.tool_calls });
    const outcomes = await runTurnTools(result.tool_calls, seen, async (name, args) => {
      const r = await executeCrmTool(name, args, ctx);
      if (r.ok && CRM_WRITE_TOOL_NAMES.includes(name)) writes.push(crmWriteSummary(name, args));
      return crmToolText(r);
    });
    for (const o of outcomes) {
      msgs.push({ role: 'tool', content: o.executed ? wrapToolOutput(o.name, o.content) : o.content, tool_call_id: o.id });
    }
  }
  return null;
}

export async function processPartnerMessage(opts: {
  chatId: number;
  text: string;
  fromName: string | null;
  partner: PartnerChatContext;
  reply: (chatId: number, text: string) => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  const { chatId, text, fromName, partner, reply } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  await saveMsg(chatId, 'operator_tg', 'user', text, null, fromName);

  const [history, bizContext] = await Promise.all([
    getHistory(chatId, 'operator_tg'),
    partner.category === 'operator' ? buildOperatorContext(partner.partnerId) : Promise.resolve(''),
  ]);
  const withContext = (system: string) => (bizContext ? `${system}\n\n${bizContext}` : system);

  let answer = '';
  const writes: string[] = [];
  if (partner.crmCategory) {
    const ctx: CrmToolContext = {
      partnerId: partner.partnerId,
      category: partner.crmCategory,
      userId: partner.userId,
      actor: 'kuzmich',
      // Партнёр пишет в свой привязанный чат сам — просить записать ему можно.
      canWrite: true,
      nowMs,
    };
    try {
      answer = (await partnerToolLoop(withContext(partnerSystemPrompt(partner, nowMs, true)), history, ctx, writes))?.trim() ?? '';
    } catch (err) {
      console.error('[partner-chat] цикл инструментов упал:', err instanceof Error ? err.message : String(err));
      answer = '';
    }
  }

  if (!answer && writes.length > 0) {
    // Записи уже сделаны, а ответа модели нет: сказать, что записано, а не
    // «не могу ответить» — иначе партнёр попросит снова и получит дубль.
    answer = `Записал: ${writes.join('; ')}. Остальное ответить сейчас не получилось — спроси ещё раз.`;
  }

  if (!answer) {
    const messages: ChatMessage[] = [
      { role: 'system', content: withContext(partnerSystemPrompt(partner, nowMs, false)) },
      ...history,
    ];
    try {
      answer = (await callAIWaterfallOrNull(messages))?.trim() ?? '';
    } catch (err) {
      console.error('[partner-chat] водопад без инструментов упал:', err instanceof Error ? err.message : String(err));
      answer = '';
    }
  }

  if (!answer) {
    answer = 'Не могу ответить прямо сейчас. Попробуй ещё раз.';
  }

  await saveMsg(chatId, 'operator_tg', 'assistant', answer, null, null);
  await reply(chatId, answer);
}
