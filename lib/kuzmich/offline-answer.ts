/**
 * Кузьмич без сети отвечает памятками Спасателя, а не молчит.
 *
 * Карт-бланш владельца 27.11 после разбора «маленький Кузьмич без интернета»:
 * сперва взять то, что уже написано и проверено. До этого дня экраны
 * Кузьмича без сети отвечали «Нет связи. Попробуйте позже.» (`/kuzmich`) или
 * блокировали ввод (`/ai-assistant`), а AI Спасатель на `/sos` и
 * `/safety` в той же беде отвечал готовыми протоколами — «медведь»,
 * «заблудились», «травма» — из `lib/safety/rescue-protocols.ts`. Человек в поле
 * без связи спрашивал не того помощника и оставался без ответа.
 *
 * Модели здесь нет и быть не должно: памятки написаны заранее, выбираются по
 * словам, и тот же список отвечает в Спасателе (один источник — два разных
 * ответа на «медведь» уже случались). Чего в памятках нет — так и сказано, с
 * 112 и кнопкой SOS, которая работает без сети.
 *
 * Ответ не выдаётся за ответ Кузьмича: первой строкой сказано, что это
 * памятка, записанная заранее.
 *
 * Серверный детектор беды (`lib/safety/sos-detector.ts`) сюда не берётся: его
 * границы слов — lookbehind, а Safari до 16.4 на нём падает при загрузке
 * модуля, и вместе с ним не открылся бы чат (сторож
 * `client-regex-no-lookbehind`). Беду без памятки ловит ответ «ответа нет» —
 * в нём 112 и кнопка SOS.
 */
import { getLocalProtocol } from '@/lib/safety/rescue-protocols';
import type { RouteFacts } from '@/lib/offline/route-facts';

/** Первая строка ответа по памятке: откуда он, раз сети нет. */
export const OFFLINE_PROTOCOL_LEAD = 'Связи нет — отвечаю памяткой, записанной заранее:';

/** Памятки под вопрос нет: ответа нет, и это сказано — с 112 и SOS. */
export const OFFLINE_NO_ANSWER =
  'Связи нет — Кузьмич ответит, когда сеть вернётся. Если есть опасность — звоните 112; кнопка SOS в шапке работает и без сети. ' +
  'Сохранённые карты и маршруты открываются без интернета.';

/** Отказ без сети — этот класс бросает экран, не дожидаясь fetch. */
export class OfflineError extends Error {
  constructor() {
    super('offline');
    this.name = 'OfflineError';
  }
}

/** Браузер сам говорит, что сети нет. Вне браузера — не знаем, значит «есть». */
export function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Отказ из-за сети, а не из-за сервера: браузер без сети, запрос не ушёл
 * (fetch бросает TypeError) или экран сам остановил отправку.
 */
export function isOfflineFailure(err: unknown): boolean {
  return err instanceof OfflineError || err instanceof TypeError || browserOffline();
}

// ── Факты сохранённых маршрутов (шаг 2) ───────────────────────────────────

/** О чём спрашивают — тема вопроса про маршрут. */
const TOPICS = {
  hazards: /опасн|риск|угроз/i,
  equipment: /взять|снаряж|экипир|с собой|одежд|обув/i,
  mchs: /мчс|регистрац|зарегистр/i,
  alerts: /закрыт|перекрыт|огранич|предупрежд/i,
  park: /парк|разрешени|пропуск/i,
  medical: /медпомощ|медицин|больниц|врач|травмпункт|фельдшер|скор(?:ая|ую|ой) помощ|аптек/i,
} as const;
type Topic = keyof typeof TOPICS;

/** Слова названия, по которым маршрут не отличить от других. */
const GENERIC_TITLE_WORDS = new Set([
  'вулкан', 'вулкана', 'озеро', 'озера', 'река', 'реке', 'реки', 'маршрут', 'тропа', 'восхождение',
  'подъем', 'долина', 'бухта', 'перевал', 'источники', 'горячие', 'гора', 'сопка', 'водопад', 'сплав',
]);

const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е');

/** Основа слова названия: «Мутновский» → «мутнов». Короче пяти букв — само слово. */
function stem(word: string): string {
  return word.length > 6 ? word.slice(0, word.length - 3) : word;
}

/** Маршруты, которые вопрос называет по имени. */
function namedRoutes(text: string, facts: readonly RouteFacts[]): RouteFacts[] {
  const q = norm(text);
  return facts.filter((f) => norm(f.title).split(/[^а-яa-z0-9]+/)
    .filter((w) => w.length >= 5 && !GENERIC_TITLE_WORDS.has(w))
    .some((w) => q.includes(stem(w))));
}

function formatKm(km: number): string {
  return km >= 10 ? String(Math.round(km)) : String(Math.round(km * 10) / 10).replace('.', ',');
}

function savedOn(f: RouteFacts): string {
  return new Date(f.savedAt).toLocaleDateString('ru-RU', { timeZone: 'Asia/Kamchatka' });
}

