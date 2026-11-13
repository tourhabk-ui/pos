/**
 * lib/requests/answer-notice-text.ts — слова сообщения после ответа
 * туроператора кнопкой (план «после отказа», этап 2б; слово владельца 11.11).
 *
 * Три адресата, без базы:
 *  - человеку — что ответил оператор и что можно сделать дальше; ПД нет
 *    (тур, дата, число людей, вывеска оператора), текст один для MAX и
 *    Telegram;
 *  - менеджеру Ведара, когда до человека не дошло, — с именем и телефоном
 *    (только в `text` sendPdAlert, то есть в MAX), заглушка без ПД;
 *  - оператору — что ушло человеку на самом деле.
 *
 * Отказ по погоде или безопасности (слово владельца 11.11, вопрос 3): замену
 * предлагать можно только проверенную — «проверка обстановки и места, а не
 * догадка», и с объяснением, почему замена. С этапа 2в после такого отказа
 * даты называются, только когда данные Ведара сами видят причину отказа на
 * дату заявки (она и есть объяснение замены), и только прошедшие ту же
 * проверку целиком (lib/trips/date-check). Рядом сказано, что проверено «на
 * дату», а что «на сейчас»; что не названо и почему — тоже. Непроверенная дата
 * не называется никогда: блок дат другого рода (`dates`) после такого отказа
 * молчит. Слово «безопасно» не говорится ни о чём, и слов «опасного не видно»
 * о дате отказа нет: Ведар говорит, что причина отказа в его данных не
 * отражена, а не спорит с оператором.
 *
 * Другие компании (этап 4а; слова владельца 11.11: «передавать другим — да»,
 * «карт-бланш по плану»): после «Нет мест» и отказа не по погоде человеку
 * называются компании, чьи туры идут к тому же месту и могут принять на его
 * дату (lib/requests/other-offers). Это не ответ этих компаний и не передача
 * заявки: имя и телефон никому не уходят, заявку человек оставляет сам по
 * ссылке. После отказа по погоде или безопасности блока нет — то же место в
 * тот же день; после «предложит другую дату» и у большой группы, которую уже
 * видят другие операторы, — тоже.
 *
 * Машина целиком и прокат (этап 2б-2, слово владельца 12.11 «1 да»): после
 * «Не могу» перевозчика или прокатчика заказчик получает одно сообщение от
 * Ведара — что ответил партнёр и где смотреть других. Обещания «менеджер
 * свяжется» в нём нет: система его не отслеживала — заявка закрывалась как
 * отказ, и напомнить менеджеру было нечем. Направление заявки на машину —
 * свободный ввод заказчика (там бывает адрес или имя): в Telegram вызывающий
 * его не отдаёт вовсе (`vehicleTitleHidden`), здесь оно экранируется как есть.
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { DECLINE_REASON_LABEL, type DeclineReason } from '@/lib/requests/chat-answer-buttons';
import { myTripDateMenuPayload, myTripDatePickPayload } from '@/lib/requests/my-trip-ask';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { SITUATION_FORECAST_DAYS } from '@/lib/trips/situation';
import type { DateCheck } from '@/lib/trips/date-check';
import { PLACE_COLOR_WORD } from '@/lib/safety/place-day-status';
import { OFFER_ORDER_NOTE_ON_DATE_RU } from '@/lib/tours/offer-order';
import { plural } from '@/lib/home/data-freshness';
import {
  otherOfferMoreToursWords, otherOfferSeatsWords, otherOffersMoreCompaniesWords, otherOffersNoteWords,
} from '@/lib/requests/other-offers-words';

export type NoticeAnswer = 'no_seats' | 'decline' | 'other_date';

/** Род заявки: тур, машина целиком у перевозчика или прокат без водителя. */
export type NoticeKind = 'tour' | 'charter' | 'rental';

/** Кому сообщение о заявке: у тура — турист, у машины и проката — заказчик. */
export type NoticePerson = 'tourist' | 'client';

export function personOf(kind: NoticeKind | undefined): NoticePerson {
  return kind === 'charter' || kind === 'rental' ? 'client' : 'tourist';
}

/** Факты заявки для слов — без имени и телефона. */
export interface NoticeFacts {
  leadId: string;
  /** Не задан — тур (так строки писались до 2б-2). */
  kind?: NoticeKind;
  /**
   * Машина проката (название из прайса прокатчика) или направление заявки на
   * машину — свободный ввод заказчика.
   */
  vehicleTitle?: string | null;
  /** Направление есть, но в этот канал не отдаётся (Telegram): так и сказано, а не «не названо». */
  vehicleTitleHidden?: boolean;
  /** Даты заявки на машину или прокат, ISO; не той формы — не показываются. */
  vehicleFrom?: string | null;
  vehicleTo?: string | null;
  /** Где смотреть других перевозчиков или другие машины проката — полный адрес. */
  offersUrl?: string | null;
  answer: NoticeAnswer;
  reason: DeclineReason | null;
  tourTitle: string | null;
  /** Полный адрес карточки тура; null — тура на витрине нет или не записан. */
  tourUrl: string | null;
  /** Дата заявки, ISO; null — не записана. */
  date: string | null;
  people: number | null;
  operatorName: string | null;
  /** Большая группа, которую после отказа увидят другие операторы (followup-scope). */
  groupPassedOn: boolean;
}

/** Свободные даты рядом — что удалось узнать. */
export type DatesBlock =
  | { kind: 'dates'; dates: string[] }
  | { kind: 'none' }
  | { kind: 'no_calendar' }
  | { kind: 'failed' }
  /**
   * После отказа «погода или безопасность» (2в): чем кончилась проверка
   * (lib/trips/date-check) и какие даты называются — только прошедшие её
   * целиком и только когда данные Ведара видят причину отказа. `refused` —
   * сколько свободных дат рядом не проверялось из-за прежнего отказа по погоде.
   */
  | { kind: 'checked'; check: DateCheck; dates: string[]; refused?: number }
  /**
   * Все свободные даты рядом — с прежним отказом по погоде или безопасности
   * (в любой заявке на этот тур): в календаре они свободны, но «проверенными»
   * их не называем, и проверка не запускалась.
   */
  | { kind: 'weather_refused'; count: number }
  /** Блока нет по смыслу ответа: большая группа, «не подходит группа», тура нет на витрине. */
  | { kind: 'skip' };

