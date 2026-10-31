/**
 * «Открой даты словами» (22.10, этап C, §9 спецификации): что Кузьмич пишет
 * продавцу своих туров в чате кабинета MAX — туроператору и, с 29.10, гиду с
 * авторскими турами. Чистые функции от размеченных исходов —
 * без выдумки: «открыто» звучит только про записанное, «не смог проверить»
 * не выдаётся ни за «нельзя», ни за «можно» (§4.0).
 *
 * MAX шлёт сообщение как HTML: название тура и причина закрытия — слова
 * оператора — проходят через escapeHtml. Телефонов и почт здесь нет: ни
 * фраза оператора, ни данные туристов в ответ не попадают.
 *
 * Подсказка в кавычках «…» — всегда фраза целиком, с глаголом: «открой весь
 * июль, 8 мест», а не «весь июль». Без глагола ответ по подсказке разбор не
 * узнаёт, сообщение уходит помощнику кабинета, а места из первой фразы
 * теряются (второй ревью 22.10). Число мест из фразы оператора подсказка
 * повторяет; месяц образца — следующий за текущим: его дни всегда впереди и
 * в пределах года, и образец не получит «прошло» в августе. В кавычках —
 * только такие подсказки и слова самого оператора (дата, число, слово фразы).
 *
 * Сторож: tests/unit/chat-open-dates-texts.test.ts.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { ownerCalendarUrl, ownerToursUrl } from '@/lib/partners/cabinet-links';
import { windowLabel } from '@/lib/tours/request-window';
import { horizonLastDate, isCalendarDate, tourHiddenText, type DateOpenResult } from '@/lib/tours/availability-open';
import { type DatesAsk, type DatesRefusal, MAX_DATES_PER_PROPOSAL, weekdayOf, weekdaysPlural } from './parse';

/** Сколько минут предложение ждёт нажатия. */
export const PROPOSAL_TTL_MIN = 30;
/** Потолок длины сообщения MAX с запасом. */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * Кому отвечает поток (29.10): туроператор или гид со своими турами. От этого
 * зависят адреса (кабинет оператора гида не пустит — его даты в разделе «Свои
 * туры») и слова о том, кто что включает: оператор показывает тур сам, у гида
 * скрытый тур и черновик включает менеджер Ведара. Обязателен у каждого
 * текста со ссылкой или такими словами — забытый продавец не соберётся.
 */
export type DatesSeller = 'operator' | 'guide';

/** Продавец по карточке чата. Поток зовёт её только для того, кто продаёт свои туры (`sellsOwnTours`). */
export function datesSellerOf(partner: { category: string | null | undefined }): DatesSeller {
  return partner.category === 'guide' ? 'guide' : 'operator';
}

/** Где продавец открывает даты на сайте. Адреса кабинета строит одно место — lib/partners/cabinet-links. */
export function calendarLink(seller: DatesSeller): string {
  return ownerCalendarUrl(seller);
}

/** Кто включает скрытый тур — продавец сам или менеджер Ведара. */
function hiddenTourText(title: string, seller: DatesSeller): string {
  return seller === 'guide'
    // В разделе «Свои туры» кнопки «Показать» нет: тур гида включает менеджер.
    ? `Тур «${title}» скрыт — туристы его не видят, и даты ему не открыты. Включает его менеджер Ведара; ` +
      'после включения откройте даты ещё раз — сами они не откроются.'
    : tourHiddenText(title);
}

// ── Слова и даты ──────────────────────────────────────────────────────────

const GEN_MONTH = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const NOM_MONTH = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function plural(n: number, one: string, few: string, many: string): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return one;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
  return many;
}
export const seatsWord = (n: number): string => `${n} ${plural(n, 'место', 'места', 'мест')}`;
export const peopleWord = (n: number): string => `${n} ${plural(n, 'человек', 'человека', 'человек')}`;
/** «открыть 1 дату», «5 дат», «Это 62 даты» — винительный совпадает с именительным, кроме единицы. */
const datesWord = (n: number): string => `${n} ${plural(n, 'дату', 'даты', 'дат')}`;

/** «, 8 мест» — число мест для подсказки; не названо — пусто, и места спросят следом. */
function seatsTail(seats: number | null | undefined): string {
  return seats == null ? '' : `, ${seatsWord(seats)}`;
}

/**
 * Месяц для образцов подсказок — следующий за сегодняшним (по Камчатке): его
 * дни всегда впереди и в пределах года, а год у него — тот, что разбор
 * выберет сам, поэтому в образце года нет. `shift` — ещё на сколько месяцев
 * дальше (второй месяц «потом»).
 */
function sampleMonth(today: string, shift = 0): { gen: string; nom: string } {
  const m0 = Number(today.slice(5, 7)) - 1;
  const m = (m0 + 1 + shift) % 12;
  return { gen: GEN_MONTH[m]!, nom: NOM_MONTH[m]! };
}

/** Образец фразы открытия на следующий месяц. */
function example(today: string): string {
  const g = sampleMonth(today).gen;
  return `«открой 3, 5 и 7 ${g}, 6 мест» или «открой субботы ${g}, 8 мест»`;
}

/** Тот же образец с местами оператора: фраза-ответ не теряет мест из первой фразы. */
function exampleSeats(today: string, seats: number | null): string {
  const g = sampleMonth(today).gen;
  return `«открой 3, 5 и 7 ${g}${seatsTail(seats)}» или «открой субботы ${g}${seatsTail(seats)}»`;
}

/**
 * Месяц образца «открой 3 и 17 <месяца>» — месяц оператора, если оба дня
 * впереди наверняка (не текущий месяц), иначе следующий за текущим.
 */
function datesMonth(month: number | null, today: string): string {
  const m0 = Number(today.slice(5, 7));
  return month !== null && month !== m0 ? GEN_MONTH[month - 1]! : sampleMonth(today).gen;
}


