/**
 * lib/crm/tools.ts — инструменты CRM для помощника партнёра (CRM #2325, шаг 1д).
 *
 * Партнёр пишет Кузьмичу в свой привязанный чат: «кто ждёт ответа?», «найди
 * Анну, что у неё было?», «запиши, что звонил, договорились на 15-е»,
 * «напомни перезвонить завтра». Инструменты здесь — одни на все поверхности:
 * чат партнёра (`lib/kuzmich/operator-chat.ts`) и MCP партнёра по ключу
 * (`app/api/mcp/partner`, 1д-2). Своего SQL у них нет: они зовут те же функции, что
 * экран кабинета (`contact-queries`, `tasks`, `events`, `inbox`), — второй
 * путь к данным разошёлся бы с первым на первой же правке.
 *
 * ── Что уходит модели ──────────────────────────────────────────────────────
 *
 * Модели у нас зарубежные (§8), и ответ инструмента уходит им целиком. Правило
 * владельца для CRM-инструментов (карт-бланш на 1д): клиент называется
 * `contact_id` и подписью «Анна П.», телефона и почты в ответе нет никогда.
 *   - имя — только подписью `contactLabel` (имя и буква фамилии); имя, в
 *     котором записан телефон или почта, подписью не становится;
 *   - свободный текст (заметка, заголовок события, задача, желаемые даты
 *     заявки) — через `redactPII`: телефон и почту, вписанные человеком,
 *     модель не увидит; фамилия клиента, о котором текст, гасится до буквы
 *     в любом падеже (`maskClientName`);
 *   - имя человека из источника (бронь, заявка) в ответ не идёт: клиента
 *     модель знает по подписи, второе имя ей не нужно.
 * Сторож: tests/unit/crm-tools-model-safe.test.ts — исполняет каждый
 * инструмент на строках, где ПД вписаны во ВСЕ текстовые поля.
 *
 * ── Кто пишет ──────────────────────────────────────────────────────────────
 *
 * Партнёр в своём чате пишет сам: «запиши», «заведи задачу». Запись идёт от
 * имени Кузьмича (`actor_kind = 'kuzmich'`, задача — `origin = 'kuzmich'`), и
 * в ленте видно, что событие внёс помощник; агент по ключу пишет от `mcp`
 * («агент партнёра»). Доступ без права записи (`canWrite = false`, ключ MCP
 * по умолчанию) пишущих инструментов не видит, а на их вызов отвечает
 * отказом словами и в базу не ходит.
 */
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import type { PartnerCategory } from '@/lib/crm/partner-context';
import { listContacts, getContactCard } from '@/lib/crm/contact-queries';
import { addContactTouch } from '@/lib/crm/events';
import { ACTOR_KIND_LABELS, EVENT_KIND_LABELS, TITLE_MAX, TOUCH_KINDS } from '@/lib/crm/event-kinds';
import { createTask, completeTask, listTasks } from '@/lib/crm/tasks';
import { loadInbox } from '@/lib/crm/inbox';
import { INBOX_ACTION, INBOX_KIND_LABELS } from '@/lib/crm/inbox-kinds';
import { SOURCE_KIND_LABELS, statusLabel } from '@/lib/crm/labels';
import { publicReviewerName } from '@/lib/reviews/public-name';
import { hasPII, redactPII } from '@/lib/security/pii-redact';
import { isRealDate, kamchatkaDate, KAMCHATKA_UTC_OFFSET_HOURS } from '@/lib/analytics/kamchatka-day';

interface Queryable {
  query: typeof pool.query;
}

/**
 * Определение инструмента для модели — та же форма, что `ToolDefinition` в
 * lib/ai/providers. Своя копия намеренно: слой CRM не импортирует ничего из
 * lib/ai и lib/kuzmich (граница ПД, сторож crm-pd-parity) — модели зовёт
 * вызывающий, а здесь только данные, уже очищенные для неё.
 */
export interface CrmToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Кто зовёт инструменты: Кузьмич в чате партнёра или агент партнёра по ключу MCP (1д-2). */
export type CrmToolActor = 'kuzmich' | 'mcp';

export interface CrmToolContext {
  partnerId: string;
  category: PartnerCategory;
  /** Аккаунт партнёра (`partners.user_id`); NULL — записи без аккаунта. */
  userId: string | null;
  actor: CrmToolActor;
  /** Можно ли писать в CRM. Нет — пишущие инструменты отвечают отказом. */
  canWrite: boolean;
  /** Для тестов: «сейчас». */
  nowMs?: number;
}

