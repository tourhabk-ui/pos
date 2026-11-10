/**
 * Наблюдение за сайтами партнёров — чистые правила, без сети и базы.
 *
 * Слово владельца 22.10: «нам нужно проверять сайты партнеров на изменение».
 * Туры партнёров у нас собраны с их сайтов: у туров «Края Вулканов» (1176) и
 * «Местечка Камчатка» (1217) записан `source_url`, туры «Камчатской рыбалки»
 * сверены с её сайтом без адресов страниц (1106, сайт на Tilda — одна
 * страница). Партнёр поменял у себя цену, даты, состав или снял тур —
 * наша карточка стала неправдой, и раньше этого не замечал никто (§0). Ночная
 * проверка сайтов операторов (`operator-site-audit`) смотрит безопасность и с
 * прошлым разом не сравнивает.
 *
 * Здесь — из чего состоит сравнение: видимый текст страницы строками, разница
 * двух текстов, вердикт по истории страницы и сообщение владельцу. Сеть и
 * запись снимков — в `site-watch-run.ts`.
 */
import { createHash } from 'node:crypto';
import { htmlToText } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';
import { escapeHtml } from '@/lib/text/escape-html';

/** Имя, под которым мы читаем чужой сайт. Своё, а не браузер и не поисковик. */
export const WATCH_USER_AGENT = 'VedarSiteWatch/1.0 (+https://vedarai.ru)';

/**
 * Потолки чтения. Страница, не уместившаяся в них, НЕ сравнивается: обрезанное
 * чтение теряет хвост, и хвост этот выглядел бы «пропавшими» строками. Отчёт
 * 10.11: страницы туров laguna-expedition.ru выросли с календарём выездов до
 * 741 тыс. знаков при потолке тела 600 тыс. — и владельцу ушло «было:
 * Проживание в спа-отеле…», «было: Номер реестровой записи…» о строках,
 * которые никуда не девались. Признак обрезки (`truncated`) тогда не читался.
 * Теперь страница больше потолка — исход «не смог прочитать», а не «прочитал».
 */
/** Потолок тела страницы, знаков HTML. */
export const WATCH_BODY_LIMIT = 3_000_000;
/** Потолок видимого текста страницы, знаков. */
export const TEXT_CAP = 200_000;

/** Потолки до миграции 1418: ими сняты снимки, у которых `body_chars` не записан. */
export const LEGACY_BODY_LIMIT = 600_000;
export const LEGACY_TEXT_CAP = 60_000;

/**
 * Обрезало бы старое чтение страницу такого размера. Снимок, снятый до 1418
 * со страницы больше старых потолков, — не вся страница: первое полное чтение
 * сравнивается с ним только в той части, которую старое чтение видело
 * (`cutSnapshotDiff`).
 */
export function legacyReadWasCut(bodyChars: number, textChars: number): boolean {
  return bodyChars > LEGACY_BODY_LIMIT || textChars > LEGACY_TEXT_CAP;
}

/** Исход чтения страницы. */
export type PageOutcome = 'ok' | 'gone' | 'failed' | 'robots';

/**
 * Строка, которая меняется при каждом открытии страницы и о туре ничего не
 * говорит: арифметическая капча формы («Защита от роботов: 4+4=?», Contact
 * Form 7 `wpcf7-quiz`). Отчёт 23.10 назвал «изменениями» 24 страницы
 * «Местечка Камчатка», и во всех показанных строках менялись только цифры
 * капчи — по две формы на странице, свои цифры у каждой. Признак узкий:
 * пример со знаком «=?», цена или дата так не пишутся.
 *
 * Первое число — одной цифрой, а не `\d+`: регулярка без якоря, и «есть ли
 * пример в строке» от этого не меняется, а строка из одних цифр не читается
 * заново с каждой позиции. С `\d+` страница из 200 тыс. цифр держала процесс
 * 52 секунды (проверка 10.11).
 */
const VOLATILE_LINE = /\d\s*[+\-−×*xх]\s*\d+\s*=\s*\?/i;

export function isVolatileLine(line: string): boolean {
  return VOLATILE_LINE.test(line);
}

/**
 * Счётчик мест у выезда: «Осталось 8 мест». Меняется с каждой бронью у
 * партнёра, а на наших карточках его нет — сверять не с чем. Отчёт 08.11
 * звал изменением «Осталось 4 места» → «Осталось 3 места». «Мест нет» — тот
 * же счётчик на нуле. В снимке строка остаётся, из сравнения выбрасывается.
 */
const SEAT_COUNTER_LINE = /^(?:осталось\s+\d+\s+мест[ао]?|мест\s+нет)\.?$/i;

