/**
 * lib/kuzmich/watch-flow.ts — контроль выхода из чата Кузьмича в MAX.
 *
 * Владелец 30.09: «зачем что-то в наше время заполнять вручную, если можно
 * делать это из чата?» Человек пишет «еду на Чёртов мост, вернусь к 19:00,
 * если задержусь — сообщите маме +7 914 …», Кузьмич собирает недостающее,
 * показывает итог — и контроль включается только после явного «да».
 *
 * Здесь НЕТ языковой модели, и это решение, а не упрощение
 * (docs/safety/WATCH_MANIFEST.md, правило 3). Разбор срока, телефона и
 * подтверждения — детерминированный: модель, которая «поняла» из «ну вроде
 * к вечеру» девятнадцать часов, включила бы тревогу не в тот час, и узнать
 * об этом было бы неоткуда. Не разобрали — переспрашиваем с примером.
 *
 * Три двери заперты намеренно (разбор тремя критиками 30.09):
 *   - только MAX: контроль без телефонов не работает, а в Telegram политика
 *     конфиденциальности (разд. 5) персональных данных не обещает;
 *   - только заверенный источник апдейта: вебхук MAX принимает обычные
 *     сообщения от кого угодно, и поддельное «вернулся» закрыло бы чужой
 *     контроль;
 *   - только чаты из списка испытаний (`TRIP_WATCH_MAX_CHATS`), пока не
 *     пройдены учения и не ответил юрист (docs/safety/WATCH_DESIGN.md, §11).
 *
 * Запись контроля — lib/safety/trip-watch.ts, сторож — checkin-watchdog.
 */
import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { logText } from '@/lib/log/log-text';
import { kamchatkaDate, shiftDate, isRealDate, ruShort, DAY_MS } from '@/lib/analytics/kamchatka-day';
import { kamchatkaWallTime, formatKamchatkaTime, BUFFERS, type TripKind } from '@/lib/safety/checkin-escalation';
import {
  createTripWatch, openWatchesForChat, closeTripWatch, markTripWatchAlive, extendTripWatch,
  type TouristChannel, type OpenWatch,
} from '@/lib/safety/trip-watch';
import { detectEmergency } from '@/lib/safety/sos-detector';

/** Черновик живёт полчаса от последнего ответа человека. */
export const WATCH_DRAFT_TTL_MS = 30 * 60 * 1000;
/** Больше трёх открытых контролей из одного чата не бывает у честного пользователя. */
export const WATCH_MAX_OPEN_PER_CHAT = 3;
/** Дальше месяца контроль из чата не ставится: это уже экспедиция, ей нужна форма и МЧС. */
export const WATCH_MAX_AHEAD_MS = 30 * DAY_MS;
/** До суток — однодневка: поставленная накануне вечером тоже (разбор с поля, 30.09). */
export const DAY_TRIP_MAX_MS = DAY_MS;
/** «Вернулся» закрывает контроли, срок которых наступил или наступит в эти часы. */
const DUE_WINDOW_MS = 12 * 3_600_000;

export type WatchStep = 'where' | 'return' | 'contact' | 'contact_name' | 'leader_phone' | 'group' | 'confirm';

export interface WatchDraft {
  step: WatchStep;
  where?: string;
  returnDate?: string; // YYYY-MM-DD по Камчатке
  returnTime?: string; // HH:MM
  contactPhone?: string;
  contactName?: string;
  leaderPhone?: string;
  groupSize?: number;
  startedAt: number;
  /** Последний ответ человека: от него считается срок жизни черновика. */
  touchedAt?: number;
}

