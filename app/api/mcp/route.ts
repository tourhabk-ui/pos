/**
 * MCP Server (Streamable HTTP) — внешний протокольный вход в мозг Кузьмича.
 * Протокол: JSON-RPC 2.0 (MCP spec). URL: https://vedarai.ru/api/mcp
 *
 * Один мозг — два протокола: инструменты НЕ дублируются здесь своим SQL,
 * а делегируются реестру Кузьмича (lib/kuzmich/tool-schemas.ts + executor в
 * core.ts). До этого сервер держал параллельный набор из 4 инструментов
 * со своим SQL по legacy-VIEW и отставал от Кузьмича: внешний агент видел
 * платформу беднее и иначе, чем турист в чате.
 *
 * Подмножество почти read-only и анонимное: наружу НЕ отдаём инструменты,
 * которые жгут внешние квоты (search_kamchatka — платный веб-поиск,
 * search_taaft — внешний каталог с трекингом использования). Ничего, что
 * требует личности пользователя, здесь нет by construction — у Кузьмича
 * такие поверхности живут вне tool-реестра.
 *
 * Записи четыре: create_lead (заявка на подбор тура), create_booking_request
 * (заявка на бронь тура на дату) и request_charter (заявка на вахтовку целой
 * машиной у перевозчика «под заказ»): не бронь и не оплата, идут в общий
 * createLead() со скорингом и дедупом; create_stay_request (заявка хозяину
 * жилья на даты) — тем же путём, что форма на карточке объекта
 * (lib/stay/stay-request-service). Бронирование анонимному внешнему
 * агенту не отдаём сознательно. Единственное исключение по форме — тур без
 * расписания: вместо ложного «нет мест» уходит запрос мест оператору
 * (lib/seat-requests). Бронь и там заводит не агент, а оператор своим
 * нажатием «Есть места» в мессенджере.
 */

