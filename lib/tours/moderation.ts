/**
 * Модерация правок тура: правило (план готовности 23.11, этап 4).
 *
 * Содержание тура — то, что турист читает как обещание: название, тексты,
 * программа, состав, условия отмены, точка сбора, цена, снимки — попадает на
 * витрину только после проверки администратором. Живая строка
 * `operator_tours` — последняя одобренная версия; правка лежит черновиком в
 * `operator_tour_edits` (миграция 1507).
 *
 * Через проверку идут и сложность, длительность, место и сезон (слово
 * владельца 23.11: «от них зависят планер и даты, поэтому без проверки сразу
 * на сайт нельзя»). По ним планер ставит тур в день, а календарь открывает
 * даты — правка, вышедшая сразу, меняла бы чужие планы без чьего-либо взгляда.
 *
 * Сразу, без очереди: скрыть и показать тур, снять с публикации, даты, число
 * мест, расписание и прочие атрибуты. Оператор обязан мочь закрыть выезд в
 * день выезда, не дожидаясь никого.
 *
 * Здесь только правило и слова — без базы, чтобы его читали и экраны.
 * Черновик — lib/tours/moderation-store.ts, очередь и решение —
 * lib/tours/moderation-review.ts, чтение правок владельца —
 * lib/tours/moderation-read.ts, единая дверь владельца —
 * lib/tours/tour-change.ts.
 */

import { locationTypeLabel } from '@/lib/places/location-types';
import { difficultyLabel } from '@/lib/tours/labels';

/** Колонки тура, которые идут на витрину через проверку. */
export const MODERATED_TOUR_COLUMNS = [
  'title', 'short_description', 'description', 'program',
  'included', 'not_included', 'what_to_bring', 'safety_notes',
  'cancellation_policy', 'pickup_type', 'pickup_details',
  // Прежнее поле точки сбора: карточка тура читает его, когда способ встречи
  // не записан. Владелец его не правит — пишет только ручной крон, дверью.
  'meeting_point',
  'base_price', 'price_old', 'price_unit',
  'photos', 'tour_image', 'video_clips',
  // Слово владельца 23.11: сложность, длительность, место и сезон.
  'difficulty',
  'duration_hours', 'duration_type', 'multi_day_count',
  'location_name', 'location_type', 'latitude', 'longitude',
  // Главное место — связь «тур → место»: по ней карточка места показывает тур.
  'main_place_id',
  'season_start', 'season_end', 'seasonal_only',
] as const;

export type ModeratedTourColumn = (typeof MODERATED_TOUR_COLUMNS)[number];

/** Правка содержания: ключа нет — поле не меняется; null — поле очищается. */
export type TourContentPatch = Partial<Record<ModeratedTourColumn, unknown>>;

const MODERATED = new Set<string>(MODERATED_TOUR_COLUMNS);

export function isModeratedTourColumn(key: string): key is ModeratedTourColumn {
  return MODERATED.has(key);
}

/** Как поле называется человеку — в диффе оператора и в очереди администратора. */
export const TOUR_FIELD_LABELS: Record<ModeratedTourColumn, string> = {
  title: 'Название',
  short_description: 'Короткое описание',
  description: 'Описание',
  program: 'Программа',
  included: 'Что включено',
  not_included: 'Что не входит',
  what_to_bring: 'Что взять с собой',
  safety_notes: 'Правила безопасности',
  cancellation_policy: 'Условия отмены',
  pickup_type: 'Как встречаются',
  pickup_details: 'Точка сбора',
  meeting_point: 'Точка сбора (прежнее поле)',
  base_price: 'Цена',
  price_old: 'Старая цена',
  price_unit: 'Единица цены',
  photos: 'Фото',
  tour_image: 'Главное фото',
  video_clips: 'Видео',
  difficulty: 'Сложность',
  duration_hours: 'Длительность в часах',
  duration_type: 'Тип длительности',
  multi_day_count: 'Число дней',
  location_name: 'Место',
  location_type: 'Вид места',
  latitude: 'Широта',
  longitude: 'Долгота',
  main_place_id: 'Главное место',
  season_start: 'Начало сезона',
  season_end: 'Конец сезона',
  seasonal_only: 'Только в сезон',
};

/** Поля-снимки: в диффе показываются картинками, а не строкой адресов. */
export const TOUR_PHOTO_FIELDS: readonly ModeratedTourColumn[] = ['photos', 'tour_image'];

