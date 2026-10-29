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
 * правило «телефонов и почт модели не отдаём». Продавцу своих туров —
 * туроператору и гиду с авторскими турами (`sellsOwnTours`, 29.10) —
 * вдобавок подкладываются его туры и брони за неделю, без имён туристов, и
 * даётся инструмент расписания my_tours_schedule.
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
import { MY_TOURS_TOOL, MY_TOURS_TOOL_NAME, runMyToursSchedule } from '@/lib/kuzmich/operator-tours-tool';
import { isFleetAsk, RENTAL_FLEET_TOOL, RENTAL_FLEET_TOOL_NAME, runOperatorRentalFleet } from '@/lib/kuzmich/operator-rental-fleet';
import { RENTAL_CALENDAR_TOOL, RENTAL_CALENDAR_TOOL_NAME } from '@/lib/rental/car-calendar';
import { rentalCalendarToolText } from '@/lib/rental/car-calendar-flow';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { handleRentalOfferEdit } from '@/lib/rental/offer-edit-flow';
import { redactPII } from '@/lib/security/pii-redact';
import { withSosBlock } from '@/lib/safety/sos-detector';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { GUIDE_OWN_PATH } from '@/lib/partners/cabinet-links';
import { getPublicBaseUrl } from '@/lib/config';

type ToolMsg = Parameters<typeof callToolsWaterfall>[0][number];