/**
 * Баннер согласия на cookie. Отчёт 10.11 назвал изменением четыре страницы
 * «Местечка Камчатка», где появились только строки «Используя этот сайт, вы
 * соглашаетесь с тем, что мы используем файлы cookie…» и «Принимаю». О туре
 * баннер не говорит ничего: строка со словом cookie («куки») в сравнении не
 * участвует. Строка-кнопка («Принимаю», «Отклонить всё») — тоже, но только
 * когда в одном из двух текстов есть сам баннер: без него «Принять» может
 * быть кнопкой формы на странице тура.
 *
 * Строка, где рядом со словом cookie стоят деньги или дата, сравнивается:
 * вёрстка без переводов строк склеивает баннер с ценой в одну строку, и
 * вместе с баннером пропала бы смена цены. Строки, зажатые между строками
 * баннера (не дальше BANNER_GAP), — его же: у «Лагуны» это «Прочтите нашу
 * Политику конфиденциальности», «Обязательные».
 */
const COOKIE_WORD = /cookie|(?<![а-яё])кук(?:и|ов|ам|ами|ах)(?![а-яё])/i;
const CONSENT_BUTTON = /^(?:принимаю|принять(?:\s+вс[её])?|согласен|согласна|я\s+согласе?на?|соглашаюсь|согласиться|разрешить(?:\s+вс[её])?|отклонить(?:\s+вс[её])?|отказаться|только\s+необходимые|настроить|настройки|сохранить(?:\s+(?:настройки|выбор))?|подробнее|закрыть|хорошо|понятно|ок|ok|accept(?:\s+all)?|reject(?:\s+all)?|decline|got\s+it)[.!]?$/i;
const BANNER_GAP = 3;

function isCookieLine(line: string): boolean {
  return COOKIE_WORD.test(line) && !MATTERS.test(line);
}

function hasCookieBanner(text: string): boolean {
  return text.split('\n').some(isCookieLine);
}

/** Номера строк баннера: сами строки cookie и зажатое между ними, кроме строк с деньгами и датами. */
function bannerLineNumbers(lines: string[]): Set<number> {
  const out = new Set<number>();
  let last = -1;
  lines.forEach((line, i) => {
    if (!isCookieLine(line)) return;
    if (last >= 0 && i - last - 1 <= BANNER_GAP) {
      for (let k = last + 1; k < i; k++) if (!MATTERS.test(lines[k])) out.add(k);
    }
    out.add(i);
    last = i;
  });
  return out;
}

/**
 * Текст для сравнения: без строк-капч (снимок до 23.10 мог быть записан с
 * ними), счётчиков мест и строк баннера cookie; `banner` — баннер есть в
 * одном из двух сравниваемых текстов, и кнопки согласия тоже не судятся.
 */
function comparable(text: string, banner = false): string {
  const lines = text.split('\n');
  const inBanner = bannerLineNumbers(lines);
  return lines.filter((l, i) =>
    !isVolatileLine(l) && !SEAT_COUNTER_LINE.test(l) && !inBanner.has(i) && !(banner && CONSENT_BUTTON.test(l)),
  ).join('\n');
}

/**
 * Видимый текст страницы строками: без скриптов, стилей и разметки, сущности
 * развёрнуты, пробелы схлопнуты, пустые строки и строки-капчи выброшены.
 * Сравнивается именно он — смена вёрстки, счётчиков в скриптах, CDN-адресов и
 * цифр капчи изменением не считается, смена цены или даты в тексте — считается.
 *
 * Потолка здесь нет: уместилась ли страница (`TEXT_CAP`), решает прогон, и не
 * уместившаяся не сохраняется и не сравнивается. Разметка снимается за время,
 * линейное по размеру (lib/html/text.js): страница — чужой ввод, и разбор за
 * квадрат на повреждённой держал бы процесс прода минутами.
 */
export function fullPageText(html: string): string {
  const text = decodeHtmlEntities(htmlToText(html))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)));
  return text.split('\n')
    .map((l) => l.replace(/[\s ]+/g, ' ').trim())
    .filter((l) => l.length > 0 && !isVolatileLine(l))
    .join('\n');
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

export function textHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/** Строка про деньги или сроки — её владелец должен увидеть первой. */
// `\b` в JS видит границу только у латиницы — у кириллицы граница задана
// просмотром назад: «марта» в «Камартане» месяцем не считается.
// Число перед «дн/ноч/час» — одной цифрой: ответ test() тот же, а длинная
// серия цифр не читается заново с каждой позиции (100 тыс. цифр — 12 с).
const MATTERS = /₽|руб|\d{1,3}[  ]\d{3}|\b\d{1,2}[./]\d{1,2}\b|(?<![а-яё])(январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)|\b20\d\d\b|\d\s*(дн|ноч|час)/i;

export interface TextDiff {
  /** Были и пропали. */
  removed: string[];
  /** Появились. */
  added: string[];
}

/**
 * Разница двух текстов по строкам. Строки про деньги и сроки — впереди,
 * остальные — в порядке страницы. Порядок строк сам по себе изменением не
 * считается: перестановка блоков на странице не меняет того, что там сказано.
 */