/** Цена: число в рублях. */
const PRICE = new Set<string>(['base_price', 'price_old']);
/** Числа без рублей: из базы numeric приходит строкой («8.00»), из формы — числом. */
const PLAIN_NUMBER = new Set<string>(['duration_hours', 'multi_day_count', 'latitude', 'longitude']);
const NUMERIC = new Set<string>([...PRICE, ...PLAIN_NUMBER]);
/** Дата без времени: сверяется и показывается как день календаря. */
const DATE_ONLY = new Set<string>(['season_start', 'season_end']);
/** Да или нет: «не записано» в базе читается как «нет» (умолчание колонки). */
const YES_NO = new Set<string>(['seasonal_only']);

/** Колонки-даты содержания: живую строку читают текстом, а не объектом времени. */
export const TOUR_DATE_COLUMNS: readonly ModeratedTourColumn[] = ['season_start', 'season_end'];

/**
 * День календаря «ГГГГ-ММ-ДД» из того, что пришло: строка базы или формы,
 * отметка времени из JSON, объект времени драйвера. `null` — дня нет.
 *
 * Объект времени драйвер собирает полночью ПО МЕСТНОМУ времени — поэтому
 * берутся местные год, месяц и число, а не строка UTC: иначе день съехал бы
 * на сутки в любом поясе западнее Гринвича.
 */
export function tourDayKey(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1] : null;
}

/** Запись значения с ключами по алфавиту: порядок ключей jsonb базы и формы не различается. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Пусто: null, пустая строка, пустой список. Для сравнения это одно и то же. */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

/**
 * Равны ли значения поля. Цена из базы приходит строкой («15000.00»), из
 * формы — числом; пустая строка и NULL — одно «не записано».
 */
export function sameTourValue(field: ModeratedTourColumn, a: unknown, b: unknown): boolean {
  // «Нет» и «не записано» у отметки — одно: колонка по умолчанию ложна, и
  // форма, приславшая false на пустую строку, ничего не меняет.
  if (YES_NO.has(field)) return (a === true) === (b === true);
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) !== isBlank(b)) return false;
  if (NUMERIC.has(field)) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  }
  if (DATE_ONLY.has(field)) {
    const x = tourDayKey(a);
    const y = tourDayKey(b);
    if (x !== null && y !== null) return x === y;
  }
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Правка против живой строки: остаются только поля, значение которых от
 * витрины отличается. Оператор вернул поле к прежнему — в черновике его нет.
 */
export function contentDiff(live: Record<string, unknown>, desired: TourContentPatch): TourContentPatch {
  const out: TourContentPatch = {};
  for (const field of MODERATED_TOUR_COLUMNS) {
    if (!(field in desired) || desired[field] === undefined) continue;
    if (!sameTourValue(field, live[field], desired[field])) out[field] = desired[field] ?? null;
  }
  return out;
}

export interface SplitTourInput {
  /** Содержание — через проверку. */
  content: TourContentPatch;
  /** Остальное — сразу. Публикация сюда не попадает; снятие с публикации — попадает. */
  immediate: Record<string, unknown>;
  /** Владелец просит опубликовать тур. */
  wantsPublish: boolean;
}

/**
 * Делит правку владельца на «через проверку» и «сразу».
 *
 * `is_published: true` — не поле, а просьба: публикацию ставит только
 * одобрение. `is_published: false` — снятие с витрины, оно действует сразу.
 */
export function splitTourInput(input: Record<string, unknown>): SplitTourInput {
  const content: TourContentPatch = {};
  const immediate: Record<string, unknown> = {};
  let wantsPublish = false;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (isModeratedTourColumn(key)) {
      content[key] = value;
    } else if (key === 'is_published') {
      if (value === true) wantsPublish = true;
      else immediate[key] = value;
    } else {
      immediate[key] = value;
    }
  }
  return { content, immediate, wantsPublish };
}

/** Содержание тура, каким оно станет после одобрения: витрина плюс правка. */
export function effectiveContent(live: Record<string, unknown>, patch: TourContentPatch): Record<ModeratedTourColumn, unknown> {
  const out = {} as Record<ModeratedTourColumn, unknown>;
  for (const field of MODERATED_TOUR_COLUMNS) {
    out[field] = field in patch ? (patch[field] ?? null) : (live[field] ?? null);
  }
  return out;
}

