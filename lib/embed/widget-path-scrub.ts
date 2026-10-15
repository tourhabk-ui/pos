/**
 * lib/embed/widget-path-scrub.ts — чистка пути страницы партнёра от ПД.
 *
 * ── Повод (аудит 15.10, находка R-path, ревью PR #2518) ───────────────────
 *
 * Путь страницы партнёра (`location.pathname`) приходит к нам в адресе окна
 * виджета и оседает в `chat_sessions.widget_origin.path` и
 * `leads.source_data.widget_origin.path`; второе GET /api/leads отдаёт
 * оператору. Прежняя чистка ловила только 7 и больше цифр ПОДРЯД — а
 * конструкторы «спасибо за заявку» кладут номер в адрес так, как его ввёл
 * человек: `/spasibo/8-914-123-45-67`, `/zakaz/+7%20914%20123%2045%2067`.
 * Такой путь проходил насквозь. Вдобавок скрипты на сайте партнёра клали путь
 * в адрес iframe сырым: даже то, что сервер потом заменял, уже лежало в
 * access-логах vedarai.ru и в Referer запросов окна.
 *
 * ── Правило (одно на три места) ───────────────────────────────────────────
 *
 * Путь режется по `/`, и каждый сегмент:
 *   1. раскрывается из %-кодирования (до трёх раз: двойное кодирование тоже
 *      прячет номер). Сам сегмент не раскрывается — он заменяется целиком
 *      меткой `{undecodable}`: проверить его нельзя, а «не смог проверить» не
 *      равно «чисто» (§4.0);
 *   2. содержит `@` — заменяется целиком меткой `{email}`;
 *   3. ряд цифр, между которыми стоят разделители номера (пробел, дефис и
 *      тире, точка, скобки, плюс, подчёркивание — не больше трёх подряд), где
 *      цифр всего 7 и больше, заменяется меткой `{digits}`. Это телефон, номер
 *      документа — и дата `2026-10-15` тоже: цена ложной метки — потерянный
 *      кусок адреса в счёте, цена пропуска — чужой телефон в базе;
 *   4. сегмент, в котором ничего не заменено, остаётся КАК БЫЛ, байт в байт;
 *      заменённый собирается обратно: метки как есть, остальное — через
 *      `encodeURIComponent`, так что раскрытые пробелы, `/` и `?` в путь не
 *      возвращаются.
 *
 * Правило идемпотентно: чистый путь проходит его без изменений. Это нужно,
 * потому что чистят ДВАЖДЫ — скрипт на странице партнёра до вставки в адрес
 * окна и сервер при записи (старый скрипт из кэша партнёра чистки не знает).
 *
 * ── Три копии и сторож ────────────────────────────────────────────────────
 *
 * `scrubWidgetPath` ниже — источник правила; им чистит `normalizeWidgetPath`
 * (lib/embed/widget-origin.ts). Скрипты на чужих страницах импортировать его
 * не могут: выдача /api/widget/lead.js вставляет текст `WIDGET_PATH_SCRUB_JS`,
 * а public/widget/embed.js — статический файл без сборки и держит такую же
 * копию текстом. Копии не должны разойтись, и держит это поведение, а не
 * сличение текста: tests/unit/widget-path-pd.test.ts прогоняет ОДИН набор
 * путей через `normalizeWidgetPath`, через embed.js и через выдачу lead.js в
 * jsdom и сравнивает путь в адресе окна. Правишь правило — правь все три.
 */

/** Метки вместо вырезанного; их же видит тот, кто читает запись. */
export const WIDGET_PATH_LABELS = {
  digits: '{digits}',
  email: '{email}',
  undecodable: '{undecodable}',
} as const;

/** Сколько раз раскрывать %-кодирование сегмента. */
const DECODE_ROUNDS = 3;

/** Сколько цифр в ряду делают его телефоном или номером документа. */
const MIN_DIGITS = 7;

/**
 * Ряд цифр с разделителями номера между ними — одной группой захвата, чтобы
 * `split` вернул ряды на нечётных местах. Ведущие `+` и `(` входят в ряд:
 * иначе от `+7 (914) …` остался бы `+` перед меткой.
 */
const DIGIT_RUN = /([+(]*\d(?:[\s().+_\u2010-\u2015-]{0,3}\d)*)/;

/** Сегмент без %-кодирования; null — сам сегмент не раскрывается. */
function decodeSegment(seg: string): string | null {
  let plain = seg;
  for (let i = 0; i < DECODE_ROUNDS && plain.includes('%'); i++) {
    let next: string;
    try {
      next = decodeURIComponent(plain);
    } catch {
      // Не раскрылся сам сегмент — null, вызывающий заменит его меткой.
      // Раскрылся раньше, а дальше нет — оставшийся `%` это буква адреса
      // (`skidka-50%25` → `skidka-50%`), а не кодирование.
      if (i === 0) return null;
      break;
    }
    if (next === plain) break;
    plain = next;
  }
  return plain;
}

/** Один сегмент пути (без `/`) — по правилу из шапки. */
export function scrubWidgetPathSegment(seg: string): string {
  const plain = decodeSegment(seg);
  if (plain === null) return WIDGET_PATH_LABELS.undecodable;
  if (plain.includes('@')) return WIDGET_PATH_LABELS.email;
  const parts = plain.split(DIGIT_RUN);
  let changed = false;
  for (let j = 0; j < parts.length; j++) {
    if (j % 2 === 1 && parts[j].replace(/\D/g, '').length >= MIN_DIGITS) {
      parts[j] = WIDGET_PATH_LABELS.digits;
      changed = true;
    } else {
      parts[j] = encodeURIComponent(parts[j]);
    }
  }
  return changed ? parts.join('') : seg;
}

/** Путь страницы (без query и hash) → путь без телефонов и почты. */
export function scrubWidgetPath(path: string): string {
  return path.split('/').map(scrubWidgetPathSegment).join('/');
}

/**
 * То же правило текстом ES5 — для скрипта, который выдача /api/widget/lead.js
 * отдаёт сайту партнёра (там нет нашей сборки, и чем браузер партнёра
 * старее — тем важнее не выходить за ES5). Такая же копия — в
 * public/widget/embed.js. Объявляет функцию `scrubPath(path)`.
 */
export const WIDGET_PATH_SCRUB_JS = String.raw`function scrubPath(path) {
    return String(path).split('/').map(function (seg) {
      var plain = seg;
      for (var i = 0; i < 3 && plain.indexOf('%') !== -1; i++) {
        var next;
        try { next = decodeURIComponent(plain); } catch (e) { if (i === 0) return '{undecodable}'; break; }
        if (next === plain) break;
        plain = next;
      }
      if (plain.indexOf('@') !== -1) return '{email}';
      var parts = plain.split(/([+(]*\d(?:[\s().+_\u2010-\u2015-]{0,3}\d)*)/);
      var changed = false;
      for (var j = 0; j < parts.length; j++) {
        if (j % 2 === 1 && parts[j].replace(/\D/g, '').length >= 7) { parts[j] = '{digits}'; changed = true; }
        else parts[j] = encodeURIComponent(parts[j]);
      }
      return changed ? parts.join('') : seg;
    }).join('/');
  }`;
