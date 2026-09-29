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
 * Записи две: create_lead (заявка на подбор тура) и create_booking_request
 * (заявка на бронь тура на дату): не бронь и не оплата, идут в общий
 * createLead() со скорингом и дедупом. Бронирование анонимному внешнему
 * агенту не отдаём сознательно. Единственное исключение по форме — тур без
 * расписания: вместо ложного «нет мест» уходит запрос мест оператору
 * (lib/seat-requests). Бронь и там заводит не агент, а оператор своим
 * нажатием «Есть места» в мессенджере.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, WRITE_TOOL_NAMES, CREATE_LEAD_TOOL, BOOKING_REQUEST_TOOL, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { negotiateProtocolVersion, isSupportedProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import { classifyMessage, jsonrpcSuccess, jsonrpcError, McpUserError, MCP_INTERNAL_ERROR_TEXT, type JsonRpcId } from '@/lib/mcp/jsonrpc';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';
import { createLead, findRecentLeadByCommentPrefix } from '@/lib/leads/create';
import { checkMcpWrite } from '@/lib/mcp/write-guard';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { logMcpToolCall, logMcpClient } from '@/lib/mcp/call-log';
import { randomUUID } from 'node:crypto';
import { issueMcpHandoff } from '@/lib/mcp/handoff';
import { SEAT_REQUEST_FAILURE, kamchatkaToday } from '@/lib/seat-requests/core';
import { createSeatRequest, statusUrl, tourKeepsSchedule } from '@/lib/seat-requests/service';
// Handoff-цели инструментов (v2, задача #60) — lib/mcp/handoff-targets.ts:
// пути строит только серверный код по белому списку, сущности резолвятся
// теми же функциями, какими их находят сами инструменты.
import { handoffTargetForTool } from '@/lib/mcp/handoff-targets';

export const dynamic = 'force-dynamic';

// ── Rate-limit по IP (Эволюция 3.0, п.4) ─────────────────────
// Вход анонимный, поэтому лимит — единственный тормоз для абьюза. Чтение
// щедрое (агент в диалоге дёргает несколько инструментов подряд), запись
// жёсткая: заявки создают работу живому менеджеру.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const writeLimiter = createRateLimiter({ windowMs: 600_000, max: 5 });
// Какие инструменты пишущие, знает аннотация (`readOnlyHint: false`) — один
// источник и для лимита, и для подсказки хосту. Свой список здесь разошёлся бы.
const WRITE_TOOLS = WRITE_TOOL_NAMES;

// IP — из заголовка, который ставит прокси (x-real-ip), а не из первого
// элемента X-Forwarded-For: тот пишет сам клиент. От этого адреса зависят
// лимит записи (5 заявок за 10 минут — единственный тормоз спама) и запись
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
    throw new McpUserError(verdict.message);
  }
  return buildConsentRecord(true, ctx.ip, 'mcp');
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

const createLeadArgsSchema = z.object({
  name: z.string().trim().min(2, 'Имя короче 2 символов').max(120),
  phone: z.string().trim().min(5, 'Телефон обязателен — иначе менеджеру не с кем связаться').max(50),
  comment: z.string().trim().min(10, 'Опишите запрос хотя бы в 10 символах').max(2000),
  interest: z.string().trim().max(200).optional(),
  // Обязателен и здесь, а не только в JSON Schema инструмента. Два источника
  // правды путают ОСНОВАНИЕ отказа: агент, смотрящий схему, видит поле
  // обязательным, а парсер роута пропускал бы его отсутствие дальше — и
  // отказ «поля нет» становился неотличим от отказа «согласия нет».
  consent: z.boolean({ error: MISSING_CONSENT_FIELD }),
});