/** Строка списка других компаний: компания и её тур, который может принять на дату. */
export interface OfferLine {
  partnerName: string;
  title: string;
  /** Цена словами с единицей; null — не записана. */
  price: string | null;
  /** `calendar` — в календаре на дату хватает мест; `by_request` — календаря нет, дату подтверждает оператор. */
  seats: 'calendar' | 'by_request';
  /** Полный адрес формы заявки тура с датой и числом людей. */
  url: string;
  /** Сколько ещё туров этой компании к месту могут принять на дату. */
  moreTours: number;
  /** Компания сама ответила Ведару «Беру» по этой заявке (этап 4б); нет поля или null — не отвечала. */
  said?: 'take' | null;
}

/** Другие компании к тому же месту на дату заявки — что удалось узнать (lib/requests/other-offers). */
export type OffersBlock =
  | { kind: 'offers'; placeName: string; placeUrl: string; offers: OfferLine[]; more: number }
  /** Главного места у тура нет, других компаний к нему нет или никто не может на эту дату. */
  | { kind: 'none' }
  /** Не прочиталось: в сообщении блока нет, отказ — в логе. */
  | { kind: 'failed' }
  /** Блока нет по смыслу ответа (answerWantsOffers) или у заявки нет тура и даты. */
  | { kind: 'skip' };

/**
 * Письмо менеджеру: в MAX с телефоном, заглушкой в Telegram, никуда не дошло —
 * или не нужно: пока оно ждало повтора, заявка переросла этот ответ.
 */
export type ManagerChannel = 'max' | 'telegram-stub' | 'none' | 'not_needed';

/**
 * Коды ноги ИИ-агента, при которых уведомление ему НЕ уходило — отказ на
 * нашей стороне, а не его. Всё остальное после `agent:` — код его приёмника
 * (http_503, timeout, dns_failed…): запрос дошёл, и он не принял.
 */
export const AGENT_NOT_SENT_CODES = [
  'no_change', 'no_encryption', 'db_error', 'claimed_elsewhere', 'deferred', 'retry_later', 'no_view', 'slow', 'exception',
] as const;
export type AgentNotSentCode = (typeof AGENT_NOT_SENT_CODES)[number];

const AGENT_NOT_SENT_WORDS: Record<AgentNotSentCode, string> = {
  no_change: 'ИИ-агенту уведомление не ушло: в его виде заявки ничего не изменилось',
  no_encryption: 'ИИ-агенту уведомление не ушло: на нашей стороне нет ключа шифрования',
  db_error: 'ИИ-агенту уведомление не ушло: сбой базы',
  claimed_elsewhere: 'уведомление ИИ-агенту в эту минуту отправляла плановая сверка',
  deferred: 'уведомление ИИ-агенту отложено до следующей сверки (лимиты отправки)',
  retry_later: 'уведомление ИИ-агенту ждёт повтора по графику после прежнего отказа',
  no_view: 'ИИ-агенту уведомление не ушло: вид заявки не прочитался',
  slow: 'уведомление ИИ-агенту не уложилось в срок',
  exception: 'ИИ-агенту уведомление не ушло: сбой',
};

/** Почему не дошло — разбор кодов «куда пробовали», один для оператора и менеджера. */
export interface UndeliveredWhy {
  /** Отправка несколько раз обрывалась сбоем (добивка сдалась): куда дошло — неизвестно. */
  broken: boolean;
  /** Чатов не было — или ни один не принял. */
  chat: 'none' | 'refused';
  /** Подписки агента нет; его приёмник не принял; уведомление ему не уходило. */
  agent: 'none' | 'refused' | 'not_sent';
}

export function undeliveredWhy(tried: readonly string[]): UndeliveredWhy {
  const agent = tried.find((t) => t.startsWith('agent:'))?.slice(6);
  return {
    broken: tried.includes('retry_exhausted'),
    chat: tried.some((t) => t.startsWith('max:') || t.startsWith('telegram:')) ? 'refused' : 'none',
    agent: agent === undefined ? 'none' : (AGENT_NOT_SENT_CODES as readonly string[]).includes(agent) ? 'not_sent' : 'refused',
  };
}

/** Чем кончился блок дат после отказа по погоде: исход проверки или «по всем датам рядом уже отказывали». */
export type WeatherDatesOutcome = DateCheck['state'] | 'weather_refused';

/** Чем кончилось сообщение человеку — для оператора и менеджера. */
export type NoticeOutcome =
  | {
    state: 'delivered'; via: 'max' | 'telegram' | 'agent_webhook' | 'agent_read' | 'page_seen'; dates: string[];
    /**
     * После отказа по погоде или безопасности (2в): чем кончилась проверка дат.
     * С `confirmed` даты в `dates` — прошедшие проверку, а не просто свободные;
     * с остальным дат нет, и оператору сказано почему.
     */
    check?: WeatherDatesOutcome;
    /** Сколько других компаний названо человеку (этап 4а); нет поля — ни одной. */
    offers?: number;
  }
  | { state: 'undelivered'; manager: ManagerChannel; why: UndeliveredWhy }
  | { state: 'skipped'; reason: 'lead_closed' | 'not_addressee' | 'self' | 'outgrown' }
  /**
   * Не решено. `sending` — отправка идёт прямо сейчас (строку держит захват
   * нажатия); без него — сбой посреди отправки, повторит добивка.
   */
  | { state: 'pending'; sending?: boolean };

export function ruDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** «13.01, 14.01»; год — если он не тот, что у даты заявки. */
export function datesLine(dates: readonly string[], around: string | null): string {
  const year = around?.slice(0, 4) ?? null;
  return dates.map((d) => (d.slice(0, 4) === year ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : ruDay(d))).join(', ');
}