// ─── Дифф для экранов ─────────────────────────────────────────────────────────

export interface TourEditChange {
  field: ModeratedTourColumn;
  label: string;
  /** Что на витрине сейчас. */
  before: string;
  /** Что станет после одобрения. */
  after: string;
  /** Адреса снимков — для превью (только у полей-снимков). */
  beforePhotos?: string[];
  afterPhotos?: string[];
  /**
   * Поле предложил автомат платформы — чем он занят, словами
   * (lib/tours/automaton). Нет — поле прислал владелец.
   */
  proposedBy?: string;
}

const EMPTY = 'не записано';

/** Слова формы редактора: «Однодневный» / «Многодневный». Незнакомое — как записано. */
const DURATION_TYPE_WORDS: Record<string, string> = { day: 'однодневный', multi_day: 'многодневный' };

function photosOf(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

/** Значение поля словами — для строки «было / стало». */
/**
 * Что нужно знать, чтобы назвать значение словами. Главное место хранится
 * адресом записи (`places.id`), а человеку нужно имя: его читает тот, кто
 * строит дифф. `null` — имена прочитать не удалось: это не «места нет» (§4.0).
 */
export interface TourValueContext {
  placeNames?: ReadonlyMap<string, string> | null;
  /** Кто предложил поле, словами: {колонка: чем занят автомат}. */
  proposedBy?: Partial<Record<ModeratedTourColumn, string>>;
}

/** Адреса мест, названные в строках и правках: по ним читаются имена. */
export function mainPlaceIdsOf(...rows: Array<Record<string, unknown> | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row?.main_place_id;
    if (typeof id === 'string' && id.trim() !== '') ids.add(id);
  }
  return [...ids];
}

function mainPlaceText(value: unknown, ctx: TourValueContext | undefined): string {
  const id = String(value);
  const names = ctx?.placeNames;
  if (names === undefined || names === null) return `место ${id} (название не прочитано)`;
  return names.get(id) ?? `место не найдено в справочнике (${id})`;
}

export function tourValueText(field: ModeratedTourColumn, value: unknown, ctx?: TourValueContext): string {
  // У отметки пустого нет: «не записано» читается как «нет».
  if (YES_NO.has(field)) return value === true ? 'да' : 'нет';
  if (isBlank(value)) return EMPTY;
  if (PRICE.has(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? `${new Intl.NumberFormat('ru-RU').format(n)} ₽` : String(value);
  }
  if (PLAIN_NUMBER.has(field)) {
    const n = Number(value);
    // Координата — до шестого знака, без разделителей разрядов.
    return Number.isFinite(n)
      ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6, useGrouping: false }).format(n)
      : String(value);
  }
  if (DATE_ONLY.has(field)) {
    const day = tourDayKey(value);
    if (day === null) return String(value);
    const [y, m, d] = day.split('-').map(Number);
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }
  if (field === 'difficulty') return difficultyLabel(String(value), true) || String(value);
  if (field === 'duration_type') return DURATION_TYPE_WORDS[String(value)] ?? String(value);
  if (field === 'location_type') return locationTypeLabel(String(value));
  if (field === 'main_place_id') return mainPlaceText(value, ctx);
  if (field === 'photos' || field === 'tour_image') {
    const n = photosOf(value).length;
    return `снимков: ${n}`;
  }
  if (field === 'video_clips') {
    return Array.isArray(value) ? `роликов: ${value.length}` : EMPTY;
  }
  if (field === 'program') {
    if (!Array.isArray(value)) return EMPTY;
    return value
      .map((s, i) => {
        const step = (s ?? {}) as { title?: unknown; text?: unknown };
        const title = typeof step.title === 'string' ? step.title : '';
        const text = typeof step.text === 'string' ? step.text : '';
        return `${i + 1}. ${[title, text].filter(Boolean).join(' — ')}`;
      })
      .join('\n');
  }
  if (Array.isArray(value)) return value.map((v) => String(v)).join('\n');
  return String(value);
}