export type CrmToolResult = { ok: true; data: unknown } | { ok: false; error: string };

const LIST_LIMIT = 10;
const INBOX_LIMIT = 30;
const TASKS_LIMIT = 30;
const CARD_SOURCES = 20;
const CARD_EVENTS = 15;
const NOTE_MAX = 1000;
const SHORT_MAX = 300;

// ── Что модель может увидеть ────────────────────────────────────────────────

/**
 * Подпись клиента для модели: «Анна П.». Имени нет — «Клиент без имени».
 * Имя, в которое записан телефон или почта (ручной контакт без имени),
 * подписью не становится: иначе номер уехал бы под видом имени.
 */
export function contactLabel(name: string | null | undefined): string {
  const s = (name ?? '').trim();
  if (!s || hasPII(s)) return 'Клиент без имени';
  return publicReviewerName(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Фамилия клиента в свободном тексте → буква. Партнёр пишет о клиенте как
 * привык: «перезвонить Петровой», и заметка о клиенте почти всегда называет
 * его самого. Имя клиента известно — значит его фамилию можно убрать в любом
 * падеже: сравнивается основа (без двух последних букв у длинной фамилии),
 * «Петрова» гасит и «Петровой», и «Петрову». Чужие имена в тексте так не
 * найти — их отличить от слов нечем; правило владельца для них — телефон и
 * почта, и они режутся всегда.
 */
export function maskClientName(text: string, clientName: string | null | undefined): string {
  // Только слова из букв: имя-телефон уже вырезано redactPII, а его цифры,
  // принятые за фамилию, испортили бы цены и даты в тексте.
  const parts = (clientName ?? '').trim().split(/\s+/).filter((p) => /^\p{L}[\p{L}-]+$/u.test(p));
  let out = text;
  for (const surname of parts.slice(1)) {
    // Короткую фамилию («Ли», «Ким») — только целым словом: по основе из двух
    // букв гасились бы чужие слова.
    const pattern = surname.length > 5
      ? `(?<!\\p{L})${escapeRegExp(surname.slice(0, -2))}\\p{L}*`
      : surname.length > 3
        ? `(?<!\\p{L})${escapeRegExp(surname)}\\p{L}{0,3}(?!\\p{L})`
        : `(?<!\\p{L})${escapeRegExp(surname)}(?!\\p{L})`;
    out = out.replace(new RegExp(pattern, 'giu'), `${surname.charAt(0).toUpperCase()}.`);
  }
  return out;
}

/**
 * Свободный текст для модели: без телефонов и почт, без фамилии клиента, о
 * котором текст (если он известен), с потолком длины.
 */
export function modelText(s: string | null | undefined, max = SHORT_MAX, clientName?: string | null): string | null {
  const t = maskClientName(redactPII(s), clientName).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function client(id: string | null, name: string | null): { contact_id: string; label: string } | null {
  return id ? { contact_id: id, label: contactLabel(name) } : null;
}

// ── Срок задачи ─────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
/** Срок без времени — 10:00 по Камчатке: напоминание придёт утром, а не в полночь. */
const DEFAULT_DUE_HOUR = 10;

/**
 * Срок словами модели → момент. Модель пишет камчатское время: «2026-10-12»
 * или «2026-10-12T15:30». Срок раньше вчерашнего дня — почти всегда ошибка
 * года или месяца у модели, а не просьба партнёра: такой не принимается.
 */
export function parseDue(raw: string, nowMs: number): { ok: true; at: Date } | { ok: false; error: string } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(raw.trim());
  if (!m || !isRealDate(m[1])) {
    return { ok: false, error: 'Срок — дата по Камчатке в виде ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ' };
  }
  const hour = m[2] === undefined ? DEFAULT_DUE_HOUR : Number(m[2]);
  const minute = m[3] === undefined ? 0 : Number(m[3]);
  if (hour > 23 || minute > 59) return { ok: false, error: 'Время срока — от 00:00 до 23:59' };
  const [y, mo, d] = m[1].split('-').map(Number);
  const at = new Date(Date.UTC(y, mo - 1, d, hour, minute) - KAMCHATKA_UTC_OFFSET_HOURS * HOUR_MS);
  if (at.getTime() < nowMs - 24 * HOUR_MS) {
    return { ok: false, error: `Срок ${m[1]} уже прошёл (сегодня ${kamchatkaDate(new Date(nowMs))}) — уточни дату у партнёра` };
  }
  return { ok: true, at };
}

// ── Инструменты ─────────────────────────────────────────────────────────────

interface CrmToolSpec<S extends z.ZodTypeAny> {
  definition: CrmToolDefinition;
  schema: S;
  /** Пишет в CRM — нужен canWrite. */
  write: boolean;
  run: (args: z.infer<S>, ctx: CrmToolContext, db: Queryable) => Promise<CrmToolResult>;
}

function tool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  schema: S,
  write: boolean,
  run: CrmToolSpec<S>['run'],
): CrmToolSpec<z.ZodTypeAny> {
  return {
    definition: { type: 'function', function: { name, description, parameters } },
    schema,
    write,
    run: run as CrmToolSpec<z.ZodTypeAny>['run'],
  };
}

const uuid = z.string().trim().uuid('Нужен идентификатор из ответа инструмента CRM');
const NO_ARGS = { type: 'object', properties: {} };

const crmInbox = tool(
  'crm_inbox',
  'Входящие партнёра: что ждёт его ответа (брони, заявки, запросы мест, отзывы) и сколько ждёт, '
    + 'плюс медиана времени первого ответа за 7 дней. Зови на «что у меня нового», «кто ждёт ответа».',
  NO_ARGS,
  z.object({}).passthrough(),
  false,
  async (_args, ctx, db) => {
    const inbox = await loadInbox(ctx.partnerId, ctx.category, ctx.userId, { db, nowMs: ctx.nowMs });
    return {
      ok: true,
      data: {
        waiting_total: inbox.items.length,
        waiting: inbox.items.slice(0, INBOX_LIMIT).map((i) => ({
          kind: INBOX_KIND_LABELS[i.kind],
          item_id: i.id,
          title: modelText(i.title, SHORT_MAX, i.contact_name),
          date: modelText(i.date, 100, i.contact_name),
          people: i.people,
          client: client(i.contact_id, i.contact_name),
          waiting_minutes: i.waiting_minutes,
          where_to_answer: INBOX_ACTION[i.kind].hint,
        })),
        // Не прочитался вид — так и сказать, а не «всё отвечено» (§4.0).
        not_read: inbox.failed.map((k) => INBOX_KIND_LABELS[k]),
        first_response: {
          window_days: inbox.response.window_days,
          median_minutes: inbox.response.median_minutes,
          answered: inbox.response.responded,
          enough_data: inbox.response.enough,
          complete: inbox.response.complete,
        },
        platform_chat_unread: inbox.chat.state === 'ok' ? inbox.chat.unread : inbox.chat.state === 'failed' ? 'не посчитано' : null,
        not_in_inbox: inbox.not_here,
      },
    };
  },
);

const crmFindContact = tool(
  'crm_find_contact',
  'Найти клиента партнёра по имени, почте или хвосту телефона. Возвращает contact_id и подпись '
    + '(«Анна П.») — без телефонов и почт. Пустой запрос — последние клиенты.',
  { type: 'object', properties: { query: { type: 'string', description: 'Имя, почта или 4+ цифры телефона' } } },
  z.object({ query: z.string().max(100).optional() }),
  false,
  async (args, ctx, db) => {
    const r = await listContacts(ctx.partnerId, { q: args.query ?? null, limit: LIST_LIMIT, offset: 0 }, db);
    return {
      ok: true,
      data: {
        total: r.total,
        contacts: r.items.map((c) => ({
          contact_id: c.id,
          label: contactLabel(c.display_name),
          tags: c.tags.map((t) => modelText(t, 50, c.display_name)).filter(Boolean),
          last_activity_at: c.last_activity_at,
          sources_count: c.sources_count,
        })),
      },
    };
  },
);

const crmContactCard = tool(
  'crm_contact_card',
  'Карточка клиента партнёра: метки, заметка, брони и заявки, лента касаний, открытые задачи. '
    + 'Без телефонов и почт — связаться партнёр может из кабинета.',
  { type: 'object', properties: { contact_id: { type: 'string', description: 'contact_id из crm_find_contact или crm_inbox' } }, required: ['contact_id'] },
  z.object({ contact_id: uuid }),
  false,
  async (args, ctx, db) => {
    const card = await getContactCard(ctx.partnerId, args.contact_id, db);
    if (!card) return { ok: false, error: 'Клиент не найден среди клиентов партнёра' };
    const tasks = await listTasks(ctx.partnerId, { status: 'open', contactId: card.id }, db);
    const text = (v: string | null, max = SHORT_MAX) => modelText(v, max, card.display_name);
    return {
      ok: true,
      data: {
        contact_id: card.id,
        label: contactLabel(card.display_name),
        tags: card.tags.map((t) => text(t, 50)).filter(Boolean),
        notes: text(card.notes, NOTE_MAX),
        has_account: card.has_account,
        consent_recorded: card.consent !== null,
        first_seen_at: card.first_seen_at,
        last_activity_at: card.last_activity_at,
        sources: card.sources.slice(0, CARD_SOURCES).map((s) => ({
          kind: SOURCE_KIND_LABELS[s.kind],
          item_id: s.id,
          title: text(s.title),
          date_from: text(s.date_from, 100),
          date_to: s.date_to,
          status: statusLabel(s.status, s.kind),
          people: s.people,
        })),
        events: card.events.slice(0, CARD_EVENTS).map((e) => ({
          kind: EVENT_KIND_LABELS[e.kind],
          by: ACTOR_KIND_LABELS[e.actor_kind],
          title: text(e.title),
          details: text(e.details),
          at: e.occurred_at,
        })),
        open_tasks: tasks.slice(0, CARD_EVENTS).map((t) => ({
          task_id: t.id,
          title: text(t.title),
          due_at: t.due_at,
        })),
      },
    };
  },
);

const crmTasks = tool(
  'crm_tasks',
  'Открытые задачи партнёра по сроку (просроченные первыми). contact_id сужает до одного клиента.',
  { type: 'object', properties: { contact_id: { type: 'string', description: 'Необязательно: contact_id клиента' } } },
  z.object({ contact_id: uuid.optional() }),
  false,
  async (args, ctx, db) => {
    const nowMs = ctx.nowMs ?? Date.now();
    const tasks = await listTasks(ctx.partnerId, { status: 'open', contactId: args.contact_id ?? null }, db);
    return {
      ok: true,
      data: {
        total: tasks.length,
        tasks: tasks.slice(0, TASKS_LIMIT).map((t) => ({
          task_id: t.id,
          title: modelText(t.title, SHORT_MAX, t.contact?.display_name),
          details: modelText(t.details, SHORT_MAX, t.contact?.display_name),
          due_at: t.due_at,
          overdue: Date.parse(t.due_at) < nowMs,
          client: t.contact ? client(t.contact.id, t.contact.display_name) : null,
        })),
      },
    };
  },
);

const READ_ONLY = 'Этот доступ только для чтения: записывать в CRM нельзя.';

const crmAddTouch = tool(
  'crm_add_touch',
  'Записать в ленту клиента заметку, звонок или встречу — когда партнёр просит «запиши, что…». '
    + 'Пиши суть его словами; телефоны и почты в заголовок не вписывай.',
  {
    type: 'object',
    properties: {
      contact_id: { type: 'string', description: 'contact_id клиента' },
      kind: { type: 'string', enum: [...TOUCH_KINDS], description: 'note — заметка, call — звонок, meeting — встреча' },
      title: { type: 'string', description: 'Суть в одну строку' },
      details: { type: 'string', description: 'Подробности, если партнёр их дал' },
    },
    required: ['contact_id', 'kind', 'title'],
  },
  z.object({
    contact_id: uuid,
    kind: z.enum(TOUCH_KINDS),
    title: z.string().trim().min(1, 'Нужен заголовок').max(TITLE_MAX),
    details: z.string().max(2000).optional(),
  }),
  true,
  async (args, ctx, db) => {
    const r = await addContactTouch(ctx.partnerId, args.contact_id, {
      kind: args.kind,
      title: args.title,
      details: args.details ?? null,
      actorKind: ctx.actor,
      actorUserId: ctx.userId,
    }, db);
    if (r.outcome === 'not_found') return { ok: false, error: 'Клиент не найден среди клиентов партнёра' };
    return { ok: true, data: { recorded: true, event_id: r.id } };
  },
);

const crmAddTask = tool(
  'crm_add_task',
  'Завести задачу партнёру («перезвонить завтра», «уточнить состав группы»). Срок — дата по Камчатке, '
    + 'ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ; без времени — 10:00. К сроку придёт напоминание.',
  {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Что сделать' },
      due: { type: 'string', description: 'Срок по Камчатке: 2026-10-12 или 2026-10-12T15:30' },
      contact_id: { type: 'string', description: 'Необязательно: contact_id клиента' },
      details: { type: 'string', description: 'Подробности' },
    },
    required: ['title', 'due'],
  },
  z.object({
    title: z.string().trim().min(1, 'Нужно, что сделать').max(TITLE_MAX),
    due: z.string().max(20),
    contact_id: uuid.optional(),
    details: z.string().max(2000).optional(),
  }),
  true,
  async (args, ctx, db) => {
    const due = parseDue(args.due, ctx.nowMs ?? Date.now());
    if (!due.ok) return { ok: false, error: due.error };
    const r = await createTask(ctx.partnerId, {
      title: args.title,
      details: args.details ?? null,
      dueAt: due.at,
      contactId: args.contact_id ?? null,
      createdBy: ctx.userId,
      origin: ctx.actor,
    }, db);
    if (r.outcome === 'contact_not_found') return { ok: false, error: 'Клиент не найден среди клиентов партнёра' };
    return { ok: true, data: { created: true, task_id: r.task.id, due_at: r.task.due_at } };
  },
);

