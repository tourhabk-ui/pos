/**
 * Коммерческий ответ Кузьмича: туры, трансфер, жильё, прокат.
 *
 * Текст собирается из данных этого хода, а не из пересказа модели.
 * Цена без строки источника не печатается. Оценка «4 500–6 750» и сумма
 * «за трое суток / на троих» не считаются. Следующий вопрос «первый /
 * сколько стоит» читает последний список той же темы. Нет данных — так и
 * сказано, и предложена форма запроса. Персональные данные в Telegram не
 * спрашиваются.
 */

import { isCarRentalAsk, isSightseeingQuestion, wantsTourCards } from '@/lib/ai/booking-intent';
import { detectEmergency } from '@/lib/safety/sos-detector';
import { calendarDay, ruDate, seasonAccusative } from '@/lib/kuzmich/season-window';
import { rentalPauseForTourist } from '@/lib/rental/site-pause';
import { touristRentalText } from '@/lib/telegram/tourist-keyboard';
import { pickToursForAnswer, type CatalogTour } from '@/lib/telegram/tourist-tours';
import { escapeHtml } from '@/lib/text/escape-html';
import { priceFromUnit } from '@/lib/tours/price-label';
import { tourPath } from '@/lib/tours/tour-url';
import { OFFER_ORDER_NOTE_SHORT_RU } from '@/lib/tours/offer-order';
import {
  MCHS_UNREAD_NOTE, notesForOffering, warningDigest, type ActiveWarning,
} from '@/lib/safety/mchs-bulletin';

export type CommercialSurface = 'web' | 'telegram' | 'max';
export type CommercialTopic = 'tour' | 'transfer' | 'lodging' | 'rental';

export interface TransferItem {
  slug: string;
  name: string;
  /** Строки прайса как записаны: за машину, без умножения на людей. */
  lines: string[];
  url: string;
}

export interface StayItem {
  name: string;
  /** null — цены в строке нет. «от A до B» допустимо, только если так записано. */
  priceText: string | null;
  url: string;
  zone: string | null;
  mentionsSprings: boolean;
}

export interface ComposeInput {
  question: string;
  history: string;
  now: Date;
  surface: CommercialSurface;
  base: string;
  pauseActive: boolean;
  pauseSlugs: readonly string[];
  tours: { ok: true; tours: CatalogTour[] } | { ok: false };
  transfers: { ok: true; items: TransferItem[] } | { ok: false };
  stays: { ok: true; items: StayItem[] } | { ok: false };
  /**
   * Действующие сводки МЧС. Нет поля — ход их не спрашивал (старые тесты).
   * ok: false — прочитать не удалось, и это нельзя прочитать как «всё спокойно».
   */
  warnings?: { ok: true; warnings: ActiveWarning[] } | { ok: false };
}

export interface CommercialAnswer {
  visible: string;
  tours: CatalogTour[];
}

interface ShownOffer {
  topic: CommercialTopic;
  title: string;
  priceText: string;
  url: string;
}

const HEADS: Array<[RegExp, CommercialTopic]> = [
  [/^Туры из каталога(?:\s|:|$)/, 'tour'],
  [/^Трансфер из прайса(?:\s|:|$)/, 'transfer'],
  [/^Жильё из витрины(?:\s|:|$)/, 'lodging'],
  [/^Прокат из прайса(?:\s|:|$)/, 'rental'],
];

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function isTransferAsk(text: string): boolean {
  return /трансфер|из аэропорта|в аэропорт/.test(norm(text));
}

function isLodgingAsk(text: string): boolean {
  const t = norm(text);
  if (/тур/.test(t) && !/остановиться|жиль|отел|гостиниц/.test(t)) return false;
  return /остановиться|где жить|жиль[её]|отел|гостиниц|на \d+ ноч/.test(t);
}

function isPriceFollowUp(text: string): boolean {
  const t = norm(text);
  if (/сколько\s+(это\s+|он[аи]?\s+|они\s+)?стоит/.test(t)) return true;
  // «первый вопрос» — не ссылка на прошлый список. Нужен номер варианта.
  const ordinal = /перв(ый|ого|ая|ое|ым)|втор(ой|ого|ая|ым)|трет(ий|ьего|ья|ьим)/.test(t);
  return ordinal && /вариант|из них|из списка|пункт/.test(t);
}

