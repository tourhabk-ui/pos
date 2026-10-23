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
import { loadRentalCompanies } from '@/lib/rental/rental';
import {
  bodyKindWord, driveWord, driverWord, rentalPagePath, seatsWords, transmissionWord,
  type RentalBodyKind, type RentalCompany, type RentalOffer,
} from '@/lib/rental/rental-format';
import { getPublicBaseUrl } from '@/lib/config';

export interface CarRentalSearchArgs {
  /** Слово о машине из вопроса: вид, модель или «с водителем». */
  query?: string;
}

export interface CarRentalSearchOpts {
  surface?: 'chat' | 'mcp';
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
  const words = norm(query).split(/[^a-zа-я0-9]+/u).filter((w) => w.length >= 2);
  if (words.length === 0) return offers;
  return offers.filter((o) => {
    const h = haystack(o);
    return words.every((w) => h.includes(w));
  });
}

/** Строка машины: «Suzuki Jimny — внедорожник, 4 места, автомат, 4WD, 105 л.с.: 7000 руб за сутки, залог 15000 руб, без водителя». */
function offerLine(o: RentalOffer): string {
  const facts = [bodyKindWord(o.bodyKind)];
  if (o.seats !== null) facts.push(seatsWords(o.seats));
  if (o.transmission) facts.push(transmissionWord(o.transmission));
  if (o.drive) facts.push(driveWord(o.drive));
  if (o.engineHp !== null) facts.push(`${o.engineHp} л.с.`);
  const price = `${o.priceIsFrom ? 'от ' : ''}${rub(o.priceRubPerDay)} за сутки`;
  const money = [price];
  if (o.depositRub !== null) money.push(`залог ${rub(o.depositRub)}`);
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
): string {
  if (companies === null) {
    return `Не смог проверить прайс проката — сбой на нашей стороне. Не говори, что проката нет; предложи посмотреть позже на ${base}/car-rental.`;
  }
  if (companies.length === 0) {
    return `Прокатчиков с прайсом на платформе пока нет — это факт витрины, не сбой. Машин, прокатчиков и цен не выдумывай. Витрина: ${base}/car-rental.`;
  }
  const needle = (query ?? '').trim();
  const blocks = companies.map((c) => {
    const hit = needle ? matchOffers(c.offers, needle) : c.offers;
    const shown = hit.length > 0 ? hit : c.offers;
    const miss = needle && hit.length === 0 ? `По запросу «${needle}» в прайсе ничего нет; весь прайс: ` : '';
    const lines = shown.map(offerLine).join('; ');
    return `${c.name}. ${miss}${lines}. Условия проката, заявка и связь — на странице прокатчика: ${base}${rentalPagePath(c.slug)}`;
  });
  // Инструмента заявки на прокат нет ни у Кузьмича, ни у внешнего агента:
  // заявка — формой на странице прокатчика (ссылка в каждом блоке). Внешнему
  // агенту это сказано словами, чтобы он не искал request_* по аналогии с
  // трансфером.
  const noRequestTool = opts.surface === 'mcp'
    ? ' Инструмента заявки на прокат в MCP нет: заявка — формой на странице прокатчика, подтверждает менеджер Ведара, расчёт — напрямую с прокатчиком.'
    : ' Заявка — формой на странице прокатчика; инструмента заявки на прокат у агента нет.';
  return `Прокат — машина без водителя, цена за сутки за машину; направление и дни задаёт арендатор. Что входит в цену, минимальный срок и требования к водителю на платформе не записаны — уточняются у прокатчика; расчёт напрямую с ним, через платформу не оплачивается.${noRequestTool}\n${blocks.join('\n')}`;
}

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
  return rentalAnswer(companies, args.query, base, opts);
}