import { localizeToolArgs, langNote } from '@/lib/mcp/query-lang';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, WRITE_TOOL_NAMES, CREATE_LEAD_TOOL, BOOKING_REQUEST_TOOL, REQUEST_CHARTER_TOOL, STAY_REQUEST_TOOL, CAR_RENTAL_REQUEST_TOOL, MCP_SERVER_INFO, MCP_READ_PER_MINUTE } from '@/lib/mcp/public-tools';
import { negotiateProtocolVersion, isSupportedProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import { classifyMessage, jsonrpcSuccess, jsonrpcError, McpUserError, MCP_INTERNAL_ERROR_TEXT, type JsonRpcId } from '@/lib/mcp/jsonrpc';
import { MAX_BODY_BYTES, readBodyLimited } from '@/lib/mcp/read-body';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';
import { logText } from '@/lib/log/log-text';
import { createLead, findRecentLeadByCommentPrefix } from '@/lib/leads/create';
import { notifyPartnerNewLeadPersonally } from '@/lib/notifications/lead-notify';
import { recordPartnerDelivery } from '@/lib/leads/delivery-outcome';
import { isVehicleOrder } from '@/lib/leads/vehicle-order';
import { planFromDraft, planSourceFields, planAttachNote } from '@/lib/leads/plan-from-draft';
import { computeQuickScore, LOW_QUALITY_SCORE } from '@/lib/leads/scoring';
import { checkMcpWrite, CLIENT_WINDOW_MINUTES, CLIENT_MAX_PER_WINDOW } from '@/lib/mcp/write-guard';
import { buildConsentRecord, type PdConsentPurpose } from '@/lib/legal/pd-consent';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { isSelfMcpCaller } from '@/lib/analytics/self-visit';
import { primaryArg, classifyExecutionError } from '@/lib/mcp/call-reason';
import { readToolArguments, argsRefusal, type ReadArguments } from '@/lib/mcp/tool-arguments';
import { unknownToolResponse } from '@/lib/mcp/unknown-tool';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { logMcpToolCall, logMcpClient } from '@/lib/mcp/call-log';
import type { PublicToolOutcome } from '@/lib/mcp/tool-outcome';
import { CONNECTOR_TOOL_NAMES, runConnectorTool } from '@/lib/mcp/connector-tools';
import { REQUEST_STATUS_TOOL_NAME, runRequestStatusTool, issueRequestKey, keyLine } from '@/lib/mcp/request-status';
import { randomUUID } from 'node:crypto';
import { issueMcpHandoff } from '@/lib/mcp/handoff';
import { SEAT_REQUEST_FAILURE, kamchatkaToday, isRealDate, seatRequestPaymentNote } from '@/lib/seat-requests/core';
import { createSeatRequest, statusUrl, tourKeepsSchedule } from '@/lib/seat-requests/service';
import { requestWindow, dateInWindow, outOfSeasonText } from '@/lib/tours/request-window';
import { checkStayDates, submitStayRequest, resolveStayForRequest } from '@/lib/stay/stay-request-service';
import { loadCharterCarriers } from '@/lib/transfers/charter';
import { charterAcceptedText, pickCarrier, planCharterRequest } from '@/lib/transfers/charter-request';
import { buildCharterLead, checkCharterDates, saveCharterLead } from '@/lib/transfers/charter-request-service';
import { loadRentalCompanies } from '@/lib/rental/rental';
import { rentalPagePath, type RentalCompany, type RentalOffer } from '@/lib/rental/rental-format';
import { rentalDays, rentalDedupPrefix } from '@/lib/rental/rental-request';
import { issueRentalConfirmation, checkRentalConfirmation, RENTAL_CONFIRM_TTL_MIN, type RentalConfirmFields } from '@/lib/mcp/rental-confirmation';
import { buildRentalLead, checkRentalDates, saveRentalLead } from '@/lib/rental/rental-request-service';
import { matchOffers } from '@/lib/kuzmich/car-rental-search';
import { recordSourceEventQuietly } from '@/lib/crm/events';
import { getPublicBaseUrl } from '@/lib/config';
// Handoff-цели инструментов (v2, задача #60) — lib/mcp/handoff-targets.ts:
// пути строит только серверный код по белому списку, сущности резолвятся
// теми же функциями, какими их находят сами инструменты.
import { handoffTargetForTool } from '@/lib/mcp/handoff-targets';

export const dynamic = 'force-dynamic';

// ── Rate-limit по IP (Эволюция 3.0, п.4) ─────────────────────
// Вход анонимный, поэтому лимит — единственный тормоз для абьюза. Чтение
// щедрое (агент в диалоге дёргает несколько инструментов подряд), запись
// жёсткая: заявки создают работу живому менеджеру.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: MCP_READ_PER_MINUTE });
// Окно — то же, что у стража в базе (lib/mcp/write-guard, решение владельца
// 01.10: 5 заявок в час); этот счётчик — первый, дешёвый рубеж до базы.
const writeLimiter = createRateLimiter({ windowMs: CLIENT_WINDOW_MINUTES * 60_000, max: CLIENT_MAX_PER_WINDOW });
// Какие инструменты пишущие, знает аннотация (`readOnlyHint: false`) — один
// источник и для лимита, и для подсказки хосту. Свой список здесь разошёлся бы.
const WRITE_TOOLS = WRITE_TOOL_NAMES;

// IP — из заголовка, который ставит прокси (x-real-ip), а не из первого
// элемента X-Forwarded-For: тот пишет сам клиент. От этого адреса зависят
// лимит записи (5 заявок в час — первый тормоз спама) и запись
// согласия на ПД, где адрес — часть доказательства. Скрипт, меняющий XFF
// с каждым запросом, обходил лимит и подделывал адрес в согласии (сверка
// MCP 29.09; тот же приём, что у запросов мест, lib/rate-limit.ts).
function clientIp(request: NextRequest): string {
  return getTrustedClientIp(request.headers);
}

// Определения инструментов и список наружу — в lib/mcp/public-tools.ts:
// тот же список нужен манифесту /.well-known/mcp.json, а два списка
// разошлись бы в первый же день. Здесь остаётся только исполнение.

/**
 * Что известно о вызывающем на момент записи. Нужен обеим заявочным
 * функциям: решение о допуске считается по адресу и агенту, а согласие
 * записывается вместе с адресом — время без адреса и версии текста не
 * доказательство (см. lib/legal/pd-consent).
 */
interface McpCallContext {
  ip: string;
  userAgent: string;
  /** Метка владельца в адресе коннектора: свой лид, вне счёта спроса (1145). */
  self: boolean;
}

/**
 * Допуск к записи — одна дверь на оба заявочных инструмента.
 *
 * Возвращает готовую запись согласия, если пускать можно, и бросает с
 * человеческим объяснением, если нет. Бросок, а не тихий возврат: заявка,
 * не созданная молча, для агента неотличима от созданной.
 */
async function admitWrite(
  ctx: McpCallContext,
  tool: string,
  phone: string,
  consent: boolean | undefined,
  // Кому уходят ПД: оператору тура (по умолчанию) или владельцу жилья —
  // версия текста согласия должна называть настоящего получателя.
  purpose: PdConsentPurpose = 'operator',
) {
  const verdict = await checkMcpWrite({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    tool,
    phone,
    consent: consent === true,
  });
  // «Не смог проверить» здесь читается как отказ, и это решение вызывающего,
  // а не сторожа: анонимный приём ПД — не то место, где непроверенное
  // пропускают. Потери нет: счёт живёт в той же базе, что и лид.
  if (verdict.decision !== 'allow') {
    throw new McpUserError(verdict.message, 'write_guard');
  }
  return buildConsentRecord(true, ctx.ip, 'mcp', purpose);
}

/**
 * Отказ «поля нет» отличается от отказа «согласия нет», и это намеренно.
 * Первый — про то, что клиент прислал запрос по старой схеме и должен
 * перечитать `tools/list`; второй — про то, что человек согласия не давал.
 * Одинаковый текст на два разных случая заставил бы агента чинить не то.
 */
const MISSING_CONSENT_FIELD =
  'В запросе нет поля consent. Схема инструмента требует его: спросите у человека согласие '
  + 'на обработку персональных данных (имя, телефон) и передайте consent: true.';

/**
 * Третий случай рядом с «поля нет» и «согласия нет»: поле есть, но не
 * логическое (строка «true»). До 29.09 он получал текст «поля нет», и агент
 * чинил не то (проверка MCP).
 */
const CONSENT_NOT_BOOLEAN = 'Поле consent должно быть логическим значением true или false, а не строкой.';

const consentField = z.boolean({
  error: (iss) => (iss.input === undefined ? MISSING_CONSENT_FIELD : CONSENT_NOT_BOOLEAN),
});

/**
 * Имя — одной строкой: в уведомлении менеджеру оно стоит прямо над
 * настоящим телефоном, и «Иван\nТел: +7999…» подделывал бы строку номера
 * (проверка MCP 29.09). Управляющие символы не проходят.
 */
const personName = z.string().trim()
  .min(2, 'Имя короче 2 символов')
  .max(120, 'Имя длиннее 120 символов')
  .regex(/^[^\p{Cc}]+$/u, 'Имя — одной строкой, без переводов строки и управляющих символов');

const createLeadArgsSchema = z.object({
  name: personName,
  phone: z.string().trim().min(5, 'Телефон обязателен — иначе менеджеру не с кем связаться').max(50, 'Телефон длиннее 50 символов'),
  comment: z.string().trim().min(10, 'Опишите запрос хотя бы в 10 символах').max(2000, 'Комментарий длиннее 2000 символов'),
  interest: z.string().trim().max(200, 'Интерес длиннее 200 символов').optional(),
  // ID плана из make_trip_plan (#2304, шаг 2): заявка уходит с планом целиком.
  plan_id: z.string().trim().max(64, 'ID плана длиннее 64 символов').optional(),
  // Обязателен и здесь, а не только в JSON Schema инструмента. Два источника
  // правды путают ОСНОВАНИЕ отказа: агент, смотрящий схему, видит поле
  // обязательным, а парсер роута пропускал бы его отсутствие дальше — и
  // отказ «поля нет» становился неотличим от отказа «согласия нет».
  consent: consentField,
});

// ── create_booking_request (Эволюция 3.0, п.4) ───────────────
// Заявка на бронь конкретного тура на дату. НЕ бронь: реальную бронь создаёт
// оператор после звонка (никакого INSERT в operator_bookings отсюда — роут,
// пишущий брони, обязан жить по правилам комиссий §7, и это не наш случай).
// Занятость проверяется движком планера — тем же расчётом, что у гейта брони:
// нет мест → заявка не создаётся, агенту честно отдаются ближайшие даты.
const bookingRequestArgsSchema = z.object({
  tour: z.string().trim().min(1, 'Укажите тур: название или ID').max(200, 'Название тура длиннее 200 символов'),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
  // Сообщения по-русски (§4): без них zod отвечал «Too small: expected
  // number to be >=1» и «expected number, received NaN».
  participants: z.coerce.number({ error: 'Число участников — целое число, например 2' })
    .int('Число участников — целое число')
    .min(1, 'Участников не меньше одного')
    .max(30, 'Не больше 30 участников в одной заявке')
    .default(1),
  name: personName,
  phone: z.string().trim().min(5, 'Телефон обязателен — заявку подтверждают по нему').max(50, 'Телефон длиннее 50 символов'),
  comment: z.string().trim().max(2000, 'Комментарий длиннее 2000 символов').optional(),
  plan_id: z.string().trim().max(64, 'ID плана длиннее 64 символов').optional(),
  // См. пояснение у createLeadArgsSchema: обязателен в обоих источниках.
  consent: consentField,
});

/**
 * Тур без расписания: вместо заявки менеджеру — запрос мест оператору в его
 * мессенджер (ответ одним нажатием, срок 2 часа). Согласие на ПД — тот же
 * допуск `admitWrite`, что у обеих заявок. Ответ агенту говорит, что запрос
 * ушёл и что это не бронь: бронь заводится только если оператор ответит
 * «Есть места», и ссылка на страницу статуса — единственное, что нужно
 * передать человеку.
 */
async function requestSeatsFromOperator(a: {
  ctx: McpCallContext; tourId: number; tourTitle: string; date: string; participants: number;
  name: string; phone: string; hasComment: boolean; consent: boolean | undefined;
}): Promise<string> {
  const pd_consent = await admitWrite(a.ctx, BOOKING_REQUEST_TOOL.name, a.phone, a.consent);
  if (!pd_consent) throw new McpUserError('Согласие на обработку персональных данных не получено — запрос не отправлен.', 'no_consent');
  const result = await createSeatRequest({
    tourId: a.tourId,
    date: a.date,
    participants: a.participants,
    touristName: a.name,
    touristPhone: a.phone,
    replyChannel: 'phone',
    pdConsent: pd_consent,
    source: 'mcp',
  });
  if (!result.ok) {
    // «Запрос уже отправлен» и «у вас уже есть подтверждённая бронь» — одним
    // текстом: второй говорил бы анониму, знающему номер, где его владелец
    // будет в этот день (проверка MCP 29.09).
    const reason = result.reason === 'already_confirmed' ? 'duplicate' : result.reason;
    // Сбой проверки или доставки — не деловой исход, а отказ: isError и
    // ok=false в журнале (до 29.09 журнал считал его успехом).
    if (reason === 'check_failed' || reason === 'delivery_failed') {
      const failure = SEAT_REQUEST_FAILURE[reason]!;
      throw new McpUserError(`${failure.error} Запрос мест по туру "${a.tourTitle}" на ${a.date} не отправлен. Можно оставить заявку через create_lead.`, `seats_${reason}`);
    }
    const failure = reason === 'duplicate'
      ? { error: 'По этому телефону запрос на этот тур и дату уже есть — повторно не отправляю; ответ придёт по ссылке, выданной в первый раз.' }
      : SEAT_REQUEST_FAILURE[reason] ?? SEAT_REQUEST_FAILURE.check_failed!;
    return `${failure.error} Запрос мест по туру "${a.tourTitle}" на ${a.date} не отправлен. Можно оставить заявку через create_lead — менеджер свяжется с оператором сам.`;
  }
  const deadline = result.deadlineAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka' });
  const statusKey = await issueRequestKey({ seatRequestId: result.requestId }, BOOKING_REQUEST_TOOL.name);
  return `У тура "${a.tourTitle}" нет расписания в системе, поэтому места на ${a.date} (${a.participants} чел.) уточняются у оператора: запрос отправлен ему в мессенджер, ответ будет до ${deadline} по Камчатке. `
    + `Места этим запросом НЕ закреплены, и это не оплата: если оператор ответит «Есть места», заявка подтвердится, ${seatRequestPaymentNote()}. `
    + `Передайте человеку эту ссылку (в ней ключ доступа, храните её только у него): ${statusUrl(result.statusToken)} `
    + (a.hasComment ? 'Комментарий оператору не передан — в запросе мест только тур, дата и число человек. ' : '')
    + 'Если оператор не ответит за 2 часа, это не значит, что мест нет — можно оставить заявку через create_lead.'
    + keyLine(statusKey);
}

/**
 * Новая MCP-заявка на бронь — ЛИЧНО оператору тура, а не только в рабочий
 * чат платформы (тот уходит из createLead). До этого вызова заявка из
 * внешнего ИИ ложилась оператору в кабинет молча: он узнавал о ней, только
 * зайдя сам (аудит партнёрского пути 18.10, блокер пилота). Механика — та же,
 * что у формы на сайте: notifyPartnerNewLeadPersonally + исход доставки в
 * журнал заявки (recordPartnerDelivery), чтобы «дошла ли» отвечалось данными.
 *
 * Ответ агенту уведомления не ждёт (fire-and-forget, как в /api/leads), а
 * отказ не глушится: исход назван функцией доставки, сбой записи — здесь.
 * Повтор за 24 ч и свой заход владельца оператора не будят: заявка уже
 * доставлена первым вызовом, а self-лид — проверка, не спрос.
 */
function notifyPartnerPersonallyAboutMcpLead(params: {
  operatorId: string;
  leadId: string;
  name: string;
  phone: string;
  comment?: string;
  routeTitle?: string;
}): void {
  void (async () => {
    const outcome = await notifyPartnerNewLeadPersonally({
      ...params,
      origin: 'заявка через ИИ-ассистента (MCP)',
    });
    await recordPartnerDelivery(params.leadId, params.operatorId, outcome);
  })().catch((e: unknown) => {
    console.error(`[mcp] личное уведомление оператора о заявке ${params.leadId} не отправлено:`, e instanceof Error ? e.message : e);
  });
}

async function executeCreateBookingRequest(rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<string> {
  const parsed = bookingRequestArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpUserError(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки', `invalid_args:${String(parsed.error.issues[0]?.path?.[0] ?? '').slice(0, 20)}`);
  }
  const { tour: tourQuery, date, participants, name, comment } = parsed.data;

  // Аудит 08.08, замечание 2: телефон нормализуется, мусор не проходит —
  // заявка без дозвонного номера бесполезна менеджеру.
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    throw new McpUserError('Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.', 'bad_phone');
  }

  const { resolveTourChoice, candidateLines, choiceListLines, choiceListReason } = await import('@/lib/kuzmich/tour-availability-tool');
  // Отказ базы — не «тур не найден»: заявка не создаётся, агент знает, что
  // это сбой, а не отсутствие тура (проверка MCP 29.09).
  const choice = await resolveTourChoice(tourQuery).catch(() => {
    throw new McpUserError('Не удалось проверить тур — заявка не создана, повторите позже.', 'tour_lookup_failed');
  });
  if (choice.kind === 'none') {
    return `Тур по запросу "${tourQuery}" не найден среди активных — заявка не создана. Уточните тур через get_tours или get_tour_availability.`;
  }
  // Туры нескольких компаний (слово владельца 29.10, «1в 2б 3 да»): пишущий
  // инструмент продавца не выбирает. До 29.10 заявка уходила той компании,
  // чьё название короче, — телефон человека получал продавец, которого он не
  // называл. Теперь заявки нет, пока агент не передаст номер тура.
  if (choice.kind === 'ambiguous') {
    return [
      `По запросу «${tourQuery}» подходят туры разных компаний — заявка не создана. Повторите create_booking_request с номером тура (поле tour):`,
      ...candidateLines(choice.candidates),
      'Порядок списка — правило платформы, а не рекомендация. Спросите человека, какой тур и какая компания ему нужны.',
    ].join('\n');
  }
  // Имя продавца вместо тура или совпала только часть слов (ловушка MCP
  // 29.10, name-search): заявки нет ни при каком числе компаний. До 29.10
  // имя компании из двух слов находило по одному общему слову туры ДРУГОЙ
  // компании, и будь она одна — заявка с телефоном человека уходила ей.
  if (choice.kind === 'seller' || choice.kind === 'weak') {
    return [
      `По запросу «${tourQuery}» ${choiceListReason(choice)} — заявка не создана. Повторите create_booking_request с номером тура (поле tour).`,
      ...choiceListLines(tourQuery, choice),
      'Спросите человека, какой тур ему нужен; не выбирайте тур и компанию за него.',
    ].join('\n');
  }
  const tour = choice.tour;

  // Несуществующая дата (2027-02-30) проходила регулярку и падала в базе
  // с 22008 — общим «внутренняя ошибка» вместо внятного отказа (29.09).
  if (!isRealDate(date)) {
    throw new McpUserError(`Даты ${date} нет в календаре — заявка не создана. Проверьте дату.`, 'date_not_in_calendar');
  }

  // Прошедшая дата — по Камчатке: по UTC с 12:00 до 24:00 заявка на уже
  // прошедший там день принималась и уходила менеджеру (проверка MCP 29.09).
  const today = kamchatkaToday();
  if (date < today) {
    return `Дата ${date} уже прошла — заявка не создана. Свободные даты: get_tour_availability.`;
  }

  const { createPlannerCache, fetchAvailabilityForTour } = await import('@/lib/planner');
  const cache = createPlannerCache();
  const slots = await fetchAvailabilityForTour(String(tour.id), date, date, cache);
  const remaining = slots[0]?.remaining ?? 0;
  if (remaining < participants) {
    // Расписание есть, а мест на дату нет — честный отказ ниже. Расписания
    // нет вовсе (оператор берёт туристов без календаря) — «нет мест» было бы
    // ложью, и вместо отказа уходит запрос оператору.
    const keepsSchedule = await tourKeepsSchedule(Number(tour.id));
    if (keepsSchedule === null) {
      throw new McpUserError('Не удалось проверить расписание тура — заявка не создана, попробуйте позже.', 'schedule_lookup_failed');
    }
    if (!keepsSchedule) {
      // Только по сезону (#2244, #2245): дата вне сезона до оператора не
      // доходит, и агент слышит окно словами, а не общий отказ.
      const window = requestWindow({
        season_start: tour.season_start ?? null, season_end: tour.season_end ?? null,
        duration_type: tour.duration_type ?? null, multi_day_count: tour.multi_day_count ?? null,
        duration_hours: tour.duration_hours ?? null,
      }, today);
      if (window.kind === 'season' && !dateInWindow(window, date)) {
        return `${outOfSeasonText(window, date)} Заявка не создана — предложите дату внутри сезона.`;
      }
      return requestSeatsFromOperator({ ctx, tourId: Number(tour.id), tourTitle: tour.title, date, participants, name, phone, hasComment: Boolean(comment), consent: parsed.data.consent });
    }
    // Честный отказ с альтернативами вместо фантомной заявки на несуществующие места.
    const horizon = new Date(Date.parse(date) + 30 * 86400000).toISOString().slice(0, 10);
    const nearest = (await fetchAvailabilityForTour(String(tour.id), today, horizon, cache))
      .filter((s) => s.remaining >= participants)
      .slice(0, 5)
      .map((s) => `${s.date} (${s.remaining} мест)`);
    return `На ${date} у тура "${tour.title}" ${remaining === 0 ? 'нет свободных мест' : `только ${remaining} мест, а нужно ${participants}`} — заявка не создана. ` +
      (nearest.length > 0 ? `Ближайшие даты с местами: ${nearest.join(', ')}.` : 'В ближайшие 30 дней подходящих дат нет — предложите другой тур.');
  }

  const leadComment = `[Заявка на бронь] Тур "${tour.title}" (ID${tour.id}), дата ${date}, участников ${participants}.`
    + (comment ? ` ${comment}` : '');
  // План, частью которого стоит тур (#2304, шаг 2): оператор видит поездку
  // целиком. Не приложился — заявка всё равно идёт, и агент это слышит.
  const planAttach = await planFromDraft(parsed.data.plan_id);
  const leadSource = { source: 'mcp', tool: 'create_booking_request', tour_id: tour.id, date, participants, ...planSourceFields(planAttach) };
  refuseSilentLead(name, phone, leadComment, leadSource);

  const pd_consent = await admitWrite(ctx, BOOKING_REQUEST_TOOL.name, phone, parsed.data.consent);

  // Аудит 08.08, замечание 3 — явная идемпотентность по (телефон, тур, дата):
  // общий дедуп createLead требует ТОЧНОГО совпадения комментария, а агент при
  // ретрае может переформулировать. Ключ — детерминированный префикс комментария;
  // SQL живёт в домене лидов (lib/leads/create), не здесь — у MCP своего движка нет.
  //
  // Проверка стоит ПОСЛЕ согласия и сторожа записи, а ответ не называет номер
  // заявки. Раньше она шла первой: любой, кто знает телефон, без согласия и
  // вне лимита записи узнавал, что его владелец просил бронь такого тура на
  // такую дату, и номер его заявки (152-ФЗ; проверка MCP 29.09).
  //
  // Ответ на дубль СОВПАДАЕТ с ответом на новую заявку, и номера нет ни в
  // одном: любой различимый ответ — оракул «этот телефон уже просил этот тур
  // на эту дату» (проверка MCP 29.09). Для агента правда одна: заявка принята,
  // оператор позвонит. Номер заявки человеку ни для чего не нужен — звонят ему.
  // Состав группы в ответе не повторяется: на дубле он взят бы из НОВОГО
  // вызова, а в заявке остался прежний (скептик проверки 29.09).
  const accepted = `Заявка оператору принята: "${tour.title}", ${date}. Сейчас на эту дату свободно ${remaining} мест. `
    + `Оператор перезвонит по телефону ${phone}, подтвердит заявку и состав группы — если число людей или пожелания изменились, `
    + 'человеку стоит сказать об этом при звонке. Это заявка, не оплата.'
    + planAttachNote(planAttach);
  const bookingPrefix = `[Заявка на бронь] Тур "${tour.title}" (ID${tour.id}), дата ${date},`;
  const existing = await findRecentLeadByCommentPrefix(phone, bookingPrefix);
  // Повтор (тот же телефон, тур и дата за 24 ч) идёт тем же выходом, что и
  // новая заявка: текст тот же, второго лида нет, а ключ статуса — свой на
  // каждый вызов (случайный, новую от прежней он не отличает).
  const leadId = existing ?? await createLead({
    name,
    phone,
    comment: leadComment,
    route_title: tour.title,
    // Оператор тура известен — заявка ложится ему. Без него лид оставался
    // без оператора: тот его не видел, а подбор по заявке предлагал туры
    // конкурентов (проверка MCP 29.09, W1).
    operator_id: tour.operator_id ?? undefined,
    source_url: 'mcp://vedar/booking',
    source_data: leadSource,
    pd_consent,
    is_self: ctx.self,
  });
  if (!leadId) {
    throw new McpUserError('Не удалось сохранить заявку — попробуйте позже', 'save_failed');
  }
  // Оператор тура известен, и заявка — ему: лично, как с формы на сайте.
  if (!existing && !ctx.self && tour.operator_id) {
    notifyPartnerPersonallyAboutMcpLead({
      operatorId: tour.operator_id,
      leadId,
      name,
      phone,
      comment: leadComment,
      routeTitle: tour.title,
    });
  }
  return accepted + keyLine(await issueRequestKey({ leadId }, BOOKING_REQUEST_TOOL.name));
}

// ── request_charter (решение владельца 10.10) ─────────────────
// Заявка на машину целиком у перевозчика «под заказ». Календаря у него нет,
// направление и дни задаёт заказчик: занятость не проверяется (система её не
// ведёт), «нет машин» не отвечаем. Заявка — лид менеджеру с operator_id
// перевозчика (createLead: скоринг, дедуп, уведомление, клиент в CRM
// перевозчика); бронь и оплата отсюда не заводятся.
const charterRequestArgsSchema = z.object({
  destination: z.string().trim().min(2, 'Укажите, куда ехать').max(200, 'Направление длиннее 200 символов'),
  date_from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата выезда в формате YYYY-MM-DD'),
  date_to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата возвращения в формате YYYY-MM-DD').optional(),
  passengers: z.coerce.number({ error: 'Число человек — целое число, например 8' })
    .int('Число человек — целое число')
    .min(1, 'Человек не меньше одного')
    .max(60, 'Не больше 60 человек в одной заявке'),
  name: personName,
  phone: z.string().trim().min(5, 'Телефон обязателен — заявку подтверждают по нему').max(50, 'Телефон длиннее 50 символов'),
  carrier: z.string().trim().max(120, 'Название перевозчика длиннее 120 символов').optional(),
  comment: z.string().trim().max(2000, 'Комментарий длиннее 2000 символов').optional(),
  consent: consentField,
});

async function executeRequestCharter(rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<string> {
  const parsed = charterRequestArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpUserError(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки', `invalid_args:${String(parsed.error.issues[0]?.path?.[0] ?? '').slice(0, 20)}`);
  }
  const { destination, date_from: dateFrom, passengers, name } = parsed.data;
  const dateTo = parsed.data.date_to ?? null;
  const comment = parsed.data.comment || null;

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    throw new McpUserError('Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.', 'bad_phone');
  }

  // Даты — по Камчатке, как у заявки на бронь: по UTC с 12:00 до 24:00 прошедший
  // там день принимался бы как сегодняшний. Правило — общее с формой на
  // странице перевозчика (charter-request-service); тексты агенту — свои.
  const dates = checkCharterDates(dateFrom, dateTo, kamchatkaToday());
  if (!dates.ok) {
    switch (dates.reason) {
      case 'not_in_calendar':
        throw new McpUserError('Такой даты нет в календаре — заявка не создана. Проверьте даты.', 'date_not_in_calendar');
      case 'past':
        return `Дата выезда ${dateFrom} уже прошла — заявка не создана. Назовите дату не раньше ${dates.today}.`;
      case 'too_far':
        return `Дата выезда ${dateFrom} слишком далека: прайс перевозчика годовой — заявка не создана. Назовите дату в пределах ${dates.maxDaysAhead} дней.`;
      case 'bad_return':
        return `Дата возвращения ${dateTo} не может быть раньше выезда или позже чем через ${dates.maxTripDays} дн. — заявка не создана. Уточните даты.`;
    }
  }

  // Отказ базы — не «перевозчиков нет»: заявка не создаётся, агент знает, что
  // это сбой нашей стороны (§4.0, как с турами).
  const carriers = await loadCharterCarriers().catch((err: unknown) => {
    console.error('[mcp/request_charter] перевозчики не прочитаны', (err as { code?: string } | null)?.code ?? '', err instanceof Error ? err.message : err);
    throw new McpUserError('Не удалось проверить перевозчиков — заявка не создана, повторите позже.', 'charter_lookup_failed');
  });
  const pick = pickCarrier(carriers, parsed.data.carrier);
  if (pick.kind === 'none') {
    return 'Перевозчиков «под заказ» с прайсом сейчас нет в системе — заявка не создана. Можно оставить заявку на подбор через create_lead.';
  }
  if (pick.kind === 'ambiguous') {
    return `Перевозчиков несколько (${pick.names.join(', ')}) — укажите, кому адресовать заявку (параметр carrier). Заявка не создана.`;
  }
  if (pick.kind === 'unknown') {
    return `Перевозчик «${parsed.data.carrier}» не найден среди тех, у кого есть прайс (${pick.names.join(', ')}). Заявка не создана.`;
  }
  const carrier = pick.carrier;

  const plan = planCharterRequest(carrier, destination, passengers);
  if (plan.kind === 'too_many') {
    return `В парке «${carrier.name}» всего ${plan.seatsTotal} мест, а нужно ${passengers} — заявка не создана. Разделите группу на несколько поездок или уточните число человек.`;
  }
  if (plan.kind === 'ambiguous') {
    return `Под «${destination}» в прайсе «${carrier.name}» подходит несколько направлений: ${plan.options.join('; ')}. Уточните, какое нужно, — заявка не создана.`;
  }
  const facts = { carrier, plan, destination, dateFrom, dateTo, passengers, comment };

  const lead = buildCharterLead(facts, 'mcp');
  refuseSilentLead(name, phone, lead.comment, lead.sourceData);

  // Телефон уходит перевозчику — согласие записывается текстом, который его и
  // называет (purpose 'carrier', 13.10; до этого — версия «туроператору»).
  const pd_consent = await admitWrite(ctx, REQUEST_CHARTER_TOOL.name, phone, parsed.data.consent, 'carrier');

  // Ответ на повтор совпадает с ответом на новую заявку (оракул «этот телефон
  // уже просил эту машину»): см. charterAcceptedText и заявку на бронь.
  // Повтор и запись — общим путём с формой на странице перевозчика.
  const accepted = charterAcceptedText(facts, phone, getPublicBaseUrl());
  const leadId = await saveCharterLead({
    facts, lead, name, phone, consent: pd_consent, isSelf: ctx.self, sourceUrl: 'mcp://vedar/charter',
  });
  if (!leadId) {
    throw new McpUserError('Не удалось сохранить заявку — попробуйте позже', 'save_failed');
  }
  return accepted + keyLine(await issueRequestKey({ leadId }, REQUEST_CHARTER_TOOL.name));
}

// ── create_car_rental_request (владелец 23.10) ─────────────────
// Заявка прокатчику на машину без водителя — тем же путём, что форма на
// странице прокатчика (lib/rental/rental-request-service): даты, лид, повтор,
// личная доставка прокатчику (в Telegram — без ПД, заглушкой). Машина — строка
// прайса этого прокатчика: чужой текст машиной не становится. test: true —
// пробная заявка: помечена, вне счёта спроса, прокатчику не уходит.
const carRentalRequestArgsSchema = z.object({
  company: z.string().trim().max(100, 'Название прокатчика длиннее 100 символов').optional(),
  car: z.string().trim().min(1, 'Укажите машину из прайса search_car_rental').max(120, 'Название машины длиннее 120 символов'),
  date_from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата начала аренды в формате YYYY-MM-DD'),
  date_to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата возврата в формате YYYY-MM-DD'),
  pickup: z.string().trim().max(200, 'Место получения длиннее 200 символов').optional(),
  name: personName,
  phone: z.string().trim().min(5, 'Телефон обязателен — заявку подтверждают по нему').max(50, 'Телефон длиннее 50 символов'),
  comment: z.string().trim().max(1000, 'Комментарий длиннее 1000 символов').optional(),
  test: z.boolean().optional(),
  confirmation: z.string().trim().max(64, 'Код подтверждения длиннее 64 символов').optional(),
  consent: consentField,
});

const lc = (v: string) => v.toLowerCase().replace(/ё/g, 'е').trim();

/** Прокатчик по названию или slug; один на платформе — он и есть. */
function pickRentalCompany(companies: RentalCompany[], want: string | undefined):
  | { kind: 'ok'; company: RentalCompany } | { kind: 'none' } | { kind: 'ambiguous' | 'unknown'; names: string[] } {
  if (companies.length === 0) return { kind: 'none' };
  const names = companies.map((c) => c.name);
  if (!want) return companies.length === 1 ? { kind: 'ok', company: companies[0] } : { kind: 'ambiguous', names };
  const w = lc(want);
  const hit = companies.find((c) => lc(c.slug) === w || lc(c.name) === w)
    ?? companies.find((c) => lc(c.name).includes(w) || w.includes(lc(c.name)));
  return hit ? { kind: 'ok', company: hit } : { kind: 'unknown', names };
}

/** Машина прайса: точное название, без регистра, или единственная по словам. */
function pickRentalOffer(offers: RentalOffer[], want: string): RentalOffer | RentalOffer[] {
  const exact = offers.find((o) => o.title === want) ?? offers.find((o) => lc(o.title) === lc(want));
  if (exact) return exact;
  const hits = matchOffers(offers, want);
  return hits.length === 1 ? hits[0] : hits;
}

async function executeCarRentalRequest(rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<string> {
  const parsed = carRentalRequestArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpUserError(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки', `invalid_args:${String(parsed.error.issues[0]?.path?.[0] ?? '').slice(0, 20)}`);
  }
  const { date_from: dateFrom, date_to: dateTo, name } = parsed.data;
  const isTest = parsed.data.test === true;
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    throw new McpUserError('Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.', 'bad_phone');
  }

  const dates = checkRentalDates(dateFrom, dateTo, kamchatkaToday());
  if (!dates.ok) {
    switch (dates.reason) {
      case 'not_in_calendar':
        throw new McpUserError('Такой даты нет в календаре — заявка не создана. Проверьте даты.', 'date_not_in_calendar');
      case 'past':
        return `Дата начала аренды ${dateFrom} уже прошла — заявка не создана. Назовите дату не раньше ${dates.today}.`;
      case 'too_far':
        return `Дата начала аренды ${dateFrom} слишком далека: прайс прокатчика годовой — заявка не создана. Назовите дату в пределах ${dates.maxDaysAhead} дней.`;
      case 'bad_return':
        return `Дата возврата ${dateTo} не может быть раньше начала или позже чем через ${dates.maxDays} дн. — заявка не создана. Уточните даты.`;
    }
  }

  const companies = await loadRentalCompanies().catch((err: unknown) => {
    console.error('[mcp/create_car_rental_request] прокатчики не прочитаны', (err as { code?: string } | null)?.code ?? '', err instanceof Error ? err.message : err);
    throw new McpUserError('Не удалось проверить прокатчиков — заявка не создана, повторите позже.', 'rental_lookup_failed');
  });
  const pick = pickRentalCompany(companies, parsed.data.company);
  if (pick.kind === 'none') return 'Прокатчиков с прайсом сейчас нет на платформе — заявка не создана. Можно оставить заявку на подбор через create_lead.';
  if (pick.kind === 'ambiguous') return `Прокатчиков несколько (${pick.names.join(', ')}) — укажите, кому адресовать заявку (параметр company). Заявка не создана.`;
  if (pick.kind !== 'ok') return `Прокатчик «${parsed.data.company}» не найден среди тех, у кого есть прайс (${pick.names.join(', ')}). Заявка не создана.`;
  const company = pick.company;

  const offer = pickRentalOffer(company.offers, parsed.data.car);
  if (Array.isArray(offer)) {
    const list = (offer.length > 1 ? offer : company.offers).map((o) => o.title).join(', ');
    return `Машины «${parsed.data.car}» нет в прайсе «${company.name}» как одной строки — назовите одну из: ${list}. Заявка не создана.`;
  }

  const notes = [
    isTest ? 'ТЕСТ — пробная заявка, прокатчику не передаётся' : '',
    parsed.data.pickup ? `где забрать: ${parsed.data.pickup}` : '',
    parsed.data.comment ?? '',
  ].filter(Boolean).join('; ');
  const facts = { company, offer, dateFrom, dateTo, days: rentalDays(dateFrom, dateTo), comment: notes || null };
  const lead = buildRentalLead(facts, 'mcp');
  if (parsed.data.pickup) lead.sourceData.pickup = parsed.data.pickup;
  // Пробная живёт под своим ключом повтора: настоящая заявка с тем же
  // телефоном и датой не должна склеиться с ней и остаться недоставленной.
  const TEST_MARK = 'ТЕСТ. ';
  if (isTest) { lead.sourceData.test = true; lead.comment = TEST_MARK + lead.comment; }
  refuseSilentLead(name, phone, lead.comment, lead.sourceData);

  // Два шага: без кода — черновик человеку, заявка не создаётся. Согласие
  // ставит человек, а не агент; код привязан к полям заявки.
  const confirmFields: RentalConfirmFields = {
    company: company.slug, car: offer.title, dateFrom, dateTo, name, phone,
    pickup: parsed.data.pickup ?? '', comment: parsed.data.comment ?? '', test: isTest,
  };
  const draft = `${isTest ? 'Пробная заявка (тест, прокатчику не передаётся)' : 'Заявка'}: ${offer.title} у «${company.name}», с ${dateFrom} по ${dateTo} (${facts.days} сут.)`
    + `${parsed.data.pickup ? `, где забрать: ${parsed.data.pickup}` : ''}; имя: ${name}, телефон: ${phone}.`;
  const askHuman = 'Покажи это человеку и прямо спроси: «Согласны ли вы на обработку имени и телефона и их передачу прокатчику и отправить заявку?» '
    + 'Только после явного «да» самого человека повтори вызов с теми же полями, consent: true и confirmation';
  if (!parsed.data.confirmation) {
    const code = issueRentalConfirmation(confirmFields);
    if (!code) throw new McpUserError('Подтверждение заявок временно недоступно — заявка не создана, повторите позже.', 'confirm_unavailable');
    return `Черновик, заявка ещё НЕ создана. ${draft} ${askHuman}: "${code}" (код действует ${RENTAL_CONFIRM_TTL_MIN} мин). Не ставь consent: true сам и не придумывай имя и телефон.`;
  }
  const check = checkRentalConfirmation(parsed.data.confirmation, confirmFields);
  if (check === 'unavailable') throw new McpUserError('Подтверждение заявок временно недоступно — заявка не создана, повторите позже.', 'confirm_unavailable');
  if (check !== 'ok') {
    const code = issueRentalConfirmation(confirmFields);
    return `Код подтверждения ${check === 'expired' ? 'истёк' : 'не подходит к этим данным (поля изменились)'} — заявка не создана. Новый черновик: ${draft} ${askHuman}: "${code}".`;
  }
  if (parsed.data.consent !== true) {
    return `Без согласия человека заявка не создаётся. ${draft} ${askHuman}: "${parsed.data.confirmation}".`;
  }

  // Телефон уходит прокатчику — согласие текстом, который его и называет.
  const pd_consent = await admitWrite(ctx, CAR_RENTAL_REQUEST_TOOL.name, phone, parsed.data.consent, 'rental');
  const leadId = await saveRentalLead({
    facts, lead, name, phone, consent: pd_consent,
    // Пробная заявка — как свой визит владельца: с пометкой, вне счёта спроса, прокатчика не будит.
    isSelf: ctx.self || isTest,
    sourceUrl: 'mcp://vedar/car-rental',
    ...(isTest ? { dedupPrefix: TEST_MARK + rentalDedupPrefix(company.name, dateFrom) } : {}),
  });
  if (!leadId) throw new McpUserError('Не удалось сохранить заявку — попробуйте позже', 'save_failed');

  // Журнал CRM прокатчика: без имени и телефона.
  await recordSourceEventQuietly({
    kind: 'change', sourceKind: 'lead', sourceId: leadId, actorKind: 'mcp',
    title: `${isTest ? 'Пробная заявка' : 'Заявка'} на прокат из MCP: ${offer.title}, ${dateFrom} — ${dateTo}`,
    payload: { tool: CAR_RENTAL_REQUEST_TOOL.name, car: offer.title, date_from: dateFrom, date_to: dateTo, days: facts.days, test: isTest },
  });

  const price = `${offer.priceIsFrom ? 'от ' : ''}${offer.priceRubPerDay} руб за сутки`;
  const accepted = `${isTest ? 'Пробная заявка принята (помечена как тест, прокатчику не передаётся)' : 'Заявка принята'}: ${offer.title} у «${company.name}», с ${dateFrom} по ${dateTo} (${facts.days} сут.), по прайсу ${price}`
    + `${offer.depositRub !== null ? `, залог ${offer.depositRub} руб` : ''}. Это заявка, не бронь: менеджер Ведара свяжется по телефону ${phone} и подтвердит с прокатчиком; оплаты через платформу нет, расчёт напрямую с прокатчиком. Страница прокатчика: ${getPublicBaseUrl()}${rentalPagePath(company.slug)}`;
  return accepted + keyLine(await issueRequestKey({ leadId }, CAR_RENTAL_REQUEST_TOOL.name));
}

async function executeCreateLead(rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<string> {
  const parsed = createLeadArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpUserError(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки', `invalid_args:${String(parsed.error.issues[0]?.path?.[0] ?? '').slice(0, 20)}`);
  }
  const { name, comment, interest } = parsed.data;
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    throw new McpUserError('Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.', 'bad_phone');
  }
  const leadComment = interest ? `[Интерес: ${interest}] ${comment}` : comment;
  // План по plan_id (#2304, шаг 2): менеджер получает поездку целиком.
  const planAttach = await planFromDraft(parsed.data.plan_id);
  const leadSource = { source: 'mcp', ...planSourceFields(planAttach) };
  refuseSilentLead(name, phone, leadComment, leadSource);
  const pd_consent = await admitWrite(ctx, CREATE_LEAD_TOOL.name, phone, parsed.data.consent);
  const leadId = await createLead({
    name,
    phone,
    comment: leadComment,
    source_url: 'mcp://vedar',
    source_data: leadSource,
    pd_consent,
    is_self: ctx.self,
    // Заказ машины через create_lead (10.10: две вахтовки на Горелый) — не
    // подбор тура: менеджеру уходит как есть, без AI-подбора туров к нему.
    skip_ai_processing: isVehicleOrder(leadComment),
  });
  if (!leadId) {
    throw new McpUserError('Не удалось сохранить заявку — попробуйте позже', 'save_failed');
  }
  // Номер не называется, как и у заявки на бронь: createLead на точном дубле
  // возвращает номер ПРЕЖНЕЙ заявки, и совпавший номер подтверждал бы, что
  // такой телефон с таким текстом уже писал (проверка MCP 29.09).
  return 'Заявка принята. Менеджер Ведара свяжется по указанному телефону.' + planAttachNote(planAttach)
    + keyLine(await issueRequestKey({ leadId }, CREATE_LEAD_TOOL.name));
}

/**
 * Заявка, которую createLead закроет сразу (балл ниже LOW_QUALITY_SCORE:
 * processed_at, без уведомления), — отказ ДО записи, а не «менеджер
 * свяжется». До 29.09 агент обещал человеку звонок по заявке, которую
 * никто не увидит (например, имя из двух букв — балл 5).
 */
function refuseSilentLead(name: string, phone: string, comment: string, sourceData: Record<string, unknown>): void {
  if (computeQuickScore(name, phone, comment, sourceData) < LOW_QUALITY_SCORE) {
    throw new McpUserError(
      'Заявка слишком неполная — менеджер её не увидит, поэтому не создаю. Укажите имя и фамилию человека '
      + 'и опишите запрос подробнее: даты, число людей, что интересует.',
      'silent_lead',
    );
  }
}


// ── Execute tool by name ─────────────────────────────────────
// ── create_stay_request (решение владельца 10.10) ─────────────
// Заявка хозяину жилья — тот же путь, что форма на карточке объекта: какие
// объекты её принимают, запись с согласием, доставка хозяину в MAX и
// оператору платформы (lib/stay/stay-request-service). Отличие одно —
// согласие: здесь его даёт человек словами ассистенту, и ассистент передаёт
// consent: true; записывается вариант текста «владельцу жилья».
const stayRequestArgsSchema = z.object({
  accommodation: z.string().trim().min(1, 'Укажите объект: название или ID из search_accommodations').max(200, 'Название объекта длиннее 200 символов'),
  check_in: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата заезда в формате YYYY-MM-DD'),
  check_out: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата выезда в формате YYYY-MM-DD'),
  guests: z.coerce.number({ error: 'Число гостей — целое число, например 4' })
    .int('Число гостей — целое число')
    .min(1, 'Гостей не меньше одного')
    .max(50, 'Не больше 50 гостей в одной заявке')
    .default(1),
  name: personName,
  phone: z.string().trim().min(5, 'Телефон обязателен — по нему перезвонит владелец').max(50, 'Телефон длиннее 50 символов'),
  comment: z.string().trim().max(1000, 'Комментарий длиннее 1000 символов').optional(),
  consent: consentField,
});

async function executeCreateStayRequest(rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<string> {
  const parsed = stayRequestArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpUserError(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки', `invalid_args:${String(parsed.error.issues[0]?.path?.[0] ?? '').slice(0, 20)}`);
  }
  const { accommodation, check_in, check_out, guests, name, comment } = parsed.data;
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    throw new McpUserError('Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.', 'bad_phone');
  }
  if (!isRealDate(check_in) || !isRealDate(check_out)) {
    throw new McpUserError('Такой даты нет в календаре — заявка не создана. Проверьте даты заезда и выезда.', 'date_not_in_calendar');
  }
  const dates = checkStayDates(check_in, check_out, kamchatkaToday());
  if (!dates.ok) {
    throw new McpUserError(`${dates.error} — заявка не создана.`, `bad_dates:${dates.field}`);
  }

  // Отказ базы — не «объект не найден» (§4.0).
  const found = await resolveStayForRequest(accommodation).catch((err: unknown) => {
    const code = (err as { code?: unknown })?.code;
    console.error('[mcp] create_stay_request: объект не проверен,', `SQLSTATE=${typeof code === 'string' ? logText(code, 10) : 'нет'}`);
    throw new McpUserError('Не удалось проверить объект — заявка не создана, повторите позже.', 'stay_lookup_failed');
  });
  const base = getPublicBaseUrl();
  if (found.kind === 'not_found') {
    return `Жильё по запросу "${accommodation}" не найдено среди опубликованных — заявка не создана. Найдите объект через search_accommodations и передайте его название или ID.`;
  }
  if (found.kind === 'ambiguous') {
    return `Под "${accommodation}" подходит несколько объектов: ${found.names.join('; ')}. Заявка не создана — передайте точное название или ID.`;
  }
  if (found.kind === 'other_path') {
    const where = found.path === 'site' ? 'бронь и свободные даты — на сайте объекта, ссылка на карточке'
      : found.path === 'rooms' ? 'у него свои номера на платформе — бронь номера на карточке'
      : 'телефона владельца на платформе нет';
    return `"${found.name}" заявку владельцу через Ведар не принимает: ${where}. Карточка: ${base}/accommodations/${found.id}. Заявка не создана.`;
  }

  // Согласие и квота записи — после всех проверок без ПД, как у заявки на тур.
  const consent = await admitWrite(ctx, STAY_REQUEST_TOOL.name, phone, parsed.data.consent, 'stay');
  if (!consent) throw new McpUserError('Согласие на обработку персональных данных не получено — заявка не отправлена.', 'no_consent');
  const r = await submitStayRequest({
    accommodationId: found.id,
    checkIn: check_in,
    checkOut: check_out,
    nights: dates.nights,
    guests,
    guestName: name,
    guestPhone: phone,
    comment: comment || null,
    consent,
    door: 'mcp',
  });
  if (!r.ok) {
    if (r.reason === 'not_accepting') {
      // Объект сняли или завели номера между поиском и записью.
      return `"${found.name}" сейчас заявку владельцу не принимает — заявка не создана. Карточка: ${base}/accommodations/${found.id}.`;
    }
    throw new McpUserError(`Не удалось сохранить заявку — попробуйте позже или позвоните владельцу: телефон на карточке ${base}/accommodations/${found.id}.`, 'save_failed');
  }
  // Три исхода доставки (lib/stay/stay-request). «Не дошло никому» — отказ:
  // строка записана, но обещать человеку звонок нельзя.
  if (r.delivered === 'none') {
    throw new McpUserError(`Заявка записана, но передать её владельцу сейчас не удалось. Пусть человек позвонит владельцу сам: телефон на карточке ${base}/accommodations/${found.id}.`, 'stay_delivery_failed');
  }
  const who = r.delivered === 'owner'
    ? 'владельцу в мессенджер'
    : 'оператору Ведара — владелец пока не подключил мессенджер, оператор передаст заявку ему';
  // Телефон человека в ответ не повторяется: ответ уходит в модель (pd-guard).
  // Ключ статуса — как у трёх других пишущих инструментов (1238): по нему
  // агент узнаёт, кому передана заявка, а человек сам подтверждает согласие.
  return `Заявка передана ${who}: "${r.accommodationName}", заезд ${check_in}, выезд ${check_out} (ночей: ${dates.nights}), гостей ${guests}. `
    + 'Владелец перезвонит по указанному телефону и подтвердит даты и цену. Это заявка, не бронь и не оплата: расчёт — напрямую с владельцем. '
    + `Карточка объекта: ${base}/accommodations/${found.id}.`
    + keyLine(await issueRequestKey({ stayRequestId: r.requestId }, STAY_REQUEST_TOOL.name), 'stay');
}

// Имя проверено вызывающим (неизвестный инструмент — ошибка протокола
// -32602, а не результат с isError: так велит спецификация tools).
async function executeTool(
  name: string,
  read: ReadArguments,
  ctx: McpCallContext,
): Promise<string> {
  const rawArgs = read.args;
  if (name === CREATE_LEAD_TOOL.name) {
    return executeCreateLead(rawArgs, ctx);
  }
  if (name === BOOKING_REQUEST_TOOL.name) {
    return executeCreateBookingRequest(rawArgs, ctx);
  }
  if (name === STAY_REQUEST_TOOL.name) {
    return executeCreateStayRequest(rawArgs, ctx);
  }
  if (name === REQUEST_CHARTER_TOOL.name) {
    return executeRequestCharter(rawArgs, ctx);
  }
  if (name === CAR_RENTAL_REQUEST_TOOL.name) {
    return executeCarRentalRequest(rawArgs, ctx);
  }
  // Пара коннекторов ChatGPT (search/fetch, ступень 2): не из реестра
  // Кузьмича, свои схемы и свой исполнитель (lib/mcp/connector-tools).
  // Английский и китайский запрос → русские слова словаря до поиска в базе
  // (lib/mcp/query-lang, прогон 17.10: zh 0/10, en 10/15). Содержимое базы не
  // переводится; клиенту — пометка о языке в конце текстового ответа.
  const localized = localizeToolArgs(name, rawArgs as Record<string, unknown>);
  if (CONNECTOR_TOOL_NAMES.has(name)) return runConnectorTool(name, localized.args as typeof rawArgs);
  // Состояние заявки по ключу (ступень 1 контура): свой исполнитель, JSON как у пары.
  if (name === REQUEST_STATUS_TOOL_NAME) return runRequestStatusTool(rawArgs);
  // Аргументы от внешнего клиента — та же граница недоверия, что
  // модель→executor у Кузьмича: тот же Zod-валидатор (коэрсия к строкам,
  // trim, обрезка длины), затем тот же исполнитель.
  const validation = validateToolArgs(name, localized.args as Record<string, string>);
  if (!validation.ok) {
    // Пусто, «не объект» и «не те поля» — разные отказы и в тексте агенту,
    // и в журнале (lib/mcp/tool-arguments, перепись 08.10).
    const refusal = argsRefusal(read, validation.error);
    throw new McpUserError(refusal.message, refusal.code);
  }
  const text = await executeKuzmichTool(name, validation.args, { surface: 'mcp' });
  // Сбой исполнителя сличается с текстом как есть — пометка к нему не цепляется.
  if (text === TOOL_EXECUTION_FAILED) return text;
  return text + langNote(localized.lang, localized.mapped);
}

/**
 * Просит ли клиент поток событий GET-запросом.
 *
 * Разбор по типу, а не поиском подстроки в сыром заголовке. Поток запрошен,
 * если text/event-stream есть в списке. Прежняя редакция требовала, чтобы
 * ДРУГОГО клиент не принимал, ссылаясь на строку `application/json,
 * text/event-stream` — но это Accept клиента на POST. На GET спецификация
 * Streamable HTTP велит клиенту перечислить text/event-stream, а серверу —
 * ответить потоком или 405; 200 с JSON на такой GET — нарушение, из-за
 * которого строгий клиент обрывает соединение (проверка MCP 29.09).
 * Браузер (text/html) и curl (*\/*) по-прежнему получают карточку сервера.
 */
export function wantsEventStream(accept: string | null): boolean {
  if (!accept) return false;
  const types = accept.split(',').map((t) => t.split(';')[0].trim().toLowerCase()).filter(Boolean);
  return types.includes('text/event-stream');
}

/**
 * GET — два разных вопроса по одному адресу, и отвечать на них надо по-разному.
 *
 * ── Повод (19.09) ─────────────────────────────────────────────────────────
 *
 * Glama прислала письмо: почасовая проверка коннектора «Ведар — Камчатка» не
 * проходит, «Error connecting to MCP», и в каталоге он помечен неработающим —
 * то есть стоит ниже живых. При этом сервер ЖИВ: вызов `safety_status` с этой
 * же машины ответил за секунду.
 *
 * Разошлись на транспорте. Клиент Streamable HTTP после рукопожатия открывает
 * GET с `Accept: text/event-stream`, ожидая либо поток событий, либо
 * `405 Method Not Allowed` — второе читается как «сервер потоком не умеет,
 * работаем без него». Мы же отвечали `200 application/json`: отдавали карточку
 * сервера и список инструментов. Для человека в браузере это удобно, для
 * клиента по спецификации — нарушение, и строгий клиент обрывает соединение.
 *
 * Снисходительный клиент (наш и агент Timeweb) это прощал, почасовая проверка
 * Glama — нет. Воспроизвести их проверку отсюда нечем: прокси песочницы наружу
 * не пускает. То есть причина названа по спецификации, а не замером, — но
 * прежнее поведение спецификации противоречит в любом случае.
 *
 * ── Что теперь ────────────────────────────────────────────────────────────
 *
 * Просят поток — честное 405: мы им не умеем, и сказать об этом надо тем
 * словом, которое клиент понимает. Просят обычное — как раньше.
 */
export async function GET(request: NextRequest) {
  if (wantsEventStream(request.headers.get('accept'))) {
    // Тело пустое намеренно: JSON здесь снова стал бы ответом не на тот
    // вопрос. Allow называет метод, которым с нами и надо говорить.
    return withCors(new NextResponse(null, { status: 405, headers: { Allow: 'POST' } }));
  }
  return withCors(NextResponse.json({
    ...MCP_SERVER_INFO,
    tools: PUBLIC_MCP_TOOLS,
  }));
}

/**
 * CORS на КАЖДОМ ответе, не только на предполёте (проверка MCP 29.09).
 *
 * Предполёт разрешал браузеру POST, а сам ответ POST шёл без
 * Access-Control-Allow-Origin: запрос исполнялся, а прочитать ответ
 * браузерный клиент не мог — обещание OPTIONS без исполнения (§10.09).
 * Открытие чтения не расширяет запись: запрос из браузера исполнялся и до
 * этого, а отдаём мы публичные данные.
 *
 * Origin не проверяется, и это отступление от «MUST validate Origin»
 * Streamable HTTP записано здесь с причиной: правило защищает ЛОКАЛЬНЫЕ
 * серверы от DNS rebinding, а этот сервер публичный и анонимный — чужой
 * странице rebinding не даёт ничего сверх прямого запроса. Что остаётся —
 * заявки из браузеров посетителей чужой страницы, каждая со своего адреса
 * мимо лимита на адрес, — решение владельца (запрет пишущих инструментов
 * при чужом Origin сломал бы браузерных агентов), см. отчёт проверки MCP.
 */
function withCors(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

/**
 * OPTIONS — для проверок, которые ходят из браузера и начинают с предполёта.
 * Без него Next отвечает 405, и предполёт читается как «сервера нет».
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: 'GET, POST, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    },
  });
}

// ── MCP Protocol: POST = JSON-RPC 2.0 ───────────────────────

/**
 * Инструкция хосту в ответ на initialize (поле появилось в 2025-03-26):
 * хост кладёт её в контекст модели. Готовый текст уже был — описание сервера
 * для каталогов, — но в рукопожатие не доходил (проверка MCP 29.09).
 */
const SERVER_INSTRUCTIONS = `${MCP_SERVER_INFO.description} Данные — из базы платформы; чего в базе нет, инструменты так и говорят, и дополнять это догадкой не нужно. Аренда машины без водителя (аренда авто, внедорожника, 4x4, прокат, rent a car, car rental) — сначала search_car_rental: прокатчики платформы, цена за сутки, залог и ссылка на страницу прокатчика. Экстренный вызов на Камчатке — 112.`;

/** Пустая строка перед «Продолжить в Ведаре» — см. handleToolsCall. */
const HANDOFF_SEPARATOR = '\n\n';

/** Отказ по лимиту пишется в журнал раз в минуту на адрес, а не на каждый запрос флуда. */
const rateLimitedLogGate = createRateLimiter({ windowMs: 60_000, max: 1 });

async function handleToolsCall(
  request: NextRequest,
  id: JsonRpcId,
  params: Record<string, unknown>,
): Promise<ReturnType<typeof jsonrpcSuccess> | ReturnType<typeof jsonrpcError>> {
  const toolName = typeof params.name === 'string' ? params.name : '';
  // Свой клиент (метка владельца в адресе коннектора) пишется с флагом и
  // в спрос не считается — lib/analytics/self-visit, решение 02.10.
  const self = isSelfMcpCaller(request.nextUrl);
  const outcome = await runPublicTool({
    toolName,
    rawArguments: params.arguments,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? '',
    self,
  });
  switch (outcome.kind) {
    case 'unknown_tool': {
      const unknown = outcome;
      return jsonrpcError(id, -32602, unknown.message, unknown.data);
    }
    case 'rate_limited':
    case 'refused':
    case 'failed':
      return jsonrpcSuccess(id, { content: [{ type: 'text', text: outcome.text }], isError: true });
    case 'ok': {
      const { text } = outcome;
      const handoff = outcome.handoffUrl ? { url: outcome.handoffUrl } : null;
      // Ссылка — отдельным элементом ответа, не хвостом текста (внешняя
      // проверка MCP 26.09: «для чистого MCP-клиента — шум»). Клиент,
      // показывающий всё подряд, увидит её как прежде; клиент, берущий
      // первый элемент как ответ инструмента, получает чистые данные.
      //
      // Ссылка начинается с пустой строки (живая проверка MCP 22.10): клиент,
      // склеивающий элементы без разделителя, получал «…/trip/<id>Продолжить
      // в Ведаре: …», и автоссылка забирала «Продолжить» в адрес страницы
      // плана. Клиенту, показывающему элементы раздельно, ведущие переводы
      // строки ничего не добавляют.
      const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text }];
      if (handoff) content.push({ type: 'text', text: `${HANDOFF_SEPARATOR}Продолжить в Ведаре: ${handoff.url}` });
      // structuredContent — у инструментов с outputSchema (search/fetch для
      // ChatGPT): ревизия 2025-06-18 велит дублировать его текстом, что и так есть.
      return jsonrpcSuccess(id, outcome.structured ? { content, structuredContent: outcome.structured } : { content });
    }
  }
}

