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
 *   cb:g                — «Сводка»: когда приходит (1354)
 *   cb:g:<m|d|e|o>      — сводка утром / днём / вечером / не присылать
 *   cb:v                — «Машины и прайс» перевозчика: парк и строки прайса
 *                         с черновиками (#2862 этап C)
 *   cb:v:<a|z>:<uuid>   — машину вернуть на линию / снять с линии
 *   cb:y                — «Сводка» перевозчика: заявки, ответы, поездки,
 *                         отзывы за 30 дней (#2862 этап D)
 *   cb:u                — «Мои туры» гида со своими турами (30.10, «гид
 *                         должен полностью управлять своей ролью из MAX»)
 *   cb:u:<тур>          — карточка своего тура: даты, правка текста, страница
 *   cb:w:<тур>[:<стр>]  — даты тура, по 14 дней на странице
 *   cb:w:<o|c>:<тур>:<ггггммдд> — открыть / закрыть дату (lib/guides/own-dates)
 *   cb:h:<тур>          — как править текст тура фразой
 *   cb:e:<s|x>:<uuid>   — черновик правки тура: «Сохранить» / «Отмена»
 *   cb:e:t:<uuid>:<i>   — черновик правки: выбрать тур из кандидатов
 *   cb:a | cb:a:<стр>   — «Отзывы» гида (этап 2, 30.10), страница
 *   cb:a:v:<uuid>       — отзыв: текст, ответ, кнопки
 *   cb:a:r:<uuid>       — «Ответить» / «Изменить ответ»: следующее сообщение — текст
 *   cb:a:d:<uuid>       — «Удалить ответ»: предпросмотр с кнопкой
 *   cb:b:<s|x>:<uuid>   — черновик гида (ответ, удаление, профиль): записать / отмена
 *   cb:s | cb:s:<стр>   — «Расписание» гида на 14 дней, страница
 *   cb:j                — «Заработок» гида за 30 дней
 *   cb:p                — «Профиль и команда» гида
 *   cb:p:<a|n>:<uuid>   — приглашение в команду: принять / отклонить
 *   cb:p:l | cb:p:y     — «Выйти из команды»: вопрос / подтверждение
 *   cb:q:a:<uuid>       — документ гида (.docx, 1359): «Сохранить всё»
 *   cb:q:f:<uuid>:<i>   — документ гида: сохранить одно поле (номер в DOC_FIELDS)
 *   cb:q:t:<uuid>:<i>   — документ гида: выбрать тур из кандидатов
 *   cb:q:x:<uuid>       — документ гида: отмена
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
/** Когда приходит сводка кабинета (chat_cabinet_settings.digest, 1354). */
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
  | { kind: 'digest_set'; mode: DigestMode }
  | { kind: 'fleet' }
  | { kind: 'vehicle_active'; vehicleId: string; active: boolean }
  | { kind: 'carrier_summary' }
  | { kind: 'my_tours' }
  | { kind: 'tour'; tourId: string }
  | { kind: 'tour_dates'; tourId: string; page: number }
  | { kind: 'date_open' | 'date_close'; tourId: string; date: string }
  | { kind: 'tour_hint'; tourId: string }
  | { kind: 'edit_save' | 'edit_cancel'; draftId: string }
  | { kind: 'edit_tour'; draftId: string; index: number }
  | { kind: 'reviews'; page: number }
  | { kind: 'review' | 'review_reply' | 'review_delete'; reviewId: string }
  | { kind: 'draft_save' | 'draft_cancel'; draftId: string }
  | { kind: 'schedule'; page: number }
  | { kind: 'earnings' }
  | { kind: 'profile' }
  | { kind: 'invite_accept' | 'invite_decline'; inviteId: string }
  | { kind: 'team_leave' }
  | { kind: 'team_leave_yes' }
  /** `field` — номер поля в DOC_FIELDS (lib/guides/tour-edit/doc-sections); null — все. */
  | { kind: 'doc_save'; draftId: string; field: number | null }
  | { kind: 'doc_cancel'; draftId: string }
  | { kind: 'doc_tour'; draftId: string; index: number };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Номер предмета «Входящих»: bigint брони строкой или uuid заявки. */
const ITEM_ID = `(?:\\d{1,18}|${UUID})`;
/** Страниц больше сотни в чате не листают — дальше кабинет на сайте. */
const PAGE = '\\d{1,2}';
/** Номер тура (`operator_tours.id`, bigint). */
const TOUR = '\\d{1,18}';
/** Страниц дат — до полугода вперёд по 14 дней. */
export const TOUR_DATES_MAX_PAGE = 12;
/** Страниц расписания гида — по 14 дней, до десяти недель вперёд. */
export const SCHEDULE_MAX_PAGE = 4;

const REVIEW_ACTION: Readonly<Record<string, 'review' | 'review_reply' | 'review_delete'>> = {
  v: 'review', r: 'review_reply', d: 'review_delete',
};

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
  [/^cb:v$/, () => ({ kind: 'fleet' })],
  [/^cb:y$/, () => ({ kind: 'carrier_summary' })],
  [new RegExp(`^cb:v:([az]):(${UUID})$`), (m) => ({ kind: 'vehicle_active', vehicleId: m[2]!, active: m[1] === 'a' })],
  [/^cb:u$/, () => ({ kind: 'my_tours' })],
  [new RegExp(`^cb:u:(${TOUR})$`), (m) => ({ kind: 'tour', tourId: m[1]! })],
  [new RegExp(`^cb:w:(${TOUR})(?::(\\d{1,2}))?$`), (m) => {
    const page = Number(m[2] ?? 0);
    return page <= TOUR_DATES_MAX_PAGE ? { kind: 'tour_dates', tourId: m[1]!, page } : null;
  }],
  [new RegExp(`^cb:w:([oc]):(${TOUR}):(\\d{8})$`), (m) => {
    const d = m[3]!;
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return { kind: m[1] === 'o' ? 'date_open' : 'date_close', tourId: m[2]!, date };
  }],
  [new RegExp(`^cb:h:(${TOUR})$`), (m) => ({ kind: 'tour_hint', tourId: m[1]! })],
  [new RegExp(`^cb:e:([sx]):(${UUID})$`), (m) => ({ kind: m[1] === 's' ? 'edit_save' : 'edit_cancel', draftId: m[2]! })],
  [new RegExp(`^cb:e:t:(${UUID}):([0-7])$`), (m) => ({ kind: 'edit_tour', draftId: m[1]!, index: Number(m[2]) })],
  [new RegExp(`^cb:a(?::(${PAGE}))?$`), (m) => ({ kind: 'reviews', page: Number(m[1] ?? 0) })],
  [new RegExp(`^cb:a:([vrd]):(${UUID})$`), (m) => ({ kind: REVIEW_ACTION[m[1]!]!, reviewId: m[2]! })],
  [new RegExp(`^cb:b:([sx]):(${UUID})$`), (m) => ({ kind: m[1] === 's' ? 'draft_save' : 'draft_cancel', draftId: m[2]! })],
  [/^cb:s(?::(\d))?$/, (m) => {
    const page = Number(m[1] ?? 0);
    return page <= SCHEDULE_MAX_PAGE ? { kind: 'schedule', page } : null;
  }],
  [/^cb:j$/, () => ({ kind: 'earnings' })],
  [/^cb:p$/, () => ({ kind: 'profile' })],
  [new RegExp(`^cb:p:([an]):(${UUID})$`), (m) => ({ kind: m[1] === 'a' ? 'invite_accept' : 'invite_decline', inviteId: m[2]! })],
  [/^cb:p:l$/, () => ({ kind: 'team_leave' })],
  [/^cb:p:y$/, () => ({ kind: 'team_leave_yes' })],
  [new RegExp(`^cb:q:a:(${UUID})$`), (m) => ({ kind: 'doc_save', draftId: m[1]!, field: null })],
  [new RegExp(`^cb:q:f:(${UUID}):([0-5])$`), (m) => ({ kind: 'doc_save', draftId: m[1]!, field: Number(m[2]) })],
  [new RegExp(`^cb:q:x:(${UUID})$`), (m) => ({ kind: 'doc_cancel', draftId: m[1]! })],
  [new RegExp(`^cb:q:t:(${UUID}):([0-7])$`), (m) => ({ kind: 'doc_tour', draftId: m[1]!, index: Number(m[2]) })],
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
  fleet: (): string => 'cb:v',
  /** «Сводка» перевозчика: заявки, ответы, поездки, отзывы за 30 дней (#2862 этап D). */
  carrierSummary: (): string => 'cb:y',
  vehicleActive: (vehicleId: string, active: boolean): string => `cb:v:${active ? 'a' : 'z'}:${vehicleId.toLowerCase()}`,
  /** «Мои туры» гида со своими турами. */
  myTours: (): string => 'cb:u',
  tour: (tourId: string): string => `cb:u:${tourId}`,
  tourDates: (tourId: string, page = 0): string => (page > 0 ? `cb:w:${tourId}:${page}` : `cb:w:${tourId}`),
  dateOpen: (tourId: string, date: string): string => `cb:w:o:${tourId}:${date.replace(/-/g, '')}`,
  dateClose: (tourId: string, date: string): string => `cb:w:c:${tourId}:${date.replace(/-/g, '')}`,
  tourHint: (tourId: string): string => `cb:h:${tourId}`,
  editSave: (draftId: string): string => `cb:e:s:${draftId.toLowerCase()}`,
  editCancel: (draftId: string): string => `cb:e:x:${draftId.toLowerCase()}`,
  editTour: (draftId: string, index: number): string => `cb:e:t:${draftId.toLowerCase()}:${index}`,
  /** «Отзывы» гида. */
  reviews: (page = 0): string => (page > 0 ? `cb:a:${page}` : 'cb:a'),
  review: (reviewId: string): string => `cb:a:v:${reviewId.toLowerCase()}`,
  reviewReply: (reviewId: string): string => `cb:a:r:${reviewId.toLowerCase()}`,
  reviewDelete: (reviewId: string): string => `cb:a:d:${reviewId.toLowerCase()}`,
  draftSave: (draftId: string): string => `cb:b:s:${draftId.toLowerCase()}`,
  draftCancel: (draftId: string): string => `cb:b:x:${draftId.toLowerCase()}`,
  /** «Расписание» гида на 14 дней. */
  schedule: (page = 0): string => (page > 0 ? `cb:s:${page}` : 'cb:s'),
  earnings: (): string => 'cb:j',
  profile: (): string => 'cb:p',
  inviteAccept: (inviteId: string): string => `cb:p:a:${inviteId.toLowerCase()}`,
  inviteDecline: (inviteId: string): string => `cb:p:n:${inviteId.toLowerCase()}`,
  teamLeave: (): string => 'cb:p:l',
  teamLeaveYes: (): string => 'cb:p:y',
  /** Документ гида (.docx → поля тура, 1359). */
  docSaveAll: (draftId: string): string => `cb:q:a:${draftId.toLowerCase()}`,
  docSaveField: (draftId: string, field: number): string => `cb:q:f:${draftId.toLowerCase()}:${field}`,
  docCancel: (draftId: string): string => `cb:q:x:${draftId.toLowerCase()}`,
  docTour: (draftId: string, index: number): string => `cb:q:t:${draftId.toLowerCase()}:${index}`,
} as const;

/** Самый длинный payload кабинета — в лимите callback_data Telegram (64 байта). */
export const CABINET_PAYLOAD_MAX_BYTES = 64;
