/**
 * Модерация правок тура: правило (план готовности 23.11, этап 4).
 *
 * Содержание тура — то, что турист читает как обещание: название, тексты,
 * программа, состав, условия отмены, точка сбора, цена, снимки — попадает на
 * витрину только после проверки администратором. Живая строка
 * `operator_tours` — последняя одобренная версия; правка лежит черновиком в
 * `operator_tour_edits` (миграция 1507).
 *
 * Сразу, без очереди: скрыть и показать тур, снять с публикации, даты, число
 * мест, сезон, расписание и прочие атрибуты. Оператор обязан мочь закрыть
 * выезд в день выезда, не дожидаясь никого.
 *
 * Здесь только правило и слова — без базы, чтобы его читали и экраны.
 * Черновик — lib/tours/moderation-store.ts, очередь и решение —
 * lib/tours/moderation-review.ts, чтение правок владельца —
 * lib/tours/moderation-read.ts, единая дверь владельца —
 * lib/tours/tour-change.ts.
 */

/** Колонки тура, которые идут на витрину через проверку. */
export const MODERATED_TOUR_COLUMNS = [
  'title', 'short_description', 'description', 'program',
  'included', 'not_included', 'what_to_bring', 'safety_notes',
  'cancellation_policy', 'pickup_type', 'pickup_details',
  'base_price', 'price_old', 'price_unit',
  'photos', 'tour_image', 'video_clips',
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
  base_price: 'Цена',
  price_old: 'Старая цена',
  price_unit: 'Единица цены',
  photos: 'Фото',
  tour_image: 'Главное фото',
  video_clips: 'Видео',
};

/** Поля-снимки: в диффе показываются картинками, а не строкой адресов. */
export const TOUR_PHOTO_FIELDS: readonly ModeratedTourColumn[] = ['photos', 'tour_image'];

const NUMERIC = new Set<string>(['base_price', 'price_old']);

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
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) !== isBlank(b)) return false;
  if (NUMERIC.has(field)) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
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
}

const EMPTY = 'не записано';

function photosOf(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

/** Значение поля словами — для строки «было / стало». */
export function tourValueText(field: ModeratedTourColumn, value: unknown): string {
  if (isBlank(value)) return EMPTY;
  if (NUMERIC.has(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? `${new Intl.NumberFormat('ru-RU').format(n)} ₽` : String(value);
  }
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
export function tourEditChanges(live: Record<string, unknown>, patch: TourContentPatch): TourEditChange[] {
  const out: TourEditChange[] = [];
  for (const field of MODERATED_TOUR_COLUMNS) {
    if (!(field in patch)) continue;
    const change: TourEditChange = {
      field,
      label: TOUR_FIELD_LABELS[field],
      before: tourValueText(field, live[field]),
      after: tourValueText(field, patch[field]),
    };
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