/** Дифф «было / стало» по полям правки, в порядке списка полей. */
export function tourEditChanges(live: Record<string, unknown>, patch: TourContentPatch, ctx?: TourValueContext): TourEditChange[] {
  const out: TourEditChange[] = [];
  for (const field of MODERATED_TOUR_COLUMNS) {
    if (!(field in patch)) continue;
    const change: TourEditChange = {
      field,
      label: TOUR_FIELD_LABELS[field],
      before: tourValueText(field, live[field], ctx),
      after: tourValueText(field, patch[field], ctx),
    };
    const proposedBy = ctx?.proposedBy?.[field];
    if (proposedBy) change.proposedBy = proposedBy;
    if (TOUR_PHOTO_FIELDS.includes(field)) {
      change.beforePhotos = photosOf(live[field]);
      change.afterPhotos = photosOf(patch[field]);
    }
    out.push(change);
  }
  return out;
}

// ─── Слова о состоянии ────────────────────────────────────────────────────────

export type TourModerationState =
  /** Тур не опубликован, проверки никто не просил. */
  | 'draft'
  /** Просьба опубликовать или правка ждёт администратора. */
  | 'pending'
  /** На витрине, правок на проверке нет. */
  | 'live'
  /** Последняя правка возвращена с причиной. */
  | 'rejected';

export interface TourModerationFacts {
  published: boolean;
  pending: boolean;
  /** Последнее решение — отказ, и новой правки после него нет. */
  rejected: boolean;
}

export function tourModerationState(f: TourModerationFacts): TourModerationState {
  if (f.pending) return 'pending';
  if (f.rejected) return 'rejected';
  return f.published ? 'live' : 'draft';
}

/** Что сказать владельцу после сохранения. */
export function pendingNotice(fields: readonly ModeratedTourColumn[], wantsPublish: boolean, published: boolean): string {
  const list = fields.map((f) => TOUR_FIELD_LABELS[f].toLowerCase()).join(', ');
  if (wantsPublish && !published) {
    return fields.length > 0
      ? `Тур отправлен на проверку вместе с правкой (${list}). Туристы увидят его после одобрения администратором.`
      : 'Тур отправлен на проверку. Туристы увидят его после одобрения администратором.';
  }
  return `Правка отправлена на проверку (${list}). На витрине пока прежняя версия.`;
}

/** Кабинет, где владелец правит свои туры: у гида он свой. */
export function tourCabinetPath(partnerCategory: string | null): string {
  return partnerCategory === 'guide' ? '/hub/guide/own' : '/hub/operator/tours';
}

/** Список полей словами — «цена, фото»: для сообщений о решении. */
export function tourFieldsWords(fields: readonly ModeratedTourColumn[]): string {
  return fields.map((f) => TOUR_FIELD_LABELS[f].toLowerCase()).join(', ');
}

// ─── Метка проверки в списке туров ────────────────────────────────────────────

/**
 * Что с проверкой тура — одной меткой рядом с «видит ли турист». `unknown` —
 * правки прочитать не удалось: это не «проверки нет» (§4.0).
 */
export type TourReviewMark = 'pending_publish' | 'pending_edit' | 'rejected' | 'unknown';

export const TOUR_REVIEW_LABELS: Readonly<Record<TourReviewMark, string>> = {
  pending_publish: 'На проверке',
  pending_edit: 'Правка на проверке',
  rejected: 'Возвращён на доработку',
  unknown: 'Проверка: не прочитано',
};

export function tourReviewMark(
  edit: { pending: { wantsPublish: boolean } | null; rejected: unknown | null } | null | undefined,
): Exclude<TourReviewMark, 'unknown'> | null {
  if (edit?.pending) return edit.pending.wantsPublish ? 'pending_publish' : 'pending_edit';
  if (edit?.rejected) return 'rejected';
  return null;
}

// ─── Очередь администратора: что отдаёт список ───────────────────────────────

export interface TourContentLine {
  field: ModeratedTourColumn;
  label: string;
  text: string;
  photos?: string[];
}

export interface PendingTourEdit {
  id: string;
  tourId: string;
  tourTitle: string;
  partnerId: string;
  partnerName: string;
  partnerCategory: string | null;
  /** Новый тур просится на витрину либо правка уже опубликованного. */
  kind: 'publish' | 'edit';
  /** Что меняется против витрины. */
  changes: TourEditChange[];
  /** Всё содержание, каким оно станет: новому туру диффа мало. */
  content: TourContentLine[];
  /** Отпечаток содержания: решение возвращает его обратно. */
  seen: string;
  since: string;
}