function factLines(f: RouteFacts, topics: readonly Topic[]): string[] {
  const lines: string[] = [];
  for (const t of topics) {
    if (t === 'hazards') {
      lines.push(f.hazards.length > 0
        ? `Опасности: ${f.hazards.join(', ')}.`
        : 'Опасности в сохранённых данных не записаны — это не значит, что их нет.');
    }
    if (t === 'equipment') {
      lines.push(f.equipment.length > 0
        ? `Снаряжение: ${f.equipment.join(', ')}.`
        : 'Снаряжение в сохранённых данных не записано.');
    }
    if (t === 'mchs') {
      const phone = f.mchsPhone ? ` Телефон МЧС для консультации: ${f.mchsPhone}.` : '';
      lines.push(f.mchsRequired === true
        ? `Регистрация в МЧС: обязательна.${phone}`
        : f.mchsRequired === false
          ? `Регистрация в МЧС: в данных маршрута обязательной не отмечена — это не значит, что она не нужна.${phone}`
          : `Регистрация в МЧС: в сохранённых данных не записано.${phone}`);
    }
    if (t === 'alerts') {
      lines.push(f.alerts.length > 0
        ? `Предупреждения на дату сохранения: ${f.alerts.map((a) => (a.until ? `${a.title} (до ${a.until.slice(0, 10)})` : a.title)).join('; ')}.`
        : 'Предупреждений на дату сохранения не было. Обстановка могла измениться.');
    }
    if (t === 'park') {
      lines.push(f.parkName
        ? `Маршрут в природном парке «${f.parkName}».`
        : 'Природный парк в сохранённых данных не записан.');
    }
    if (t === 'medical') {
      lines.push(f.medical.length > 0
        ? `Ближайшая медпомощь по данным мест маршрута: ${f.medical.map((m) => `от «${m.place}» — ${formatKm(m.km)} км`).join(', ')}.`
        : 'Расстояние до медпомощи в сохранённых данных не записано. При беде — 112.');
    }
  }
  return lines;
}

/**
 * Ответ по фактам сохранённых маршрутов: только то, что лежит в телефоне, с
 * датой сохранения. Вопрос не про маршрут — null. Маршрутов несколько, а
 * вопрос ни одного не называет — просьба назвать, без догадки.
 */
export function routeFactsAnswer(text: string, facts: readonly RouteFacts[]): string | null {
  if (facts.length === 0) return null;
  const topics = (Object.keys(TOPICS) as Topic[]).filter((t) => TOPICS[t].test(text));
  if (topics.length === 0) return null;
  const named = namedRoutes(text, facts);
  const pick = named.length > 0 ? named : facts.length === 1 ? [facts[0]] : [];
  if (pick.length !== 1) {
    const list = (named.length > 1 ? named : facts).map((f) => `«${f.title}»`).join(', ');
    return `Связи нет. В телефоне сохранены маршруты: ${list}. Назовите, о каком спрашиваете.`;
  }
  const f = pick[0];
  return [
    `Связи нет — отвечаю по сохранённому в телефоне маршруту «${f.title}» (сохранён ${savedOn(f)}):`,
    ...factLines(f, topics).map((l) => `— ${l}`),
    'С даты сохранения обстановка могла измениться. При опасности — 112.',
  ].join('\n');
}

/**
 * Вопрос называет сохранённый маршрут, а ответа на него в телефоне нет — так и
 * сказано, с перечнем того, что записано (шаг 2: «честно говорит „этого в
 * сохранённом нет“»). Вопрос не про сохранённый маршрут — null.
 */
export function savedRouteMiss(text: string, facts: readonly RouteFacts[]): string | null {
  const named = namedRoutes(text, facts);
  if (named.length === 0) return null;
  const list = named.map((f) => `«${f.title}»`).join(', ');
  return `В сохранённом в телефоне маршруте ${list} ответа на это нет: там записаны опасности, снаряжение, регистрация в МЧС, медпомощь и предупреждения.`;
}

/**
 * Ответ Кузьмича без сети. `earlier` — прежние реплики человека в этом чате:
 * без них «Потеряли рюкзак» после «Мы заблудились» сошла бы за утерю вещи.
 * `facts` — карточки маршрутов, сохранённых в телефоне вместе с картой.
 *
 * Порядок: памятка беды раньше фактов маршрута — «что делать, медведь» важнее
 * списка снаряжения.
 */
export function offlineKuzmichAnswer(
  text: string,
  earlier: readonly string[] = [],
  facts: readonly RouteFacts[] = [],
): string {
  const protocol = getLocalProtocol(text, earlier);
  if (protocol) return `${OFFLINE_PROTOCOL_LEAD}\n\n${protocol}`;
  const fromRoute = routeFactsAnswer(text, facts);
  if (fromRoute) return fromRoute;
  const miss = savedRouteMiss(text, facts);
  return miss ? `${miss}\n\n${OFFLINE_NO_ANSWER}` : OFFLINE_NO_ANSWER;
}
