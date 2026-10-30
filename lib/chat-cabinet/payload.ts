/**
 * Кабинет в чате (решение владельца 30.10: «продумай app для мессенджеров
 * лёгкий, лучше кнопки в чате»; объём — «всё сразу + Telegram»). Форма
 * payload кнопок кабинета, разбор и сборка. Без базы и сети: модуль читают
 * экраны, вебхуки MAX и Telegram и классификатор нажатий MAX.
 *
 *   cb:m                — «Ещё»: туры, места, сводка, помощь, кабинет на сайте
 *   cb:i | cb:i:<стр>   — «Входящие», страница
 *   cb:o:<вид>:<id>     — карточка предмета «Входящих»
 *   cb:t | cb:t:<стр>   — «Задачи», страница
 *   cb:d:<uuid>         — задача выполнена
 *   cb:z:<uuid>         — задача на завтра, 10:00 по Камчатке
 *   cb:c | cb:l:<стр>   — «Клиенты», страница
 *   cb:c:<uuid>         — карточка клиента
 *   cb:f                — найти клиента: следующее сообщение — запрос
 *   cb:x                — не искать
 *   cb:k:<d|n|a>:<uuid> — звонок клиенту: дозвонился / не дозвонился / договорились
 *   cb:r:<h|t|w>:<uuid> — напомнить о клиенте: через час / завтра 10:00 / через 3 дня
 *   cb:n:<i|t|g>        — «Входящие» / «Задачи» / «Сводка» НОВЫМ сообщением:
 *                         кнопка под напоминанием и сводкой не стирает их правкой
 *   cb:g                — «Сводка»: когда приходит (1353)
 *   cb:g:<m|d|e|o>      — сводка утром / днём / вечером / не присылать
 *
 * Кнопки экрана кабинета правят то сообщение, под которым стоят (кабинет
 * листается); `cb:n:` — нет (`cabinetPressEdits`).
 *
 * В payload — только вид и номер: имя, телефон и текст в кнопку не кладутся
 * (Telegram показывает callback_data в логах клиента, MAX — в апдейте).
 * Длина — до 64 байт (лимит callback_data Telegram); самая длинная форма —
 * карточка предмета с uuid, 44 байта.
 *
 * Права payload не даёт: чей чат, чья задача, чей клиент — решает сервис
 * (lib/chat-cabinet/service) по чату сообщения с кнопкой.
 */

import type { InboxKind } from '@/lib/crm/inbox-kinds';

export const CABINET_PREFIX = 'cb:';

/** Двухбуквенный код вида предмета «Входящих» в payload. */
export const INBOX_KIND_CODE: Readonly<Record<InboxKind, string>> = {
  operator_booking: 'ob',
  seat_request: 'sr',
  lead: 'ld',
  accommodation_booking: 'ab',
  stay_request: 'sq',
  gear_rental: 'gr',
  charter_request: 'cr',
  charter_ride: 'rd',
  guide_invite: 'gi',
  guide_review: 'gv',
  tour_review: 'tv',
  stay_review: 'sv',
};

const CODE_KIND = new Map(Object.entries(INBOX_KIND_CODE).map(([kind, code]) => [code, kind as InboxKind]));

export type TouchOutcome = 'reached' | 'missed' | 'agreed';
export type RemindWhen = 'hour' | 'tomorrow' | 'days3';
/** Когда приходит сводка кабинета (chat_cabinet_settings.digest, 1353). */
export type DigestMode = 'morning' | 'day' | 'evening' | 'off';

const TOUCH_CODE: Readonly<Record<TouchOutcome, string>> = { reached: 'd', missed: 'n', agreed: 'a' };
const CODE_TOUCH = new Map(Object.entries(TOUCH_CODE).map(([o, c]) => [c, o as TouchOutcome]));
const REMIND_CODE: Readonly<Record<RemindWhen, string>> = { hour: 'h', tomorrow: 't', days3: 'w' };
const CODE_REMIND = new Map(Object.entries(REMIND_CODE).map(([w, c]) => [c, w as RemindWhen]));
const DIGEST_CODE: Readonly<Record<DigestMode, string>> = { morning: 'm', day: 'd', evening: 'e', off: 'o' };
const CODE_DIGEST = new Map(Object.entries(DIGEST_CODE).map(([d, c]) => [c, d as DigestMode]));

export type CabinetPress =
  | { kind: 'more' }
  | { kind: 'inbox'; page: number }
  | { kind: 'item'; item: InboxKind; id: string }
  | { kind: 'tasks'; page: number }
  | { kind: 'task_done'; taskId: string }
  | { kind: 'task_tomorrow'; taskId: string }
  | { kind: 'clients'; page: number }
  | { kind: 'client'; contactId: string }
  | { kind: 'search' }
  | { kind: 'search_cancel' }
  | { kind: 'touch'; outcome: TouchOutcome; contactId: string }
  | { kind: 'remind'; when: RemindWhen; contactId: string }
  | { kind: 'digest' }
  | { kind: 'digest_set'; mode: DigestMode };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Номер предмета «Входящих»: bigint брони строкой или uuid заявки. */
const ITEM_ID = `(?:\\d{1,18}|${UUID})`;
/** Страниц больше сотни в чате не листают — дальше кабинет на сайте. */
const PAGE = '\\d{1,2}';