export function diffLines(prev: string, next: string): TextDiff {
  const a = prev.split('\n');
  const b = next.split('\n');
  const inB = new Set(b);
  const inA = new Set(a);
  const removed = [...new Set(a.filter((l) => !inB.has(l)))];
  const added = [...new Set(b.filter((l) => !inA.has(l)))];
  const first = (xs: string[]) => [...xs.filter((l) => MATTERS.test(l)), ...xs.filter((l) => !MATTERS.test(l))];
  return { removed: first(removed), added: first(added) };
}

/**
 * Разница, которую стоит показать человеку. Капчи, счётчики мест и баннер
 * cookie выброшены из обоих текстов; сдвиг скользящей даты и прошедший выезд (если передан
 * `today` — сегодня по Камчатке, YYYY-MM-DD) изменением не считаются. Если
 * после этого не пропало и не появилось ни одной строки — изменения нет,
 * null. Так молчат смена капчи, перестановка или повтор тех же строк и
 * просто наступивший день: хэш у таких текстов разный, а партнёр ничего не
 * менял.
 */
export function meaningfulDiff(prevText: string, nextText: string, today?: string): TextDiff | null {
  const banner = hasCookieBanner(prevText) || hasCookieBanner(nextText);
  const prev = comparable(prevText, banner);
  let d = withoutRollingShifts(diffLines(prev, comparable(nextText, banner)));
  if (today) d = withoutPassedDepartures(d, today, prev);
  return d.removed.length === 0 && d.added.length === 0 ? null : d;
}

/**
 * Разница для снимка старого чтения, которое страницу обрезало. В снимке —
 * начало страницы: строка, которая в нём была и пропала, пропала на деле.
 * Появившиеся строки судятся только там, куда старое чтение доставало: до
 * последней строки снимка, которая в новом тексте стоит ровно один раз. Ниже
 * неё — хвост, которого в снимке не было; он не новость. Последняя строка
 * снимка не судится: обрезка могла оставить от неё обрывок.
 *
 * null — в видимой части ничего не изменилось: первое полное чтение просто
 * становится точкой отсчёта.
 */
export function cutSnapshotDiff(prevCutText: string, nextText: string, today?: string): TextDiff | null {
  const d = meaningfulDiff(prevCutText, nextText, today);
  if (!d) return null;
  const prevLines = prevCutText.split('\n');
  const nextLines = nextText.split('\n');
  const times = new Map<string, number>();
  for (const l of nextLines) times.set(l, (times.get(l) ?? 0) + 1);
  let edge = -1;
  for (let i = prevLines.length - 2; i >= 0 && edge < 0; i--) {
    if (times.get(prevLines[i]) === 1) edge = nextLines.indexOf(prevLines[i]);
  }
  const seen = new Set(nextLines.slice(0, edge + 1));
  const lastOfSnapshot = prevLines[prevLines.length - 1];
  const removed = d.removed.filter((l) => l !== lastOfSnapshot);
  const added = d.added.filter((l) => seen.has(l));
  return removed.length === 0 && added.length === 0 ? null : { removed, added };
}

/**
 * «Скользящая» дата: строка вроде «Ближайший выезд: 4 ноября» на
 * laguna-expedition.ru сама сдвигается каждый день — партнёр ничего не
 * менял, а отчёт звал это изменением (слово владельца 03.11). Пара
 * «пропала / появилась» гасится, только если строки совпадают целиком,
 * кроме дат, и каждая дата сдвинулась ВПЕРЁД не больше чем на
 * ROLLING_MAX_DAYS. Сдвиг назад, дальний перенос, новая цена или другой
 * текст рядом с датой — по-прежнему изменение.
 *
 * Строка из одной даты с годом («14 ноября 2026») — дата выезда в календаре,
 * а не подпись «ближайший»: пара таких строк скользящей не считается. Иначе
 * перенос выезда на неделю молчал, а новый выезд рядом с ушедшим гасился
 * вместе с ним (находка проверки 10.11).
 */
export const ROLLING_MAX_DAYS = 14;

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const DATE_RE = new RegExp(
  String.raw`(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\d.])` +
  String.raw`|(?<!\d)(\d{1,2})\s+(январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])(?:\s+(20\d\d))?(?![а-яё])`,
  'gi',
);

/** Дни от условной эпохи; год, если не указан, — один и тот же условный. */
function dayNumber(day: number, month: number, year: number | null): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year ?? 2000, month - 1, day) / 86_400_000;
}

function rollingKey(line: string): { mask: string; days: (number | null)[] } {
  const days: (number | null)[] = [];
  const mask = line.replace(DATE_RE, (_m, d1, m1, y1, d2, mon) => {
    if (d1) {
      const y = y1 ? Number(y1.length === 2 ? `20${y1}` : y1) : null;
      days.push(dayNumber(Number(d1), Number(m1), y));
    } else {
      const lower = String(mon).toLowerCase();
      const idx = MONTHS.findIndex((m) => lower.startsWith(m));
      days.push(dayNumber(Number(d2), idx + 1, null));
    }
    return '\u0000';
  });
  return { mask, days };
}