// ── Разбор: чистые функции ────────────────────────────────────────────────────

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Слово целиком, без знаков: «Да!» → «да», «Вернулся.» → «вернулся». */
function bare(text: string): string {
  return norm(text).replace(/[.,!?;:«»"'()\-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const TRIGGERS: RegExp[] = [
  /поставь(те)? (меня )?на контрол/,
  /контрол[ьяюе]? выход/,
  /если (я |мы )?(не вернусь|не вернемся|задержусь|задержимся|не выйду на связь|не выйдем на связь|пропаду|пропадем)/,
  /^\/watch\b/,
];

export function isWatchTrigger(text: string): boolean {
  const t = norm(text);
  return TRIGGERS.some((r) => r.test(t));
}

const RETURNED = new Set(['вернулся', 'вернулась', 'вернулись', 'я вернулся', 'я вернулась', 'мы вернулись', 'back', '/back']);
// Без «ок»: отметка отодвигает тревогу, и случайное «ок» в разговоре не должно
// её отодвигать.
const DELAYED = new Set(['задерживаюсь', 'задерживаемся', 'я в порядке', 'мы в порядке']);
const CONFIRM = new Set(['да', 'подтверждаю', 'да подтверждаю', 'ставь', 'да ставь', 'включай', 'да включай']);
const CANCEL = new Set(['нет', 'отмена', 'отменить', 'стоп', 'не надо', '/cancel']);
const CANCEL_WATCH = new Set(['отменить контроль', 'отмени контроль', 'снять контроль', 'сними контроль']);

/**
 * Только сообщение ЦЕЛИКОМ. Подстрока здесь опасна: «я не вернулся» содержит
 * «вернулся», а «ок» живёт внутри «около» — закрыть контроль живого человека
 * из-за совпадения букв нельзя (правило 3).
 */
export const isReturnedCommand = (text: string) => RETURNED.has(bare(text));
export const isDelayedCommand = (text: string) => DELAYED.has(bare(text));
export const isConfirm = (text: string) => CONFIRM.has(bare(text));
export const isCancel = (text: string) => CANCEL.has(bare(text));
export const isCancelWatchCommand = (text: string) => CANCEL_WATCH.has(bare(text));

/**
 * Похоже на отметку, но не команда: «вернулся, всё ок», «я дома», «задержусь
 * немного». Такое не уходит модели — та про контроль не знает и ответила бы
 * «с возвращением», а лестница шла бы дальше (разбор с поля, 30.09).
 */
const NEAR_MISS = /(вернул|я дома|мы дома|уже дома|добрал|дошл[аи]|на связи|задерж|все ок|все хорошо|в порядке)/;
export const isNearMissCheckin = (text: string) => NEAR_MISS.test(norm(text));

/**
 * Телефон → +7XXXXXXXXXX для России, +<код><номер> для остальных. Иначе null.
 * Иностранный турист не должен упираться в «не нашёл телефон» (разбор с поля).
 */
export function extractPhone(text: string): string | null {
  const ru = text.match(/(?:\+7|(?<!\d)8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/);
  if (ru) return `+7${ru[0].replace(/\D/g, '').slice(1)}`;
  const intl = text.match(/\+\d[\d\s\-()]{6,20}\d/);
  if (!intl) return null;
  const digits = intl[0].replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** Куда идут — из фразы «еду на …», «иду к …». Не нашли — спросим. */
export function extractDestination(text: string): string | null {
  // Пробелы схлопнуты до одного, и захват начинается с не-пробела: у `\s+`
  // и следующего класса нет общих символов, поэтому на строке из тысячи
  // табуляций разбор линейный (CodeQL js/polynomial-redos, #2132).
  const t = text.replace(/\s+/g, ' ');
  const m = t.match(
    /(?:еду|иду|идем|идём|едем|пойду|поеду|пойдем|пойдём|поедем|выхожу|выходим|собираюсь|собираемся|сплавляюсь|сплавляемся) (?:на|в|во|к|ко) ([^\s,.;!?][^,.;!?]{1,79})/i,
  );
  if (!m) return null;
  const cut = m[1].split(/ (?:если|вернусь|вернемся|вернёмся|до|к \d|в \d|сегодня|завтра|послезавтра|и вернусь)(?!\p{L})/iu)[0].trim();
  return cut.length >= 2 ? cut : null;
}

export type ReturnParse =
  | { ok: true; date: string; time: string }
  | { ok: false; reason: 'no_time' | 'bad_date' | 'past' | 'too_far' | 'ambiguous' }
  | { ok: false; reason: 'ampm'; hour: number };

const MONTHS: Array<[RegExp, number]> = [
  [/^январ[ья]$/, 1], [/^феврал[ья]$/, 2], [/^марта?$/, 3], [/^апрел[ья]$/, 4], [/^ма[йя]$/, 5],
  [/^июн[ья]$/, 6], [/^июл[ья]$/, 7], [/^августа?$/, 8], [/^сентябр[ья]$/, 9], [/^октябр[ья]$/, 10],
  [/^ноябр[ья]$/, 11], [/^декабр[ья]$/, 12],
];

/** «В субботу», «на выходных», «через пару часов» — день словами, которых мы не считаем. */
const VAGUE =
  /(?<!\p{L})(понедельник|вторник|сред[уаы]|четверг|пятниц|суббот|воскресень|выходн|через (?:пару|полчаса|несколько))/u;

/** Число после предлога — не час, если за ним единица: «в 2 км», «до 3 дней». */
const NOT_HOUR = String.raw`(?! ?(?:км|километр|метр|м(?!\p{L})|дн|день|дня|дней|недел|чел|человек|раз|шт|кг|л(?!\p{L})))`;

function applyDayPart(hh: number, part: string | undefined): number {
  if (!part) return hh;
  if (part.startsWith('веч')) return hh < 12 ? hh + 12 : hh;
  if (part === 'дня') return hh >= 1 && hh <= 6 ? hh + 12 : hh;
  if (part === 'ночи') return hh >= 9 && hh <= 11 ? hh + 12 : hh === 12 ? 0 : hh;
  return hh; // утра
}

function yearFor(day: number, month: number, explicitYear: number | null, today: string): string | null {
  const y = explicitYear ?? Number(today.slice(0, 4));
  const candidate = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!isRealDate(candidate)) return null;
  // «03.01» в декабре — январь следующего года, если год не назван.
  if (explicitYear === null && candidate < today) return `${y + 1}${candidate.slice(4)}`;
  return candidate;
}

function hhmm(hh: number, mm: number): string {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Срок возвращения из текста: «сегодня 19:00», «завтра к 12», «03.10 18:30»,
 * «к 19.30», «3 октября в 7 вечера», «через 5 часов». Без даты — сегодня.
 *
 * Не угадываем НИКОГДА (§4.0):
 *   - два разных времени во фразе («выхожу в 7, вернусь в 19») — отказ
 *     «ambiguous», а не первое попавшееся: первое было бы временем ВЫХОДА;
 *   - «к 5» без «утра/вечера» — переспрос «5:00 или 17:00?»: в 04:30 перед
 *     ранним выходом это 05:00, и тревога ушла бы через полчаса;
 *   - «в субботу», «через пару часов» — переспрос: словами мы дни не считаем;
 *   - срок в прошлом или дальше месяца — отказ, а не «наверное, завтра».
 */
export function parseReturn(text: string, now: Date): ReturnParse {
  // После norm пробел везде ровно один — поэтому ниже в выражениях литеральный
  // пробел, а не `\s+`: так нет двусмысленных повторов (js/polynomial-redos).
  const t = norm(text);
  const today = kamchatkaDate(now);
  if (VAGUE.test(t)) return { ok: false, reason: 'ambiguous' };

  // «через 5 часов», «через 40 минут» — от этой минуты.
  const rel = t.match(/(?<!\p{L})через (\d{1,2}) ?(час|часа|часов|ч|минут|минуты|мин)(?!\p{L})/u);
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2].startsWith('м') ? n * 60_000 : n * 3_600_000;
    const at = new Date(Math.ceil((now.getTime() + ms) / 300_000) * 300_000); // до 5 минут вверх
    if (at.getTime() - now.getTime() > WATCH_MAX_AHEAD_MS) return { ok: false, reason: 'too_far' };
    const local = new Date(at.getTime() + 12 * 3_600_000);
    return { ok: true, date: kamchatkaDate(at), time: hhmm(local.getUTCHours(), local.getUTCMinutes()) };
  }

  const times = new Set<string>();
  const dates = new Set<string>();
  let badDate = false;
  let bareHour: number | null = null;
  const addTime = (hh: number, mm: number) => {
    if (hh > 23 || mm > 59) return;
    times.add(hhmm(hh, mm));
  };

  // 19:00 (с частью суток после — «7:30 вечера»)
  for (const m of t.matchAll(/(?<![\d.:])(\d{1,2}):(\d{2})(?![\d.:])(?: (утра|дня|вечера|вечером|ночи))?/g)) {
    addTime(applyDayPart(Number(m[1]), m[3]), Number(m[2]));
  }
  // к 19, в 7 вечера, до 19.30, около 20 ч
  const prep = new RegExp(
    String.raw`(?<!\p{L})(?:к|в|до|около) (\d{1,2})(?:[.:](\d{2}))?(?![\d.:])` + NOT_HOUR +
      String.raw`(?: ?(?:ч|час|часам|часов|часа)(?!\p{L}))?(?: (утра|дня|вечера|вечером|ночи))?`,
    'gu',
  );
  const prepSpans: Array<[number, number]> = [];
  for (const m of t.matchAll(prep)) {
    const hh = Number(m[1]);
    if (!m[2] && !m[3] && hh >= 1 && hh <= 11) bareHour = hh;
    addTime(applyDayPart(hh, m[3]), m[2] ? Number(m[2]) : 0);
    prepSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  // 03.10, 03.10.2026 — дата; «19.30» без предлога — время, раз такой даты нет
  for (const m of t.matchAll(/(?<![\d.:])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d.:])/g)) {
    const at = m.index ?? 0;
    if (prepSpans.some(([a, b]) => at >= a && at < b)) continue; // уже время после предлога
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    const d = yearFor(a, b, yr, today);
    if (d) dates.add(d);
    else if (!m[3] && m[2].length === 2 && a <= 23 && b <= 59) addTime(a, b);
    else badDate = true;
  }
  // 3 октября
  for (const m of t.matchAll(/(?<![\d.])(\d{1,2}) (\p{L}+)/gu)) {
    const month = MONTHS.find(([re]) => re.test(m[2]))?.[1];
    if (!month) continue;
    const d = yearFor(Number(m[1]), month, null, today);
    if (d) dates.add(d);
    else badDate = true;
  }
  if (/послезавтра/.test(t)) dates.add(shiftDate(today, 2));
  else if (/завтра/.test(t)) dates.add(shiftDate(today, 1));
  if (/сегодня/.test(t)) dates.add(today);

  if (badDate) return { ok: false, reason: 'bad_date' };
  if (dates.size > 1 || times.size > 1) return { ok: false, reason: 'ambiguous' };
  if (times.size === 0) return { ok: false, reason: 'no_time' };
  if (bareHour !== null && [...times][0] === hhmm(bareHour, 0)) return { ok: false, reason: 'ampm', hour: bareHour };

  const date = dates.size === 1 ? [...dates][0] : today;
  const time = [...times][0];
  const at = kamchatkaWallTime(date, time);
  if (at.getTime() <= now.getTime()) return { ok: false, reason: 'past' };
  if (at.getTime() - now.getTime() > WATCH_MAX_AHEAD_MS) return { ok: false, reason: 'too_far' };
  return { ok: true, date, time };
}

/**
 * Кусок фразы, где говорится о ВОЗВРАЩЕНИИ: «еду на мост в 7, вернусь к 19»
 * → «вернусь к 19». Нет такого слова — срок из первой фразы не берём вовсе
 * и спрашиваем отдельно: «еду на Авачу к 10» — это, скорее всего, прибытие.
 */
export function returnSegment(text: string): string | null {
  const m = text.match(/(?<!\p{L})(вернусь|вернемся|вернёмся|вернуться|буду дома|буду обратно|обратно|назад)(?!\p{L})/iu);
  if (!m || m.index === undefined) return null;
  return text.slice(m.index).split(/[,;]\s*(?:если|а если|и если)/iu)[0];
}

/** Имя контакта: текст без телефона и служебных слов. */
export function extractContactName(text: string): string | null {
  const phone = extractPhone(text) ? text.match(/(?:\+7|(?<!\d)8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)|\+\d[\d\s\-()]{6,20}\d/) : null;
  const rest = (phone ? text.replace(phone[0], ' ') : text)
    // \b в JS не видит кириллицу — граница слова через \p{L} и флаг u.
    .replace(/(?<!\p{L})(сообщите|сообщить|позвоните|позвонить|напишите|написать|по номеру|номер|телефон|тел)(?!\p{L})\.?/giu, ' ')
    .replace(/[,:;\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (rest.length < 2 || rest.length > 80) return null;
  return rest;
}

const GROUP_WORDS: Record<string, number> = {
  'один': 1, 'одна': 1, 'я один': 1, 'я одна': 1, 'иду один': 1, 'иду одна': 1,
  'вдвоем': 2, 'двое': 2, 'нас двое': 2, 'втроем': 3, 'трое': 3, 'нас трое': 3,
  'вчетвером': 4, 'четверо': 4, 'впятером': 5, 'пятеро': 5,
};

/** «4», «нас 4», «вдвоём» → число от 1 до 30; иначе null. */
export function parseGroupSize(text: string): number | null {
  const t = bare(text);
  if (t in GROUP_WORDS) return GROUP_WORDS[t];
  const m = t.match(/^(?:нас )?(\d{1,2})(?: (?:чел|человек|человека))?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 30 ? n : null;
}

export type Extension = { kind: 'relative'; minutes: number } | { kind: 'absolute'; text: string };

/**
 * Новый срок: «+2 ч», «+30 мин», «продли на 2 часа», «задержусь на час»,
 * «до 21:00», «продли до 21:30». Только сообщение целиком (правило 3).
 */
export function parseExtension(text: string): Extension | null {
  // Новый срок — короткое сообщение: длинное им не бывает, и разбирать его
  // незачем. Хвостовые «.» и «!» срезаются циклом, а не выражением `[.!]+$`:
  // у того на строке из тысяч «!» с буквой в конце время квадратичное
  // (CodeQL js/polynomial-redos, #2132).
  let t = norm(text);
  if (t.length > 60) return null;
  let end = t.length;
  while (end > 0 && (t[end - 1] === '.' || t[end - 1] === '!')) end--;
  t = t.slice(0, end);
  const rel = t.match(/^(?:\+ ?|плюс |продли(?:ть)? (?:на )?|на |задерж(?:усь|иваюсь|имся|иваемся) на )(\d{1,2}|час|полчаса) ?(ч|час|часа|часов|м|мин|минут|минуты)?$/);
  if (rel) {
    const n = rel[1] === 'час' ? 1 : rel[1] === 'полчаса' ? 30 : Number(rel[1]);
    const unit = rel[1] === 'полчаса' ? 'м' : (rel[2] ?? 'ч');
    const minutes = unit.startsWith('м') ? n : n * 60;
    return minutes >= 15 && minutes <= 72 * 60 ? { kind: 'relative', minutes } : null;
  }
  // Только со временем: «до завтра» — прощание, а не новый срок.
  const abs = t.match(/^(?:продли(?:ть)? |новый срок )?до ((?:(?:сегодня|завтра|послезавтра|\d{1,2}\.\d{1,2}) )?\d{1,2}(?:[:.]\d{2})?(?: (?:утра|дня|вечера|ночи))?)$/);
  if (abs) return { kind: 'absolute', text: `до ${abs[1]}` };
  return null;
}

/** Однодневка или многодневка — по длительности от этой минуты до срока. */
export function tripKindFor(returnAt: Date, now: Date): TripKind {
  return returnAt.getTime() - now.getTime() <= DAY_TRIP_MAX_MS ? 'day' : 'multi';
}

// ── Тексты ────────────────────────────────────────────────────────────────────

function localTime(at: Date): string {
  const local = new Date(at.getTime() + 12 * 3_600_000);
  return hhmm(local.getUTCHours(), local.getUTCMinutes());
}

/** «19:00», «завтра 03:00» или «03.10 03:00» — по Камчатке, от сегодняшнего дня. */
function clock(at: Date, now: Date): string {
  const d = kamchatkaDate(at);
  const today = kamchatkaDate(now);
  if (d === today) return localTime(at);
  if (d === shiftDate(today, 1)) return `завтра ${localTime(at)}`;
  return `${ruShort(d)} ${localTime(at)}`;
}

/** Час с предлогом: «в 20:00», «завтра в 03:00», «03.10 в 03:00». */
function clockWith(prep: 'в' | 'к', at: Date, now: Date): string {
  const d = kamchatkaDate(at);
  const today = kamchatkaDate(now);
  if (d === today) return `${prep} ${localTime(at)}`;
  if (d === shiftDate(today, 1)) return `завтра ${prep} ${localTime(at)}`;
  return `${ruShort(d)} ${prep} ${localTime(at)}`;
}

/**
 * Всегда с датой: «30.09 19:00». Для текста, который прочтут позже, — его
 * пересылают контакту, и «завтра», прочитанное назавтра, указало бы не тот день.
 */
function stamp(at: Date): string {
  return `${ruShort(kamchatkaDate(at))} ${localTime(at)}`;
}

function inHours(at: Date, now: Date): string {
  const min = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (min < 60) return `через ${Math.max(1, min)} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `через ${h} ч` : `через ${h} ч ${m} мин`;
}

function whenText(date: string, time: string, now: Date): string {
  const today = kamchatkaDate(now);
  const day = date === today ? 'сегодня' : date === shiftDate(today, 1) ? 'завтра' : ruShort(date);
  return `${day}, ${ruShort(date)}, ${time} по камчатскому времени (${inHours(kamchatkaWallTime(date, time), now)})`;
}

/** Абсолютные часы ступеней лестницы от срока — те же числа, что у сторожа. */
export function ladderTimes(returnAt: Date, kind: TripKind): { soft: Date; hard: Date; duty: Date } {
  const b = BUFFERS[kind];
  const at = (h: number) => new Date(returnAt.getTime() + h * 3_600_000);
  return { soft: at(b.soft), hard: at(b.hard), duty: at(b.mchs) };
}

export const WATCH_DISCLAIMER =
  'Контроль выхода — помощь, а не служба спасения: он не гарантирует, что вас найдут, и не заменяет регистрацию в МЧС. ' +
  'В беде звоните 112 сами, не дожидаясь срока.';

/**
 * Итог, который человек подтверждает. Лестница названа абсолютными часами:
 * человек должен знать, что и когда случится, если он не отметится, — и что
 * спасателей вызывает не автомат, а человек, который ночью может ответить не
 * сразу (разбор трёх критиков, 30.09).
 */
export function watchSummary(d: WatchDraft, now: Date): string {
  const returnAt = kamchatkaWallTime(d.returnDate ?? '', d.returnTime ?? '');
  const lt = ladderTimes(returnAt, tripKindFor(returnAt, now));
  const contact = `${escapeHtml(d.contactName)} (${escapeHtml(d.contactPhone)})`;
  return [
    'Проверьте, всё ли верно:',
    '',
    `Куда: ${escapeHtml(d.where)}`,
    `Вернусь: ${whenText(d.returnDate ?? '', d.returnTime ?? '', now)}`,
    `Сколько вас: ${d.groupSize ?? 'не указано'}`,
    `Ваш телефон: ${escapeHtml(d.leaderPhone)}`,
    `Контакт: ${contact}`,
    '',
    'Если к сроку не напишете «вернулся»:',
    `- ${clockWith('в', lt.soft, now)} напишу вам сюда;`,
    // Своего канала к контакту у контроля из чата нет, пока не подключены SMS:
    // до контакта его несёт человек. Обещать «сообщу» от имени бота было бы
    // неправдой (Trust-First: не обещать того, что система не гарантирует).
    `- ${clockWith('в', lt.hard, now)} попрошу дежурного Ведара позвонить вашему контакту;`,
    `- ${clockWith('в', lt.duty, now)} дежурный получит тревогу и решит, звать ли спасателей. Сам автомат спасателей не вызывает.`,
    'Дежурный один: ночью он может ответить не сразу. Сторож проверяет примерно раз в час, поэтому шаг может прийти позже — до двух часов.',
    'Назовите реальное время, без запаса: запас уже в лестнице.',
    '',
    WATCH_DISCLAIMER,
    '',
    'Ответьте «да», чтобы включить контроль, или «нет», чтобы отменить.',
  ].join('\n');
}

const ASK: Record<Exclude<WatchStep, 'confirm'>, string> = {
  where: 'Куда идёте? Например: «Чёртов мост» или «Авачинский перевал, радиально».',
  return: 'Когда вернётесь? Например: «сегодня 19:00», «завтра к 12», «03.10 18:30», «через 5 часов». Время — камчатское.',
  contact: 'Кто точно возьмёт трубку вечером и ночью, если вы не вернётесь? Имя и телефон, например: «Марина +7 914 123-45-67».',
  contact_name: 'Как зовут человека, которому сообщить?',
  leader_phone: 'Ваш телефон — по нему вас будут искать. Например: +7 914 123-45-67.',
  group: 'Сколько вас идёт, включая вас? Напишите число, например: 1 или 4.',
};

function returnError(r: Exclude<ReturnParse, { ok: true }>): string {
  switch (r.reason) {
    case 'no_time': return 'Не понял время. Напишите, например: «сегодня 19:00» или «завтра к 12».';
    case 'bad_date': return 'Такой даты нет. Напишите, например: «03.10 18:30».';
    case 'past': return 'Этот срок уже прошёл. Когда вернётесь? Например: «сегодня 21:00».';
    case 'too_far': return 'Из чата контроль ставится не дальше чем на месяц. Для долгого похода — форма vedarai.ru/register.';
    case 'ambiguous': return 'Напишите только срок возвращения — одну дату и одно время, например: «сегодня 19:00» или «03.10 18:30».';
    case 'ampm': return `Уточните время: ${hhmm(r.hour, 0)} утра или ${hhmm(r.hour + 12, 0)}? Напишите, например, «к ${hhmm(r.hour + 12, 0)}».`;
  }
}

function nextStep(d: WatchDraft): WatchStep {
  if (!d.where) return 'where';
  if (!d.returnDate || !d.returnTime) return 'return';
  if (!d.contactPhone) return 'contact';
  if (!d.contactName) return 'contact_name';
  if (!d.leaderPhone) return 'leader_phone';
  if (!d.groupSize) return 'group';
  return 'confirm';
}

function prompt(d: WatchDraft, now: Date): string {
  return d.step === 'confirm' ? watchSummary(d, now) : ASK[d.step];
}

/**
 * Черновик из первой фразы: забираем всё, что названо явно. Первый телефон
 * фразы — телефон КОНТАКТА: в ней человек говорит, кому сообщить, а свой
 * номер спрашивается отдельно.
 */
export function draftFromTrigger(text: string, now: Date, startedAt: number): WatchDraft {
  const d: WatchDraft = { step: 'where', startedAt, touchedAt: startedAt };
  const where = extractDestination(text);
  if (where) d.where = where;
  const seg = returnSegment(text);
  const r = seg ? parseReturn(seg, now) : null;
  if (r?.ok) { d.returnDate = r.date; d.returnTime = r.time; }
  const phone = extractPhone(text);
  if (phone) d.contactPhone = phone;
  d.step = nextStep(d);
  return d;
}

/** Один шаг черновика: вернуть черновик и ответ. Не разобрали — тот же шаг и пример. */
export function advanceDraft(d: WatchDraft, text: string, now: Date): { draft: WatchDraft; reply: string } {
  const next: WatchDraft = { ...d, touchedAt: now.getTime() };
  const same = (reply: string) => ({ draft: { ...d, touchedAt: now.getTime() }, reply });
  switch (d.step) {
    case 'where': {
      const w = text.trim().replace(/\s+/g, ' ');
      if (w.endsWith('?')) return same(`Сначала закончим с контролем. ${ASK.where} Передумали — «отмена».`);
      if (w.length < 2 || w.length > 120) return same(ASK.where);
      next.where = w;
      break;
    }
    case 'return': {
      const r = parseReturn(text, now);
      if (!r.ok) return same(returnError(r));
      next.returnDate = r.date;
      next.returnTime = r.time;
      break;
    }
    case 'contact': {
      const p = extractPhone(text);
      if (!p) return same(`Не нашёл телефон. ${ASK.contact}`);
      next.contactPhone = p;
      const n = extractContactName(text);
      if (n) next.contactName = n;
      break;
    }
    case 'contact_name': {
      if (text.trim().endsWith('?')) return same(`Сначала закончим с контролем. ${ASK.contact_name} Передумали — «отмена».`);
      const n = extractContactName(text);
      if (!n) return same(ASK.contact_name);
      next.contactName = n;
      break;
    }
    case 'leader_phone': {
      const p = extractPhone(text);
      if (!p) return same(`Не нашёл телефон. ${ASK.leader_phone}`);
      if (p === next.contactPhone) {
        return same('Это номер контакта. Нужен ваш собственный телефон — тот, что будет с вами.');
      }
      next.leaderPhone = p;
      break;
    }
    case 'group': {
      const n = parseGroupSize(text);
      if (!n) return same(ASK.group);
      next.groupSize = n;
      break;
    }
    case 'confirm':
      return same('Ответьте «да», чтобы включить контроль, или «нет», чтобы отменить.');
  }
  next.step = nextStep(next);
  return { draft: next, reply: prompt(next, now) };
}

/**
 * Готовый текст для контакта: план и что делать, если мы до него не
 * дозвонимся или дежурный спит. Так устроено в Новой Зеландии и Канаде —
 * контакт сам звонит в свой срок, не дожидаясь нас (разбор трёх критиков:
 * «при одном дежурном ночью узкое место — его сон, а не таймер»).
 */
export function contactForwardText(d: WatchDraft, returnAt: Date, contactCallAt: Date): string {
  const people = d.groupSize && d.groupSize > 1 ? `, нас ${d.groupSize}` : '';
  return [
    `«Иду: ${escapeHtml(d.where)}${people}. Вернусь к ${stamp(returnAt)} (камчатское время).`,
    `Если до ${stamp(contactCallAt)} я не напишу тебе, что вернулся, — позвони мне: ${escapeHtml(d.leaderPhone)}.`,
    `Не дозвонишься — звони 112 и скажи: маршрут «${escapeHtml(d.where)}», срок ${stamp(returnAt)}, телефон ${escapeHtml(d.leaderPhone)}.»`,
  ].join('\n');
}

// ── Хранение черновика ────────────────────────────────────────────────────────
// Отказ базы не глушится (§4.0): черновик контроля — не заявка на тур, и
// «потерялся молча» здесь значит «человек думает, что его ждут, а его не ждут».

async function loadDraft(channel: TouristChannel, chatId: number): Promise<WatchDraft | null> {
  const { rows } = await pool.query<{ state: WatchDraft }>(
    `SELECT state FROM trip_watch_flow WHERE channel = $1 AND chat_id = $2`,
    [channel, chatId],
  );
  return rows[0]?.state ?? null;
}

async function saveDraft(channel: TouristChannel, chatId: number, d: WatchDraft): Promise<void> {
  await pool.query(
    `INSERT INTO trip_watch_flow (channel, chat_id, state, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (channel, chat_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [channel, chatId, JSON.stringify(d)],
  );
}

/**
 * Забрать черновик ровно один раз. Двойное «да» (два сообщения подряд, два
 * апдейта в пачке) иначе создало бы два контроля: оба прочитали бы черновик
 * до того, как первый его удалил (разбор противником, 30.09).
 */
async function claimDraft(channel: TouristChannel, chatId: number): Promise<WatchDraft | null> {
  const { rows } = await pool.query<{ state: WatchDraft }>(
    `DELETE FROM trip_watch_flow WHERE channel = $1 AND chat_id = $2 RETURNING state`,
    [channel, chatId],
  );
  return rows[0]?.state ?? null;
}

export async function deleteWatchDraft(channel: TouristChannel, chatId: number): Promise<void> {
  await pool.query(`DELETE FROM trip_watch_flow WHERE channel = $1 AND chat_id = $2`, [channel, chatId]);
}

// ── Вход из processMessage ────────────────────────────────────────────────────

export interface WatchMessage {
  channel: TouristChannel;
  chatId: number;
  text: string;
  userName: string | null;
  reply: (chatId: number, text: string) => Promise<void>;
  /** Апдейт пришёл на вебхук с нашим секретом. Без этого переходов нет. */
  verified: boolean;
  now?: Date;
}

const FAIL_TEXT =
  'Не получилось включить контроль — сбой на нашей стороне, и я не буду делать вид, что всё в порядке. ' +
  'Поставьте контроль через форму vedarai.ru/register или предупредите близких сами. В беде — 112.';

const UNVERIFIED_TEXT =
  'Не могу подтвердить, что это сообщение пришло из MAX, — контроль выхода его не принимает. ' +
  'Отметку можно сделать на сайте: vedarai.ru/return. В беде — 112.';

/**
 * Чаты, которым контроль из чата уже открыт: `TRIP_WATCH_MAX_CHATS` —
 * номера через запятую, `*` — всем. Не задано — никому (fail-closed): до
 * учений и ответа юриста контроль из чата испытывают только свои.
 */
export function chatAllowed(chatId: number): boolean {
  const raw = (process.env.TRIP_WATCH_MAX_CHATS ?? '').trim();
  if (raw === '*') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(String(chatId));
}

/** Всё, что похоже на разговор о контроле, — для отказов без записи. */
export function looksLikeWatchText(text: string): boolean {
  return isWatchTrigger(text) || isReturnedCommand(text) || isDelayedCommand(text) ||
    isCancelWatchCommand(text) || parseExtension(text) !== null;
}

/**
 * true — сообщение про контроль выхода и обработано здесь; false — не про
 * него, дальше идёт обычный разговор.
 */
export async function handleWatchMessage(m: WatchMessage): Promise<boolean> {
  const now = m.now ?? new Date();
  const { channel, chatId, reply } = m;
  const text = m.text.slice(0, 2000);

  if (!m.verified) {
    if (!looksLikeWatchText(text)) return false;
    await reply(chatId, UNVERIFIED_TEXT);
    return true;
  }

  // «Вернулся» и «отменить контроль» — про уже открытый контроль, и важнее
  // любого черновика: закрыть контроль живого человека нельзя заставить ждать.
  if (isReturnedCommand(text)) return handleReturned(m, now);
  if (isCancelWatchCommand(text)) return handleCancelWatch(m);

  let draft: WatchDraft | null;
  try {
    draft = await loadDraft(channel, chatId);
  } catch (err) {
    console.error('[watch-flow] черновик не прочитан', logText(channel), logText(chatId), logText(err instanceof Error ? err.message : err));
    // «Да» и «нет» без черновика ушли бы модели — а человек ждёт включения.
    if (isConfirm(text) || isCancel(text)) {
      await reply(chatId, 'Не получилось прочитать черновик контроля — сбой базы. Повторите через минуту; в беде — 112.');
      return true;
    }
    draft = null;
  }
  if (draft && (draft.touchedAt ?? draft.startedAt) < now.getTime() - WATCH_DRAFT_TTL_MS) {
    await deleteWatchDraft(channel, chatId);
    draft = null;
  }

  if (draft) {
    // Сообщение о беде черновик не проглатывает: «помогите, сломал ногу»
    // в ответ на «когда вернётесь?» уходит в обычный путь с SOS-блоком
    // (lib/safety/sos-detector.ts), а черновик ждёт дальше.
    if (detectEmergency(text).detected) return false;
    if (isCancel(text)) {
      await deleteWatchDraft(channel, chatId);
      await reply(chatId, 'Контроль выхода не включён.');
      return true;
    }
    if (draft.step === 'confirm' && isConfirm(text)) return confirmDraft(m, now);
    // Здесь «до 21:00» — ответ на «когда вернётесь?», а не продление.
    const { draft: next, reply: answer } = advanceDraft(draft, text, now);
    await saveDraft(channel, chatId, next);
    await reply(chatId, answer);
    return true;
  }

  const ext = parseExtension(text);
  if (ext && await handleExtension(m, ext, now)) return true;
  if (isDelayedCommand(text) && await handleDelayed(m, now)) return true;

  if (isWatchTrigger(text)) {
    if (!chatAllowed(chatId)) {
      await reply(chatId,
        'Контроль выхода из чата сейчас в испытаниях и включён не для всех. ' +
        `Поставить контроль можно на сайте: vedarai.ru/register. Номер этого чата для испытаний: ${chatId}.`);
      return true;
    }
    // Потолок открытых контролей на чат: каждый просроченный контроль будит
    // живого дежурного, и чат не должен уметь завалить его сотней выдуманных.
    const already = await openWatchesForChat(channel, chatId);
    if (already.length >= WATCH_MAX_OPEN_PER_CHAT) {
      await reply(chatId,
        `У вас уже ${already.length} открытых контроля — больше из одного чата не ставлю. ` +
        'Вернулись — напишите «вернулся», и можно ставить новый.');
      return true;
    }
    const d = draftFromTrigger(text, now, now.getTime());
    await saveDraft(channel, chatId, d);
    await reply(chatId, [
      'Поставлю вас на контроль выхода: если не вернётесь к сроку, я подниму тревогу.',
      '',
      prompt(d, now),
    ].join('\n'));
    return true;
  }

  // Похоже на отметку, но не команда — при открытом контроле переспрашиваем
  // кодом, а не отдаём модели.
  if (isNearMissCheckin(text)) {
    const open = await openWatchesForChat(channel, chatId);
    if (open.length > 0) {
      await reply(chatId,
        `Это про контроль «${escapeHtml(open[0].route_name)}»? Чтобы я понял точно, ответьте одним сообщением:\n` +
        '«вернулся» — закрою контроль;\n«+2 ч» или «до 21:00» — перенесу срок;\n«задерживаюсь» — отмечу, что вы на связи.');
      return true;
    }
  }
  return false;
}

/**
 * «Вернулся» закрывает только контроль, у которого подошёл срок. Завтрашний
 * поход не закрывается возвращением с сегодняшнего — даже если он у чата
 * единственный: человек ушёл бы без контроля, думая, что он есть (разбор
 * противником). Далёкий срок закрывает только явное «отменить контроль».
 */
async function handleReturned(m: WatchMessage, now: Date): Promise<boolean> {
  const { channel, chatId, reply } = m;
  const open = await openWatchesForChat(channel, chatId);
  if (open.length === 0) {
    await reply(chatId, 'Открытого контроля выхода у этого чата нет. С возвращением!');
    return true;
  }
  // Срок не записан (у контроля из чата так не бывает) — не держим человека
  // в контроле, который нечем закрыть.
  const due = open.filter((w) => !w.expected_return_at ||
    new Date(w.expected_return_at).getTime() <= now.getTime() + DUE_WINDOW_MS);
  if (due.length === 0) {
    const list = open.map((w) => `«${escapeHtml(w.route_name)}» — ${w.expected_return_at ? clock(new Date(w.expected_return_at), now) : 'срок не записан'}`).join('\n');
    await reply(chatId, `Ни один открытый контроль ещё не подошёл к сроку:\n${list}\nСнять контроль сейчас — «отменить контроль».`);
    return true;
  }
  for (const w of due) await closeTripWatch(w.id, 'chat', 'returned');
  const names = due.map((w) => `«${escapeHtml(w.route_name)}»`).join(', ');
  const contacts = [...new Set(due.map((w) => escapeHtml(w.emergency_contact_name)))].join(', ');
  await reply(chatId, [
    `С возвращением! Контроль ${names} закрыт, тревог не будет.`,
    `Напишите ${contacts}, что вы дома.`,
    'Если регистрировались в МЧС — сообщите о возвращении и им, иначе вас начнут искать.',
  ].join('\n'));
  return true;
}

async function handleCancelWatch(m: WatchMessage): Promise<boolean> {
  const { channel, chatId, reply } = m;
  const open = await openWatchesForChat(channel, chatId);
  if (open.length === 0) {
    await reply(chatId, 'Открытого контроля выхода у этого чата нет.');
    return true;
  }
  for (const w of open) await closeTripWatch(w.id, 'chat', 'cancelled');
  await reply(chatId, [
    `Контроль снят: ${open.map((w) => `«${escapeHtml(w.route_name)}»`).join(', ')}. Тревог не будет.`,
    open.some((w) => w.alerted_others)
      ? 'Тем, кого уже встревожили, я сообщил, что вы сняли контроль. Если вы вернулись — напишите им сами.'
      : '',
  ].filter(Boolean).join('\n'));
  return true;
}

/** Ближайший по сроку открытый контроль — к нему относятся «+2 ч» и «задерживаюсь». */
function nearest(open: OpenWatch[]): OpenWatch | null {
  return open[0] ?? null; // openWatchesForChat отдаёт ближайший срок первым
}

async function handleExtension(m: WatchMessage, ext: Extension, now: Date): Promise<boolean> {
  const { channel, chatId, reply } = m;
  const w = nearest(await openWatchesForChat(channel, chatId));
  if (!w) return false; // нет контроля — это не про него, пусть отвечает разговор
  let newAt: Date;
  if (ext.kind === 'relative') {
    const base = Math.max(now.getTime(), w.expected_return_at ? new Date(w.expected_return_at).getTime() : now.getTime());
    newAt = new Date(base + ext.minutes * 60_000);
  } else {
    const r = parseReturn(ext.text, now);
    if (!r.ok) {
      await reply(chatId, returnError(r));
      return true;
    }
    newAt = kamchatkaWallTime(r.date, r.time);
  }
  if (newAt.getTime() - now.getTime() > WATCH_MAX_AHEAD_MS) {
    await reply(chatId, 'Дальше месяца из чата не продлеваю. Для долгого похода — форма vedarai.ru/register.');
    return true;
  }
  const kind = tripKindFor(newAt, now);
  if (!(await extendTripWatch(w.id, newAt, kind))) {
    await reply(chatId, 'Контроль уже закрыт — продлевать нечего.');
    return true;
  }
  const lt = ladderTimes(newAt, kind);
  await reply(chatId, [
    `Новый срок «${escapeHtml(w.route_name)}» — ${clock(newAt, now)}.`,
    `Не отметитесь — ${clockWith('в', lt.soft, now)} напишу вам сюда, дальше по той же лестнице.`,
    w.alerted_others ? 'Тем, кого уже встревожили, я сообщил, что вы на связи и назвали новый срок.' : '',
  ].filter(Boolean).join('\n'));
  return true;
}

/**
 * «Задерживаюсь» честно: до срока оно ничего не сдвигает (отметку сторож
 * учитывает только после срока), и обещать «отсчёт заново» было бы
 * неправдой — просим новый срок. После срока — отмечаем, что человек на
 * связи, и всё равно просим срок.
 */
async function handleDelayed(m: WatchMessage, now: Date): Promise<boolean> {
  const { channel, chatId, reply } = m;
  const w = nearest(await openWatchesForChat(channel, chatId));
  if (!w) return false;
  const due = w.expected_return_at ? new Date(w.expected_return_at) : null;
  if (due && due.getTime() > now.getTime()) {
    await reply(chatId,
      `Срок «${escapeHtml(w.route_name)}» ещё не наступил — ${clock(due, now)}. ` +
      'Задержитесь — напишите новое время: «+2 ч» или «до 21:00».');
    return true;
  }
  await markTripWatchAlive([w.id], 'chat');
  await reply(chatId, [
    'Отметил: вы на связи.',
    w.last_step >= 3
      ? 'Дежурный уже получил тревогу — я передал ему, что вы на связи.'
      : 'Следующий шаг отложен от этой минуты.',
    'Лучше назовите новый срок — «+2 ч» или «до 21:00»: тогда я снова начну с вопроса вам.',
  ].join('\n'));
  return true;
}

async function confirmDraft(m: WatchMessage, now: Date): Promise<boolean> {
  const { channel, chatId, reply } = m;
  const today = kamchatkaDate(now);
  let d: WatchDraft | null;
  try {
    d = await claimDraft(channel, chatId);
  } catch (err) {
    console.error('[watch-flow] черновик не забран', logText(channel), logText(chatId), logText(err instanceof Error ? err.message : err));
    await reply(chatId, FAIL_TEXT);
    return true;
  }
  if (!d) {
    await reply(chatId, 'Черновика нет: контроль уже включён этим «да» или черновик истёк. Сомневаетесь — поставьте контроль заново.');
    return true;
  }
  const expectedReturnAt = kamchatkaWallTime(d.returnDate ?? '', d.returnTime ?? '');
  // Срок мог истечь, пока человек думал над «да».
  if (expectedReturnAt.getTime() <= now.getTime()) {
    await saveDraft(channel, chatId, { ...d, step: 'return', returnDate: undefined, returnTime: undefined, touchedAt: now.getTime() })
      .catch((err) => console.error('[watch-flow] черновик не возвращён', logText(err instanceof Error ? err.message : err)));
    await reply(chatId, returnError({ ok: false, reason: 'past' }));
    return true;
  }
  const kind = tripKindFor(expectedReturnAt, now);
  try {
    await createTripWatch({
      source: 'max',
      userId: null,
      routeName: d.where ?? '',
      routeDescription: null,
      startDate: today,
      endDate: d.returnDate ?? today,
      expectedReturnAt,
      tripKind: kind,
      region: 'Камчатский край',
      groupSize: d.groupSize ?? 1,
      groupMembers: null,
      leaderName: m.userName?.trim() || 'турист из чата',
      leaderPhone: d.leaderPhone ?? '',
      leaderEmail: null,
      contactName: d.contactName ?? '',
      contactPhone: d.contactPhone ?? '',
      contactRelation: null,
      contactTelegramChatId: null,
      contactEmail: null,
      contactConsent: false,
      touristChat: { channel, chatId },
    });
  } catch (err) {
    console.error('[watch-flow] контроль не создан', logText(channel), logText(chatId), logText(err instanceof Error ? err.message : err));
    // Черновик возвращается: человеку не придётся отвечать заново.
    await saveDraft(channel, chatId, d).catch(() => undefined);
    await reply(chatId, FAIL_TEXT);
    return true;
  }
  const lt = ladderTimes(expectedReturnAt, kind);
  await reply(chatId, [
    `Контроль включён. Жду вас ${clockWith('к', expectedReturnAt, now)} (камчатское время).`,
    '',
    `Перешлите это ${escapeHtml(d.contactName)} — так контакт будет знать, что делать, даже если мы не дозвонимся или дежурный спит:`,
    contactForwardText(d, expectedReturnAt, lt.hard),
    '',
    'Вернётесь — напишите сюда «вернулся». Задерживаетесь — новое время: «+2 ч» или «до 21:00».',
    'В беде не ждите срока: 112 работает без баланса и SIM-карты.',
  ].join('\n'));
  return true;
}

/**
 * Telegram: контроль выхода там не ставится — он собирает телефоны, а
 * политика конфиденциальности (разд. 5) обещает, что персональных данных в
 * Telegram нет. На разговор о контроле — ответ, где его поставить.
 */
export function telegramWatchRedirect(text: string): string | null {
  if (!looksLikeWatchText(text)) return null;
  return [
    'Контроль выхода Кузьмич ведёт в MAX: https://max.ru/id4101147649_bot — там же отмечайтесь «вернулся».',
    'Или поставьте контроль на сайте: vedarai.ru/register.',
    'Телефоны в Telegram мы не собираем. В беде — 112.',
  ].join('\n');
}
