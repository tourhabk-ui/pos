/**
 * lib/kuzmich/car-rental-search.ts — инструмент Кузьмича search_car_rental.
 *
 * Прокат автомобилей на Камчатке — машина БЕЗ водителя за сутки у прокатчиков
 * платформы (схема 1317, владелец 23.10 «пока берем аренду автомобилей и
 * трансфер»). Не трансфер (§14): перевозчик сдаёт машину с водителем целиком,
 * прокатчик — машину без водителя за сутки, направление и дни задаёт
 * арендатор. Инструмент отвечает тем же прайсом, что витрина /car-rental и
 * страница прокатчика (lib/rental/rental) — второй копии цены нет.
 *
 * Три исхода (§4.0): прайс есть — прайс; прокатчиков с прайсом нет — так и
 * сказано, это факт витрины; не смог прочитать — «не смог проверить», без
 * «проката нет».
 *
 * Чего на платформе не записано — минимальный срок, что входит в цену,
 * требования к водителю, цена водителя «по желанию» — не выдумывается:
 * ответ говорит «уточняется у прокатчика». Телефон прокатчика в ответ НЕ
 * кладётся (pd-guard: модели зарубежные) — только ссылка на его страницу.
 *
 * Инструмента заявки на прокат у агента нет: заявка — формой на странице
 * прокатчика, подтверждает менеджер Ведара. Обещать request_* здесь значило
 * бы обещать путь, которого нет (§4).
 */
import { cyrillicToLatin } from '@/lib/text/slugify';
import { loadRentalCompanies } from '@/lib/rental/rental';
import {
  bodyKindWord, driveWord, driverWord, rentalPagePath, seatsWords, transmissionWord,
  type RentalBodyKind, type RentalCompany, type RentalOffer,
} from '@/lib/rental/rental-format';
import { getPublicBaseUrl } from '@/lib/config';
import { RENTAL_MAX_DAYS, rentalDays } from '@/lib/rental/rental-request';
import { RENTAL_SITE_PAUSE, rentalOnSite } from '@/lib/rental/site-pause';

export interface CarRentalSearchArgs {
  /** Слово о машине из вопроса: вид, модель или «с водителем». */
  query?: string;
  /** Вид кузова, если агент знает его точно. */
  type?: RentalBodyKind;
  /** Даты проката YYYY-MM-DD — только для расчёта суток; занятость машин на платформе не ведётся. */
  date_from?: string;
  date_to?: string;
}

/**
 * Слова самой просьбы, а не машины (23.10, диалог моделей: «аренда
 * внедорожника» и «rent a car 4x4» приходили целиком в query, и каждое слово
 * обязано было найтись в машине — «аренда» не находилось нигде). Эти слова
 * из фильтра выбрасываются.
 */
const REQUEST_WORDS = new Set([
  'аренда', 'аренду', 'арендовать', 'арендую', 'прокат', 'прокате', 'напрокат', 'взять', 'снять', 'машина', 'машину', 'машины',
  'авто', 'автомобиль', 'автомобиля', 'автомобили', 'на', 'камчатке', 'камчатка', 'сутки', 'день', 'дней', 'хочу', 'нужен', 'нужна',
  'car', 'cars', 'rent', 'rental', 'rentals', 'hire', 'self', 'drive', 'kamchatka', 'in', 'for', 'the', 'an', 'to', 'vehicle',
]);

/** Английские и разговорные слова о машине → слово прайса. */
const WORD_ALIASES: Record<string, string> = {
  suv: 'внедорожник', jeep: 'внедорожник', '4x4': '4wd', '4х4': '4wd', offroad: 'внедорожник', внедорожника: 'внедорожник',
  внедорожники: 'внедорожник', джипа: 'джип', minibus: 'микроавтобус', van: 'микроавтобус', микроавтобуса: 'микроавтобус',
  вездехода: 'вездеход', вахтовку: 'вахтовка', automatic: 'автомат', manual: 'механика', sedan: 'седан',
};

/** Слова фильтра без слов просьбы, с заменой синонимов. */
export function filterWords(query: string): string[] {
  return norm(query).split(/[^a-zа-я0-9]+/u)
    .filter((w) => w.length >= 2 && !REQUEST_WORDS.has(w))
    .map((w) => WORD_ALIASES[w] ?? w);
}

/**
 * Сутки проката — тем же счётом, что форма на странице прокатчика (с 10 по 14
 * ноября — 5 суток, lib/rental/rental-request); null — дат нет или они кривые.
 */
export function searchDays(from?: string, to?: string): number | null {
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return null;
  const d = rentalDays(from, to);
  return Number.isFinite(d) && d >= 1 && d <= RENTAL_MAX_DAYS ? d : null;
}