const crmCompleteTask = tool(
  'crm_complete_task',
  'Отметить задачу выполненной, когда партнёр говорит, что сделал. task_id — из crm_tasks.',
  { type: 'object', properties: { task_id: { type: 'string', description: 'task_id из crm_tasks' } }, required: ['task_id'] },
  z.object({ task_id: uuid }),
  true,
  async (args, ctx, db) => {
    const r = await completeTask(ctx.partnerId, args.task_id, ctx.userId, db, ctx.actor);
    if (r.outcome === 'not_found') return { ok: false, error: 'Открытой задачи с таким номером у партнёра нет' };
    return { ok: true, data: { done: true, task_id: r.task.id } };
  },
);

const SPECS: Readonly<Record<string, CrmToolSpec<z.ZodTypeAny>>> = Object.fromEntries(
  [crmInbox, crmFindContact, crmContactCard, crmTasks, crmAddTouch, crmAddTask, crmCompleteTask]
    .map((s) => [s.definition.function.name, s]),
);

export const CRM_TOOL_NAMES: readonly string[] = Object.keys(SPECS);
export const CRM_WRITE_TOOL_NAMES: readonly string[] = CRM_TOOL_NAMES.filter((n) => SPECS[n].write);

/** Определения для модели: всё — при праве записи, только чтение — без него. */
export function crmToolDefinitions(canWrite: boolean): CrmToolDefinition[] {
  return Object.values(SPECS).filter((s) => canWrite || !s.write).map((s) => s.definition);
}

