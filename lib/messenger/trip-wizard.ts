/**
 * «Спланировать поездку» кнопками в ботах MAX и Telegram (22.11, слово
 * владельца «И планеры в максе и тг для пользователей с ролью турист»).
 *
 * Четыре вопроса кнопками — когда, сколько дней, кто едет, что интересно — и
 * план тем же движком, что у сайта и у Кузьмича (`makeTripPlanForKuzmich` →
 * `recommendTrip`). Модель не зовётся: ни одного запроса к LLM.
 *
 * Правила:
 *  - состояние диалога целиком в данных кнопки: коды, без имён и телефонов,
 *    короче 64 байт (предел Telegram `callback_data`); таблиц не заводим;
 *  - места — из ответа движка в момент сборки (БД, без кэша);
 *  - телефон и имя не спрашиваются; заявка — не бронь, оплаты нет;
 *  - ответ — строка на день и две ссылки: план целиком (/trip/<id>) и
 *    «Изменить в планере» (/planner?…).
 *
 * Чистые функции; сборка плана — `buildWizardPlan` с внедряемыми
 * зависимостями (тест — без базы).
 */
import { tourRuns } from '@/lib/planner/day-card-view';
import { zoneName } from '@/lib/planner/zone-style';
import type { DayPlan } from '@/lib/planner/engine';

export const WIZARD_BUTTON = 'Спланировать поездку';
export const WIZARD_PREFIX = 'tp:';
/** Предел Telegram для `callback_data`, байт. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** Интересы — ключи движка; порядок задаёт бит в маске, менять только дописыванием в конец. */
export const WIZARD_INTERESTS: ReadonlyArray<{ key: string; label: string; word: string }> = [
  { key: 'volcano', label: 'Вулканы', word: 'вулканы' },
  { key: 'bears', label: 'Медведи', word: 'медведи' },
  { key: 'fishing', label: 'Рыбалка', word: 'рыбалка' },
  { key: 'thermal', label: 'Источники', word: 'термальные источники' },
  { key: 'boat_trip', label: 'Океан', word: 'океан' },
  { key: 'helicopter', label: 'Вертолёт', word: 'вертолёт' },
  { key: 'geyser', label: 'Гейзеры', word: 'гейзеры' },
  { key: 'trekking', label: 'Походы', word: 'поход' },
  { key: 'river', label: 'Сплав', word: 'сплав' },
  { key: 'snowmobile', label: 'Снегоходы', word: 'снегоход' },
];

export const WIZARD_DAYS = [3, 5, 7, 10, 14] as const;
export const WIZARD_ADULTS = [1, 2, 3, 4] as const;
/**
 * Ребёнок — возрастной группой. Движок судит допуски по возрасту, поэтому
 * берётся МЛАДШИЙ возраст группы: строже, а не мягче (это говорится в плане).
 * Несколько детей и точные возрасты — в планере на сайте.
 */
export const WIZARD_KIDS: ReadonlyArray<{ code: number; label: string; age: number | null }> = [
  { code: 0, label: 'Без детей', age: null },
  { code: 1, label: 'Ребёнок до 3 лет', age: 1 },
  { code: 2, label: '4–6 лет', age: 4 },
  { code: 3, label: '7–11 лет', age: 7 },
  { code: 4, label: '12–17 лет', age: 12 },
];

export interface WizardState {
  /** Шаг, который показать: 0 когда, 1 дни, 2 взрослые, 3 дети, 4 интересы, 5 собрать. */
  step: number;
  /** Дата старта YYYY-MM-DD. */
  start: string | null;
  days: number | null;
  adults: number | null;
  kid: number | null;
  /** Битовая маска WIZARD_INTERESTS. */
  mask: number;
}

export interface WizardButton { text: string; payload?: string; url?: string }
export interface WizardScreen { text: string; buttons: WizardButton[][] }

const EMPTY: WizardState = { step: 0, start: null, days: null, adults: null, kid: null, mask: 0 };
/** Первый шаг мастера. */
export const WIZARD_START: Readonly<WizardState> = EMPTY;