type RollingKey = ReturnType<typeof rollingKey>;

/** Те же слова вокруг дат, и каждая дата ушла вперёд не дальше `ROLLING_MAX_DAYS`. */
function shiftedForward(a: RollingKey, b: RollingKey): boolean {
  if (a.mask !== b.mask || a.days.length !== b.days.length) return false;
  return a.days.every((x, i) => {
    const y = b.days[i];
    if (x === null || y === null) return false;
    let delta = y - x;
    if (delta < 0) delta += 365; // декабрь → январь без года в строке
    return delta > 0 && delta <= ROLLING_MAX_DAYS;
  });
}

/** Появившиеся строки с одними словами вокруг дат: с одной датой — по дню, с несколькими — списком. */
interface RollingBucket {
  single: Map<number, { rows: number[]; head: number }>;
  multi: number[];
}

/**
 * Первая ещё не занятая появившаяся строка, которая отличается от пропавшей
 * только датой, ушедшей вперёд. Строка с одной датой ищется по дню — по одному
 * взгляду на каждый допустимый сдвиг, а не перебором всех строк с теми же
 * словами: календарь на тысячи строк иначе сравнивался бы каждая с каждой.
 */
function firstShifted(key: RollingKey, bucket: RollingBucket, addedKeys: RollingKey[], paired: Set<number>): number {
  if (key.days.length > 1) {
    return bucket.multi.find((i) => !paired.has(i) && shiftedForward(key, addedKeys[i])) ?? -1;
  }
  const day = key.days[0];
  if (day === null) return -1;
  let best = -1;
  for (let k = 1; k <= ROLLING_MAX_DAYS; k++) {
    // Сдвиг на k дней; второй вариант — декабрь → январь без года в строке.
    for (const target of [day + k, day + k - 365]) {
      const list = bucket.single.get(target);
      if (!list) continue;
      while (list.head < list.rows.length && paired.has(list.rows[list.head])) list.head += 1;
      const row = list.rows[list.head];
      if (row !== undefined && (best < 0 || row < best)) best = row;
    }
  }
  return best;
}

/**
 * Убирает из разницы пары строк, где сдвинулась только скользящая дата.
 *
 * Пропавшей строке ищется первая появившаяся с теми же словами вокруг дат.
 * Ключ строки (слова без дат и сами даты) считается один раз, а появившиеся
 * разложены по словам и дням: сравнение каждой с каждой, с разбором дат на
 * каждую пару, на странице в 8 000 сменившихся строк держало процесс 17 секунд
 * (проверка 10.11).
 */
export function withoutRollingShifts(d: TextDiff): TextDiff {
  const addedKeys = d.added.map(rollingKey);
  const buckets = new Map<string, RollingBucket>();
  addedKeys.forEach((key, i) => {
    if (key.days.length === 0) return;
    let bucket = buckets.get(key.mask);
    if (!bucket) buckets.set(key.mask, (bucket = { single: new Map(), multi: [] }));
    if (key.days.length > 1) { bucket.multi.push(i); return; }
    const day = key.days[0];
    if (day === null) return;
    const list = bucket.single.get(day);
    if (list) list.rows.push(i); else bucket.single.set(day, { rows: [i], head: 0 });
  });
  const paired = new Set<number>();
  const removed: string[] = [];
  for (const r of d.removed) {
    const key = isDateOnlyLine(r) ? null : rollingKey(r);
    const bucket = key && key.days.length > 0 ? buckets.get(key.mask) : undefined;
    const at = key && bucket ? firstShifted(key, bucket, addedKeys, paired) : -1;
    if (at >= 0) paired.add(at); else removed.push(r);
  }
  return { removed, added: d.added.filter((_, i) => !paired.has(i)) };
}

/*
 * Прошедший выезд. Отчёт 08.11 о «Лагуне» почти целиком состоял из строк
 * «было: 08 ноября 2026,» и «было: 08 ноября 2026» — начало и конец
 * однодневного выезда в день самого выезда. Партнёр ничего не снимал: день
 * наступил, и сайт убрал выезд из календаря сам.
 *
 * Пропавшая строка гасится, только если в ней нет ничего, кроме дат С ГОДОМ
 * (и дня недели, знаков препинания), и все эти даты не позже сегодняшней по
 * Камчатке. Дата без года прошедшей не считается: «4 ноября» может значить и
 * следующий год. Пропавшая БУДУЩАЯ дата — по-прежнему изменение: это снятый
 * выезд.
 *
 * Вместе с выездом с календаря уходят строки его дня недели, времени
 * («в 10:00») и месяца («Ноябрь 2026»), если другой такой на странице не
 * осталось. Они гасятся только рядом с погашенной датой и только когда строк
 * того же рода не появилось: «в 09:00» → «в 10:00» — смена времени, её видно.
 * Заголовок месяца позже текущего не гасится: будущий месяц сам не уходит.
 *
 * Конец начавшегося выезда. Отчёт 10.11: «было: 13 ноября 2026» у двух туров
 * «Лагуны» — дата ОКОНЧАНИЯ выезда 10–13 ноября, ушедшего с календаря в день
 * начала. Дата в будущем, и прежнее правило звало её снятым выездом. Пропавшая
 * дата гасится, если в прошлом тексте она везде стоит концом выезда: перед ней
 * (не дальше END_LOOKBACK строк) подпись об окончании, а ближайшая дата выше —
 * начало, которое прошло и пропало вместе с ней. Между началом и концом
 * допускаются только подпись, день недели и время: цена, кнопка или строка
 * «Сбор в 09:00, возвращение к 19:00» значат, что это список однодневных
 * выездов, и пропавшая будущая дата там — снятый выезд.
 */