export interface CarRentalSearchOpts {
  surface?: 'chat' | 'mcp';
  /**
   * Спрашивает внешний агент по A2A свободным текстом. Его ответ — как у MCP:
   * пауза проката на сайте (lib/rental/site-pause) агентов не касается.
   */
  agent?: boolean;
  /** Момент для паузы; по умолчанию — сейчас. */
  now?: Date;
}

/** Деньги в тексте для модели — «7000 руб», как в search_transfers; без неразрывных пробелов. */
function rub(n: number): string {
  return `${n} руб`;
}

/** Слова, которыми человек называет кузов, кроме слова прайса: «джип» — внедорожник. */
const BODY_SYNONYMS: Record<RentalBodyKind, readonly string[]> = {
  car: ['седан', 'легковушка', 'легковой'],
  suv: ['джип', 'кроссовер'],
  minibus: ['минивэн', 'автобус', 'микрик'],
  offroad_truck: [],
  vahtovka: [],
};

/** Регистр и «ё» не различаются: «Джип» и «джип», «вездеход» и «вездехoд» с ё — одно слово. */
function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').trim();
}

/** По каким словам машина находится: модель, кузов и его синонимы, коробка, привод, водитель. */
function haystack(o: RentalOffer): string {
  const parts = [o.title, bodyKindWord(o.bodyKind), ...BODY_SYNONYMS[o.bodyKind], driverWord(o.driver)];
  if (o.transmission) parts.push(transmissionWord(o.transmission));
  if (o.drive) parts.push(driveWord(o.drive));
  return norm(parts.join(' '));
}

/**
 * Машины, подходящие под слово из вопроса: каждое слово запроса (от двух букв)
 * должно встретиться в описании машины. «с водителем» находит только машины,
 * где водитель возможен; «без водителя» — все, потому что без водителя
 * сдаётся каждая.
 */
export function matchOffers(offers: RentalOffer[], query: string): RentalOffer[] {
  const words = filterWords(query);
  if (words.length === 0) return offers;
  return offers.filter((o) => {
    const h = haystack(o);
    const hl = cyrillicToLatin(h);
    return words.every((w) => h.includes(w) || hl.includes(latinOf(w)));
  });
}

/**
 * Кириллица и латиница — одно слово (23.10, разбор владельца: агент спросил
 * «танк», в прайсе стоит «Tank-300», и по-русски написанную марку поиск не
 * находил). Слово запроса ищется как есть и в транслитерации — «танк» → tank,
 * «сузуки» → suzuki, «камаз» ↔ «КамАЗ». У марок, чьё русское написание
 * транслитом не получается, — явная таблица; правило — транслитерация, таблица
 * только для неправильных случаев.
 */
const BRAND_SPELLINGS: Record<string, string> = {
  джимни: 'jimny', тойота: 'toyota', тоета: 'toyota', ленд: 'land', лэнд: 'land', крузер: 'cruiser', крузак: 'cruiser',
  трак: 'truck', мицубиси: 'mitsubishi', митсубиси: 'mitsubishi', паджеро: 'pajero', делика: 'delica', хайлюкс: 'hilux',
  хендай: 'hyundai', хундай: 'hyundai', джили: 'geely', чери: 'chery', хайс: 'hiace', транзит: 'transit', форд: 'ford',
};

function latinOf(word: string): string {
  return BRAND_SPELLINGS[word] ?? cyrillicToLatin(word);
}

/** Строка машины: «Suzuki Jimny — внедорожник, 4 места, автомат, 4WD, 105 л.с.: 7000 руб за сутки, залог 15000 руб, без водителя». */
function offerLine(o: RentalOffer, days: number | null = null): string {
  const facts = [bodyKindWord(o.bodyKind)];
  if (o.seats !== null) facts.push(seatsWords(o.seats));
  if (o.transmission) facts.push(transmissionWord(o.transmission));
  if (o.drive) facts.push(driveWord(o.drive));
  if (o.engineHp !== null) facts.push(`${o.engineHp} л.с.`);
  const price = `${o.priceIsFrom ? 'от ' : ''}${rub(o.priceRubPerDay)} за сутки`;
  const money = [price];
  if (o.depositRub !== null) money.push(`залог ${rub(o.depositRub)}`);
  if (days !== null) money.push(`за ${days} сут. по прайсу ${o.priceIsFrom ? 'от ' : ''}${rub(o.priceRubPerDay * days)}`);
  money.push(o.driver === 'optional' ? 'водитель по желанию, цена отдельно' : 'без водителя');
  return `${o.title} — ${facts.join(', ')}: ${money.join(', ')}`;
}

/**
 * Ответ по прайсу проката. null — не смог проверить (отличается от пустого
 * списка: «прокатчиков нет» и «не смог узнать» человеку говорятся по-разному).
 */