/**
 * JSON-текст инструмента → объект для structuredContent. Текст, который не
 * разбирается, — не сбой ответа: клиент получит его как обычный текст, а
 * расхождение видно в логе (инструмент обещал JSON и не дал).
 */
function parseStructured(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // ниже — лог
  }
  console.error('[mcp] structuredContent: ответ инструмента не JSON-объект', logText(text, 80));
  return undefined;
}

/**
 * Исполнение публичного инструмента — одно на оба протокольных входа:
 * MCP (`tools/call` выше) и A2A (`app/api/a2a`, 12.10). Лимиты, журнал,
 * стражи записи и ссылка «продолжить в Ведаре» живут здесь один раз; каждый
 * вход только переводит исход (lib/mcp/tool-outcome) на свой язык:
 * JSON-RPC-результат MCP или состояние Task в A2A.
 */
export interface PublicToolCall {
  toolName: string;
  rawArguments: unknown;
  ip: string;
  userAgent: string;
  /** Свой клиент (метка владельца в адресе коннектора) — вне счёта спроса. */
  self: boolean;
}

export async function runPublicTool(call: PublicToolCall): Promise<PublicToolOutcome> {
  const { toolName, ip, userAgent, self } = call;
  // Строка с JSON-объектом читается как объект; прочее не-объектное — как
  // пустота, но с запомненной формой для отказа и журнала (tool-arguments).
  const read = readToolArguments(call.rawArguments);
  const toolArgs = read.args;

  // Журнал вызовов (Рост-6): факт, исход, длительность. Аргументы в
  // журнал не передаются вовсе — в заявочных инструментах ПД туриста.

  // Rate-limit до исполнения и до любой записи в базу: превышение — обычный
  // tool-ответ с isError, агент его прочитает и подождёт (429 на JSON-RPC
  // клиенты реагируют хуже). Запись о клиенте — ПОСЛЕ лимита: раньше каждый
  // запрос флуда писал строку в mcp_clients мимо тормоза.
  const isWrite = WRITE_TOOLS.has(toolName);
  const limiter = isWrite ? writeLimiter : readLimiter;
  // Главный аргумент для журнала: имя всегда, значение — только у читающих
  // инструментов и не похожее на телефон (lib/mcp/call-reason, 1143).
  const arg = primaryArg(toolArgs, isWrite);
  if (!limiter.check(`${isWrite ? 'w' : 'r'}:${ip}`)) {
    if (rateLimitedLogGate.check(ip)) {
      logMcpToolCall({ tool: toolName, ok: false, errorKind: 'rate_limited', errorCode: 'rate_limited', argKey: arg.key, ip, userAgent, self });
    }
    // Окно записи — десять минут, чтения — минута; общий текст «подождите
    // минуту» на записи обещал неправду (проверка MCP 29.09).
    return {
      kind: 'rate_limited',
      text: isWrite
        ? 'Слишком много заявок с этого адреса — подождите час и повторите.'
        : 'Слишком много запросов — подождите минуту и повторите.',
    };
  }

  // Клиент мог не звать рукопожатие вовсе — тогда род из заголовка
  // остаётся единственным ответом на «кто». Имя не перетирается: см.
  // COALESCE в logMcpClient.
  logMcpClient({ ip, userAgent });

  // Неизвестный инструмент — ошибка протокола, не результат (спецификация
  // tools, «Error Handling»): агент, перепутавший имя, должен перечитать
  // tools/list, а не пересказывать человеку «инструмент не сработал».
  if (!PUBLIC_MCP_TOOL_NAMES.has(toolName)) {
    logMcpToolCall({ tool: toolName, ok: false, errorKind: 'unknown_tool', errorCode: 'unknown_tool', requestedTool: toolName, argKey: arg.key, ip, userAgent, self });
    // Списком живых имён и ближайшим по написанию, а не голым отказом:
    // клиенты зовут старые названия и не узнают, чем заменить (02.10).
    const unknown = unknownToolResponse(toolName);
    return { kind: 'unknown_tool', message: unknown.message, data: unknown.data };
  }

  const startedAt = Date.now();
  const invocationId = randomUUID();
  try {
    const text = await executeTool(toolName, read, { ip, userAgent, self });

    // Исполнитель Кузьмича ловит своё падение и возвращает этот текст — для
    // модели в чате. Здесь это отказ: isError, ok=false в журнале (его читают
    // панель MCP и сторож молчания), и никакой ссылки «продолжить» к
    // несостоявшемуся ответу (проверка MCP 29.09).
    if (text === TOOL_EXECUTION_FAILED) {
      logMcpToolCall({ tool: toolName, ok: false, errorKind: 'execution', errorCode: 'tool_failed', durationMs: Date.now() - startedAt, argKey: arg.key, argValue: arg.value, ip, userAgent, self });
      return { kind: 'failed', text: 'Инструмент сейчас не смог получить данные — это сбой на стороне Ведара, а не ответ «ничего нет». Повторите позже.' };
    }
    logMcpToolCall({ tool: toolName, ok: true, durationMs: Date.now() - startedAt, argKey: arg.key, argValue: arg.value, ip, userAgent, self });

    // Мост «ответ агента → действие человека»: отдельная проверяемая
    // ссылка с непрозрачным токеном. Сбой выпуска не ломает ответ, но
    // называется в логе (§4.0).
    const target = await handoffTargetForTool(toolName, toolArgs, text).catch((err: unknown) => {
      console.error('[mcp] цель ссылки не определена:', logText(toolName), logText(err instanceof Error ? err.message : err, 300));
      return null;
    });
    const handoff = target
      ? await issueMcpHandoff({ mcpInvocationId: invocationId, toolName, target })
      : null;
    // search/fetch отдают JSON: тот же объект уходит structuredContent (MCP)
    // и DataPart (A2A). Текст от этого не меняется — ChatGPT читает его как
    // JSON-строку, остальные клиенты — как обычный ответ.
    const structured = CONNECTOR_TOOL_NAMES.has(toolName) || toolName === REQUEST_STATUS_TOOL_NAME ? parseStructured(text) : undefined;
    return { kind: 'ok', text, handoffUrl: handoff ? handoff.url : null, ...(structured ? { structured } : {}) };
  } catch (toolErr) {
    // Наружу — только текст, написанный для агента. Отказ пула или чужое
    // исключение уходит общим текстом, подробность — в лог: раньше аноним
    // получал err.message как есть, а лог роута не получал ничего.
    const userFacing = toolErr instanceof McpUserError;
    if (!userFacing) {
      const code = (toolErr as { code?: unknown })?.code;
      console.error('[mcp] инструмент упал:', logText(toolName), typeof code === 'string' ? logText(code, 10) : '', logText(toolErr instanceof Error ? toolErr.message : toolErr, 300));
    }
    // Отказ по входу и падение — разные исходы журнала (§4.0): первый
    // говорит «агент передал не то», второй — «наш код упал».
    logMcpToolCall({
      tool: toolName,
      ok: false,
      errorKind: userFacing ? 'refused' : 'execution',
      // Причина — машинным кодом: у отказа её называет сам McpUserError, у
      // падения выводится из исключения (SQLSTATE, таймаут) — 1143.
      errorCode: userFacing ? toolErr.code : classifyExecutionError(toolErr),
      durationMs: Date.now() - startedAt,
      argKey: arg.key,
      argValue: arg.value,
      ip,
      userAgent,
      self,
    });
    return userFacing
      ? { kind: 'refused', text: toolErr.message }
      : { kind: 'failed', text: MCP_INTERNAL_ERROR_TEXT };
  }
}