/** Точка в конце, если её ещё нет («…, 3 чел.» кончается своей). */
const endDot = (line: string) => (line.endsWith('.') ? line : `${line}.`);

const who = (f: NoticeFacts) => (f.operatorName ? `Оператор «${escapeHtml(f.operatorName)}»` : 'Оператор');

function head(f: NoticeFacts): string {
  const parts = [
    f.tourTitle ? `Тур «${escapeHtml(f.tourTitle)}»` : 'Заявка на тур',
    f.date ? ruDay(f.date) : null,
    f.people && f.people > 0 ? `${f.people} чел.` : null,
  ].filter(Boolean);
  // «3 чел.» уже кончается точкой: вторая не ставится.
  return `<b>Ответ по вашей заявке</b>\n${endDot(parts.join(', '))}`;
}

/** Есть ли у ответа блок дат по смыслу. */
export function answerWantsDates(f: Pick<NoticeFacts, 'answer' | 'reason' | 'groupPassedOn'>): boolean {
  if (f.groupPassedOn) return false;
  if (f.answer === 'decline') return f.reason !== 'group';
  return true;
}

/** Отказ «погода или безопасность»: даты — только проверенные (2в). */
export function isWeatherDecline(f: Pick<NoticeFacts, 'answer' | 'reason'>): boolean {
  return f.answer === 'decline' && f.reason === 'weather';
}

/** Что проверяется у даты после отказа по погоде — коротко, менеджеру. Зоны здесь нет: она входит в проверку не у каждого тура. */
export const DATE_CHECK_SHORT = 'прогноз на дату, уже выпущенные предупреждения по главному месту, статус места на сейчас';

/**
 * Что именно проверено — по тому, что входило в проверку этого тура, а не
 * общим списком. «На дату» и «на сейчас» названы порознь: статус места и
 * оценка зоны о дате не говорят. Предупреждения — «уже выпущенные» и «по
 * главному месту»: на дни вперёд их могли ещё не выпустить, а чужое место в
 * проверку не входит (ревью 2в).
 */
export function dateCheckWords(c: { place: string; zoneAssessed: boolean }): string {
  const place = `«${escapeHtml(c.place)}»`;
  return `прогноз погоды на дату и уже выпущенные официальные предупреждения по главному месту тура (${place}); `
    + `статус места${c.zoneAssessed ? ' и оценка опасности зоны' : ''} — на сейчас`;
}

const WEATHER_NO_OFFER = 'Других дат не предлагаю';
const ASK = 'о дате можно спросить здесь, в чате';
/** Прогноз — на сегодня и ещё несколько дней: «суток», чтобы число не требовало склонения. */
const FORECAST_SPAN = `Прогноз есть только на ${SITUATION_FORECAST_DAYS} суток, считая сегодня`;
/** Когда проверки нет вовсе: тура нет на витрине или в заявке нет даты. */
const WEATHER_NO_BLOCK = `${WEATHER_NO_OFFER}: назвать можно только проверенную по прогнозу и предупреждениям, а для этой заявки такой проверки нет. О дате можно спросить здесь, в чате.`;

/** Что данные Ведара называют опасным на дату заявки — не больше трёх пунктов, чужой текст экранирован. */
function risksWords(risks: readonly string[]): string {
  const shown = risks.slice(0, 3).map((r) => escapeHtml(r.length > 200 ? `${r.slice(0, 199)}…` : r));
  return shown.join('; ') + (risks.length > shown.length ? ` и ещё ${risks.length - shown.length}` : '');
}

/** Заголовки предупреждений — не больше трёх, в кавычках; чужой текст экранирован и обрезан. */
function titlesWords(titles: readonly string[]): string {
  const shown = titles.slice(0, 3).map((t) => `«${escapeHtml(t.length > 200 ? `${t.slice(0, 199)}…` : t)}»`);
  return shown.join(', ') + (titles.length > shown.length ? ` и ещё ${titles.length - shown.length}` : '');
}

const operatorContacts = (f: NoticeFacts) => (f.tourUrl ? `: контакты на странице тура ${f.tourUrl}` : '');

const ZONE_LEVEL_WORD: Record<'high' | 'critical', string> = { high: 'высокая', critical: 'критическая' };

/** «уже был отказ по погоде — 2»: свободные даты рядом, которые не проверялись из-за прежнего отказа. */
const refusedWords = (n: number) => `уже был отказ по погоде или безопасности — ${n}`;

/**
 * Даты после отказа «погода или безопасность». Называются только прошедшие
 * проверку — и только когда данные Ведара видят причину отказа; иначе сказано,
 * почему дат нет. Блок просто свободных дат (`dates`) сюда попасть не должен
 * — и если попал, даты из него не печатаются.
 */
function weatherDatesText(f: NoticeFacts, d: DatesBlock): string | null {
  switch (d.kind) {
    case 'skip':
      return null;
    case 'failed':
      return `Свободные даты сейчас не прочитались — это сбой, а не «дат нет». ${WEATHER_NO_OFFER}.`;
    case 'no_calendar':
      return 'Расписания у тура на Ведаре нет — других дат назвать не могу; спросите о них у оператора.';
    case 'none':
      return `Других свободных дат${f.people ? ` на ${f.people} чел.` : ''} в календаре тура на год вперёд нет.`;
    case 'weather_refused':
      return `${WEATHER_NO_OFFER}: по свободным датам рядом (${d.count}) уже был отказ из-за погоды или безопасности. `
        + `О других датах спросите оператора${operatorContacts(f)}.`;
    case 'dates':
      return `${WEATHER_NO_OFFER}: проверить свободные даты сейчас не удалось. Позже ${ASK}.`;
    case 'checked':
      return checkedDatesText(f, d.check, d.dates, d.refused ?? 0);
  }
}

