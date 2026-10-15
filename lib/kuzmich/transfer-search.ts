/**
 * lib/kuzmich/transfer-search.ts — инструмент Кузьмича search_transfers.
 *
 * Трансфер на Камчатке — машина целиком под заказ, не место в ней (владелец
 * 13.10: «бронируют целую машину а не место в ней»). Инструмент отвечает
 * прайсом перевозчиков «под заказ» (миграция 1185) из lib/transfers/charter —
 * того же загрузчика, что у экрана /transfers и страницы перевозчика.
 *
 * Мест в поездках (схема 926) он больше не называет. Модуль спрятан, а не
 * удалён, но продавать место модель не должна: перевозчик сдаёт машину, и
 * цена у него — за машину. До 13.10 ответ начинался с «никто не едет» по
 * витрине поездок, которую не заполнял никто, а прайс машины шёл приложением.
 *
 * Три исхода (§4.0): прайс есть — прайс; перевозчиков с прайсом нет — так и
 * сказано, это факт витрины; не смог прочитать — «не смог проверить», без
 * «таких нет».
 *
 * Телефон перевозчика в ответ НЕ кладётся (pd-guard: модели зарубежные) —
 * только ссылка на страницу перевозчика, где он есть.
 */
import { loadCharterCarriers, charterFootnote, describeFleet, matchDestinations, type CharterCarrier } from '@/lib/transfers/charter';
import { getPublicBaseUrl } from '@/lib/config';
import { carrierPagePath, rateWords } from '@/lib/transfers/charter-format';

export interface TransferSearchArgs {
  /** Куда или откуда — слово из вопроса человека. */
  place?: string;
}

/**
 * Ответ по прайсу. null — не смог проверить (отличается от пустого списка:
 * «таких перевозчиков нет» и «не смог узнать» человеку говорятся по-разному).
 */
export function charterAnswer(
  carriers: CharterCarrier[] | null,
  place: string | undefined,
  base: string,
  opts: { surface?: 'chat' | 'mcp' } = {},
): string {
  if (carriers === null) {
    return `Не смог проверить прайс машин под заказ — сбой на нашей стороне. Не говори, что таких перевозчиков нет; предложи посмотреть позже на ${base}/transfers.`;
  }
  if (carriers.length === 0) {
    return `Перевозчиков с прайсом под заказ на платформе пока нет — это факт витрины, не сбой. Перевозчиков, рейсов и цен не выдумывай. Витрина: ${base}/transfers.`;
  }
  const needle = (place ?? '').trim().toLowerCase();
  const blocks = carriers.map(c => {
    const fleet = describeFleet(c.vehicles);
    const note = charterFootnote(c);
    const head = `${c.name}${fleet ? ` — ${fleet}` : ''}.`;
    const tail = `${note ? ` ${note}` : ''} Связь, фото и заявка на машину — на странице перевозчика: ${base}${carrierPagePath(c.slug)}`;
    // Цена за время работы (1292): направлений нет, куда ехать — задаёт
    // заказчик. «Направления нет в прайсе» тут было бы неправдой: прайс не
    // про направления, и любое направление считается по часам или дням.
    const rates = c.rates.length > 0 ? `${c.rates.map(rateWords).join('; ')}` : '';
    if (c.destinations.length === 0 && rates) {
      return `${head} Цена за машину целиком — за время работы, направление задаёт заказчик: ${rates}.${tail}`;
    }
    const hit = needle
      ? matchDestinations(c.destinations, needle, { includeFrom: true })
      : c.destinations;
    const shown = hit.length > 0 ? hit : c.destinations;
    const miss = needle && hit.length === 0 ? `Направления «${place}» в прайсе нет; весь прайс: ` : '';
    const prices = shown.map(d => `${d.to} ${d.priceRub} руб${d.note ? ` (${d.note})` : ''}`).join('; ');
    const extra = c.extraDay
      ? `; доплата ${c.extraDay.priceRub} руб в день${c.extraDay.note ? ` (${c.extraDay.note})` : ''}`
      : '';
    const byTime = rates ? `; или за время работы: ${rates}` : '';
    return `${head} ${miss}Цена за машину целиком: ${prices}${extra}${byTime}.${tail}`;
  });
  // Инструмент заявки на машину есть только у внешнего агента (MCP): у
  // Кузьмича в чате его нет, и отсылать к request_charter значило бы обещать
  // путь, которого нет (§4). Человеку в чате путь — форма на странице
  // перевозчика (стандарт 13.10), ссылка на неё стоит в каждом блоке.
  // Параметр carrier называется здесь явно (проверка владельца 10.10: агент
  // сам подставил slug из ссылки на карточку; при нескольких перевозчиках он
  // угадывал бы). Один перевозчик — параметр можно не передавать.
  const ids = carriers.map(c => `${c.slug} (${c.name})`).join('; ');
  const order = opts.surface === 'mcp'
    ? '\nОставить заявку на машину: request_charter (куда, даты выезда, сколько человек, имя, телефон, согласие). Машина этим не закрепляется — подтверждает менеджер с перевозчиком.'
      + ` Параметр carrier — ${ids}${carriers.length === 1 ? '; пока перевозчик один, его можно не передавать' : ''}.`
    : '';
  return `Трансфер — машина целиком под заказ: цена за машину, не за место; дату и направление задаёт заказчик. Сколько дней или часов и что входит в цену — в прайсе не сказано, уточняется у перевозчика; расчёт напрямую с ним, через платформу не оплачивается.\n${blocks.join('\n')}${order}`;
}

export async function searchTransfersForKuzmich(args: TransferSearchArgs, opts: { surface?: 'chat' | 'mcp' } = {}): Promise<string> {
  const base = getPublicBaseUrl();
  let carriers: CharterCarrier[] | null;
  try {
    carriers = await loadCharterCarriers();
  } catch (err) {
    console.error('[kuzmich/search_transfers]', (err as { code?: string } | null)?.code ?? '', err instanceof Error ? err.message : err);
    carriers = null;
  }
  return charterAnswer(carriers, args.place, base, opts);
}