/**
 * Одно сообщение JSON-RPC → ответ или null (уведомление и ответ клиента
 * ответа не получают). Ошибки протокола уходят телом JSON-RPC с HTTP 200:
 * клиент SDK на не-2xx бросает транспортную ошибку и не видит кода -32601.
 */
async function handleMessage(
  request: NextRequest,
  raw: unknown,
): Promise<ReturnType<typeof jsonrpcSuccess> | ReturnType<typeof jsonrpcError> | null> {
  const msg = classifyMessage(raw);
  if (msg.kind === 'response' || msg.kind === 'notification') return null;
  if (msg.kind === 'invalid') return jsonrpcError(msg.id, -32600, `Invalid Request: ${msg.reason}`);

  const { id, method, params } = msg;
  switch (method) {
    // ── initialize handshake ──
    case 'initialize':
      // Клиент представляется САМ (clientInfo). До 18.08 мы это поле
      // выбрасывали — и на вопрос владельца «какая именно AI обращалась»
      // ответить было нечем при полном журнале вызовов. Имя программы, не
      // человека: суточную модель hash не ломает. Запись — под тем же
      // лимитом чтения, что и вызовы: рукопожатие не дверь в базу мимо него.
      if (readLimiter.check(`r:${clientIp(request)}`)) {
        logMcpClient({
          ip: clientIp(request),
          userAgent: request.headers.get('user-agent') ?? '',
          clientInfo: params.clientInfo,
        });
      }
      return jsonrpcSuccess(id, {
        // Версией клиента, если умеем её; иначе — своей новейшей. Решение
        // «жить с этим» за клиентом (lib/mcp/protocol-version.ts).
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: {
          name: MCP_SERVER_INFO.name,
          title: MCP_SERVER_INFO.title,
          version: MCP_SERVER_INFO.version,
        },
        instructions: SERVER_INSTRUCTIONS,
      });

    // ── list available tools ──
    case 'tools/list':
      return jsonrpcSuccess(id, { tools: PUBLIC_MCP_TOOLS });

    // ── call a tool ──
    case 'tools/call':
      return handleToolsCall(request, id, params);

    // ── ping/pong ──
    case 'ping':
      return jsonrpcSuccess(id, {});

    // ── unknown method ──
    default:
      return jsonrpcError(id, -32601, `Method not found: ${method.slice(0, 80)}`);
  }
}