/** «3 июля 2027». */
export function dayLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${GEN_MONTH[m - 1]} ${y}`;
}

/**
 * Список дат коротко: по месяцам, подряд идущие от трёх — диапазоном.
 * «3, 10, 17 июля 2027; 1–5 августа 2027». С днями недели — у каждой даты
 * (`datesByWeekday`): «сб 3, 10, 17 июля 2027».
 */
export function datesList(dates: string[], withWeekday = false): string {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return '';
  if (withWeekday) return datesByWeekday(sorted).join('; ');
  const groups = new Map<string, number[]>();
  for (const d of sorted) {
    const key = d.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), Number(d.slice(8, 10))]);
  }
  const parts: string[] = [];
  for (const [key, days] of groups) {
    const [y, m] = key.split('-').map(Number) as [number, number];
    const runs: string[] = [];
    for (let i = 0; i < days.length;) {
      let j = i;
      while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++;
      if (j - i >= 2) runs.push(`${days[i]}–${days[j]}`);
      else for (let k = i; k <= j; k++) runs.push(String(days[k]));
      i = j + 1;
    }
    parts.push(`${runs.join(', ')} ${GEN_MONTH[m - 1]} ${y}`);
  }
  return parts.join('; ');
}

/**
 * Даты с днём недели у каждой — строка на месяц (четвёртый ревью 22.10:
 * «весь июль без выходных» показывала «3, 4, 10, 11… июля», и что это одни
 * выходные, было не видно). Правило («будни июля») — группами по порядку
 * недели: «пн 5, 12, 19, 26; вт 6, 13, 20, 27 июля 2027» — пропавший день
 * недели видно сразу. Перечень и отрезок — по порядку дат: «вт 3, чт 5, сб 7
 * августа 2027».
 */
export function datesByWeekday(dates: string[]): string[] {
  const months = new Map<string, string[]>();
  for (const d of [...new Set(dates)].sort()) months.set(d.slice(0, 7), [...(months.get(d.slice(0, 7)) ?? []), d]);
  const lines: string[] = [];
  for (const [key, ds] of months) {
    const [y, m] = key.split('-').map(Number) as [number, number];
    const byWd = new Map<number, number[]>();
    for (const d of ds) byWd.set(weekdayOf(d), [...(byWd.get(weekdayOf(d)) ?? []), Number(d.slice(8, 10))]);
    const groups = [...byWd].sort((a, b) => a[0] - b[0]);
    // Группами — когда это правило (у каждого дня недели не меньше двух дат
    // или день один); иначе («3–10 августа», «3, 5 и 7») — по порядку дат.
    const body = groups.length === 1 || groups.every(([, days]) => days.length >= 2)
      ? groups.map(([w, days]) => `${WEEKDAY_SHORT[w]} ${days.join(', ')}`).join('; ')
      : ds.map((d) => `${WEEKDAY_SHORT[weekdayOf(d)]} ${Number(d.slice(8, 10))}`).join(', ');
    lines.push(`${body} ${GEN_MONTH[m - 1]} ${y}`);
  }
  return lines;
}

/** «Даты (N): …» — одной строкой для одного месяца, строкой на месяц для нескольких. Не режется. */
function datesBlock(dates: string[]): string[] {
  const lines = datesByWeekday(dates);
  return lines.length === 1
    ? [`Даты (${dates.length}): ${lines[0]}`]
    : [`Даты (${dates.length}):`, ...lines.map((l) => `— ${l}`)];
}

/** Строка правила фразы («будни июля 2027»), если фраза была правилом. */
function ruleLines(rule: string | null | undefined): string[] {
  return rule ? [`Правило: ${escapeHtml(rule)}`] : [];
}

/** Запас под пометки и вопрос «Открыть?» — они не режутся (`fit`). */
const TAIL_ROOM = 1500;

/**
 * Влезает ли предложение в сообщение MAX так, что ни одна дата и ни одна
 * пометка не обрезаны (четвёртый ревью 22.10, §5): голова — тур (название не
 * длиннее 200 знаков), места, правило и даты — плюс запас под пометки. Не
 * влезает — отказ «разбейте», а не обрезанный список под кнопкой «Открыть».
 * Даты разбора — не больше 31, и при них голова всегда влезает; проверка —
 * на случай, когда это перестанет быть правдой.
 */
export function proposalFits(dates: string[], rule: string | null): boolean {
  const head = ['Понял так:', `Тур: «${'Т'.repeat(200)}…»`, `Мест на каждый выезд: ${MAX_SEATS_SAMPLE}`, ...ruleLines(rule), ...datesBlock(dates), ''];
  return head.join('\n').length + TAIL_ROOM <= MAX_MESSAGE_CHARS;
}
const MAX_SEATS_SAMPLE = 500;

/**
 * Обрезать до `n` знаков, не разрезая сущность HTML: «&am…» в сообщении
 * формата HTML — битая разметка, а не многоточие.
 */
function cutSafe(text: string, n: number): string {
  if (text.length <= n) return text;
  return `${text.slice(0, Math.max(0, n - 1)).replace(/&[#a-z0-9]*$/i, '')}…`;
}

/**
 * Сообщение не длиннее MAX_MESSAGE_CHARS — за счёт тела (строк по датам), а
 * не хвоста: голова (тур, места, даты) и хвост (пометки, вопрос «Открыть?»)
 * остаются целиком. До ревью 22.10 сообщение резалось с конца, и первыми под
 * нож шли строка про автоподтверждение и сам вопрос, а кнопка «Открыть»
 * оставалась. Не поместившиеся строки тела называются числом.
 */
function fit(head: string[], body: string[], tail: string[]): string {
  const join = (b: string[]): string => [...head, ...b, ...tail].join('\n');
  const whole = join(body);
  if (whole.length <= MAX_MESSAGE_CHARS) return whole;
  const rest = (n: number): string[] => (n > 0 ? [`…и ещё ${n} ${plural(n, 'строка', 'строки', 'строк')} — полный список в кабинете.`] : []);
  const kept: string[] = [];
  let i = 0;
  for (; i < body.length; i++) {
    const room = MAX_MESSAGE_CHARS - join([...kept, ...rest(body.length - i - 1)]).length - 1;
    if (body[i]!.length <= room) { kept.push(body[i]!); continue; }
    if (room >= 60) { kept.push(cutSafe(body[i]!, room)); i++; }
    break;
  }
  return cutSafe(join([...kept, ...rest(body.length - i)]), MAX_MESSAGE_CHARS);
}

/**
 * Название тура в сообщении — не длиннее 200 знаков: голова сообщения (тур,
 * места) в `fit` не режется, и бесконечное название вытеснило бы вопрос.
 */
function tourName(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return escapeHtml(t.length <= 200 ? t : `${t.slice(0, 199).trimEnd()}…`);
}

/** Причина закрытия в превью — коротко: 255 знаков на каждую из 31 даты вытеснили бы вопрос. */
function shortReason(reason: string): string {
  const r = reason.replace(/\s+/g, ' ').trim();
  return r.length <= 60 ? r : `${r.slice(0, 59).trimEnd()}…`;
}

function only<K extends DateOpenResult['result']>(perDate: DateOpenResult[], kind: K): Array<Extract<DateOpenResult, { result: K }>> {
  return perDate.filter((r): r is Extract<DateOpenResult, { result: K }> => r.result === kind);
}

/**
 * Строки исхода по датам: `preview` — что будет, `done` — что сделано.
 * `seller` — где открыть закрытое и кто меняет сезон: оператор — сам, в
 * календаре и карточке тура; гид — в разделе «Свои туры», сезон — менеджер.
 */
export function perDateLines(perDate: DateOpenResult[], seats: number, mode: 'preview' | 'done', seller: DatesSeller): string[] {
  const p = mode === 'preview';
  const lines: string[] = [];
  const opened = only(perDate, 'opened');
  const reopened = only(perDate, 'reopened');
  if (p) {
    const will = [...opened, ...reopened].map((r) => r.date);
    if (will.length) lines.push(`Откроются (${will.length}): ${datesList(will)}.`);
  } else {
    if (opened.length) lines.push(`Открыты (${opened.length}): ${datesList(opened.map((r) => r.date))}.`);
    if (reopened.length) lines.push(`Открыты снова (${reopened.length}): ${datesList(reopened.map((r) => r.date))}.`);
  }
  const updated = only(perDate, 'updated');
  if (updated.length) {
    lines.push(`${p ? 'Места перепишу' : 'Места переписаны'} (${updated.length}): ` +
      updated.map((r) => `${dayLong(r.date)} — было ${seatsWord(r.from)}`).join(', ') + '.');
  }
  const already = only(perDate, 'already_open');
  if (already.length) {
    lines.push(`${p ? 'Уже открыты, не трогаю' : 'Уже были открыты, не менял'} (${already.length}): ` +
      already.map((r) => `${dayLong(r.date)} — ${seatsWord(r.slots)}`).join(', ') + '.');
  }
  const booked = only(perDate, 'refused_booked');
  if (booked.length) {
    lines.push(`${p ? 'Не открою' : 'Не открыты'} — уже записано больше, чем ${seatsWord(seats)} (${booked.length}): ` +
      booked.map((r) => `${dayLong(r.date)} — записано ${peopleWord(r.taken)}`).join(', ') + '.');
  }
  const closed = only(perDate, 'refused_closed');
  if (closed.length) {
    // Одна причина на несколько дат называется один раз: «1–20 июля 2027 («Шторм»)».
    const byReason = new Map<string, string[]>();
    for (const r of closed) {
      const key = r.reason ? shortReason(r.reason) : '';
      byReason.set(key, [...(byReason.get(key) ?? []), r.date]);
    }
    const parts = [...byReason].map(([reason, ds]) => (reason ? `${datesList(ds)} («${escapeHtml(reason)}»)` : datesList(ds)));
    lines.push(`${p ? 'Закрыты вами, не открываю' : 'Не открыты — закрыты вами'} (${closed.length}): ${parts.join('; ')}` +
      (seller === 'guide'
        ? ' — открыть их снова можно в кабинете, в разделе «Свои туры».'
        : ' — открыть их снова можно в кабинете, в календаре.'));
  }
  const season = only(perDate, 'refused_season');
  if (season.length) {
    const w = season[0]!;
    const label = windowLabel({ kind: 'season', from: w.from, to: w.to, seasonStart: w.seasonStart, seasonEnd: w.seasonEnd });
    lines.push(`${p ? 'Вне сезона тура, не открою' : 'Не открыты — вне сезона тура'} (${season.length}): ` +
      `${datesList(season.map((r) => r.date))} — ${label}; ` +
      (seller === 'guide' ? 'сезон тура меняет менеджер Ведара.' : 'сезон меняется в карточке тура.'));
  }
  const past = only(perDate, 'refused_past');
  if (past.length) lines.push(`${p ? 'Прошли, не открою' : 'Не открыты — прошли'} (${past.length}): ${datesList(past.map((r) => r.date))}.`);
  const far = only(perDate, 'refused_horizon');
  if (far.length) {
    lines.push(`${p ? 'Дальше года вперёд, не открою' : 'Не открыты — дальше года вперёд'} (${far.length}): ` +
      `${datesList(far.map((r) => r.date))} — туристы такие даты не видят.`);
  }
  return lines;
}

/** Сколько дат запись откроет по превью. */
export function openableCount(perDate: DateOpenResult[]): number {
  return perDate.filter((r) => r.result === 'opened' || r.result === 'reopened' || r.result === 'updated').length;
}

// ── Предложение ───────────────────────────────────────────────────────────

/** Что известно о туре для пометок под превью. */
export interface PreviewFacts {
  maxParticipants: number | null;
  isPublished: boolean;
  /** Дней в поездке. */
  days: number;
}

/** Что разбор фразы отбросил как прошедшее (только в первом ответе) и «сегодня» для подсказки года. */
export interface PastFlags {
  pastDropped?: string[];
  pastNamed?: string[];
  /** Сегодня по Камчатке: подсказка «если про следующий год» — ближайший будущий год, а не «год + 1». */
  today?: string;
}

export interface ProposalView extends PastFlags {
  tourTitle: string;
  seats: number;
  dates: string[];
  /** Исход по датам из превью; null — превью не прочиталось. */
  perDate: DateOpenResult[] | null;
  facts: PreviewFacts | null;
  /** Автоподтверждение у оператора: true / false / null — не смог проверить. */
  autoConfirm: boolean | null;
  priceMentioned: boolean;
  weekdayWords: boolean;
  /** Правило фразы словами; null — фраза перечисляла даты. */
  rule?: string | null;
  /** Кому: от этого слова о неопубликованном туре. */
  seller: DatesSeller;
}

/**
 * Тот же день и месяц в ближайшем году, не раньше сегодняшнего; null — такой
 * даты в ближайшие годы нет (29 февраля) или «сегодня» не известно. «3 августа
 * 2025», сказанное 22.10.2026, — подсказка «3 августа 2027», а не «2026»,
 * который тоже прошёл.
 */
export function nextSameDay(date: string, today: string | undefined): string | null {
  if (!today) return null;
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  const y0 = Number(today.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const c = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (isCalendarDate(c) && c >= today) return c;
  }
  return null;
}

/**
 * «20 октября 2026 прошло — …» с подсказкой ближайшего будущего года, если он
 * есть. Подсказка — фраза целиком, с годом и местами: «открой 20 октября
 * 2027, 8 мест». `inProposal` — пометка под предложением с другими датами:
 * новая фраза заменяет предложение, и без слова об этом остальные даты
 * терялись бы — кнопка под ними отвечала «заменено новым» (третий ревью 22.10).
 */
function pastLine(d: string, today: string | undefined, tail: string, seats: number | null, inProposal: boolean): string {
  const next = nextSameDay(d, today);
  if (!next) return `${dayLong(d)} прошло${tail}`;
  const [y, m, day] = next.split('-').map(Number) as [number, number, number];
  const phrase = `«открой ${day} ${GEN_MONTH[m - 1]} ${y}${seatsTail(seats)}»`;
  return inProposal
    ? `${dayLong(d)} прошло${tail} Если про ${y} год — сначала закончите с этим предложением («Открыть» или «Не надо»): ` +
      `новая фраза его заменит. Потом напишите ${phrase}.`
    : `${dayLong(d)} прошло${tail} Если про ${y} год — напишите ${phrase}.`;
}

/** Пометки под датами: только те, что правда для этого предложения. `seats` null — мест ещё не назвали. */
function notes(v: Omit<ProposalView, 'seats' | 'seller'> & { seats: number | null; seller: DatesSeller | null }): string[] {
  const out: string[] = [];
  if (v.pastDropped?.length) out.push(`Раньше сегодняшнего не открываю — прошли: ${datesList(v.pastDropped)}.`);
  for (const d of v.pastNamed ?? []) out.push(pastLine(d, v.today, ' — не открываю.', v.seats, true));
  if (v.facts?.maxParticipants != null && v.seats !== null && v.seats > v.facts.maxParticipants) {
    out.push(`В туре группа до ${peopleWord(v.facts.maxParticipants)} — туристы увидят не больше ${seatsWord(v.facts.maxParticipants)}.`);
  }
  if (v.facts && v.facts.days > 1 && closerThan(v.dates, v.facts.days)) {
    out.push(`Тур идёт ${v.facts.days} ${plural(v.facts.days, 'день', 'дня', 'дней')}, а выезды стоят чаще — ` +
      'группы будут делить места в общие дни: места считаются на день, а не на выезд.');
  }
  if (v.facts && !v.facts.isPublished) {
    out.push(v.seller === 'guide'
      // Те же слова, что у раздела «Свои туры» на сайте.
      ? 'Тур — черновик, туристы даты пока не видят: пришлите описание менеджеру Ведара, и тур появится на сайте.'
      : 'Тур не опубликован — туристы даты пока не видят.');
  }
  if (v.autoConfirm === true) out.push('У вас включено автоподтверждение: брони на эти даты подтвердятся сразу.');
  if (v.autoConfirm === null) out.push('Включено ли у вас автоподтверждение броней — не смог проверить.');
  if (v.weekdayWords) {
    out.push('Праздничные дни не учитываю: «выходные» — это субботы и воскресенья, «будни» — с понедельника по пятницу.');
  }
  if (v.priceMentioned) out.push('Цену из чата не меняю: новые даты пойдут по цене тура.');
  return out;
}

function closerThan(dates: string[], days: number): boolean {
  const sorted = [...dates].sort();
  for (let i = 1; i < sorted.length; i++) {
    const gap = (Date.parse(sorted[i]!) - Date.parse(sorted[i - 1]!)) / 86_400_000;
    if (gap < days) return true;
  }
  return false;
}

/**
 * Превью с вопросом «Открыть?». Кнопка «Открыть» стоит, если по превью есть
 * что открыть или превью не прочиталось (`canOpen`); иначе — честное
 * «открывать нечего». Длинное режется в строках по датам, а не в пометках и
 * не в вопросе (`fit`).
 */
export function proposalText(v: ProposalView): { text: string; canOpen: boolean } {
  const head = [
    'Понял так:',
    `Тур: «${tourName(v.tourTitle)}»`,
    `Мест на каждый выезд: ${v.seats}`,
    ...ruleLines(v.rule),
    ...datesBlock(v.dates),
    '',
  ];
  let canOpen: boolean;
  let body: string[];
  if (v.perDate === null) {
    body = ['Что сейчас с этими датами — не смог проверить, скажу после нажатия.'];
    canOpen = true;
  } else {
    body = perDateLines(v.perDate, v.seats, 'preview', v.seller);
    canOpen = openableCount(v.perDate) > 0;
  }
  const n = notes(v);
  const tail = [...(n.length ? ['', ...n] : []), '', canOpen
    ? `Пока ничего не изменилось. Открыть? Предложение действует ${PROPOSAL_TTL_MIN} минут.`
    : 'Открывать нечего — ничего не меняю.'];
  return { text: fit(head, body, tail), canOpen };
}

/**
 * Тур не назван однозначно: выбор кнопкой. Названия целиком — в тексте.
 * `hidden` — скрытые туры, названные фразой наравне с живыми: кнопок у них
 * нет, и вопрос говорит почему (третий ревью 22.10).
 */
export function chooseTourText(v: PastFlags & {
  dates: string[]; seats: number | null; titles: string[]; priceMentioned: boolean; weekdayWords: boolean; hidden?: string[];
  rule?: string | null;
}): string {
  const what = v.seats === null ? '' : `, ${seatsWord(v.seats)}`;
  const n = notes({ tourTitle: '', seats: v.seats, dates: v.dates, perDate: null, facts: null, autoConfirm: false, seller: null,
    priceMentioned: v.priceMentioned, weekdayWords: v.weekdayWords, pastDropped: v.pastDropped, pastNamed: v.pastNamed, today: v.today });
  // «Нажмите кнопку», а не «номер»: номер, написанный текстом, — не выбор тура
  // (до ревью 22.10 он становился числом мест).
  const ask = v.seats === null
    ? 'Нажмите кнопку с туром под сообщением — число мест спрошу следом.'
    : 'Нажмите кнопку с туром под сообщением.';
  const hidden = (v.hidden ?? []).map((t) => `«${tourName(t)}» скрыт — даты ему из чата не открываются, кнопки у него нет.`);
  return fit(
    [`На какой тур открыть ${datesWord(v.dates.length)}${what}?`, ...ruleLines(v.rule), ...datesBlock(v.dates), ''],
    v.titles.map((t, i) => `${i + 1}. ${tourName(t)}`),
    [...hidden, ask, ...(n.length ? ['', ...n] : [])],
  );
}

/** Текст кнопки выбора тура: номер и начало названия — общее начало длинных названий различит номер. */
export function tourButtonText(index: number, title: string): string {
  const t = title.length > 28 ? `${title.slice(0, 27)}…` : title;
  return `${index + 1}. ${t}`;
}

/** Места не названы: вопрос. */
export function askSeatsText(v: PastFlags & {
  tourTitle: string | null; dates: string[]; priceMentioned: boolean; weekdayWords: boolean; rule?: string | null;
}): string {
  const n = notes({ tourTitle: '', seats: null, dates: v.dates, perDate: null, facts: null, autoConfirm: false, seller: null,
    priceMentioned: v.priceMentioned, weekdayWords: v.weekdayWords, pastDropped: v.pastDropped, pastNamed: v.pastNamed, today: v.today });
  return fit(
    [...(v.tourTitle ? [`Тур: «${tourName(v.tourTitle)}»`] : []), ...ruleLines(v.rule), ...datesBlock(v.dates)],
    [],
    ['Сколько мест открыть на каждый выезд? Напишите число, например: 8', ...(n.length ? ['', ...n] : [])],
  );
}

// ── Разбор фразы: вопросы и отказы ────────────────────────────────────────

/**
 * Вопрос разбора. `today` — сегодня по Камчатке: от него месяц образца и
 * нужен ли в подсказке год. `seller` — чей кабинет в ссылке.
 */
export function askText(a: DatesAsk, today: string, seller: DatesSeller): string {
  switch (a.what) {
    case 'month_scope': {
      const last = new Date(Date.UTC(a.year, a.month, 0)).getUTCDate();
      const name = NOM_MONTH[a.month - 1]!;
      // Текущий месяц — с сегодняшнего: «весь октябрь» 22-го открывает 10 дней, а не 31.
      const left = last - a.fromDay + 1;
      const scope = a.fromDay > 1
        ? `Весь ${name} ${a.year} — с сегодняшнего это ${left} ${plural(left, 'день', 'дня', 'дней')} ` +
          `(${a.fromDay}–${last} ${GEN_MONTH[a.month - 1]}) — или некоторые дни?`
        : `Весь ${name} ${a.year} (${last} ${plural(last, 'день', 'дня', 'дней')}) или некоторые дни?`;
      // Год в подсказке — только когда разбор сам выбрал бы другой: «июль 2028».
      const [y0, m0] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
      const yr = a.year === (a.month >= m0 ? y0 : y0 + 1) ? '' : ` ${a.year}`;
      const s = seatsTail(a.seats);
      // «Некоторые дни» — субботы, если до конца месяца есть хоть одна; в
      // последнюю неделю месяца — два оставшихся дня: «субботы декабря» 28-го
      // открыли бы одни прошедшие субботы.
      const some = left >= 7 ? `субботы ${GEN_MONTH[a.month - 1]}` : `${a.fromDay}${left > 1 ? ` и ${last}` : ''} ${GEN_MONTH[a.month - 1]}`;
      return `${scope} Напишите «открой весь ${name}${yr}${s}» или, например, «открой ${some}${yr}${s}». ` +
        `Или в кабинете: ${calendarLink(seller)}`;
    }
    case 'weekday_month':
      return `Какого месяца? Например: «открой ${weekdaysPlural(a.days)} ${sampleMonth(today).gen}${seatsTail(a.seats)}».`;
    case 'half_range':
      return `С какой и по какую дату? Напишите обе, например: «открой с 3 по 15 ${sampleMonth(today).gen}${seatsTail(a.seats)}». ` +
        'Ничего не открыто.';
    case 'vague_period':
      return `Назовите даты числами — праздничного календаря и границ начала или конца периода у меня нет (во фразе «${escapeHtml(a.word)}»). ` +
        `Например: ${example(today)}.`;
  }
}

/** Отказ разбора. `today` — сегодня по Камчатке: от него месяц образца. `seller` — чей кабинет в ссылке. */
export function refusalText(r: DatesRefusal, today: string, seller: DatesSeller): string {
  const nothing = 'Ничего не открыто.';
  const g = sampleMonth(today).gen;
  switch (r.reason) {
    case 'negated':
    case 'exclusion':
    case 'mixed_actions':
      return 'Одно действие за раз и без исключений: перечислите даты, которые открыть, например ' +
        `«открой 3, 10 и 24 ${g}, 8 мест». Закрывают даты в кабинете: ${calendarLink(seller)}. ${nothing}`;
    case 'question':
      return `Это вопрос — по вопросу даты не открываю. Открыть: ${example(today)}. Что открыто сейчас, видно в кабинете: ${calendarLink(seller)}`;
    case 'past_only': {
      const named = r.named.map((d) => pastLine(d, r.today, '.', r.seats, false));
      return named.length > 0 && r.dropped.length === 0 && named.length <= 3
        ? `${named.join('\n')}\n${nothing}`
        : `Все эти даты уже прошли. ${nothing}`;
    }
    case 'too_many': {
      const s = seatsTail(r.seats);
      const head = `Это ${datesWord(r.count)} — за раз открываю до ${MAX_DATES_PER_PROPOSAL}.`;
      // Месяцы оператора, если их можно назвать словами. Иначе — без образца:
      // фраза на чужие месяцы («весь ноябрь») была бы принята как есть и
      // открыла бы то, о чём не просили (третий ревью 22.10).
      if (r.parts.length < 2) {
        return `${head} Разбейте по месяцам — одна фраза на месяц. Или в кабинете: ${calendarLink(seller)}. ${nothing}`;
      }
      const [a, b, ...more] = r.parts;
      return `${head} Разбейте по месяцу: «открой ${a}${s}», потом «открой ${b}${s}»${more.length ? ' и дальше так же' : ''}. ` +
        `Или в кабинете: ${calendarLink(seller)}. ${nothing}`;
    }
    case 'bad_date':
      return `Даты «${escapeHtml(r.text)}» нет в календаре. ${nothing}`;
    case 'too_far':
      return `${dayLong(r.date)} — дальше года вперёд: туристы видят даты до ${dayLong(r.lastDate)}. ${nothing}`;
    case 'two_seat_numbers':
      return `Назвали два числа мест (${r.values.join(' и ')}) — напишите одно. ${nothing}`;
    case 'bad_seats':
      return `Мест на выезд — от 1 до 500, а названо ${r.value}. ${nothing}`;
    case 'leftover_number':
      return r.yearLike
        ? `Не понял «${escapeHtml(r.token)}» — год пишите сразу после месяца, например «открой 3 ${g} ${sampleYear(today)}, 8 мест». ${nothing}`
        : `Не понял «${escapeHtml(r.token)}» — напишите даты и места, например ${example(today)}. ${nothing}`;
    case 'weekday_mismatch':
      return `${dayLong(r.date)} — ${WEEKDAY_LONG[weekdayOf(r.date)]}, а во фразе другой день недели. Напишите даты ещё раз. ${nothing}`;
    case 'range_end':
      return `Не понял «${escapeHtml(r.from)} … ${escapeHtml(r.to)}»: диапазон пишите с месяцем в конце, например ` +
        `«открой с 3 по 15 ${g}, 8 мест». Если это цена — её из чата не меняю. ${nothing}`;
    case 'range_reversed': {
      const s = seatsTail(r.seats);
      if (r.startMonthInherited) {
        // «с 25 по 5 августа»: месяц начала взят у конца, и вероятнее «с 25
        // июля». Переставить даты («с 5 по 25 августа») — открыть три недели,
        // о которых не просили (третий ревью 22.10).
        const prev = prevMonthSameDay(r.from);
        const head = `Конец диапазона раньше начала: ${Number(r.from.slice(8, 10))} … ${dayLong(r.to)}.`;
        return prev
          ? `${head} Если с ${dayLong(prev)} — напишите «открой ${rangeWords(prev, r.to, today)}${s}». ` +
            `Иначе назовите месяц у обеих дат. ${nothing}`
          : `${head} Назовите месяц у обеих дат. ${nothing}`;
      }
      // Обе даты названы целиком — те же две в порядке «начало — конец»:
      // открыть их всё равно можно только после превью и кнопки.
      return `Конец диапазона раньше начала: ${dayLong(r.from)} … ${dayLong(r.to)}. Начало пишите первым: ` +
        `«открой ${rangeWords(r.to, r.from, today)}${s}». ${nothing}`;
    }
    case 'weekday_scope': {
      const s = seatsTail(r.seats);
      return `Не понял, к какому месяцу какие дни недели. По одной части за раз: «открой субботы ${g}${s}», ` +
        `потом «открой воскресенья ${sampleMonth(today, 1).gen}${s}». ${nothing}`;
    }
    case 'relative_mixed':
      return `«${escapeHtml(r.word)}» рядом с другими датами не понял — это дата или просьба сделать сейчас? ` +
        `Напишите даты отдельно, например ${example(today)}. ${nothing}`;
    case 'time_like':
      return `Не понял «${escapeHtml(r.token)}» — если это время, оно задаётся в карточке тура. Даты пишите так: ${example(today)}. ${nothing}`;
    case 'periodicity': {
      // Месяц образца — месяц оператора; в его последнюю неделю — следующий:
      // «субботы октября» 28-го не открыли бы ничего.
      const left = r.month === null ? 0 : daysLeftIn(r.month, today);
      const gm = r.month !== null && left >= 7 ? GEN_MONTH[r.month - 1]! : g;
      return `Периодичность («${escapeHtml(r.word)}») не разбираю — открыл бы каждый день подряд. ` +
        `Назовите дни недели, например «открой субботы ${gm}${seatsTail(r.seats)}», или перечислите даты числами. ${nothing}`;
    }
    case 'unknown_words': {
      // Слова оператора — в кавычках, как есть; подсказка — фраза целиком.
      const words = r.words.slice(0, 6).map((w) => `«${escapeHtml(w)}»`).join(', ');
      const tour = r.tourLike ? ' Тур называйте словами из его названия.' : '';
      return `Не понял: ${words}.${tour} Напишите фразу целиком, например ${exampleSeats(today, r.seats)}. ${nothing}`;
    }
    case 'two_tours': {
      const titles = r.titles.map((t) => `«${tourName(t)}»`).join(', ');
      return `Во фразе разные туры (${titles}) — открываю по одному туру за раз. Напишите отдельную фразу для каждого, ` +
        `например «открой 3 ${g} на ${escapeHtml(r.word)}${seatsTail(r.seats)}». ${nothing}`;
    }
    case 'weekday_exclusion': {
      const s = seatsTail(r.seats);
      const hint = r.keep !== null && r.scope !== null
        ? `«открой ${weekdaysPlural(r.keep)} ${escapeHtml(r.scope)}${s}»`
        : `например «открой ${r.keep !== null ? weekdaysPlural(r.keep) : 'будни'} ${g}${s}»`;
      return `Исключения дней недели («${escapeHtml(r.word)}») не разбираю — назовите дни, которые открыть: ${hint}. ${nothing}`;
    }
    case 'alternative': {
      const left = r.month === null ? 0 : daysLeftIn(r.month, today);
      const gm = r.month !== null && left >= 7 ? GEN_MONTH[r.month - 1]! : g;
      return `«${escapeHtml(r.word)}» не разбираю — открываю только то, что названо точно. Назовите одно, ` +
        `например «открой субботы ${gm}${seatsTail(r.seats)}». ${nothing}`;
    }
    case 'ordinal':
      return `Порядковые слова («${escapeHtml(r.word)}») не разбираю — назовите даты числами, ` +
        `например «открой 3 и 17 ${datesMonth(r.month, today)}${seatsTail(r.seats)}». ${nothing}`;
    case 'number_word':
      return `Числа пишите цифрами («${escapeHtml(r.word)}» не разбираю), ` +
        `например «открой 3 и 17 ${datesMonth(r.month, today)}${seatsTail(r.seats)}». ${nothing}`;
    case 'year_words':
      return `Год пишите числом после месяца («${escapeHtml(r.word)}» не разбираю), ` +
        `например «открой 3 ${g} ${sampleYear(today)}${seatsTail(r.seats)}». ${nothing}`;
    case 'etc':
      return `«${escapeHtml(r.word)}» не разбираю — назовите все даты, например «открой 3, 10, 17 и 24 ${g}${seatsTail(r.seats)}», ` +
        `или дни недели: «открой субботы ${g}${seatsTail(r.seats)}». ${nothing}`;
    case 'seats_delta':
      return `Пишите итоговое число мест на дату, а не добавку («${escapeHtml(r.word)}»), например «открой 3 ${g}, 10 мест». ` +
        `Сколько мест открыто сейчас, видно в кабинете: ${calendarLink(seller)}. ${nothing}`;
    case 'bad_char':
      // Пятый ревью: «❌», «🚫», «−» несут «кроме» и «минус», которых разбор не знает.
      return `Не понял знак «${escapeHtml(r.char)}» — открываю только то, что написано словами и числами, без исключений. ` +
        `Напишите фразу целиком, например ${exampleSeats(today, r.seats)}. ${nothing}`;
    case 'unjoined_dates': {
      const parts = r.parts.slice(0, 4).map((x) => `«${escapeHtml(x)}»`).join(', ');
      return `Не понял, как связаны даты ${parts}: открыть их все или одна из них — что-то другое (начало продаж, срок)? ` +
        `Перечислите даты выезда через запятую, места и тур — один раз в конце, например ` +
        `«открой 3 и 10 ${g}${seatsTail(r.seats)}». ${nothing}`;
    }
    case 'date_relation':
      return `«${escapeHtml(r.word)}» рядом с датой не разбираю — открываю только названные даты выезда. ` +
        `Назовите их числами, например «открой 3 и 17 ${datesMonth(r.month, today)}${seatsTail(r.seats)}». ${nothing}`;
    case 'date_word_in_title': {
      // Седьмой ревью: тур со словом даты в названии называется после слова «тур».
      // Восьмой (m2): образец — даты самой фразы, если она в языке.
      const dates = escapeHtml(r.dates ?? `субботы ${sampleMonth(today).gen}`);
      const plain = r.dates ? `«открой ${dates}${seatsTail(r.seats)}»` : exampleSeats(today, r.seats);
      return `«${escapeHtml(r.word)}» — это даты или тур «${tourName(r.title)}»? Напишите даты без названия тура — ` +
        `тур выберете кнопкой, например ${plain}, — или назовите его после слова тур: ` +
        `«открой ${dates} тур ${tourName(r.title)}${seatsTail(r.seats)}». ${nothing}`;
    }
    case 'action_word_in_title': {
      // Восьмой ревью (S2): слово исключения в названии тура без «тур» не скрывается.
      const dates = escapeHtml(r.dates ?? `субботы ${sampleMonth(today).gen}`);
      return `«${escapeHtml(r.word)}» — это исключение дат или тур «${tourName(r.title)}»? Не угадываю. Тур с таким словом ` +
        `называйте после слова тур: «открой ${dates} тур ${tourName(r.title)}${seatsTail(r.seats)}» — или напишите даты ` +
        `без названия тура, тур выберете кнопкой. ${nothing}`;
    }
    case 'year_order': {
      // Седьмой ревью: год даты зависел от порядка дат во фразе. Восьмой (S3):
      // образец — вся фраза оператора с годом, по году в окне продаж.
      const [y1, y2] = [Number(r.date.slice(0, 4)), Number(r.other.slice(0, 4))].sort((a, b) => a - b);
      const name = NOM_MONTH[Number(r.date.slice(5, 7)) - 1]!;
      const what = r.month ? `${name[0]!.toUpperCase()}${name.slice(1)}` : dayLong(r.date).replace(/ \d{4}$/, '');
      const how = r.variants.length > 0
        ? `Напишите фразу с годом: ${r.variants.map((v) => `«${escapeHtml(v.text)}»`).join(' или ')}.`
        : `Напишите год ${r.month ? 'после месяца' : 'у этой даты'}.`;
      return `${what} — ${y1} или ${y2} год? По порядку дат во фразе и само по себе выходит разное — не угадываю. ${how} ${nothing}`;
    }
    case 'range_until': {
      // Седьмой ревью: «до» в конце отрезка бывает и невключительно. Восьмой:
      // образцы — вся фраза оператора с «по», оба прочтения, проверенные разбором.
      const how = r.variants.length > 0 ? `: ${r.variants.map((v) => `«${escapeHtml(v.text)}»`).join(' или ')}` : '';
      return `До ${dayLong(r.to)} — входит ли этот день, не угадываю: так пишут и включительно, и нет. Напишите с предлогом по${how}. ${nothing}`;
    }
    case 'range_same':
      // Восьмой ревью (m2): образец — то же без отрезка («субботы июля», «3 августа»).
      return `Отрезок начинается и кончается одним и тем же днём или месяцем — не понял, что открыть. ` +
        (r.hint ? `Если нужно это — напишите «открой ${escapeHtml(r.hint)}${seatsTail(r.seats)}». ` : `Назовите даты, например ${exampleSeats(today, r.seats)}. `) +
        nothing;
    case 'seats_total':
      return `Всего ${seatsWord(r.seats)} на ${datesWord(r.count)} не разбираю — места ставятся на каждый выезд. ` +
        `Напишите, сколько мест на каждую дату, например «открой 3 и 10 ${g}, ${seatsWord(r.seats)}». ${nothing}`;
    case 'off_pattern':
      // Шестой ревью: фраза вне языка не угадывается — образец целиком, тур через «на».
      return 'Фразу целиком не разобрал — даты из чата открываю только по образцу: сначала глагол, потом даты, тур ' +
        'через предлог на и места; между датами — только запятая или союз и, без точек и пояснений. ' +
        `Например ${exampleSeats(today, r.seats)}. ${nothing}`;
    case 'repeated_date':
      return `${dayLong(r.date)} во фразе дважды — не понял, сколько на неё мест. Назовите каждую дату один раз, например ` +
        `${exampleSeats(today, r.seats)}. ${nothing}`;
    case 'not_understood':
      return `Не понял даты. Напишите так: ${example(today)}. ${nothing}`;
  }
}

/**
 * Диапазон словами, которые разбор понимает: «с 5 по 10 июля», «с 28 июня по
 * 3 июля»; год — только когда разбор сам выбрал бы другой.
 */
function rangeWords(from: string, to: string, today: string): string {
  const [y0, m0] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const part = (d: string): { day: number; gen: string; yr: string } => {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    return { day, gen: GEN_MONTH[m - 1]!, yr: y === (m >= m0 ? y0 : y0 + 1) ? '' : ` ${y}` };
  };
  const a = part(from);
  const b = part(to);
  return from.slice(0, 7) === to.slice(0, 7)
    ? `с ${a.day} по ${b.day} ${b.gen}${b.yr}`
    : `с ${a.day} ${a.gen}${a.yr} по ${b.day} ${b.gen}${b.yr}`;
}

/** Тот же день месяцем раньше: 2027-08-25 → 2027-07-25; null — такой даты нет (31 → июнь). */
function prevMonthSameDay(date: string): string | null {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const c = `${py}-${String(pm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isCalendarDate(c) ? c : null;
}

/**
 * Сколько дней месяца `m` впереди, считая сегодня: текущий месяц — до конца,
 * будущий — целиком (год разбор выберет сам: этот или следующий).
 */
function daysLeftIn(m: number, today: string): number {
  const [y0, m0, d0] = today.split('-').map(Number) as [number, number, number];
  const y = m >= m0 ? y0 : y0 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return m === m0 ? last - d0 + 1 : last;
}

/** Год месяца образца: следующий месяц после декабря — январь следующего года. */
function sampleYear(today: string): number {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  return m === 12 ? y + 1 : y;
}
const WEEKDAY_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

// ── Отказы потока ─────────────────────────────────────────────────────────

export const FLOW_TEXT = {
  closeIntent: (seller: DatesSeller) => `Закрыть даты из чата пока нельзя. В кабинете: ${calendarLink(seller)}`,
  switchedOff: (seller: DatesSeller) => `Открывать даты из чата сейчас нельзя. В кабинете: ${calendarLink(seller)}`,
  /** Группа: кнопку «Открыть» нажал бы любой участник (четвёртый ревью 22.10: раньше фраза пропадала молча). */
  groupChat: 'Открывать даты словами можно только в личном диалоге со мной: в группе кнопку «Открыть» нажал бы '
    + 'любой участник. Напишите эту фразу мне в личные сообщения. Ничего не открыто.',
  /** «отмена», «стоп», «не надо» при действующем предложении. */
  cancelledByText: 'Хорошо, предложение снято — ничего не открыто.',
  cancelFailed: 'Не смог снять предложение — база не ответила. Его кнопку «Открыть» не нажимайте; попробуйте через минуту.',
  /**
   * Поправка ушла помощнику («нет, 4 места», «не тот тур»), а предложение
   * ждало нажатия (пятый ревью): оно снято — старая «Открыть» не пишет.
   */
  retiredByCorrection: 'Прежнее предложение дат снято — по нему ничего не открыто. Если хотели его поправить, '
    + 'напишите фразу целиком: даты, тур и места.',
  /** Сообщение старше действующего предложения (повтор апдейта MAX): ничего не меняем. */
  staleMessage: 'Это сообщение пришло позже нового предложения дат — по нему ничего не меняю, действует последнее.',
  /** Поправка текстом не сняла прежнее предложение: его кнопка ещё жива. */
  retireFailed: 'Прежнее предложение снять не смог — его кнопку «Открыть» не нажимайте.',
  tooLong: (n: number) => `Это ${datesWord(n)} — список не помещается в одно сообщение. Разбейте по месяцам — одна фраза на месяц. `
    + 'Ничего не открыто.',
  noAccount: (seller: DatesSeller) => seller === 'guide'
    ? 'Открывать даты из чата может только гид с кабинетом на Ведаре, а у вашей карточки кабинета нет. ' +
      `Ничего не открыто. Даты открывает менеджер Ведара или вы — после входа: ${calendarLink(seller)}`
    : 'Открывать даты из чата может только компания с кабинетом на Ведаре, а у этой записи кабинета нет. ' +
      `Ничего не открыто. Даты открывает администратор или вы — после входа: ${calendarLink(seller)}`,
  // Слышит и турист: проверка чата не прошла — значит, неизвестно, чей он.
  partnerUnknown: 'Сбой на нашей стороне — ничего не изменено, попробуйте через минуту.',
  toursUnread: 'Не смог прочитать ваши туры — ничего не открыто, попробуйте через минуту.',
  noTours: (seller: DatesSeller) => seller === 'guide'
    ? `У вас нет активных туров — открывать даты некуда. Скрытый тур включает менеджер Ведара. Ваши туры: ${ownerToursUrl(seller)}`
    : `У вас нет активных туров — открывать даты некуда. Тур включается в кабинете: ${ownerToursUrl(seller)}`,
  nameNeeded: (titles: string[]) => 'Напишите фразу заново с названием тура. Ваши туры:\n' +
    titles.map((t) => `— ${escapeHtml(t)}`).join('\n'),
  hidden: (title: string, seller: DatesSeller) => `${escapeHtml(hiddenTourText(title, seller))} Ничего не открыто.`,
  /** Фраза назвала только скрытые туры — один или несколько (третий ревью 22.10). */
  hiddenTours: (titles: string[], seller: DatesSeller) => titles.length === 1
    ? FLOW_TEXT.hidden(titles[0]!, seller)
    : `Туры ${titles.map((t) => `«${tourName(t)}»`).join(', ')} скрыты — туристы их не видят, и даты им не открыты. ` +
      (seller === 'guide'
        ? 'Включает их менеджер Ведара; после включения откройте даты ещё раз — сами они не откроются. Ничего не открыто.'
        : 'Включите нужный («Показать» в списке туров или «Активен» в карточке тура) и откройте даты ещё раз — ' +
          'сами при включении они не откроются. Ничего не открыто.'),
  saveFailed: 'Не смог сохранить предложение — ничего не открыто. Попробуйте через минуту.',
  draftUnread: 'Не смог прочитать незаконченное предложение дат — ничего не открыто. Если число было про места, напишите его ещё раз через минуту.',
  chooseTourFirst: 'Тур выберите кнопкой под сообщением, места спрошу следом. Ничего не изменено.',
  badSeats: (n: number) => `Мест на выезд — от 1 до 500, а названо ${n}. Ничего не открыто.`,
  cancelled: 'Хорошо, ничего не открываю.',
  // Нажатия
  // Чей это чат, не проверено — значит, неизвестно и чей кабинет: ссылка
  // на кабинет оператора гида увела бы на отказ (29.10).
  pressUnverifiedPartner: 'Не смог проверить нажатие — ничего не изменено. Нажмите кнопку ещё раз через минуту '
    + 'или откройте даты в кабинете на сайте.',
  pressNotHere: 'Эта кнопка работает только в чате кабинета оператора или гида со своими турами. Ничего не изменено.',
  notFound: 'Это предложение не найдено в этом чате — ничего не изменено.',
  // Заменяет и новое предложение, и поправка текстом (отказ, вопрос): новой
  // кнопки может не быть — поэтому «под последним, если есть».
  superseded: 'Это предложение снято вашим следующим сообщением — по нему ничего не открыто. '
    + 'Нажмите кнопку под последним предложением, если оно есть, или напишите фразу ещё раз.',
  wasCancelled: 'Вы отменили это предложение — ничего не открыто.',
  expired: `Предложение устарело (действует ${PROPOSAL_TTL_MIN} минут), ничего не открыто. Напишите ещё раз.`,
  staleButton: 'Кнопка устарела — напишите фразу ещё раз. Ничего не изменено.',
  needTour: 'Сначала выберите тур кнопкой под вопросом. Ничего не открыто.',
  needSeats: 'Сначала напишите число мест на выезд, например: 8. Ничего не открыто.',
  dbFailed: 'Ничего не открыто: база не ответила. Нажмите «Открыть» ещё раз через минуту.',
  dbFailedPress: 'Ничего не изменено: база не ответила. Нажмите кнопку ещё раз через минуту.',
  badButton: 'Кнопка не распознана — ничего не изменено. Напишите фразу ещё раз.',
} as const;

/** «открой весь декабрь, 8 мест» — месяц следующий за сегодняшним: «весь ноябрь» в декабре разбор отверг бы как прошедший. */
export function wholeMonthHint(today: string): string {
  return `«открой весь ${sampleMonth(today).nom}, 8 мест»`;
}

/** Где на сайте: у гида — раздел «Свои туры», у туроператора — календарь кабинета. */
function calendarWhere(seller: DatesSeller): string {
  return seller === 'guide'
    ? `в разделе «Свои туры»: ${calendarLink(seller)}`
    : `в календаре кабинета: ${calendarLink(seller)}`;
}

/**
 * «Обновить места» (31.10, снимок владельца): MAX получал текст для Telegram —
 * «В MAX можно написать…» в самом MAX. В MAX фраза пишется здесь же, и
 * кнопка подтверждения у потока дат есть; в Telegram её нет.
 */
export function seatsHintText(seller: DatesSeller, channel: 'max' | 'telegram', today: string): string {
  if (channel === 'max') {
    return [
      `Открыть даты можно прямо здесь: напишите одной фразой, например ${wholeMonthHint(today)}.`,
      'Я покажу, какие даты откроются, и кнопку «Открыть». Пока её не нажмёте, ничего не меняется.',
      `Или ${calendarWhere(seller)}`,
    ].join('\n');
  }
  return [
    'В Telegram даты не открываю: здесь нет кнопки подтверждения.',
    `Откройте их ${calendarWhere(seller)}`,
    `Или в MAX одной фразой, например ${wholeMonthHint(today)}.`,
  ].join('\n');
}

/** Telegram: кнопки подтверждения там нет — даты словами открываются в MAX. */
export function telegramDatesText(seller: DatesSeller): string {
  return `Открыть даты словами можно в MAX — там есть кнопка подтверждения. Или в кабинете: ${calendarLink(seller)}`;
}

// ── Итог нажатия ──────────────────────────────────────────────────────────

/** Итог нажатия «Открыть» — то, что лежит в `outcome` строки предложения. */
export type StoredOutcome =
  | { kind: 'done'; tourTitle: string; seats: number; written: number; perDate: DateOpenResult[] }
  | { kind: 'refused'; reason: 'tour_not_found' }
  | { kind: 'refused'; reason: 'tour_inactive'; title: string };

const RESULTS = new Set<string>([
  'opened', 'reopened', 'updated', 'already_open', 'refused_booked', 'refused_closed', 'refused_past', 'refused_horizon', 'refused_season',
]);

/** Итог из JSONB — с проверкой формы: прочитанное из базы не принимается на веру. */
export function readStoredOutcome(v: unknown): StoredOutcome | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'refused' && o.reason === 'tour_not_found') return { kind: 'refused', reason: 'tour_not_found' };
  if (o.kind === 'refused' && o.reason === 'tour_inactive' && typeof o.title === 'string') {
    return { kind: 'refused', reason: 'tour_inactive', title: o.title };
  }
  if (o.kind === 'done' && typeof o.tourTitle === 'string' && typeof o.seats === 'number'
      && typeof o.written === 'number' && Array.isArray(o.perDate)
      && o.perDate.every((r) => typeof r === 'object' && r !== null
        && typeof (r as { date?: unknown }).date === 'string' && RESULTS.has(String((r as { result?: unknown }).result)))) {
    return { kind: 'done', tourTitle: o.tourTitle, seats: o.seats, written: o.written, perDate: o.perDate as DateOpenResult[] };
  }
  return null;
}

/** Ответ на нажатие «Открыть»: исход каждой даты словами. `lead` — строка перед итогом (повтор нажатия). */
export function outcomeText(o: StoredOutcome, seller: DatesSeller, lead?: string): string {
  if (o.kind === 'refused') {
    const t = o.reason === 'tour_inactive'
      ? FLOW_TEXT.hidden(o.title, seller)
      : 'Тур снят с продажи или больше не ваш — даты не открыты.';
    return lead ? `${lead} ${t}` : t;
  }
  const head = o.written > 0
    ? `Готово, «${tourName(o.tourTitle)}», ${seatsWord(o.seats)} на выезд.`
    : `Ничего не открыто: «${tourName(o.tourTitle)}», ${seatsWord(o.seats)} на выезд.`;
  return fit([...(lead ? [lead] : []), head], perDateLines(o.perDate, o.seats, 'done', seller), [`Проверить: ${calendarLink(seller)}`]);
}

/** «14:32» по Камчатке. */
export function kamchatkaTime(at: Date): string {
  return new Date(at.getTime() + 12 * 3_600_000).toISOString().slice(11, 16);
}

/** Повторное нажатие уже исполненного предложения: ничего не пишется, итог — прежний. */
export function repeatText(usedAt: Date | null, o: StoredOutcome | null, seller: DatesSeller): string {
  const when = usedAt ? ` в ${kamchatkaTime(usedAt)} (по Камчатке)` : '';
  if (o === null) return `Уже сделано${when}. Итог не прочитался — проверьте в кабинете: ${calendarLink(seller)}`;
  if (o.kind === 'refused') return outcomeText(o, seller, `Это предложение уже обработано${when}:`);
  return outcomeText(o, seller, `Уже сделано${when}, повтор ничего не меняет:`);
}

// ── История помощника ─────────────────────────────────────────────────────

/**
 * Сводка для истории помощника кабинета: сырая фраза оператора в историю не
 * идёт — история уходит зарубежной модели (§8), а сводка из размеченных
 * полей не несёт ничего, кроме тура, дат и числа мест.
 */
export function historyAsk(tourTitle: string | null, dates: string[], seats: number | null, seller: DatesSeller): string {
  const tour = tourTitle ? ` тура «${tourTitle}»` : '';
  const s = seats === null ? '' : ` по ${seatsWord(seats)}`;
  return `${seller === 'guide' ? 'Гид' : 'Оператор'} попросил в чате открыть ${datesWord(dates.length)} (${datesList(dates)})${tour}${s}.`;
}
export function historyResult(o: StoredOutcome, seller: DatesSeller): string {
  if (o.kind === 'refused') return `Даты из чата не открыты: тур снят, скрыт или больше не этого ${seller === 'guide' ? 'гида' : 'оператора'}.`;
  return `По кнопке «Открыть» открыто ${o.written} из ${o.perDate.length} дат тура «${o.tourTitle}» (${seatsWord(o.seats)} на выезд). ` +
    'Сам помощник даты не открывает.';
}