function checkedDatesText(f: NoticeFacts, c: DateCheck, dates: readonly string[], refused: number): string {
  switch (c.state) {
    case 'no_data':
      return `${WEATHER_NO_OFFER}: у Ведара нет данных, чтобы проверить место этого тура. О других датах спросите оператора${operatorContacts(f)}.`;
    case 'past':
      return `${WEATHER_NO_OFFER}: дата заявки уже прошла, и сверить её с прогнозом нельзя. О новой дате можно спросить здесь, в чате.`;
    case 'beyond':
      return `${WEATHER_NO_OFFER}: ваша дата вне прогноза, и проверить, чем она опасна и чем от неё отличаются соседние, Ведару нечем. ${FORECAST_SPAN}; ближе к дате ${ASK}.`;
    case 'place_risk': {
      const now = c.level === 'closed' ? 'отмечено закрытым' : `в статусе ${PLACE_COLOR_WORD[c.level]}`;
      return `${WEATHER_NO_OFFER}: главное место тура «${escapeHtml(c.place)}» сейчас ${now} — пока это так, назвать другую дату проверенной нельзя. Позже ${ASK}.`;
    }
    case 'zone_risk':
      return `${WEATHER_NO_OFFER}: опасность в зоне «${escapeHtml(c.zone)}» сейчас оценена как ${ZONE_LEVEL_WORD[c.level]} — пока это так, назвать другую дату проверенной нельзя. Позже ${ASK}.`;
    case 'unchecked':
      return `${WEATHER_NO_OFFER}: проверить обстановку на вашу дату сейчас не удалось. Позже ${ASK}.`;
    case 'unconfirmed': {
      const standing = c.standing ?? [];
      // Постоянный режим на дату заявки (пропуска на дороге, класс пожарной опасности) причиной отказа по
      // погоде не называется — но и не замалчивается: что есть в данных, сказано как есть.
      if (standing.length > 0) {
        return `${WEATHER_NO_OFFER}: на вашу дату по данным Ведара ${standing.length > 1 ? 'действуют предупреждения' : 'действует предупреждение'} `
          + `${titlesWords(standing)} — причина ли это отказа, Ведар не знает (проверено: ${dateCheckWords(c)}). `
          + `Назвать другую дату проверенной по этим данным нельзя. О других датах спросите оператора${operatorContacts(f)}.`;
      }
      // Не «опасного не видно»: Ведар не спорит с оператором, а говорит, чего нет в его данных.
      return `${WEATHER_NO_OFFER}: в данных Ведара причина отказа не отражена (проверено: ${dateCheckWords(c)}) — значит, оператор знает то, чего в этих данных нет, `
        + `и назвать другую дату проверенной по ним нельзя. О других датах спросите его${operatorContacts(f)}.`;
    }
    case 'confirmed': {
      const seen = `По данным Ведара на вашу дату: ${risksWords(c.risks)}.`;
      const rest = [
        c.risk > 0 ? `с опасной погодой или действующим предупреждением — ${c.risk}` : null,
        c.beyond > 0 ? `вне прогноза — ${c.beyond}` : null,
        c.unchecked > 0 ? `проверить не удалось — ${c.unchecked}` : null,
        refused > 0 ? refusedWords(refused) : null,
      ].filter(Boolean).join(', ');
      if (dates.length > 0) {
        const page = f.tourUrl ? ` Заявку на другую дату можно оставить на странице тура: ${f.tourUrl}` : '';
        return `${seen} Вместо неё называю свободные по календарю тура, на которые Ведар сейчас не нашёл ни опасной погоды в прогнозе, ни предупреждений: ${datesLine(dates, f.date)}. `
          + `Проверено: ${dateCheckWords(c)}. Это не обещание погоды и не разрешение на выезд: прогноз меняется, выезд и места подтверждает оператор.`
          + (rest ? ` Другие свободные даты рядом не называю: ${rest}.` : '')
          + page;
      }
      if (!rest) return `${seen} Других свободных дат рядом, которые можно проверить, нет.`;
      return `${seen} ${WEATHER_NO_OFFER}: из свободных дат рядом проверку не прошла ни одна (${rest}).`
        + (c.beyond > 0 ? ` ${FORECAST_SPAN}; ближе к дате ${ASK}.` : '');
    }
  }
}

/**
 * Есть ли у ответа блок «другие компании на вашу дату» по смыслу (этап 4а).
 * Нет: у машины и проката (там свои витрины); у большой группы, которую уже
 * видят другие операторы; после «предложит другую дату» — это не отказ; после
 * отказа по погоде или безопасности — то же место в тот же день, и замену там
 * можно называть только проверенную (слово владельца 11.11, вопрос 3).
 */
export function answerWantsOffers(f: Pick<NoticeFacts, 'kind' | 'answer' | 'reason' | 'groupPassedOn'>): boolean {
  if (personOf(f.kind) === 'client') return false;
  if (f.groupPassedOn) return false;
  if (f.answer === 'other_date') return false;
  return !isWeatherDecline(f);
}

/**
 * Предел текста сообщения человеку: с запасом под пределы MAX и Telegram.
 * Блок других компаний в него обязан уложиться — сообщение об отказе важнее.
 */
export const NOTICE_TEXT_MAX = 3800;
/** Длиннее этого название тура и вывеска компании в строке списка обрезаются. */
const OFFER_NAME_CHARS = 90;

/** Обрезка по символам, а не по половинкам пар. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * Другие компании к тому же месту на дату заявки — первые `count` из блока.
 * Слов «лучше», «дешевле», «рекомендуем» нет; сказано, что это не ответ
 * компаний и что телефон получит только та, которой человек оставит заявку
 * сам; порядок назван правилом. Компании, не вошедшие в текст, названы числом.
 */