/**
 * Вопрос к витрине туров. Упоминание вулкана само по себе — про место
 * и безопасность, его отвечает модель с get_guardian_context.
 * Вопрос о безопасности и обстановке («какие опасности на Авачинском»,
 * «какие вулканы извергаются») — тоже не витрина: то же правило, что у
 * карточек сайта (`wantsTourCards` зовёт `isSafetyOrSituationAsk`, находка 24.10).
 *
 * Сборщик не шире правила карточек: `composeTours` судит списком
 * `pickToursForAnswer`, а тот отвечает «не про тур», когда `wantsTourCards`
 * говорит «нет». Тогда сборщик печатал «В каталоге нет тура под этот запрос»
 * при живом туре в каталоге (ревью 25.10: «какие восхождения есть, хочу
 * поехать»). Не вопрос к витрине по общему правилу — отвечает модель.
 */
function asksTourOffer(text: string): boolean {
  if (!wantsTourCards(text)) return false;
  if (isSightseeingQuestion(text)) return true;
  const t = norm(text);
  if (/(?<![а-яе])тур(?!ист)|экскурс/.test(t)) return true;
  const activity = /вулкан|рыбалк|восхожд|поход|экскурс/.test(t);
  if (/списком|с ценами/.test(t) && activity) return true;
  if (/какие\s/.test(t) && /тур|вулкан|рыбалк|восхожд|поход|экскурс/.test(t)) return true;
  return false;
}

/**
 * «Хочу тур …» у вошедшего туриста ведёт агент брони с инструментами.
 * Список «какие / списком / с ценами» и «что посмотреть» — нет: их пишет
 * сборщик витрины, иначе карточки снова расходятся с текстом.
 */
export function bookingAgentOwns(text: string): boolean {
  if (isCarRentalAsk(text) || isSightseeingQuestion(text)) return false;
  const t = norm(text);
  if (/списком|с ценами|какие\s|подобрать/.test(t)) return false;
  if (!/хочу|заброн|запис|брон/.test(t)) return false;
  return /(?<![а-яе])тур(?!ист)|вулкан|экскурс|поход|рыбалк/.test(t);
}

function asksNewList(text: string): boolean {
  return /какие\s|списком|покажи|нужен|нужна|хочу|где остановиться/.test(norm(text));
}

function ordinal(text: string): number | null {
  const t = norm(text);
  if (/перв/.test(t)) return 1;
  if (/втор/.test(t)) return 2;
  if (/трет/.test(t)) return 3;
  return null;
}

function topicHint(text: string): CommercialTopic | null {
  if (isCarRentalAsk(text)) return 'rental';
  if (isTransferAsk(text)) return 'transfer';
  if (isLodgingAsk(text)) return 'lodging';
  if (/тур/.test(norm(text))) return 'tour';
  return null;
}

export function parseShownLists(history: string): Array<{ topic: CommercialTopic; offers: ShownOffer[] }> {
  const lists: Array<{ topic: CommercialTopic; offers: ShownOffer[] }> = [];
  let current: { topic: CommercialTopic; offers: ShownOffer[] } | null = null;
  for (const raw of history.split('\n')) {
    const line = raw.trim();
    const head = HEADS.find(([re]) => re.test(line));
    if (head) {
      if (current) lists.push(current);
      current = { topic: head[1], offers: [] };
      continue;
    }
    if (!current) continue;
    const item = /^- (.+?) — (.+?) — (https:\/\/\S+)/.exec(line);
    if (item) {
      current.offers.push({
        topic: current.topic,
        title: item[1],
        priceText: item[2],
        url: item[3].replace(/[.,)]+$/, ''),
      });
      continue;
    }
    if (line === '') {
      lists.push(current);
      current = null;
    }
  }
  if (current) lists.push(current);
  return lists;
}

function whoFor(topic: CommercialTopic): string {
  if (topic === 'transfer' || topic === 'rental') return 'перевозчику';
  if (topic === 'lodging') return 'владельцу жилья';
  return 'оператору';
}