export function isWizardPayload(data: string): boolean {
  return typeof data === 'string' && data.startsWith(WIZARD_PREFIX);
}

/** `tp:<шаг>:<yymmdd|->:<дни|->:<взрослые|->:<ребёнок|->:<маска hex>` */
export function encodeWizard(s: WizardState): string {
  const d = s.start ? s.start.slice(2).replace(/-/g, '') : '-';
  const n = (v: number | null) => (v === null ? '-' : String(v));
  return `${WIZARD_PREFIX}${s.step}:${d}:${n(s.days)}:${n(s.adults)}:${n(s.kid)}:${s.mask.toString(16)}`;
}

/** Разбор строго по формату; любое отклонение — null (кнопка ничего не делает). */
export function decodeWizard(data: string): WizardState | null {
  if (!isWizardPayload(data) || data.length > CALLBACK_DATA_MAX_BYTES) return null;
  const m = /^tp:([0-5]):(-|\d{6}):(-|\d{1,2}):(-|\d):(-|\d):([0-9a-f]{1,3})$/.exec(data);
  if (!m) return null;
  const num = (v: string) => (v === '-' ? null : Number(v));
  const start = m[2] === '-' ? null : `20${m[2]!.slice(0, 2)}-${m[2]!.slice(2, 4)}-${m[2]!.slice(4, 6)}`;
  if (start !== null && Number.isNaN(Date.parse(`${start}T00:00:00Z`))) return null;
  const days = num(m[3]!);
  if (days !== null && !(WIZARD_DAYS as readonly number[]).includes(days)) return null;
  const adults = num(m[4]!);
  if (adults !== null && !(WIZARD_ADULTS as readonly number[]).includes(adults)) return null;
  const kid = num(m[5]!);
  if (kid !== null && !WIZARD_KIDS.some((k) => k.code === kid)) return null;
  const mask = parseInt(m[6]!, 16);
  if (mask >= 1 << WIZARD_INTERESTS.length) return null;
  return { step: Number(m[1]), start, days, adults, kid, mask };
}

const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Сегодня по Камчатке (UTC+12), YYYY-MM-DD. */
export function kamchatkaToday(nowMs: number): string {
  return new Date(nowMs + 12 * 3600_000).toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}

function ruDate(iso: string): string {
  const [, mm, dd] = iso.split('-');
  return `${Number(dd)} ${MONTHS_GEN[Number(mm) - 1]}`;
}

/** Варианты старта: через две недели и 1-е число шести следующих месяцев. */
export function startOptions(nowMs: number): Array<{ label: string; iso: string }> {
  const today = kamchatkaToday(nowMs);
  const soon = addDays(today, 14);
  const out = [{ label: `Через 2 недели (с ${ruDate(soon)})`, iso: soon }];
  let y = Number(today.slice(0, 4));
  let mo = Number(today.slice(5, 7)); // 1..12, текущий
  for (let i = 0; i < 6; i++) {
    mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
    const iso = `${y}-${String(mo).padStart(2, '0')}-01`;
    if (iso <= soon) continue;
    out.push({ label: `${MONTHS_NOM[mo - 1]![0]!.toUpperCase()}${MONTHS_NOM[mo - 1]!.slice(1)} ${y}`, iso });
  }
  return out;
}

function kidOf(code: number | null) {
  return WIZARD_KIDS.find((k) => k.code === code) ?? null;
}

function chosenLine(s: WizardState): string {
  const parts: string[] = [];
  if (s.start) parts.push(`с ${ruDate(s.start)}`);
  if (s.days) parts.push(`${s.days} дн.`);
  if (s.adults) parts.push(`взрослых: ${s.adults}`);
  const kid = kidOf(s.kid);
  if (kid && kid.age !== null) parts.push(`ребёнок ${kid.label.replace('Ребёнок ', '')}`);
  return parts.length ? `Выбрано: ${parts.join(', ')}.` : '';
}

const RESTART: WizardButton = { text: 'Сначала', payload: encodeWizard(EMPTY) };