// ── create_booking_request (Эволюция 3.0, п.4) ───────────────
// Заявка на бронь конкретного тура на дату. НЕ бронь: реальную бронь создаёт
// оператор после звонка (никакого INSERT в operator_bookings отсюда — роут,
// пишущий брони, обязан жить по правилам комиссий §7, и это не наш случай).
// Занятость проверяется движком планера — тем же расчётом, что у гейта брони:
// нет мест → заявка не создаётся, агенту честно отдаются ближайшие даты.
const bookingRequestArgsSchema = z.object({
  tour: z.string().trim().min(1, 'Укажите тур: название или ID').max(200),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
  participants: z.coerce.number().int().min(1).max(30).default(1),
  name: z.string().trim().min(2, 'Имя короче 2 символов').max(120),
  phone: z.string().trim().min(5, 'Телефон обязателен — заявку подтверждают по нему').max(50),
  comment: z.string().trim().max(2000).optional(),
  // См. пояснение у createLeadArgsSchema: обязателен в обоих источниках.
  consent: z.boolean({ error: MISSING_CONSENT_FIELD }),
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
  if (!pd_consent) throw new McpUserError('Согласие на обработку персональных данных не получено — запрос не отправлен.');
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
    const failure = reason === 'duplicate'
      ? { error: 'По этому телефону запрос на этот тур и дату уже есть — повторно не отправляю; ответ придёт по ссылке, выданной в первый раз.' }
      : SEAT_REQUEST_FAILURE[reason] ?? SEAT_REQUEST_FAILURE.check_failed!;
    return `${failure.error} Запрос мест по туру "${a.tourTitle}" на ${a.date} не отправлен. Можно оставить заявку через create_lead — менеджер свяжется с оператором сам.`;
  }
  const deadline = result.deadlineAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka' });
  return `У тура "${a.tourTitle}" нет расписания в системе, поэтому места на ${a.date} (${a.participants} чел.) уточняются у оператора: запрос отправлен ему в мессенджер, ответ будет до ${deadline} по Камчатке. `
    + `Это НЕ бронь и не оплата: если оператор ответит «Есть места», бронь заведётся и подтвердится, а ссылка на оплату появится на странице статуса. `
    + `Передайте человеку эту ссылку (в ней ключ доступа, храните её только у него): ${statusUrl(result.statusToken)} `
    + (a.hasComment ? 'Комментарий оператору не передан — в запросе мест только тур, дата и число человек. ' : '')
    + 'Если оператор не ответит за 2 часа, это не значит, что мест нет — можно оставить заявку через create_lead.';
}

async function executeCreateBookingRequest(rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<string> {
  const parsed = bookingRequestArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpUserError(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки');
  }
  const { tour: tourQuery, date, participants, name, comment } = parsed.data;

  // Аудит 08.08, замечание 2: телефон нормализуется, мусор не проходит —
  // заявка без дозвонного номера бесполезна менеджеру.
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    throw new McpUserError('Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.');
  }

  const { resolveTourByQuery } = await import('@/lib/kuzmich/tour-availability-tool');
  // Отказ базы — не «тур не найден»: заявка не создаётся, агент знает, что
  // это сбой, а не отсутствие тура (проверка MCP 29.09).
  const tour = await resolveTourByQuery(tourQuery).catch(() => {
    throw new McpUserError('Не удалось проверить тур — заявка не создана, повторите позже.');
  });
  if (!tour) {
    return `Тур по запросу "${tourQuery}" не найден среди активных — заявка не создана. Уточните тур через get_tours или get_tour_availability.`;
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
      throw new McpUserError('Не удалось проверить расписание тура — заявка не создана, попробуйте позже.');
    }
    if (!keepsSchedule) {
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
  const accepted = `Заявка на бронь принята: "${tour.title}", ${date}, ${participants} чел. ` +
    `На ${date} свободно ${remaining} мест. Оператор подтвердит бронь по телефону ${phone}. Это заявка, не оплата.`;
  const bookingPrefix = `[Заявка на бронь] Тур "${tour.title}" (ID${tour.id}), дата ${date},`;
  const existing = await findRecentLeadByCommentPrefix(phone, bookingPrefix);
  if (existing) {
    return accepted;
  }

  const leadId = await createLead({
    name,
    phone,
    comment:
      `[Заявка на бронь] Тур "${tour.title}" (ID${tour.id}), дата ${date}, участников ${participants}.` +
      (comment ? ` ${comment}` : ''),
    route_title: tour.title,
    source_url: 'mcp://vedar/booking',
    source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tour.id, date, participants },
    pd_consent,
  });
  if (!leadId) {
    throw new McpUserError('Не удалось сохранить заявку — попробуйте позже');
  }
  return accepted;
}

async function executeCreateLead(rawArgs: Record<string, unknown>, ctx: McpCallContext): Promise<string> {
  const parsed = createLeadArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpUserError(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки');
  }
  const { name, comment, interest } = parsed.data;
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    throw new McpUserError('Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.');
  }
  const pd_consent = await admitWrite(ctx, CREATE_LEAD_TOOL.name, phone, parsed.data.consent);
  const leadId = await createLead({
    name,
    phone,
    comment: interest ? `[Интерес: ${interest}] ${comment}` : comment,
    source_url: 'mcp://vedar',
    source_data: { source: 'mcp' },
    pd_consent,
  });
  if (!leadId) {
    throw new McpUserError('Не удалось сохранить заявку — попробуйте позже');
  }
  return `Заявка принята (номер ${leadId}). Менеджер Ведара свяжется по указанному телефону.`;
}