function pdLine(surface: CommercialSurface): string {
  if (surface === 'telegram') {
    return 'Имя и телефон в этот чат не пишите: их принимают только форма на сайте или MAX, с согласием.';
  }
  if (surface === 'max') {
    return 'Имя и телефон — в форме на сайте или здесь, в MAX, с согласием. Сам я заявку не отправляю.';
  }
  return 'Имя и телефон — в форме на сайте, с согласием. Сам я заявку не отправляю.';
}

/**
 * Предложение отправить запрос. В Telegram из этой строки делается кнопка
 * с тем же адресом. Заявку создаёт форма на сайте (карточка тура, форма
 * перевозчика, карточка жилья) или MAX — с именем, телефоном и согласием.
 * Чат сам строку заявки не пишет и кнопки ответа партнёра не рисует.
 */
export function requestCta(who: string, url: string, surface: CommercialSurface): string {
  return `Отправить запрос ${who}: ${url}. ${pdLine(surface)} Запрос появится у партнёра, когда форма отправлена.`;
}

/**
 * Призыв, когда туров несколько (слово владельца 29.10): кнопка ведёт не на
 * первый тур — его выбрал бы порядок, а не человек, — а туда, где все туры
 * рядом: на «Туры к этому месту» карточки места или в каталог.
 */
export const CHOOSE_TOUR_CTA = 'Выбрать тур и отправить запрос';

export function chooseTourCta(url: string, surface: CommercialSurface): string {
  return `${CHOOSE_TOUR_CTA}: ${url}. ${pdLine(surface)} Запрос появится у партнёра, когда форма отправлена.`;
}

/** Кнопка под ответом в Telegram. Нет строки «Отправить запрос» — кнопки нет. */
export function requestButton(text: string): { text: string; url: string } | null {
  const match = /(Отправить запрос [^:\n]+|Выбрать тур и отправить запрос): (https:\/\/\S+)/.exec(text);
  if (!match) return null;
  const label = match[1].trim().slice(0, 64);
  const url = match[2].replace(/[),.;]+$/, '');
  if (!/^https:\/\/vedarai\.ru\//.test(url)) return null;
  return { text: label, url };
}