/** Пакет длиннее — не наш клиент, а флуд одним HTTP-запросом мимо лимита соединений. */
const MAX_BATCH = 20;

async function handlePost(request: NextRequest): Promise<NextResponse> {
  // Ревизия 2025-06-18: неподдерживаемая версия в заголовке — 400. Нет
  // заголовка — клиент старше 2025-06-18, и это его право.
  const headerVersion = request.headers.get('mcp-protocol-version');
  if (headerVersion !== null && !isSupportedProtocolVersion(headerVersion)) {
    return NextResponse.json(
      jsonrpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${headerVersion.slice(0, 40)}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`),
      { status: 400 },
    );
  }

  // Тело — не больше MAX_BODY_BYTES: длины режет Zod, но уже ПОСЛЕ разбора,
  // а многомегабайтный POST — дешёвый способ занять память контейнера мимо
  // лимита на вызовы (проверка MCP 29.09).
  const raw = await readBodyLimited(request);
  if (raw === null) {
    return NextResponse.json(jsonrpcError(null, -32600, `Invalid Request: тело больше ${MAX_BODY_BYTES / 1024} КБ`), { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(jsonrpcError(null, -32700, 'Parse error'), { status: 400 });
  }

  try {
    // Пакет (массив сообщений) — ревизия 2025-03-26 требует его принимать.
    // Ответы — только на запросы с id; одни уведомления — пустой 202.
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return NextResponse.json(jsonrpcError(null, -32600, 'Invalid Request: пустой пакет'), { status: 400 });
      }
      const replies = [];
      for (const item of body.slice(0, MAX_BATCH)) {
        const reply = await handleMessage(request, item);
        if (reply) replies.push(reply);
      }
      if (body.length > MAX_BATCH) {
        replies.push(jsonrpcError(null, -32600, `Invalid Request: в пакете больше ${MAX_BATCH} сообщений, лишние не обработаны`));
      }
      return replies.length > 0 ? NextResponse.json(replies) : new NextResponse(null, { status: 202 });
    }

    const reply = await handleMessage(request, body);
    if (!reply) {
      // Уведомление или ответ клиента — JSON-RPC на них не отвечает,
      // Streamable HTTP велит принять пустым 202. До 17.09 так было только
      // у notifications/initialized, до 29.09 остальные получали 400.
      return new NextResponse(null, { status: 202 });
    }
    const invalid = 'error' in reply && reply.error.code === -32600;
    return NextResponse.json(reply, invalid ? { status: 400 } : undefined);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[mcp] необработанная ошибка:', typeof code === 'string' ? logText(code, 10) : '', logText(err instanceof Error ? err.message : err, 300));
    const id = (body && typeof body === 'object' && !Array.isArray(body) ? (body as { id?: unknown }).id : null);
    const safeId = typeof id === 'string' || typeof id === 'number' ? id : null;
    return NextResponse.json(jsonrpcError(safeId, -32603, MCP_INTERNAL_ERROR_TEXT), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return withCors(await handlePost(request));
}