// ── Execute tool by name ─────────────────────────────────────
// Имя проверено вызывающим (неизвестный инструмент — ошибка протокола
// -32602, а не результат с isError: так велит спецификация tools).
async function executeTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: McpCallContext,
): Promise<string> {
  if (name === CREATE_LEAD_TOOL.name) {
    return executeCreateLead(rawArgs, ctx);
  }
  if (name === BOOKING_REQUEST_TOOL.name) {
    return executeCreateBookingRequest(rawArgs, ctx);
  }
  // Аргументы от внешнего клиента — та же граница недоверия, что
  // модель→executor у Кузьмича: тот же Zod-валидатор (коэрсия к строкам,
  // trim, обрезка длины), затем тот же исполнитель.
  const validation = validateToolArgs(name, rawArgs as Record<string, string>);
  if (!validation.ok) {
    throw new McpUserError(validation.error);
  }
  return executeKuzmichTool(name, validation.args, { surface: 'mcp' });
}

/**
 * Просит ли клиент поток событий.
 *
 * Разбор именно по типу, а не поиском подстроки в сыром заголовке: клиент
 * Streamable HTTP шлёт `application/json, text/event-stream` — обе строки
 * сразу, — и «содержит text/event-stream» отправляло бы в 405 того, кто
 * согласен и на JSON. Поток запрошен только тогда, когда ДРУГОГО он не
 * принимает.
 */
export function wantsEventStream(accept: string | null): boolean {
  if (!accept) return false;
  const types = accept.split(',').map((t) => t.split(';')[0].trim().toLowerCase()).filter(Boolean);
  if (types.length === 0) return false;
  return types.every((t) => t === 'text/event-stream');
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
    return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
  }
  return NextResponse.json({
    ...MCP_SERVER_INFO,
    tools: PUBLIC_MCP_TOOLS,
  });
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
const SERVER_INSTRUCTIONS = `${MCP_SERVER_INFO.description} Данные — из базы платформы; чего в базе нет, инструменты так и говорят, и дополнять это догадкой не нужно. Экстренный вызов на Камчатке — 112.`;

/** Отказ по лимиту пишется в журнал раз в минуту на адрес, а не на каждый запрос флуда. */
const rateLimitedLogGate = createRateLimiter({ windowMs: 60_000, max: 1 });