export function dedupeParagraphs(text: string): string {
  const parts = text.split(/\n{2,}/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.join('\n\n');
}

function todayLine(now: Date): string {
  const day = calendarDay(now);
  return `Сегодня ${ruDate(day.iso) ?? day.iso} по Камчатке.`;
}

function touristPrice(tour: CatalogTour): string {
  const labeled = priceFromUnit(tour.base_price, tour.price_unit);
  if (!labeled) return 'цена не указана';
  return labeled.replace(
    ' (за что назначена цена — не записано, не называй её ценой с человека)',
    ' (за что назначена цена — не записано)',
  );
}

function joinUrl(base: string, path: string): string {
  const root = base.replace(/\/$/, '');
  return `${root}${path.startsWith('/') ? path : `/${path}`}`;
}

function peopleCount(text: string): number | null {
  const m = /(\d{1,2})\s*человек/.exec(norm(text));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 30 ? n : null;
}

function nightCount(text: string): number | null {
  const m = /(\d{1,2})\s*ноч/.exec(norm(text));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 30 ? n : null;
}

function placeNeedles(text: string): string[] {
  const t = norm(text);
  const out: string[] = [];
  if (t.includes('елизов')) out.push('елизов');
  if (t.includes('петропавловск')) out.push('петропавловск');
  if (t.includes('паратунк')) out.push('паратунк');
  return out;
}

function boardFor(topic: CommercialTopic, base: string): string {
  if (topic === 'transfer' || topic === 'rental') return joinUrl(base, '/transfers');
  if (topic === 'lodging') return joinUrl(base, '/accommodations');
  return joinUrl(base, '/catalog');
}

function topicWord(topic: CommercialTopic): string {
  if (topic === 'lodging') return 'жильё';
  if (topic === 'transfer') return 'трансфер';
  if (topic === 'rental') return 'прокат';
  return 'туры';
}

function offeringLine(text: string, input: ComposeInput): string {
  if (!input.warnings?.ok) return '';
  const notes = notesForOffering(text, input.warnings.warnings);
  return notes.length > 0 ? `\n  ${notes[0]}` : '';
}

function warningFooter(input: ComposeInput, always = true): string {
  if (!input.warnings) return '';
  if (!input.warnings.ok) return MCHS_UNREAD_NOTE;
  if (!always) return '';
  return warningDigest(input.warnings.warnings) ?? '';
}

/** Тариф «за час / за день» — цена из прайса, даже если в строке нет города. */
function isTariffLine(line: string): boolean {
  return /руб за час|руб за полн|руб за день|руб за смену/.test(norm(line));
}

function linesForTransfer(item: TransferItem, needles: string[]): string[] {
  if (needles.length === 0) return item.lines;
  const places = item.lines.filter((line) => needles.some((needle) => norm(line).includes(needle)));
  const picked = [...places];
  for (const line of item.lines) {
    if (isTariffLine(line) && !picked.includes(line)) picked.push(line);
  }
  return picked;
}

/**
 * Куда ведёт кнопка под списком туров. Тур один — на его карточку: продавца
 * выбирать не из кого. Туров несколько — не на первый: у всех одно записанное
 * главное место — на «Туры к этому месту» его карточки, иначе в каталог.
 */
function toursCta(tours: readonly CatalogTour[], base: string, catalog: string, surface: CommercialSurface): string {
  if (tours.length === 1) return requestCta('оператору', joinUrl(base, tourPath(tours[0])), surface);
  const ref = tours[0]?.main_place_ref ?? null;
  const samePlace = ref !== null && tours.every((t) => t.main_place_ref === ref);
  return chooseTourCta(samePlace ? joinUrl(base, `/places/${encodeURIComponent(ref)}#tours`) : catalog, surface);
}

function composeTours(input: ComposeInput): CommercialAnswer {
  const picked = pickToursForAnswer(input.question, input.tours, input.now);
  const catalog = joinUrl(input.base, '/catalog');
  if (picked.kind !== 'list') {
    const line = picked.line || 'В каталоге нет тура под этот запрос. Цену не называю.';
    const ask = picked.nearest.length === 1
      ? joinUrl(input.base, tourPath(picked.nearest[0]))
      : catalog;
    return {
      visible: dedupeParagraphs([
        todayLine(input.now),
        `Туры из каталога:\n${line}`,
        requestCta('оператору', ask, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  const lines = picked.tours.map((tour) => {
    const url = joinUrl(input.base, tourPath(tour));
    const flag = offeringLine(`${tour.title} ${tour.location_name ?? ''}`, input);
    // Компания — в каждой строке: туры к одному месту продают разные компании (29.10).
    return `- ${tour.title} — ${tour.operator_name ?? 'компания не записана'} — ${touristPrice(tour)} — ${url}${flag}`;
  });
  const more = picked.unnamedMore > 0
    ? `Ещё ${picked.unnamedMore} на эти даты в каталоге. Названия и цены здесь не повторяю: ${catalog}`
    : '';
  const head = `Туры из каталога на ${picked.windowLabel ? seasonAccusative(picked.windowLabel) : 'сегодня'}:`;
  // Какие туры попали в список, решило правило 1в — оно названо (§0, ревью
  // 29.10). Один тур без «ещё» — выбирать было не из чего, подписи нет.
  const order = picked.tours.length > 1 || picked.unnamedMore > 0 ? OFFER_ORDER_NOTE_SHORT_RU : '';
  return {
    visible: dedupeParagraphs([
      todayLine(input.now),
      [head, ...lines, more, order, warningFooter(input)].filter(Boolean).join('\n'),
      toursCta(picked.tours, input.base, catalog, input.surface),
    ].join('\n\n')),
    tours: picked.tours,
  };
}

function composeTransfers(input: ComposeInput): CommercialAnswer {
  const board = joinUrl(input.base, '/transfers');
  if (!input.transfers.ok) {
    return {
      visible: dedupeParagraphs([
        todayLine(input.now),
        'Трансфер из прайса:\nПрайс трансфера сейчас не прочитан. Цену и перевозчика не называю.',
        requestCta('перевозчику', board, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  const hidden = input.pauseActive ? new Set(input.pauseSlugs) : new Set<string>();
  const visible = input.transfers.items.filter((item) => !hidden.has(item.slug));
  if (visible.length === 0) {
    const hiddenOnly = input.transfers.items.length > 0;
    const line = hiddenOnly
      ? `${rentalPauseForTourist()} Перевозчика, которого сайт сейчас прячет, в этот ответ не ставлю.`
      : 'Перевозчиков с прайсом под заказ на платформе нет. Цену не называю.';
    // Пауза уже содержит ссылку на /transfers. Вторая фраза с тем же адресом
    // снова даёт два текста на один вопрос.
    const tail = hiddenOnly ? [] : [requestCta('перевозчику', board, input.surface)];
    return {
      visible: dedupeParagraphs([todayLine(input.now), `Трансфер из прайса:\n${line}`, ...tail].join('\n\n')),
      tours: [],
    };
  }
  const needles = placeNeedles(input.question);
  const lines: string[] = [];
  for (const item of visible) {
    if (lines.length >= 8) break;
    const picked = linesForTransfer(item, needles);
    if (picked.length === 0) {
      lines.push(`- ${item.name} — направления из вопроса в прайсе нет, цену не подставляю — ${item.url}`);
      continue;
    }
    for (const price of picked) {
      if (lines.length >= 8) break;
      lines.push(`- ${item.name} — ${price} — ${item.url}${offeringLine(`${item.name} ${price}`, input)}`);
    }
  }
  const people = peopleCount(input.question);
  const perCar = people
    ? `Цена за машину целиком, не за человека. На ${people} человек отдельной цены в прайсе нет — сумму не считаю.`
    : 'Цена за машину целиком, не за место и не за человека.';
  const more = visible.length > 8
    ? `Ещё ${visible.length - 8} перевозчиков не называю. Витрина: ${board}`
    : '';
  const priced = visible.filter((item) => linesForTransfer(item, needles).length > 0);
  const ctaUrl = priced.length === 1 ? priced[0].url : board;
  return {
    visible: dedupeParagraphs([
      todayLine(input.now),
      ['Трансфер из прайса:', ...lines, more, warningFooter(input)].filter(Boolean).join('\n'),
      perCar,
      requestCta('перевозчику', ctaUrl, input.surface),
    ].join('\n\n')),
    tours: [],
  };
}

function composeStays(input: ComposeInput): CommercialAnswer {
  const board = joinUrl(input.base, '/accommodations');
  if (!input.stays.ok) {
    return {
      visible: dedupeParagraphs([
        todayLine(input.now),
        'Жильё из витрины:\nВитрину жилья сейчас не прочитал. Цену и объект не называю.',
        requestCta('владельцу жилья', board, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  const needles = placeNeedles(input.question);
  const pool = needles.length === 0
    ? input.stays.items
    : input.stays.items.filter((item) => {
      const hay = norm(`${item.name} ${item.zone ?? ''}`);
      return needles.some((needle) => hay.includes(needle));
    });
  if (pool.length === 0) {
    const where = needles.includes('паратунк') ? 'по Паратунке' : 'по этому запросу';
    return {
      visible: dedupeParagraphs([
        todayLine(input.now),
        `Жильё из витрины:\nВ витрине жилья ${where} ничего нет. Другое место и тур из другого списка вместо него не подставляю. Цену не называю.`,
        requestCta('владельцам жилья', board, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  const shown = pool.slice(0, 8);
  const stayCta = shown.length === 1 ? shown[0].url : board;
  const lines = shown.map((item) => {
    const flag = offeringLine(`${item.name} ${item.zone ?? ''}`, input);
    return `- ${item.name} — ${item.priceText ?? 'цена не указана'} — ${item.url}${flag}`;
  });
  const nights = nightCount(input.question);
  const perNight = nights
    ? `Цена — за сутки, как в витрине. Сумму за ${nights} ночи не считаю.`
    : 'Цена — за сутки, как в витрине. Сумму за несколько ночей не считаю.';
  const springs = shown.some((item) => item.mentionsSprings)
    ? 'Про горячие источники сказано только у тех объектов, где это есть в строке витрины.'
    : 'Про горячие источники в этих строках витрины не записано — не добавляю.';
  const more = pool.length > shown.length
    ? `Ещё ${pool.length - shown.length} не называю. Витрина: ${board}`
    : '';
  return {
    visible: dedupeParagraphs([
      todayLine(input.now),
      ['Жильё из витрины:', ...lines, more, warningFooter(input, lines.some((l) => l.includes('МЧС:')))].filter(Boolean).join('\n'),
      perNight,
      springs,
      requestCta('владельцу жилья', stayCta, input.surface),
    ].join('\n\n')),
    tours: [],
  };
}

function composeRental(input: ComposeInput): CommercialAnswer {
  const line = touristRentalText(input.now);
  // Пауза уже содержит одну ссылку на перевозчиков. Вторая фраза
  // «Отправить запрос» с тем же адресом — это второе сообщение другим текстом.
  if (input.pauseActive) {
    return {
      visible: dedupeParagraphs([todayLine(input.now), line].join('\n\n')),
      tours: [],
    };
  }
  const url = joinUrl(input.base, '/car-rental');
  return {
    visible: dedupeParagraphs([todayLine(input.now), line, requestCta('перевозчику', url, input.surface)].join('\n\n')),
    tours: [],
  };
}

/**
 * Один ответ в Telegram, если пауза проката уже сказана.
 * Повтор того же абзаца и вторая формулировка с той же ссылкой /transfers
 * не уходят. Кабинет проката эта функция не читает.
 */
export function collapseRepeatedReply(text: string): string {
  const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const seen = new Set<string>();
  let pauseKept = false;
  const out: string[] = [];
  for (const part of parts) {
    const key = part.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    if (pauseKept && /vedarai\.ru\/transfers/.test(part) && /Отправить запрос|не показывается|прокат/i.test(part)) {
      continue;
    }
    if (/не показывается/.test(part)) pauseKept = true;
    seen.add(key);
    out.push(part);
  }
  return out.join('\n\n');
}

/**
 * Строка списка с ценой становится ссылкой на карточку.
 * Цена в пункте без адреса vedarai.ru не отправляется.
 */
export function telegramOfferLinks(text: string): string {
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    const item = /^- (.+?) — (.+?) — (https:\/\/vedarai\.ru\/\S+)/.exec(trimmed);
    if (item) {
      const url = item[3].replace(/[),.;]+$/, '');
      return `- <a href="${url}">${escapeHtml(item[1])}</a> — ${escapeHtml(item[2])}`;
    }
    if (/^- /.test(trimmed) && /₽|руб/i.test(trimmed) && !/https:\/\/vedarai\.ru\//.test(trimmed)) {
      return '- цена без карточки каталога не названа';
    }
    return line;
  }).join('\n');
}

function composeFollowUp(input: ComposeInput): CommercialAnswer {
  const lists = parseShownLists(input.history);
  const hint = topicHint(input.question);
  const same = hint ? lists.filter((list) => list.topic === hint) : lists;
  const last = same.length > 0 ? same[same.length - 1] : null;
  const board = joinUrl(input.base, '/catalog');
  if (!last) {
    return {
      visible: dedupeParagraphs([
        'Не вижу списка, к которому это относится. Напишите, что смотреть: тур, трансфер, жильё или прокат. Цену наугад не беру.',
        requestCta('оператору', board, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  const who = last.offers.length === 0 && last.topic === 'lodging'
    ? 'владельцам жилья'
    : whoFor(last.topic);
  const topicBoard = boardFor(last.topic, input.base);
  if (last.offers.length === 0) {
    return {
      visible: dedupeParagraphs([
        `В прошлом ответе тема — ${topicWord(last.topic)}, и варианта с ценой там не было. Более ранний список другой темы не беру. Если речь о нём — напишите, о каком.`,
        requestCta(who, topicBoard, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  const n = ordinal(input.question);
  if (n === null && last.offers.length > 1) {
    return {
      visible: dedupeParagraphs([
        'В прошлом ответе несколько вариантов, и неясно, какой считать. Назовите номер или название. Цену наугад не беру.',
        requestCta(who, topicBoard, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  const index = n === null ? 0 : n - 1;
  const offer = last.offers[index];
  if (!offer) {
    return {
      visible: dedupeParagraphs([
        `В прошлом списке нет варианта номер ${n}. Цену наугад не беру.`,
        requestCta(who, last.offers[0]?.url ?? board, input.surface),
      ].join('\n\n')),
      tours: [],
    };
  }
  return {
    visible: dedupeParagraphs([
      `В прошлом списке это «${offer.title}»: ${offer.priceText}.`,
      `Карточка: ${offer.url}`,
      requestCta(who, offer.url, input.surface),
    ].join('\n\n')),
    tours: [],
  };
}

/**
 * Что читать из витрины, прежде чем собирать ответ.
 * Те же признаки, что у сборщика: «где жить» и «что посмотреть» не должны
 * получать пустой список, который ещё не смотрели в базе.
 */
export function commercialSources(question: string): {
  tours: boolean;
  transfers: boolean;
  stays: boolean;
  stayZones: string[];
} {
  if (detectEmergency(question).detected) {
    return { tours: false, transfers: false, stays: false, stayZones: [] };
  }
  const follow = isPriceFollowUp(question) && !asksNewList(question);
  if (follow || isCarRentalAsk(question)) {
    return { tours: false, transfers: false, stays: false, stayZones: [] };
  }
  const stays = isLodgingAsk(question);
  return {
    tours: asksTourOffer(question),
    transfers: isTransferAsk(question),
    stays,
    stayZones: stays ? placeNeedles(question) : [],
  };
}

export function composeCommercial(input: ComposeInput): CommercialAnswer | null {
  if (detectEmergency(input.question).detected) return null;
  const follow = isPriceFollowUp(input.question) && !asksNewList(input.question);
  if (isCarRentalAsk(input.question) && !follow) return composeRental(input);
  if (isTransferAsk(input.question) && !follow) return composeTransfers(input);
  if (isLodgingAsk(input.question) && !follow) return composeStays(input);
  if (asksTourOffer(input.question) && !follow) return composeTours(input);
  if (follow) return composeFollowUp(input);
  return null;
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

function sourceHasAmount(source: string, amount: string): boolean {
  if (!amount) return false;
  const compact = source.replace(/[\s\u00a0\u202f]/g, '');
  let from = 0;
  while (from <= compact.length) {
    const at = compact.indexOf(amount, from);
    if (at < 0) return false;
    const before = compact[at - 1] ?? '';
    const after = compact[at + amount.length] ?? '';
    if (!/\d/.test(before) && !/\d/.test(after)) return true;
    from = at + 1;
  }
  return false;
}

function sourceHasRange(source: string, left: string, right: string): boolean {
  const compact = source.replace(/[\s\u00a0\u202f]/g, '');
  return new RegExp(`${left}.{0,16}(?:до|–|—|-)${right}`).test(compact);
}

/**
 * Убирает цену, которой нет в источнике этого хода, и любую вилку-ориентир.
 * Диапазон остаётся, только если та же пара чисел уже стоит в источнике
 * через «до» или тире — так записана витрина, а не оценка.
 */
export function dropUnsourcedPrices(answer: string, source: string): { text: string; dropped: boolean } {
  let dropped = false;
  const kept = answer.split('\n').flatMap((line) => {
    if (/ориентир|вилк/i.test(line) && /\d{3,}|₽|руб/i.test(line)) {
      dropped = true;
      return [];
    }
    const range = /(\d[\d\s\u00a0\u202f]{0,14})\s*[–—-]\s*(\d[\d\s\u00a0\u202f]{0,14})\s*(?:₽|руб)/i.exec(line);
    if (range && !sourceHasRange(source, digitsOf(range[1]), digitsOf(range[2]))) {
      dropped = true;
      return [];
    }
    for (const amount of line.matchAll(/(\d[\d\s\u00a0\u202f]{0,14})\s*(?:₽|руб)/gi)) {
      if (!sourceHasAmount(source, digitsOf(amount[1] ?? ''))) {
        dropped = true;
        return [];
      }
    }
    return [line];
  });
  let text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (dropped) text = `${text}\n\nЦену, которой нет в данных этого ответа, не называю.`.trim();
  return { text, dropped };
}

/** Числа рублей в тексте — для проверки, что лишних нет. */
export function rubleAmounts(text: string): number[] {
  const out: number[] = [];
  for (const amount of text.matchAll(/(\d[\d\s\u00a0\u202f]{0,14})\s*(?:₽|руб)/gi)) {
    const n = Number(digitsOf(amount[1] ?? ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