export function isCrmTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SPECS, name);
}

/**
 * Исполнить инструмент CRM. Скоуп партнёра — только из `ctx` (его знает тот,
 * кто опознал партнёра: привязанный чат, ключ MCP), никогда из аргументов
 * модели. Отказ базы — названный отказ, а не «ничего нет» (§4.0).
 */
export async function executeCrmTool(
  name: string,
  rawArgs: unknown,
  ctx: CrmToolContext,
  db: Queryable = pool,
): Promise<CrmToolResult> {
  const spec = isCrmTool(name) ? SPECS[name] : undefined;
  if (!spec) return { ok: false, error: 'Неизвестный инструмент CRM' };
  if (spec.write && !ctx.canWrite) return { ok: false, error: READ_ONLY };
  const parsed = spec.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => i.message).join('; ') || 'некорректные аргументы';
    return { ok: false, error: `Аргументы ${name} не прошли проверку: ${why}` };
  }
  try {
    return await spec.run(parsed.data, ctx, db);
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error(`[crm-tools] ${name} не выполнен, SQLSTATE`, code);
    return {
      ok: false,
      error: 'Данные CRM сейчас не прочитались — скажи партнёру, что не удалось, и не придумывай ответ',
    };
  }
}

/** Ответ инструмента текстом для модели в чате. */
export function crmToolText(r: CrmToolResult): string {
  return r.ok ? JSON.stringify(r.data) : `Не выполнено: ${r.error}`;
}

/**
 * Что записал пишущий инструмент — словами для партнёра. Нужна поверхности,
 * где модель может не дойти до ответа после записи (чат партнёра): человек
 * должен узнать, что записано, иначе попросит снова и получит дубль. Слова
 * живут здесь, рядом с инструментами, а не в поверхности: новый пишущий
 * инструмент получает свою строку там же, где заводится.
 */
export function crmWriteSummary(name: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (name === 'crm_add_task') return `задача «${str(args.title)}» со сроком ${str(args.due)}`.trim();
  if (name === 'crm_complete_task') return 'задача отмечена выполненной';
  if (name === 'crm_add_touch') return `запись в ленту клиента «${str(args.title)}»`;
  return name;
}