export function rentalAnswer(
  companies: RentalCompany[] | null,
  query: string | undefined,
  base: string,
  opts: CarRentalSearchOpts = {},
  filters: Pick<CarRentalSearchArgs, 'type' | 'date_from' | 'date_to'> = {},
): string {
  if (companies === null) {
    return `Не смог проверить прайс проката — сбой на нашей стороне. Не говори, что проката нет; предложи посмотреть позже на ${base}/car-rental.`;
  }
  if (companies.length === 0) {
    return `Прокатчиков с прайсом на платформе пока нет — это факт витрины, не сбой. Машин, прокатчиков и цен не выдумывай. Витрина: ${base}/car-rental.`;
  }
  const needle = (query ?? '').trim();
  const days = searchDays(filters.date_from, filters.date_to);
  const blocks = companies.map((c) => {
    const typed = filters.type ? c.offers.filter((o) => o.bodyKind === filters.type) : c.offers;
    const hit = needle ? matchOffers(typed, needle) : typed;
    const filtered = Boolean(needle || filters.type);
    const shown = hit.length > 0 ? hit : c.offers;
    const label = needle || (filters.type ? bodyKindWord(filters.type) : '');
    const miss = filtered && hit.length === 0 ? `По запросу «${label}» в прайсе ничего нет; весь прайс: ` : '';
    const lines = shown.map((o) => offerLine(o, days)).join('; ');
    return `${c.name}. ${miss}${lines}. Условия проката, заявка и связь — на странице прокатчика: ${base}${rentalPagePath(c.slug)}`;
  });
  // Инструмента заявки на прокат нет ни у Кузьмича, ни у внешнего агента:
  // заявка — формой на странице прокатчика (ссылка в каждом блоке). Внешнему
  // агенту это сказано словами, чтобы он не искал request_* по аналогии с
  // трансфером.
  const noRequestTool = opts.surface === 'mcp'
    ? ' Заявка на машину — create_car_rental_request (машина как в прайсе, даты, согласие человека) или формой на странице прокатчика; подтверждает менеджер Ведара, расчёт — напрямую с прокатчиком.'
    : ' Заявка — формой на странице прокатчика; инструмента заявки на прокат у агента нет.';
  const dates = days !== null
    ? ` Даты ${filters.date_from} — ${filters.date_to}: ${days} сут.; занятость машин на эти даты платформа не ведёт — подтверждает прокатчик.`
    : '';
  return `Прокат — машина без водителя, цена за сутки за машину; направление и дни задаёт арендатор.${dates} Что входит в цену, минимальный срок и требования к водителю на платформе не записаны — уточняются у прокатчика; расчёт напрямую с ним, через платформу не оплачивается.${noRequestTool}\n${blocks.join('\n')}`;
}

/**
 * Прокат на сайте на паузе (слово владельца 23.10), и показать в чате некого.
 * Не «проката нет»: прокатчик есть, сайт его прячет до названного дня.
 */
export function rentalPausedAnswer(base: string, returnsOn: string = RENTAL_SITE_PAUSE.returnsOn): string {
  return `Прокат автомобилей без водителя на сайте сейчас не показывается — вернётся ${returnsOn}. `
    + 'Прокатчиков, машин и цен не называй и не говори, что проката нет. '
    + `Машину с водителем целиком можно заказать у перевозчиков — search_transfers, витрина ${base}/transfers.`;
}

/**
 * Чат Кузьмича (сайт, виджет, Telegram, MAX) — люди на сайте: прокатчик под
 * паузой (lib/rental/site-pause) им не показывается. MCP и агент по A2A
 * получают прайс целиком — так решил владелец 23.10.
 */
export async function searchCarRentalForKuzmich(args: CarRentalSearchArgs, opts: CarRentalSearchOpts = {}): Promise<string> {
  const base = getPublicBaseUrl();
  let companies: RentalCompany[] | null;
  try {
    companies = await loadRentalCompanies();
  } catch (err) {
    // Имя проверки и SQLSTATE — в лог; ПД здесь нет (прайс, не люди).
    console.error('[car-rental-search] прайс не прочитан', (err as { code?: string } | null)?.code ?? '', err instanceof Error ? err.message : err);
    companies = null;
  }
  const forAgents = opts.surface === 'mcp' || opts.agent === true;
  if (companies !== null && !forAgents) {
    const { shown, hidden } = rentalOnSite(companies, opts.now);
    if (shown.length === 0 && hidden > 0) return rentalPausedAnswer(base);
    companies = shown;
  }
  return rentalAnswer(companies, args.query, base, opts, { type: args.type, date_from: args.date_from, date_to: args.date_to });
}