const WEEKDAY_RE = /(?<![а-яё])(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс)(?![а-яё])/gi;
const PUNCT_ONLY = /^[\s,.;:!?()«»"'—–-]*$/;
const TIME_ONLY = /^(?:в\s+)?\d{1,2}:\d{2}(?:\s*[—–-]\s*\d{1,2}:\d{2})?$/i;
const MONTH_HEADER = /^(январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)\s+(20\d\d)$/i;
const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function isoDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Даты строки (YYYY-MM-DD у даты с годом, null — без года) и что осталось вокруг них. */
function datesOf(line: string): { days: (string | null)[]; rest: string } {
  const days: (string | null)[] = [];
  const rest = line.replace(DATE_RE, (_m, d1, m1, y1, d2, mon, y2) => {
    if (d1) {
      days.push(y1 ? isoDay(Number(y1.length === 2 ? `20${y1}` : y1), Number(m1), Number(d1)) : null);
    } else {
      const lower = String(mon).toLowerCase();
      days.push(y2 ? isoDay(Number(y2), MONTHS.findIndex((m) => lower.startsWith(m)) + 1, Number(d2)) : null);
    }
    return ' ';
  });
  return { days, rest };
}

/** Строка, в которой нет ничего, кроме дат с годом (и дня недели, знаков). */
function isDateOnlyLine(line: string): boolean {
  const { days, rest } = datesOf(line);
  return days.length > 0 && days.every((day) => day !== null) && PUNCT_ONLY.test(rest.replace(WEEKDAY_RE, ''));
}

function isPassedDateLine(line: string, today: string): boolean {
  return isDateOnlyLine(line) && datesOf(line).days.every((day) => day !== null && day <= today);
}

const END_MARK = /(?<![а-яё])(?:оконч|заверш|возвращ|финиш)/i;
const END_LOOKBACK = 8;

/** Подпись «Окончание тура»: слово об окончании и ни одной цифры. */
function isEndLabel(line: string): boolean {
  return END_MARK.test(line) && !/\d/.test(line);
}

/**
 * Даты, которые в прошлом тексте ВЕЗДЕ стоят концом выезда с прошедшим и
 * пропавшим началом (`passed`). Одно вхождение вне такого выезда — дата не
 * гасится: там она значит что-то ещё.
 */
function endsOfStartedDepartures(prevLines: string[], passed: Set<string>): Set<string> {
  const verdict = new Map<string, boolean>();
  for (let i = 0; i < prevLines.length; i++) {
    const line = prevLines[i];
    if (!isDateOnlyLine(line)) continue;
    let isEnd = false;
    let endSaid = false;
    for (let j = i - 1; j >= 0 && j >= i - END_LOOKBACK; j--) {
      const above = prevLines[j];
      if (isDateOnlyLine(above)) { isEnd = endSaid && passed.has(above); break; }
      if (isEndLabel(above)) { endSaid = true; continue; }
      if (companionKind(above) === null) break;
    }
    verdict.set(line, (verdict.get(line) ?? true) && isEnd);
  }
  return new Set([...verdict].filter(([, ok]) => ok).map(([line]) => line));
}

type CalendarCompanion = 'weekday' | 'time' | 'month';

function companionKind(line: string): CalendarCompanion | null {
  if (TIME_ONLY.test(line)) return 'time';
  if (MONTH_HEADER.test(line)) return 'month';
  const bare = line.replace(WEEKDAY_RE, '');
  return bare !== line && PUNCT_ONLY.test(bare) ? 'weekday' : null;
}

function monthNotAfter(line: string, today: string): boolean {
  const m = MONTH_HEADER.exec(line);
  if (!m) return false;
  const month = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1;
  return `${m[2]}-${String(month).padStart(2, '0')}` <= today.slice(0, 7);
}

/**
 * Убирает из разницы прошедшие выезды и строки, ушедшие вместе с ними.
 * `prevText` — прошлый текст (тот, что сравнивался): по нему узнаётся дата
 * окончания выезда, который уже начался.
 */
export function withoutPassedDepartures(d: TextDiff, today: string, prevText?: string): TextDiff {
  const passed = new Set(d.removed.filter((l) => isPassedDateLine(l, today)));
  if (passed.size === 0) return d;
  const ends = prevText === undefined ? new Set<string>() : endsOfStartedDepartures(prevText.split('\n'), passed);
  const removed = d.removed.filter((l) => !passed.has(l) && !ends.has(l));
  const addedKinds = new Set(d.added.map(companionKind).filter((k): k is CalendarCompanion => k !== null));
  return {
    removed: removed.filter((l) => {
      const kind = companionKind(l);
      if (kind === null || addedKinds.has(kind)) return true;
      return kind === 'month' && !monthNotAfter(l, today);
    }),
    added: d.added,
  };
}

/**
 * Запрещает ли robots.txt наш путь. Группа нашего имени, иначе группа `*`;
 * побеждает самое длинное совпавшее правило, Allow — при равной длине.
 * Пустой или недоступный robots.txt ничего не запрещает.
 */
export function robotsDisallows(robotsTxt: string | null, path: string, agent = 'vedarsitewatch'): boolean {
  if (!robotsTxt) return false;
  interface Group { agents: string[]; rules: Array<{ allow: boolean; prefix: string }> }
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'disallow' || key === 'allow') && cur) {
      lastWasAgent = false;
      if (key === 'disallow' && value === '') continue;
      cur.rules.push({ allow: key === 'allow', prefix: value });
    } else {
      lastWasAgent = false;
    }
  }
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!matchesRobotsPath(r.prefix, path)) continue;
      const len = r.prefix.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? !best.allow : false;
}