const FORMS: ReadonlyArray<[RegExp, (m: RegExpExecArray) => CabinetPress | null]> = [
  [/^cb:m$/, () => ({ kind: 'more' })],
  [/^cb:n:i$/, () => ({ kind: 'inbox', page: 0 })],
  [/^cb:n:t$/, () => ({ kind: 'tasks', page: 0 })],
  [/^cb:n:g$/, () => ({ kind: 'digest' })],
  [/^cb:g$/, () => ({ kind: 'digest' })],
  [/^cb:g:([mdeo])$/, (m) => {
    const mode = CODE_DIGEST.get(m[1] ?? '');
    return mode ? { kind: 'digest_set', mode } : null;
  }],
  [new RegExp(`^cb:i(?::(${PAGE}))?$`), (m) => ({ kind: 'inbox', page: Number(m[1] ?? 0) })],
  [new RegExp(`^cb:o:([a-z]{2}):(${ITEM_ID})$`), (m) => {
    const item = CODE_KIND.get(m[1] ?? '');
    return item ? { kind: 'item', item, id: (m[2] ?? '').toLowerCase() } : null;
  }],
  [new RegExp(`^cb:t(?::(${PAGE}))?$`), (m) => ({ kind: 'tasks', page: Number(m[1] ?? 0) })],
  [new RegExp(`^cb:d:(${UUID})$`), (m) => ({ kind: 'task_done', taskId: m[1]! })],
  [new RegExp(`^cb:z:(${UUID})$`), (m) => ({ kind: 'task_tomorrow', taskId: m[1]! })],
  [/^cb:c$/, () => ({ kind: 'clients', page: 0 })],
  [new RegExp(`^cb:l:(${PAGE})$`), (m) => ({ kind: 'clients', page: Number(m[1]) })],
  [new RegExp(`^cb:c:(${UUID})$`), (m) => ({ kind: 'client', contactId: m[1]! })],
  [/^cb:f$/, () => ({ kind: 'search' })],
  [/^cb:x$/, () => ({ kind: 'search_cancel' })],
  [new RegExp(`^cb:k:([dna]):(${UUID})$`), (m) => {
    const outcome = CODE_TOUCH.get(m[1] ?? '');
    return outcome ? { kind: 'touch', outcome, contactId: m[2]! } : null;
  }],
  [new RegExp(`^cb:r:([htw]):(${UUID})$`), (m) => {
    const when = CODE_REMIND.get(m[1] ?? '');
    return when ? { kind: 'remind', when, contactId: m[2]! } : null;
  }],
];

export function isCabinetPayload(payload: string): boolean {
  return payload.startsWith(CABINET_PREFIX);
}

/**
 * Править ли сообщение с кнопкой. Нет — у кнопок под напоминанием и сводкой
 * (`cb:n:`): их текст — то, что ждёт, и правка его стёрла бы.
 */
export function cabinetPressEdits(payload: string): boolean {
  return !/^cb:n:/i.test(payload);
}

/** null — не кнопка кабинета или испорченный payload. Регистр uuid не важен. */
export function parseCabinetPress(payload: string): CabinetPress | null {
  if (!isCabinetPayload(payload)) return null;
  const p = payload.toLowerCase();
  for (const [re, build] of FORMS) {
    const m = re.exec(p);
    if (m) return build(m);
  }
  return null;
}

/** Сборка payload. Каждая форма разбирается обратно `parseCabinetPress`. */
export const cabinetPayload = {
  more: (): string => 'cb:m',
  inbox: (page = 0): string => (page > 0 ? `cb:i:${page}` : 'cb:i'),
  /** «Входящие» новым сообщением — под напоминанием и сводкой. */
  openInbox: (): string => 'cb:n:i',
  /** «Задачи» новым сообщением — под напоминанием и сводкой. */
  openTasks: (): string => 'cb:n:t',
  /** «Сводка» новым сообщением — под самой сводкой. */
  openDigest: (): string => 'cb:n:g',
  digest: (): string => 'cb:g',
  digestSet: (mode: DigestMode): string => `cb:g:${DIGEST_CODE[mode]}`,
  item: (kind: InboxKind, id: string): string => `cb:o:${INBOX_KIND_CODE[kind]}:${id.toLowerCase()}`,
  tasks: (page = 0): string => (page > 0 ? `cb:t:${page}` : 'cb:t'),
  taskDone: (taskId: string): string => `cb:d:${taskId.toLowerCase()}`,
  taskTomorrow: (taskId: string): string => `cb:z:${taskId.toLowerCase()}`,
  clients: (page = 0): string => (page > 0 ? `cb:l:${page}` : 'cb:c'),
  client: (contactId: string): string => `cb:c:${contactId.toLowerCase()}`,
  search: (): string => 'cb:f',
  searchCancel: (): string => 'cb:x',
  touch: (outcome: TouchOutcome, contactId: string): string => `cb:k:${TOUCH_CODE[outcome]}:${contactId.toLowerCase()}`,
  remind: (when: RemindWhen, contactId: string): string => `cb:r:${REMIND_CODE[when]}:${contactId.toLowerCase()}`,
} as const;

/** Самый длинный payload кабинета — в лимите callback_data Telegram (64 байта). */
export const CABINET_PAYLOAD_MAX_BYTES = 64;