function pairs(buttons: WizardButton[]): WizardButton[][] {
  const rows: WizardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/** Экран шага. Шаг 5 («собрать») экраном не рисуется — его собирает buildWizardPlan. */
export function wizardScreen(s: WizardState, nowMs: number): WizardScreen {
  const head = chosenLine(s);
  const lead = (q: string) => (head ? `${head}\n\n${q}` : q);
  switch (s.step) {
    case 0:
      return {
        text: 'Соберу план поездки по Камчатке по дням — четыре вопроса кнопками, без имени и телефона.\n\nКогда едете?',
        buttons: startOptions(nowMs).map((o) => [{ text: o.label, payload: encodeWizard({ ...EMPTY, step: 1, start: o.iso }) }]),
      };
    case 1:
      return {
        text: lead('Сколько дней на Камчатке, считая день прилёта?'),
        buttons: [
          WIZARD_DAYS.map((d) => ({ text: String(d), payload: encodeWizard({ ...s, step: 2, days: d }) })),
          [RESTART],
        ],
      };
    case 2:
      return {
        text: lead('Сколько взрослых едет?'),
        buttons: [
          WIZARD_ADULTS.map((a) => ({ text: String(a), payload: encodeWizard({ ...s, step: 3, adults: a }) })),
          [RESTART],
        ],
      };
    case 3:
      return {
        text: lead('Едет ли ребёнок? Если детей несколько — выберите младшего, точный состав можно задать в планере.'),
        buttons: [
          ...pairs(WIZARD_KIDS.map((k) => ({ text: k.label, payload: encodeWizard({ ...s, step: 4, kid: k.code, mask: 0 }) }))),
          [RESTART],
        ],
      };
    default: {
      // Все занятия, без фильтра по сезону из констант: сезон по каталогу
      // (зимняя рыбалка, например) знает движок, и чего нет — план скажет сам.
      const toggles = WIZARD_INTERESTS.map((_, bit) => {
        const on = (s.mask & (1 << bit)) !== 0;
        return { text: `${on ? '✅ ' : ''}${WIZARD_INTERESTS[bit]!.label}`, payload: encodeWizard({ ...s, step: 4, mask: s.mask ^ (1 << bit) }) };
      });
      const done = s.mask === 0 ? 'Собрать: классика первой поездки' : 'Собрать план';
      return {
        text: lead('Что интересно? Отметьте одно или несколько. Если занятия в эти даты нет, план так и скажет.'),
        buttons: [...pairs(toggles), [{ text: done, payload: encodeWizard({ ...s, step: 5 }) }], [RESTART]],
      };
    }
  }
}

/** Всё ли выбрано для сборки. */
/** Кнопка из старого сообщения: дата старта уже прошла — начинаем сначала. */
export function wizardStale(s: WizardState, nowMs: number): boolean {
  return s.start !== null && s.start < kamchatkaToday(nowMs);
}

export function wizardReady(s: WizardState): s is WizardState & { start: string; days: number; adults: number; kid: number } {
  return s.step === 5 && s.start !== null && s.days !== null && s.adults !== null && s.kid !== null;
}

/** Аргументы для `makeTripPlanForKuzmich` — те же поля, что у инструмента Кузьмича. */
export function wizardPlanArgs(s: WizardState & { start: string; days: number; adults: number; kid: number }) {
  const kid = kidOf(s.kid);
  const words = WIZARD_INTERESTS.filter((_, bit) => (s.mask & (1 << bit)) !== 0).map((it) => it.word);
  return {
    when: s.start,
    days: String(s.days),
    adults: String(s.adults),
    ...(kid && kid.age !== null ? { children: `${kid.age} ${kid.age === 1 ? 'год' : kid.age < 5 ? 'года' : 'лет'}` } : {}),
    ...(words.length ? { interests: words.join(', ') } : {}),
  };
}

const SITE_DEFAULT = 'https://vedarai.ru';

/** «Изменить в планере»: только то, что планер читает из адреса (app/planner/_PlannerClient.tsx). */
export function wizardPlannerHref(s: WizardState & { start: string; days: number; adults: number; kid: number }, site: string = SITE_DEFAULT): string {
  const q = new URLSearchParams();
  q.set('from', s.start);
  q.set('days', String(s.days));
  const keys = WIZARD_INTERESTS.filter((_, bit) => (s.mask & (1 << bit)) !== 0).map((it) => it.key);
  if (keys.length) q.set('hint', keys.join(','));
  q.set('adults', String(s.adults));
  const kid = kidOf(s.kid);
  if (kid && kid.age !== null) q.set('children', String(kid.age));
  return `${site}/planner?${q.toString()}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function seatsWord(d: DayPlan): string {
  if (!d.realTour) return '';
  if (d.availability === 'open') return ' — места есть';
  if (d.availability === 'none') return ' — свободных мест на эти даты нет';
  return ' — места не проверены';
}

/** Строка на день; многодневный тур — одной строкой «Дни 2–4». HTML-безопасно. */
export function dayLines(days: readonly DayPlan[], arrivalIso: string): string[] {
  const runs = tourRuns(days);
  const out: string[] = [];
  let prev = 0;
  for (const d of days) {
    const run = runs.get(d.day);
    if (run && run.first !== d.day) { prev = d.day; continue; }
    if (d.day > prev + 1) {
      out.push(prev + 1 === d.day - 1
        ? `День ${prev + 1} — не заполнен: подтверждённого выхода нет`
        : `Дни ${prev + 1}–${d.day - 1} — не заполнены: подтверждённых выходов нет`);
    }
    prev = d.day;
    const label = run ? `Дни ${run.first}–${run.last}` : `День ${d.day}`;
    const date = ddmm(addDays(arrivalIso, d.day - 1));
    const zone = d.type === 'activity' ? ` (${zoneName(d.zone)})` : '';
    out.push(`${label}, ${date} — ${esc(d.title)}${zone}${seatsWord(d)}`);
  }
  return out;
}

const TRIP_ID_RE = /\/trip\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export interface WizardDeps {
  makePlan: (args: ReturnType<typeof wizardPlanArgs>) => Promise<string>;
  loadDays: (id: string) => Promise<DayPlan[] | null>;
  site?: string;
}

export const WIZARD_FOOTER = 'Цена, жильё, погода и безопасность (разрешения, медведи, сводки МЧС) — в плане целиком. Заявка на тур — не бронь: места подтверждает оператор, оплаты на сайте нет.';

/**
 * Собрать план и ответ. Черновик плана не сохранился или план не собран —
 * честный отказ движка без строк дней и кнопка в планер.
 */
export async function buildWizardPlan(s: WizardState, deps: WizardDeps): Promise<WizardScreen> {
  const site = deps.site ?? SITE_DEFAULT;
  if (!wizardReady(s)) {
    return { text: 'Не все ответы на месте — начнём сначала.', buttons: [[{ text: WIZARD_BUTTON, payload: encodeWizard(EMPTY) }]] };
  }
  const planner: WizardButton = { text: 'Изменить в планере', url: wizardPlannerHref(s, site) };
  let full: string;
  try {
    full = await deps.makePlan(wizardPlanArgs(s));
  } catch {
    return { text: 'План сейчас не собрался. Попробуйте ещё раз через минуту или соберите его в планере на сайте.', buttons: [[planner], [RESTART]] };
  }
  const id = TRIP_ID_RE.exec(full)?.[1] ?? null;
  const days = id ? await deps.loadDays(id).catch(() => null) : null;
  if (!id || !days || days.length === 0) {
    // Отказ движка (не сезон, возраст, даты) — его же словами, коротко.
    const reason = full.trim().slice(0, 1200);
    return { text: esc(reason), buttons: [[planner], [RESTART]] };
  }
  const kid = kidOf(s.kid);
  const head = `План на ${s.days} дн. с ${ruDate(s.start)}, взрослых: ${s.adults}${kid && kid.age !== null ? `, ребёнок ${kid.label.replace('Ребёнок ', '')} (допуски — по младшему возрасту)` : ''}:`;
  return {
    text: [head, '', ...dayLines(days, s.start), '', WIZARD_FOOTER].join('\n'),
    buttons: [
      [{ text: 'Открыть план целиком', url: `${site}/trip/${id}` }],
      [planner],
      [RESTART],
    ],
  };
}