function matchesRobotsPath(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

/** Снимок страницы — то, что о ней знает история. */
export interface Snapshot { outcome: PageOutcome; hash: string | null }

/** Что случилось со страницей по сравнению с прошлыми прогонами. */
export type WatchEvent =
  | { kind: 'baseline' }
  | { kind: 'same' }
  | { kind: 'changed' }
  | { kind: 'gone' }
  | { kind: 'back' }
  | { kind: 'failing' }
  | { kind: 'quiet' };

/**
 * Вердикт по истории. `prev` — прошлый снимок, `prevOk` — последний удачный
 * с текстом (с ним сравнивается текст), `prev2` — позапрошлый.
 *
 *  - первый удачный снимок — точка отсчёта, тревоги нет;
 *  - текст другой, чем в последнем удачном, — «изменилась»;
 *  - 404/410 впервые — «пропала»; пропала и пропала — молчим, уже сказано;
 *  - снова открылась после «пропала» — «вернулась»;
 *  - не открылась второй прогон подряд — «не открывается» (один отказ сети
 *    тревогой не считается), дальше молчим;
 *  - robots.txt запретил — не читали, это не изменение.
 */
export function watchEvent(now: Snapshot, prev: Snapshot | null, prev2: Snapshot | null, prevOkHash: string | null): WatchEvent {
  if (now.outcome === 'robots') return { kind: 'quiet' };
  if (now.outcome === 'gone') return prev?.outcome === 'gone' ? { kind: 'quiet' } : { kind: 'gone' };
  if (now.outcome === 'failed') {
    return prev?.outcome === 'failed' && prev2?.outcome !== 'failed' ? { kind: 'failing' } : { kind: 'quiet' };
  }
  if (prev?.outcome === 'gone') return { kind: 'back' };
  if (prevOkHash === null) return { kind: 'baseline' };
  return now.hash === prevOkHash ? { kind: 'same' } : { kind: 'changed' };
}

/** Страница под наблюдением: чья и каким нашим турам служит источником. */
export interface WatchedPage {
  url: string;
  partnerName: string;
  /** Названия наших живых туров, собранных с этой страницы; пусто — главная. */
  tours: string[];
  /**
   * Сайт ведёт платформа (`partners.site_managed_by_platform`, 1312). Тогда
   * изменение — наша правка или правка того, у кого остался доступ, и правда —
   * наши карточки, а не сайт. Нет поля — сайт не наш.
   */
  managedByUs?: boolean;
}

export interface PageReport {
  page: WatchedPage;
  event: WatchEvent['kind'];
  diff?: TextDiff;
  httpStatus?: number | null;
  /** Страница открылась, но больше потолка чтения: прочитана не целиком и не сравнивалась. */
  tooBig?: boolean;
}

const SHOW_LINES = 4;
const MESSAGE_CAP = 3600;

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function what(page: WatchedPage): string {
  if (page.tours.length === 0) return 'главная страница сайта';
  if (page.tours.length === 1) return `тур «${page.tours[0]}»`;
  return `туры ${page.tours.map((t) => `«${t}»`).join(', ')}`;
}

/** Больше сообщений за прогон не шлём: остаток назван числом. */
const MAX_MESSAGES = 5;

/**
 * Одна и та же строка на стольких страницах партнёра — правка сайта, а не
 * одной карточки. Баннер акции или пункт меню стоит на каждой странице:
 * партнёр поменял его — и владельцу пришло бы по блоку с одной и той же
 * строкой на каждую страницу под наблюдением (у «Лагуны» их больше тридцати).
 * Такие строки сводятся в один блок на набор страниц; у страницы остаётся
 * только её собственное.
 */
export const SITE_WIDE_MIN_PAGES = 3;
/** Сколько страниц назвать в сводном блоке; остальные — числом. */
const SHOW_PAGES = 12;

interface SiteWideBlock {
  first: WatchedPage;
  pages: WatchedPage[];
  /** Сколько страниц этого партнёра прочитано в прогоне. */
  watched: number;
  removed: string[];
  added: string[];
}

/**
 * Делит изменения на общие для нескольких страниц партнёра и собственные.
 * Строки, пропавшие (или появившиеся) на одном и том же наборе страниц,
 * идут одним блоком: цена, сменившаяся у трёх туров, не смешивается с
 * баннером, сменившимся у тридцати, — и страницы названы у каждой свои.
 */
function splitSiteWide(reports: PageReport[]): { site: SiteWideBlock[]; own: Map<PageReport, TextDiff> } {
  const own = new Map<PageReport, TextDiff>();
  const site: SiteWideBlock[] = [];
  const byPartner = new Map<string, PageReport[]>();
  for (const r of reports) {
    if (r.event !== 'changed') continue;
    own.set(r, { removed: [...(r.diff?.removed ?? [])], added: [...(r.diff?.added ?? [])] });
    byPartner.set(r.page.partnerName, [...(byPartner.get(r.page.partnerName) ?? []), r]);
  }
  for (const [partner, group] of byPartner) {
    if (group.length < SITE_WIDE_MIN_PAGES) continue;
    // «сторона + строка» → на каких страницах группы она есть.
    const where = new Map<string, number[]>();
    group.forEach((r, n) => {
      for (const side of ['removed', 'added'] as const) {
        for (const line of new Set(r.diff?.[side] ?? [])) {
          const key = `${side}\u0000${line}`;
          where.set(key, [...(where.get(key) ?? []), n]);
        }
      }
    });
    const blocks = new Map<string, SiteWideBlock>();
    for (const [key, at] of where) {
      if (at.length < SITE_WIDE_MIN_PAGES) continue;
      const [side, line] = key.split('\u0000') as ['removed' | 'added', string];
      const pagesKey = at.join(',');
      let block = blocks.get(pagesKey);
      if (!block) {
        block = {
          first: group[at[0]].page, pages: at.map((n) => group[n].page),
          watched: reports.filter((r) => r.page.partnerName === partner).length, removed: [], added: [],
        };
        blocks.set(pagesKey, block);
        site.push(block);
      }
      block[side].push(line);
      for (const n of at) {
        const mine = own.get(group[n])!;
        mine[side] = mine[side].filter((l) => l !== line);
      }
    }
  }
  return { site, own };
}

/**
 * Сообщения владельцу. Пусто — сообщать нечего: точки отсчёта, «без перемен»
 * и молчащие исходы в Telegram не идут. Текст — HTML для parse_mode, всё
 * чужое экранировано: строки с сайта партнёра — не наша разметка.
 *
 * Не влезло в одно сообщение — идёт следующим, до MAX_MESSAGES. Отчёт 08.11
 * кончался строкой «ещё изменений: 14 — полностью в partner_page_snapshots»:
 * таблицу базы владелец не читает, и 14 изменений он не увидел вовсе.
 */
export function ownerMessages(reports: PageReport[]): string[] {
  const loud = reports.filter((r) => r.event === 'changed' || r.event === 'gone' || r.event === 'back' || r.event === 'failing');
  if (loud.length === 0) return [];
  const { site, own } = splitSiteWide(reports);
  const diffLinesOf = (d: TextDiff): string[] => {
    const lines = [
      ...d.removed.slice(0, SHOW_LINES).map((l) => `было: ${escapeHtml(cut(l))}`),
      ...d.added.slice(0, SHOW_LINES).map((l) => `стало: ${escapeHtml(cut(l))}`),
    ];
    const rest = Math.max(0, d.removed.length - SHOW_LINES) + Math.max(0, d.added.length - SHOW_LINES);
    if (rest > 0) lines.push(`и ещё строк: ${rest}`);
    return lines;
  };
  const blocks: string[] = [];
  for (const b of site) {
    const named = b.pages.slice(0, SHOW_PAGES).map((p) => escapeHtml(what(p))).join(', ');
    const more = b.pages.length > SHOW_PAGES ? ` и ещё ${b.pages.length - SHOW_PAGES}` : '';
    blocks.push([
      `<b>${escapeHtml(b.first.partnerName)}</b>${b.first.managedByUs ? ' (сайт ведём мы)' : ''} — одна и та же правка на ${b.pages.length} страницах из ${b.watched} под наблюдением`,
      ...diffLinesOf(b),
      `страницы: ${named}${more}`,
    ].join('\n'));
  }
  for (const r of loud) {
    const head = `<b>${escapeHtml(r.page.partnerName)}</b>${r.page.managedByUs ? ' (сайт ведём мы)' : ''} — ${escapeHtml(what(r.page))}`;
    const url = escapeHtml(shortUrl(r.page.url));
    if (r.event === 'gone') {
      blocks.push(`${head}\nстраница пропала с сайта партнёра (${r.httpStatus ?? 404})\n${url}`);
    } else if (r.event === 'back') {
      blocks.push(`${head}\nстраница снова открывается\n${url}`);
    } else if (r.event === 'failing' && r.tooBig) {
      // Вчерашний отказ мог быть другим (сеть): «второй день» — про то, что страница не прочитана, причина — сегодняшняя.
      blocks.push(`${head}\nстраница второй день не прочитана; сегодня она больше потолка чтения: читается не целиком, изменения на ней не видны\n${url}`);
    } else if (r.event === 'failing') {
      blocks.push(`${head}\nстраница не открывается второй день${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}\n${url}`);
    } else {
      // Собственное страницы; всё её изменение ушло в сводный блок — отдельного блока нет.
      const d = own.get(r) ?? { removed: [], added: [] };
      const whole = r.diff ?? { removed: [], added: [] };
      if (d.removed.length === 0 && d.added.length === 0 && whole.removed.length + whole.added.length > 0) continue;
      blocks.push(`${head}\n${url}\n${diffLinesOf(d).join('\n')}`);
    }
  }
  const title = `<b>Сайты партнёров: ${blocks.length === 1 && site.length === 0 ? 'изменилась 1 страница' : `изменений — ${blocks.length}`}</b>`;
  // Направление сверки зависит от того, чей сайт: чужой поменялся — устарели
  // наши карточки; наш поменялся — сайт сверяется с карточками.
  // Страница больше потолка названа владельцу один раз, на второй день; дальше
  // она молчит и не сравнивается. Пока так — о ней напоминает каждое сообщение.
  const blind = reports.filter((r) => r.tooBig && r.event !== 'failing').map((r) => escapeHtml(shortUrl(r.page.url)));
  const tail = [
    loud.some((r) => !r.page.managedByUs) ? 'Наши карточки этих туров могли устареть — сверьте и поправьте.' : null,
    loud.some((r) => r.page.managedByUs)
      ? 'Сайт с пометкой «ведём мы» правим мы сами: если правка не наша — проверьте, у кого есть доступ. Правда там — наши карточки, сайт сверяется с ними.'
      : null,
    blind.length > 0 ? `Не читаются целиком и не сравниваются (больше потолка чтения): ${blind.slice(0, 5).join(', ')}${blind.length > 5 ? ` и ещё ${blind.length - 5}` : ''}` : null,
  ].filter(Boolean).join('\n');
  const messages: string[] = [];
  let body = title;
  let inBody = 0;
  let shown = 0;
  for (const b of blocks) {
    if (inBody > 0 && body.length + b.length + tail.length + 160 > MESSAGE_CAP) {
      if (messages.length + 1 >= MAX_MESSAGES) break;
      messages.push(body);
      body = '<b>Сайты партнёров — продолжение</b>';
      inBody = 0;
    }
    body += `\n\n${b}`;
    inBody++;
    shown++;
  }
  if (shown < blocks.length) {
    body += `\n\nещё изменений: ${blocks.length - shown} — не вошли в ${MAX_MESSAGES} сообщений; они записаны в журнале наблюдения на сервере`;
  }
  messages.push(`${body}\n\n${tail}`);
  return messages;
}

function cut(line: string): string {
  return line.length > 220 ? `${line.slice(0, 219)}…` : line;
}

/** Первый прогон: кого взяли под наблюдение — одним сообщением, чтобы владелец сверил список. */
export function baselineMessage(pages: WatchedPage[]): string | null {
  if (pages.length === 0) return null;
  const byPartner = new Map<string, { n: number; ours: boolean }>();
  for (const p of pages) {
    const was = byPartner.get(p.partnerName) ?? { n: 0, ours: false };
    byPartner.set(p.partnerName, { n: was.n + 1, ours: was.ours || p.managedByUs === true });
  }
  const lines = [...byPartner.entries()].map(([name, { n, ours }]) =>
    `${escapeHtml(name)} — страниц: ${n}${ours ? ' · сайт ведём мы' : ''}`);
  return [
    '<b>Сайты партнёров: наблюдение начато</b>',
    '',
    ...lines,
    '',
    'Раз в сутки сверяю видимый текст этих страниц с прошлым разом и пишу сюда, если что-то поменялось.',
  ].join('\n');
}