function offersText(f: NoticeFacts, o: Extract<OffersBlock, { kind: 'offers' }>, count: number): string {
  const on = f.date ? ` на ${ruDay(f.date)}` : '';
  const lines = o.offers.slice(0, count).map((x, i) => {
    const seats = otherOfferSeatsWords(x.seats, f.people, x.said ?? null);
    const more = x.moreTours > 0 ? `; ${otherOfferMoreToursWords(x.moreTours)}` : '';
    return `${i + 1}. «${escapeHtml(clip(x.partnerName, OFFER_NAME_CHARS))}» — тур «${escapeHtml(clip(x.title, OFFER_NAME_CHARS))}», `
      + `${escapeHtml(x.price ?? 'цена не указана')}; ${seats}${more}. Заявка: ${escapeHtml(x.url)}`;
  });
  const rest = o.more + (o.offers.length - count);
  return [
    `<b>К месту «${escapeHtml(clip(o.placeName, OFFER_NAME_CHARS))}»${on} — другие компании</b>`,
    ...lines,
    rest > 0 ? `${otherOffersMoreCompaniesWords(rest)} — на странице места: ${escapeHtml(o.placeUrl)}` : null,
    otherOffersNoteWords(o.offers.slice(0, count).some((x) => x.said === 'take')),
    OFFER_ORDER_NOTE_ON_DATE_RU,
  ].filter((l): l is string => !!l).join('\n');
}

/**
 * Кнопки дат — только где нажатие пройдёт: чат вправе менять дату этой
 * заявки, поездка впереди и лимит смен за сутки не исчерпан (`canPick`, то же
 * правило, что у нажатия, — myTripDatePressable), и ответ её не закрыл. После
 * «Отказать» заявка `lost`, и «Изменить дату» ответило бы «заявка закрыта»
 * (критика 11.11, п. 5).
 */
export function datesPickable(f: Pick<NoticeFacts, 'answer'>, canPick: boolean): boolean {
  return canPick && (f.answer === 'no_seats' || f.answer === 'other_date');
}

function datesText(f: NoticeFacts, d: DatesBlock, pick: boolean): string | null {
  if (isWeatherDecline(f)) return weatherDatesText(f, d);
  const page = f.tourUrl ? ` Заявку на другую дату можно оставить на странице тура: ${f.tourUrl}` : '';
  switch (d.kind) {
    case 'skip':
      return null;
    case 'failed':
      return pick
        ? 'Свободные даты сейчас не прочитались — это сбой, а не «дат нет». Позже их покажет «Моя поездка» → «Изменить дату».'
        : `Свободные даты сейчас не прочитались — это сбой, а не «дат нет».${page}`;
    case 'no_calendar':
      return 'Расписания у тура на Ведаре нет — свободных дат показать не могу; другую дату можно спросить у оператора.';
    case 'none':
      return `Других свободных дат${f.people ? ` на ${f.people} чел.` : ''} в календаре тура на год вперёд нет.`;
    // Проверенные даты — только после отказа по погоде (weatherDatesText); у других ответов такого блока нет.
    case 'checked':
    case 'weather_refused':
      return null;
    case 'dates': {
      const line = datesLine(d.dates, f.date);
      if (f.answer === 'other_date') {
        return pick
          ? `Если удобнее выбрать самому — свободные даты рядом по календарю тура: ${line}. Нажмите дату — оператор получит вашу просьбу перенести; места подтверждает он.`
          : `Свободные даты рядом по календарю тура: ${line}. Места на них подтверждает оператор.`;
      }
      return pick
        ? `Свободные даты рядом с вашей — по календарю тура на Ведаре: ${line}. Это не ответ оператора: места на них подтверждает он. Нажмите дату — она сразу встанет в заявку, и оператор получит её с кнопками ответа.`
        : `Свободные даты рядом с вашей — по календарю тура на Ведаре: ${line}. Места на них подтверждает оператор.${page}`;
    }
  }
}