async function handleToolsCall(
  request: NextRequest,
  id: JsonRpcId,
  params: Record<string, unknown>,
): Promise<ReturnType<typeof jsonrpcSuccess> | ReturnType<typeof jsonrpcError>> {
  const toolName = typeof params.name === 'string' ? params.name : '';
  const toolArgs = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments
    : {}) as Record<string, unknown>;

  // Журнал вызовов (Рост-6): факт, исход, длительность. Аргументы в
  // журнал не передаются вовсе — в заявочных инструментах ПД туриста.
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent') ?? '';

  // Rate-limit до исполнения и до любой записи в базу: превышение — обычный
  // tool-ответ с isError, агент его прочитает и подождёт (429 на JSON-RPC
  // клиенты реагируют хуже). Запись о клиенте — ПОСЛЕ лимита: раньше каждый
  // запрос флуда писал строку в mcp_clients мимо тормоза.
  const isWrite = WRITE_TOOLS.has(toolName);
  const limiter = isWrite ? writeLimiter : readLimiter;
  if (!limiter.check(`${isWrite ? 'w' : 'r'}:${ip}`)) {
    if (rateLimitedLogGate.check(ip)) {
      logMcpToolCall({ tool: toolName, ok: false, errorKind: 'rate_limited', ip, userAgent });
    }
    return jsonrpcSuccess(id, {
      content: [{ type: 'text', text: 'Слишком много запросов — подождите минуту и повторите.' }],
      isError: true,
    });
  }

  // Клиент мог не звать рукопожатие вовсе — тогда род из заголовка
  // остаётся единственным ответом на «кто». Имя не перетирается: см.
  // COALESCE в logMcpClient.
  logMcpClient({ ip, userAgent });

  // Неизвестный инструмент — ошибка протокола, не результат (спецификация
  // tools, «Error Handling»): агент, перепутавший имя, должен перечитать
  // tools/list, а не пересказывать человеку «инструмент не сработал».
  if (!PUBLIC_MCP_TOOL_NAMES.has(toolName)) {
    logMcpToolCall({ tool: toolName, ok: false, errorKind: 'unknown_tool', ip, userAgent });
    return jsonrpcError(id, -32602, `Unknown tool: ${toolName.slice(0, 80)}`);
  }

  const startedAt = Date.now();
  const invocationId = randomUUID();
  try {
    const text = await executeTool(toolName, toolArgs, { ip, userAgent });

    // Исполнитель Кузьмича ловит своё падение и возвращает этот текст — для
    // модели в чате. Здесь это отказ: isError, ok=false в журнале (его читают
    // панель MCP и сторож молчания), и никакой ссылки «продолжить» к
    // несостоявшемуся ответу (проверка MCP 29.09).
    if (text === TOOL_EXECUTION_FAILED) {
      logMcpToolCall({ tool: toolName, ok: false, errorKind: 'execution', durationMs: Date.now() - startedAt, ip, userAgent });
      return jsonrpcSuccess(id, {
        content: [{ type: 'text', text: 'Инструмент сейчас не смог получить данные — это сбой на стороне Ведара, а не ответ «ничего нет». Повторите позже.' }],
        isError: true,
      });
    }
    logMcpToolCall({ tool: toolName, ok: true, durationMs: Date.now() - startedAt, ip, userAgent });

    // Мост «ответ агента → действие человека»: отдельная проверяемая
    // ссылка с непрозрачным токеном. Сбой выпуска не ломает ответ, но
    // называется в логе (§4.0).
    const target = await handoffTargetForTool(toolName, toolArgs).catch((err: unknown) => {
      console.error('[mcp] цель ссылки не определена:', toolName, err instanceof Error ? err.message : String(err));
      return null;
    });
    const handoff = target
      ? await issueMcpHandoff({ mcpInvocationId: invocationId, toolName, target })
      : null;

    // Ссылка — отдельным элементом ответа, не хвостом текста (внешняя
    // проверка MCP 26.09: «для чистого MCP-клиента — шум»). Клиент,
    // показывающий всё подряд, увидит её как прежде; клиент, берущий
    // первый элемент как ответ инструмента, получает чистые данные.
    const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text }];
    if (handoff) content.push({ type: 'text', text: `Продолжить в Ведаре: ${handoff.url}` });
    return jsonrpcSuccess(id, { content });
  } catch (toolErr) {
    // Наружу — только текст, написанный для агента. Отказ пула или чужое
    // исключение уходит общим текстом, подробность — в лог: раньше аноним
    // получал err.message как есть, а лог роута не получал ничего.
    const userFacing = toolErr instanceof McpUserError;
    if (!userFacing) {
      const code = (toolErr as { code?: unknown })?.code;
      console.error('[mcp] инструмент упал:', toolName, typeof code === 'string' ? code : '', toolErr instanceof Error ? toolErr.message : String(toolErr));
    }
    logMcpToolCall({
      tool: toolName,
      ok: false,
      errorKind: 'execution',
      durationMs: Date.now() - startedAt,
      ip,
      userAgent,
    });
    return jsonrpcSuccess(id, {
      content: [{ type: 'text', text: userFacing ? toolErr.message : MCP_INTERNAL_ERROR_TEXT }],
      isError: true,
    });
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

export async function POST(request: NextRequest) {
  // Ревизия 2025-06-18: неподдерживаемая версия в заголовке — 400. Нет
  // заголовка — клиент старше 2025-06-18, и это его право.
  const headerVersion = request.headers.get('mcp-protocol-version');
  if (headerVersion !== null && !isSupportedProtocolVersion(headerVersion)) {
    return NextResponse.json(
      jsonrpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${headerVersion.slice(0, 40)}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`),
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
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
    console.error('[mcp] необработанная ошибка:', typeof code === 'string' ? code : '', err instanceof Error ? err.message : String(err));
    const id = (body && typeof body === 'object' && !Array.isArray(body) ? (body as { id?: unknown }).id : null);
    const safeId = typeof id === 'string' || typeof id === 'number' ? id : null;
    return NextResponse.json(jsonrpcError(safeId, -32603, MCP_INTERNAL_ERROR_TEXT), { status: 500 });
  }
}