export interface PartnerChatContext {
  partnerId: string;
  partnerName: string;
  /**
   * `partners.slug`. null — в строке slug пуст. Поле необязательно у старых
   * вызовов: отсутствие значит «пилот проката не узнан», не «slug пуст в базе».
   */
  slug?: string | null;
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
  /**
   * Есть ли у карточки свои неудалённые туры (`operator_tours.operator_id`).
   * Решает `sellsOwnTours` (lib/partners/tour-seller): гид с авторскими
   * турами получает их сводку и расписание, гид команды — нет. Поля нет —
   * не продаёт (старые вызовы и моки).
   */
  sellsTours?: boolean;
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
 *
 * Свои туры (`sells_tours`) читаются тем же запросом, без второго: черновик
 * считается (это тур гида, его видно в «Своих турах»), удалённый — нет.
 * База по умолчанию — пул приложения; параметр — для проверки на настоящем
 * PostgreSQL (crm-contacts.pg).
 */
export async function findPartnerByChat(
  channel: keyof typeof CHAT_COLUMN,
  chatId: number,
  db: Pick<typeof pool, 'query'> = pool,
): Promise<PartnerChatLookup> {
  try {
    const { rows } = await db.query<{
      id: string; slug: string | null; name: string; category: string; user_id: string | null;
      profile_status: string | null; sells_tours: boolean | null;
    }>(
      `SELECT id::text AS id, NULLIF(btrim(slug), '') AS slug, COALESCE(company_name, name) AS name, category,
              user_id::text AS user_id, profile_status,
              EXISTS (SELECT 1 FROM operator_tours own
                       WHERE own.operator_id = partners.id AND own.deleted_at IS NULL) AS sells_tours
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
        slug: typeof row.slug === 'string' && row.slug.trim() !== '' ? row.slug : null,
        category: row.category,
        crmCategory: crmCategoryFor(row.category, row.profile_status),
        userId: row.user_id,
        sellsTours: row.sells_tours === true,
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
/** Экспорт — для проверки окна на настоящей базе (crm-contacts.pg); база по умолчанию — пул приложения. */
export async function buildOperatorContext(
  partnerId: string,
  db: Pick<typeof pool, 'query'> = pool,
): Promise<string> {
  // Окно — 7 суток назад от сейчас, в SQL. Прежнее «с воскресенья» считалось
  // в JS (now − getDay()): в воскресенье окно было пустым, и помощник уверенно
  // говорил «броней нет» при свежих бронях (проверка каналов 25.10).
  const [toursResult, bookingsResult, pendingResult] = await Promise.allSettled([
    db.query<{ id: number; title: string; base_price: number; is_active: boolean; is_published: boolean; available_slots: number | null }>(
      `SELECT id, title, base_price, is_active, is_published,
              available_slots, next_available_date::text
       FROM operator_tours
       WHERE operator_id = $1
         AND deleted_at IS NULL
       ORDER BY is_active DESC, created_at DESC
       LIMIT 10`,
      [partnerId],
    ),
    db.query<{ id: string; booking_date: string; participants: number; final_price: number; booking_status: string }>(
      `SELECT ob.id::text AS id, ob.booking_date::text, ob.participants,
              ob.final_price, ob.booking_status
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ot.operator_id = $1
         AND ob.deleted_at IS NULL
         AND ob.created_at >= NOW() - INTERVAL '7 days'
       ORDER BY ob.created_at DESC
       LIMIT 10`,
      [partnerId],
    ),
    db.query<{ cnt: string; awaiting: string }>(
      `SELECT COUNT(*) FILTER (WHERE ob.booking_status IN ('pending_payment','confirmed'))::text AS cnt,
              COUNT(*) FILTER (WHERE ob.booking_status = 'new')::text AS awaiting
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ot.operator_id = $1
         AND ob.deleted_at IS NULL
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
  const awaitingCount =
    pendingResult.status === 'fulfilled'
      ? parseInt(pendingResult.value.rows[0]?.awaiting ?? '0', 10)
      : null;

  const toursText = tours.length
    ? tours
        .map(
          t =>
            `- "${t.title}" | ${Number(t.base_price).toLocaleString('ru-RU')} ₽/чел | ${t.is_active ? 'активен' : 'неактивен'}${t.is_published ? '' : ', скрыт с витрины'}${t.available_slots != null ? ` | мест: ${t.available_slots}` : ''}`,
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
      : 'Бронирований за последние 7 дней нет.';

  return [
    pendingFailed || pendingCount === null || awaitingCount === null
      ? 'Предстоящие бронирования: НЕ УДАЛОСЬ ПРОЧИТАТЬ.'
      : `Предстоящих активных бронирований: ${pendingCount}. Ждут вашего подтверждения: ${awaitingCount}`,
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
  // «Открой даты словами» (22.10): даты открывает поток с кнопкой
  // подтверждения (lib/operators/chat-dates), а не модель. Без этой строки
  // помощник на непонятую фразу мог ответить «открыл» — а записи не было.
  if (partner.category === 'operator') {
    lines.push(
      'Даты и места туров ты сам не меняешь и не говоришь, что открыл или закрыл их. '
      + 'В MAX их открывают фразой «открой субботы июля, 8 мест» с кнопкой «Открыть», в остальных случаях — в кабинете.',
    );
  } else if (sellsOwnTours(partner)) {
    // Гид со своими турами (29.10): поток дат словами ему пока не открыт
    // (lib/operators/chat-dates/flow — только туроператор), его даты — в
    // разделе «Свои туры». Кабинет оператора гида не пустит.
    lines.push(
      'Даты и места своих туров ты сам не меняешь и не говоришь, что открыл или закрыл их. '
      + `Гид открывает даты, отвечает на брони и заявки в кабинете, раздел «Свои туры»: ${getPublicBaseUrl()}${GUIDE_OWN_PATH}`,
    );
  } else {
    // Гиду, перевозчику, владельцу жилья фраза с «открой» и датой тоже
    // приходит сюда (четвёртый ревью 22.10: раньше поток дат отвечал им
    // готовым отказом). Календаря у помощника нет — и «открыл» он не скажет.
    lines.push('Календарь, даты и свободные места ты не меняешь и не говоришь, что открыл или закрыл их: это делается в кабинете.');
  }
  if (tools) {
    lines.push(
      'О клиентах, входящих и задачах знаешь только то, что вернули инструменты crm_*. Чего инструмент не вернул — не утверждай.',
      'Клиента называй подписью из инструмента («Анна П.»). Телефонов и почт клиентов у тебя нет: связаться партнёр может из кабинета.',
      ...(sellsOwnTours(partner)
        ? ['Свои туры (и скрытые с витрины тоже) и открытые даты со свободными местами узнавай инструментом my_tours_schedule — не говори, что расписания или туров нет, не вызвав его.']
        : []),
      ...(isRentalPilotSlug(partner.slug)
        ? ['Свои машины проката (и скрытые из прайса тоже), цену за сутки и залог узнавай инструментом operator_rental_fleet. Цену, залог, модель и видимость, которых инструмент не вернул, не называй. Занятость на ближайшие 30 дней по Камчатке узнавай инструментом operator_rental_calendar: день «не отмечено» — это не «свободна». Отметку ставит только кнопка в MAX; инструмент её не ставит, и ты не говори, что отметил. Цену и описание машины ты не меняешь и не говори, что они уже на сайте: прокатчик пишет отдельным сообщением слово «цена», название машины и рубли за сутки одним числом, либо слово «описание», название, двоеточие и текст. Это черновик до одобрения.']
        : []),
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
  operatorTours = false,
  rentalFleet: { partnerName: string; slug: string | null } | null = null,
): Promise<string | null> {
  const msgs: ToolMsg[] = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content } as ToolMsg)),
  ];
  const tools = [
    ...crmToolDefinitions(ctx.canWrite),
    ...(operatorTours ? [MY_TOURS_TOOL] : []),
    ...(rentalFleet ? [RENTAL_FLEET_TOOL, RENTAL_CALENDAR_TOOL] : []),
  ];
  const seen = new Set<string>();

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const result = await callToolsWaterfall(msgs, tools);
    if (!result) return null;
    if (!result.tool_calls?.length) return result.content;

    msgs.push({ role: 'assistant', content: result.content, tool_calls: result.tool_calls });
    const outcomes = await runTurnTools(result.tool_calls, seen, async (name, args) => {
      if (operatorTours && name === MY_TOURS_TOOL_NAME) return runMyToursSchedule(ctx.partnerId, args, ctx.nowMs);
      if (rentalFleet && name === RENTAL_FLEET_TOOL_NAME) {
        return runOperatorRentalFleet(ctx.partnerId, rentalFleet.partnerName, rentalFleet.slug, args, ctx.nowMs);
      }
      if (rentalFleet && name === RENTAL_CALENDAR_TOOL_NAME) {
        const car = typeof args.car === 'string' ? args.car : '';
        return rentalCalendarToolText(ctx.partnerId, car, ctx.nowMs ?? Date.now());
      }
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
  const { chatId, text, fromName, partner } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  // Беда в тексте — блок 112 поверх любого ответа кабинета. Кузьмичу туриста
  // её отдаёт boundChatLane; сюда она доходит, когда в ней есть дело CRM
  // («запиши: у клиента сломана нога») или вход не спрашивает классификатор.
  const reply = (id: number, body: string) => opts.reply(id, withSosBlock(body, text).text);

  // Телефон и почта из текста партнёра (чаще — туриста: «запиши звонок Анне
  // +7 …») в зарубежную модель не уходят: та же граница, что у Кузьмича
  // туриста (core, redactUserTurns). В историю пишется очищенное — история
  // это вход модели на следующем ходу; реплики помощника тоже (ответ на
  // правку описания повторяет текст прокатчика). Правка цены ниже читает
  // исходный текст: модели там нет, а число цены очистка не трогает.
  // Хвост номера (4 цифры) остаётся: по нему инструмент CRM находит клиента.
  const clean = (body: string) => redactPII(body, { keepPhoneTail: true });
  await saveMsg(chatId, 'operator_tg', 'user', clean(text), null, fromName);
  const saveAnswer = (body: string) => saveMsg(chatId, 'operator_tg', 'assistant', clean(body), null, null);

  // Цена и описание — черновик на модерацию, без модели: число из фразы
  // прокатчика, на сайт не попадает, пока его не одобрят.
  const edited = await handleRentalOfferEdit({
    partnerId: partner.partnerId,
    slug: partner.slug ?? null,
    text,
  });
  if (edited !== null) {
    await saveAnswer(edited);
    await reply(chatId, edited);
    return;
  }

  // «Покажи машины» — прайс из базы, без модели: модель на этот вопрос
  // выдумывала цену, когда инструмента не было.
  if (isRentalPilotSlug(partner.slug) && isFleetAsk(text)) {
    const fleet = await runOperatorRentalFleet(partner.partnerId, partner.partnerName, partner.slug ?? null, {}, nowMs);
    await saveAnswer(fleet);
    await reply(chatId, fleet);
    return;
  }

  const [storedHistory, bizContext] = await Promise.all([
    getHistory(chatId, 'operator_tg'),
    sellsOwnTours(partner) ? buildOperatorContext(partner.partnerId) : Promise.resolve(''),
  ]);
  const withContext = (system: string) => (bizContext ? `${system}\n\n${bizContext}` : system);
  // Строки, записанные до очистки (до 25.10), чистятся на входе модели —
  // все роли: в старой реплике помощника мог остаться номер из описания.
  const history = storedHistory.map((m) => ({ ...m, content: clean(m.content) }));

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
      const fleetCtx = isRentalPilotSlug(partner.slug)
        ? { partnerName: partner.partnerName, slug: partner.slug ?? null }
        : null;
      answer = (await partnerToolLoop(
        withContext(partnerSystemPrompt(partner, nowMs, true)),
        history,
        ctx,
        writes,
        sellsOwnTours(partner),
        fleetCtx,
      ))?.trim() ?? '';
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

  await saveAnswer(answer);
  await reply(chatId, answer);
}