function answerLine(f: NoticeFacts, d: DatesBlock): string {
  if (f.groupPassedOn) {
    return `${who(f)} не может взять всю группу${f.people ? ` (${f.people} чел.)` : ''} на эту дату. `
      + 'Заявку на группу увидят другие операторы того же вида туров — новую заявку заводить не нужно; ждите звонка по телефону из заявки.';
  }
  if (f.answer === 'no_seats') return `${who(f)} ответил: на эту дату мест нет. Это ответ на заявку — брони не было, оплату Ведар не принимает.`;
  if (f.answer === 'other_date') return `${who(f)} ответил: на эту дату не может и предложит другую — напишет или позвонит по телефону из заявки.`;
  switch (f.reason) {
    case 'weather':
      return `${who(f)} отказал по заявке: на эту дату — погода или безопасность. Решение о выезде за оператором.`;
    case 'seats':
      return `${who(f)} отказал по заявке: мест нет. Заявка закрыта; брони не было, оплату Ведар не принимает.`;
    case 'dates':
      // «Даты ниже» — только когда они ниже есть: иначе строка ссылалась бы на
      // пустоту, а при «других дат нет» спорила бы со следующей (ревью 2б).
      return `${who(f)} отказал по заявке: даты не подходят.`
        + (d.kind === 'dates' ? ' Возможно, в эти дни тур не ходит — даты ниже взяты только из календаря.' : '');
    case 'group':
      return `${who(f)} отказал по заявке: не подходит группа. Что именно — число людей или состав, — можно спросить у оператора${f.tourUrl ? `: контакты на странице тура ${f.tourUrl}` : ''}.`;
    default:
      return `${who(f)} отказал по заявке; причину он не уточнил.`;
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (v: string | null | undefined): string | null => (typeof v === 'string' && ISO_DAY.test(v) ? v : null);

/** Кто ответил по заявке на машину или прокат — с вывеской, если она записана. */
function vehiclePartner(f: NoticeFacts, form: 'nom' | 'gen'): string {
  const word = f.kind === 'rental' ? (form === 'nom' ? 'Прокат' : 'проката') : (form === 'nom' ? 'Перевозчик' : 'перевозчика');
  return f.operatorName ? `${word} «${escapeHtml(f.operatorName)}»` : word;
}

/** Предмет заявки одной строкой: направление и даты у машины, машина и дни у проката. */
function vehicleSubject(f: NoticeFacts): string {
  const from = isoDay(f.vehicleFrom);
  const to = isoDay(f.vehicleTo);
  const title = f.vehicleTitle ? `«${escapeHtml(f.vehicleTitle)}»` : null;
  if (f.kind === 'rental') {
    const span = from && to ? `с ${ruDay(from)} по ${ruDay(to)}` : from ? `с ${ruDay(from)}` : null;
    return [title ?? 'машина не названа', span].filter(Boolean).join(', ');
  }
  const span = from && to && to !== from ? `с ${ruDay(from)} по ${ruDay(to)}` : from ? `выезд ${ruDay(from)}` : null;
  const where = title ? `направление ${title}` : f.vehicleTitleHidden ? 'направление — в заявке' : 'направление не названо';
  return [where, span].filter(Boolean).join(', ');
}

/**
 * Заказчику после «Не могу» перевозчика или прокатчика. Обещаний нет: машина
 * не закреплялась, другого перевозчика Ведар сам не подбирает — где смотреть,
 * сказано ссылкой.
 */
function vehicleDeclineText(f: NoticeFacts): string {
  const rental = f.kind === 'rental';
  const where = f.offersUrl
    ? (rental
      ? `Другие машины проката — ${f.offersUrl}; новую заявку можно оставить там же.`
      : `Другие перевозчики и их цены за машину — ${f.offersUrl}; новую заявку можно оставить там же.`)
    : null;
  return [
    `<b>Ответ по вашей заявке на ${rental ? 'прокат' : 'машину'}</b>`,
    `${rental ? 'Прокат' : 'Машина под заказ'}: ${vehicleSubject(f)}.`,
    `${vehiclePartner(f, 'nom')} ответил: выполнить заявку не может. Брони не было, машина за вами не закреплялась.`,
    where,
  ].filter((l): l is string => !!l).join('\n');
}

const TAIL = 'Подобрать другой тур можно здесь же — напишите, что ищете.';

/**
 * Сообщение человеку. `canPick` — чат вправе менять дату этой заявки
 * (тогда даты — кнопками «Изменить дату», иначе текстом и ссылкой на тур).
 */
export function touristAnswerText(
  f: NoticeFacts, d: DatesBlock, canPick: boolean, offers: OffersBlock = { kind: 'skip' },
): { text: string; buttons: Array<{ text: string; payload: string }>; offers: number } {
  if (personOf(f.kind) === 'client') return { text: vehicleDeclineText(f), buttons: [], offers: 0 };
  const pick = datesPickable(f, canPick);
  const block = answerWantsDates(f) ? datesText(f, d, pick) : null;
  const weather = isWeatherDecline(f);
  const compose = (others: string | null) => [
    head(f), answerLine(f, d),
    weather ? (block ?? WEATHER_NO_BLOCK) : block,
    others,
    weather ? 'Экстренный вызов — 112.' : f.groupPassedOn ? null : TAIL,
  ].filter((l): l is string => !!l);
  // Блок других компаний встаёт в сообщение столькими строками, сколько помещается в предел:
  // не поместилась ни одна — блока нет, а сообщение об отказе уходит как было.
  let named = answerWantsOffers(f) && offers.kind === 'offers' ? offers.offers.length : 0;
  let lines = compose(null);
  for (; named > 0; named--) {
    const withOffers = compose(offersText(f, offers as Extract<OffersBlock, { kind: 'offers' }>, named));
    if (withOffers.join('\n').length <= NOTICE_TEXT_MAX) { lines = withOffers; break; }
  }
  const buttons: Array<{ text: string; payload: string }> = [];
  if (pick && block && d.kind === 'dates') {
    for (const iso of d.dates) {
      buttons.push({ text: datesLine([iso], f.date), payload: signPayload(myTripDatePickPayload(f.leadId, iso)) });
    }
    buttons.push({ text: 'Другие даты', payload: myTripDateMenuPayload(f.leadId) });
  }
  return { text: lines.join('\n'), buttons, offers: named };
}

/** Сколько компаний называется менеджеру: звонок короткий, остальные — на странице места. */
export const MANAGER_OFFERS_MAX = 3;

/**
 * Менеджеру, который будет звонить: кого ещё можно назвать человеку на эту
 * дату (4а). Те же компании и тем же порядком, что получил бы человек в чате —
 * до него сообщение не дошло. Ссылок на формы нет: по телефону их не
 * продиктовать; страница места — одна. После отказа по погоде, у большой
 * группы и когда список не прочитался, строки нет (answerWantsOffers).
 */
function managerOffersNote(f: NoticeFacts, o: OffersBlock): string | null {
  if (!answerWantsOffers(f) || o.kind !== 'offers' || o.offers.length === 0) return null;
  const shown = o.offers.slice(0, MANAGER_OFFERS_MAX);
  const names = shown.map((x) => `«${escapeHtml(clip(x.partnerName, OFFER_NAME_CHARS))}» — тур «${escapeHtml(clip(x.title, OFFER_NAME_CHARS))}» `
    + `(${x.said === 'take' ? 'ответила Ведару: возьмёт' : x.seats === 'calendar' ? 'в календаре места есть' : 'дату подтверждает оператор'})`);
  const rest = o.more + (o.offers.length - shown.length);
  const basis = shown.some((x) => x.said === 'take') ? 'по календарю Ведара и ответам компаний' : 'по календарю Ведара, это не ответ компаний';
  return `Кого ещё можно назвать клиенту на эту дату — к месту «${escapeHtml(clip(o.placeName, OFFER_NAME_CHARS))}», ${basis}: `
    + `${names.join('; ')}${rest > 0 ? `; ${otherOffersMoreCompaniesWords(rest).toLowerCase()}` : ''}. `
    + `Все туры к месту: ${escapeHtml(o.placeUrl)} Заявку другой компании клиент оставляет сам.`;
}

/** Ответ оператора словами — для менеджера. */
function answerShort(f: NoticeFacts): string {
  if (f.answer === 'no_seats') return 'мест нет';
  if (f.answer === 'other_date') return 'предложит другую дату';
  return `отказ — ${f.reason ? DECLINE_REASON_LABEL[f.reason].toLowerCase() : 'причина не указана'}`;
}

const BROKEN_WORDS = 'отправка несколько раз обрывалась сбоем — дошло ли что-то до человека, неизвестно';

/**
 * Куда пробовали — коды отправки словами (без id чатов). Обрыв, после которого
 * добивка сдалась, — «неизвестно», а не «чата нет»: у строки, которая падала
 * посреди отправки, исходы каналов не записаны (§4.0, ревью 2б).
 */
export function triedWords(tried: readonly string[]): string {
  if (undeliveredWhy(tried).broken) return BROKEN_WORDS;
  const say: string[] = [];
  const chats = tried.filter((t) => t.startsWith('max:') || t.startsWith('telegram:'));
  if (chats.length === 0) say.push('чата с человеком нет');
  for (const t of chats) {
    const [ch, code] = t.split(':');
    say.push(`${ch === 'max' ? 'MAX' : 'Telegram'} не принял (${code})`);
  }
  const agent = tried.find((t) => t.startsWith('agent:'))?.slice(6);
  if (agent === undefined) say.push('подписки ИИ-агента нет');
  else if ((AGENT_NOT_SENT_CODES as readonly string[]).includes(agent)) say.push(AGENT_NOT_SENT_WORDS[agent as AgentNotSentCode]);
  else say.push(`ИИ-агент уведомления не принял (${agent})`);
  return say.join('; ');
}

/**
 * Менеджеру: до человека не дошло — позвонить. `text` с именем и телефоном
 * уходит только в MAX (sendPdAlert), `stub` — без ПД.
 */
export function managerUndeliveredText(
  f: NoticeFacts, contact: { name: string | null; phone: string | null }, tried: readonly string[], dates: readonly string[],
  offers: OffersBlock = { kind: 'skip' },
): { text: string; stub: string } {
  const vehicle = personOf(f.kind) === 'client';
  const tour = vehicle
    ? `${f.kind === 'rental' ? 'прокат' : 'машина под заказ'} — ${vehicleSubject(f)}`
    : [f.tourTitle ? `тур «${escapeHtml(f.tourTitle)}»` : 'тур', f.date ? ruDay(f.date) : null, f.people ? `${f.people} чел.` : null]
      .filter(Boolean).join(', ');
  const title = vehicle
    ? `<b>Ответ ${f.kind === 'rental' ? 'прокатчика' : 'перевозчика'} не доставлен клиенту — позвонить</b>`
    : '<b>Ответ оператора не доставлен клиенту — позвонить</b>';
  const answer = vehicle
    ? `Ответ ${vehiclePartner(f, 'gen')}: выполнить заявку не может.`
    : `Ответ ${f.operatorName ? `оператора «${escapeHtml(f.operatorName)}»` : 'оператора'}: ${answerShort(f)}.`;
  const datesNote = dates.length === 0 ? null : isWeatherDecline(f)
    ? `Свободные даты рядом, на которые Ведар не нашёл ни опасной погоды, ни предупреждений (${DATE_CHECK_SHORT}): ${datesLine(dates, f.date)} — выезд и места подтверждает оператор.`
    : `Свободные даты рядом по календарю: ${datesLine(dates, f.date)} — места подтверждает оператор.`;
  const text = [
    title,
    `Заявка <code>${escapeHtml(f.leadId)}</code>: ${endDot(tour)}`,
    answer,
    `<b>Имя:</b> ${escapeHtml(contact.name ?? 'не записано')}`,
    `<b>Телефон:</b> ${escapeHtml(contact.phone ?? 'не записан')}`,
    `Куда пробовали: ${triedWords(tried)}.`,
    datesNote,
    managerOffersNote(f, offers),
    `${vehicle ? 'Брони не было; машина за заказчиком не закреплялась.' : 'Брони не было; оплату Ведар не принимает.'} Если ИИ-агент или человек прочтёт статус позже — пришлю «звонить не нужно».`,
  ].filter(Boolean).join('\n');
  // Заглушка уходит ровно тогда, когда MAX НЕ принял письмо (pd-alert): в MAX
  // телефона нет, и звать туда нельзя — тот же урок, что у жилья 10.10
  // (lib/stay/stay-request.ts).
  const stub = [
    title,
    `Заявка <code>${escapeHtml(f.leadId)}</code>: ${endDot(tour)} ${answer}`,
    'MAX не сработал: имя и телефон — в админке (кнопка ниже), в Telegram они не передаются.',
  ].join('\n');
  return { text, stub };
}

const VIA_WORDS: Record<'agent_webhook' | 'agent_read' | 'page_seen', string> = {
  agent_webhook: 'уведомление ИИ-агенту принято',
  agent_read: 'ИИ-агент прочитал статус',
  page_seen: 'клиент открыл страницу заявки',
};

/** Менеджеру позже, без ПД: дошло — звонить не нужно. */
export function managerClearedText(leadId: string, via: NoticeOutcome & { state: 'delivered' }, kind: NoticeKind = 'tour'): string {
  const how = via.via === 'max' || via.via === 'telegram' ? `сообщение принял ${via.via === 'max' ? 'MAX' : 'Telegram'}` : VIA_WORDS[via.via];
  const whose = kind === 'charter' ? 'перевозчика' : kind === 'rental' ? 'прокатчика' : 'оператора';
  return `Заявка <code>${escapeHtml(leadId)}</code>: ответ ${whose} до клиента дошёл (${how}) — звонить не нужно.`;
}

/** Слова о человеке в строке партнёру: турист у тура, заказчик у машины и проката. */
const PERSON: Record<NoticePerson, { Nom: string; gen: string; Dat: string; dat: string }> = {
  tourist: { Nom: 'Турист', gen: 'туриста', Dat: 'Туристу', dat: 'туристу' },
  client: { Nom: 'Заказчик', gen: 'заказчика', Dat: 'Заказчику', dat: 'заказчику' },
};

/**
 * Оператору после отказа по погоде, когда других дат туристу не назвали:
 * почему. Иначе он читает «ваш ответ.» и не знает, что туриста отправили за
 * датами к нему, а у тура не хватает данных для проверки (ревью 2в).
 */
const NO_DATES_TO_OPERATOR: Record<WeatherDatesOutcome, string> = {
  confirmed: 'Других дат Ведар туристу не назвал: из свободных рядом проверку по прогнозу и предупреждениям не прошла ни одна.',
  unconfirmed: 'Других дат Ведар туристу не назвал: причины вашего отказа он по своим данным назвать не может — туристу сказано спросить о датах у вас.',
  place_risk: 'Других дат Ведар туристу не назвал: главное место тура сейчас закрыто либо в жёлтом или красном статусе.',
  zone_risk: 'Других дат Ведар туристу не назвал: опасность в зоне тура сейчас оценена не ниже высокой.',
  no_data: 'Других дат Ведар туристу не назвал: у тура на Ведаре не хватает данных для проверки (координаты, главное место со сводками и зоной); туристу сказано спросить о датах у вас.',
  past: 'Других дат Ведар туристу не назвал: дата заявки уже прошла.',
  beyond: 'Других дат Ведар туристу не назвал: дата заявки дальше прогноза.',
  unchecked: 'Других дат Ведар туристу не назвал: проверить обстановку сейчас не удалось.',
  weather_refused: 'Других дат Ведар туристу не назвал: по свободным датам рядом уже был отказ по погоде или безопасности; туристу сказано спросить о датах у вас.',
};

/**
 * Строка партнёру: что на самом деле ушло человеку. `person` — о ком речь:
 * у перевозчика и прокатчика это заказчик, и свободных дат у них нет.
 */
export function operatorOutcomeLine(o: NoticeOutcome, person: NoticePerson = 'tourist'): string {
  const w = PERSON[person];
  switch (o.state) {
    case 'delivered':
      if (o.via === 'max' || o.via === 'telegram') {
        const checked = o.check === 'confirmed' && o.dates.length > 0;
        const dates = o.dates.length === 0 ? '' : checked
          ? ` и свободные даты рядом, на которые Ведар не нашёл ни опасной погоды в прогнозе, ни предупреждений по месту (${datesLine(o.dates, null)}); выезд на них подтверждаете вы`
          : ` и свободные даты тура рядом по календарю (${datesLine(o.dates, null)})`;
        const why = o.check && !checked ? ` ${NO_DATES_TO_OPERATOR[o.check]}` : '';
        // Оператору сказано и это: после его отказа человеку названы другие компании (этап 4а).
        const others = o.offers && o.offers > 0
          ? ` Ещё ${w.dat} ${o.offers > 1 ? `названы ${o.offers} ${plural(o.offers, 'другая компания', 'другие компании', 'других компаний')}` : 'названа другая компания'} с турами к этому месту на эту дату — по общему правилу порядка витрины.`
          : '';
        return `${w.Dat} ушло сообщение в ${o.via === 'max' ? 'MAX' : 'Telegram'}: ваш ответ${dates}.${why}${others}`;
      }
      if (o.via === 'agent_webhook') return `Ответ ушёл ИИ-агенту ${w.gen}: его уведомление принято.`;
      return o.via === 'agent_read' ? `Ваш ответ уже прочитал ИИ-агент ${w.gen}.` : `${w.Nom} уже открыл страницу заявки и видит ваш ответ.`;
    case 'undelivered': {
      // Об агенте — только то, что было: подписки могло не быть вовсе (заявка с формы).
      const y = o.why;
      const why = y.broken
        ? 'отправка несколько раз обрывалась сбоем, дошло ли — неизвестно'
        : [
          y.chat === 'refused' ? 'чат не принял сообщение' : 'чат с ним не подключён',
          y.agent === 'refused' ? 'ИИ-агент уведомления не принял' : y.agent === 'not_sent' ? 'ИИ-агенту уведомление не ушло' : null,
        ].filter(Boolean).join(', ');
      const base = `${w.Dat} сообщить не удалось: ${why}.`;
      if (o.manager === 'max') return `${base} Заявку с телефоном получил менеджер Ведара — он позвонит.`;
      if (o.manager === 'telegram-stub') return `${base} Менеджеру Ведара ушло уведомление без телефона — номер он видит в админке.`;
      if (o.manager === 'not_needed') return `${base} Заявка с тех пор изменилась — менеджеру её не передавал.`;
      return `${base} И менеджеру Ведара сейчас не дошло — повторю автоматически. Если можете, позвоните заказчику сами по телефону из заявки.`;
    }
    case 'skipped':
      return {
        lead_closed: `Заявка уже была закрыта — ${w.dat} ничего не отправлял.`,
        not_addressee: `Заявка сейчас не ваша по карточке — ${w.dat} ничего не отправлял.`,
        self: `Это тестовая заявка вашей карточки — ${w.dat} ничего не отправлял.`,
        // У машины и проката брони и повторного ответа не бывает — причину не выдумываем.
        // Заказчик об отказе не узнал ни от кого: сказать ему больше некому (ревью 2б-2, п. 2).
        outgrown: person === 'client'
          ? `Статус заявки уже сменился — ${w.dat} ничего не отправлял. Если он ещё не знает об отказе, сообщите ему сами по телефону из заявки.`
          : `Статус заявки уже сменился (бронь или новый ответ) — ${w.dat} ничего не отправлял.`,
      }[o.reason];
    case 'pending':
      // Отправка ещё идёт — «не ушло» было бы неправдой за секунду до «ушло» (ревью 2б-2, п. 4).
      return o.sending
        ? `Сообщение ${w.dat} отправляется; не уйдёт — повторю автоматически, не выйдет — передам менеджеру Ведара.`
        : `Сообщение ${w.dat} сейчас не ушло — повторю автоматически в течение получаса, не выйдет — передам менеджеру Ведара.`;
  }
}
