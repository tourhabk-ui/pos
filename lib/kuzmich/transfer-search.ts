/**
 * lib/kuzmich/transfer-search.ts — инструмент Кузьмича search_transfers.
 *
 * Вернулся 02.09 поверх витрины схемы 926. Прежний инструмент удалён 01.09:
 * он читал таблицы, которых на проде не было, и Кузьмич отвечал бы
 * «трансферов не нашлось» на каждый вопрос — выдавал поломку за факт о мире.
 *
 * Читает ТОЛЬКО через listPublishedTrips — единственное место с фильтром
 * is_published (сторож carrier-api): Кузьмич видит ровно то, что видит
 * витрина /transfers, и ничего сверх.
 *
 * Три исхода (§4.0): нашли — список; искали и нет — «в эти дни никто не
 * едет» с окном дат; не смогли проверить — так и сказано, без выдумки.
 *
 * Вторым разделом идёт прайс перевозчиков «под заказ» (целая машина, цена за
 * машину; миграция 1185) — из lib/transfers/charter, того же источника, что
 * у экрана /transfers и карточки перевозчика. Две поверхности друг от друга не
 * зависят: падение одной не прячет другую. Телефон перевозчика в ответ НЕ
 * кладётся (pd-guard: модели зарубежные) — только ссылка на карточку, где он
 * есть.
 */
import { listPublishedTrips } from '@/lib/transfers/service';
import { loadCharterCarriers, charterFootnote, describeFleet, matchDestinations, type CharterCarrier } from '@/lib/transfers/charter';
import { getPublicBaseUrl } from '@/lib/config';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { platformAcceptsPayments } from '@/lib/payments/accepting';

export interface TransferSearchArgs {
  from?: string;
  to?: string;
  seats?: string;
  place?: string;
}

const KIND_LABEL: Record<string, string> = { jeep: 'джип', vahtovka: 'вахтовка', minibus: 'микроавтобус', other: 'транспорт' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 60;

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

/** Окно дат из аргументов модели: неразборчивые даты — окно по умолчанию. */
export function resolveWindow(args: TransferSearchArgs, now = new Date()): { from: string; to: string } {
  // «Сегодня» — по Камчатке: поездки местные, и по UTC с 12:00 до 24:00 окно
  // начиналось со вчерашнего там дня (проверка MCP 29.09).
  const from = args.from && DATE.test(args.from) ? args.from : kamchatkaToday(now.getTime());
  let to = args.to && DATE.test(args.to) ? args.to : isoDate(new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * 86_400_000));
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isFinite(span) || span < 0 || span > MAX_WINDOW_DAYS) {
    to = isoDate(new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * 86_400_000));
  }
  return { from, to };
}

/**
 * Раздел «под заказ». null — не смог проверить (отличается от пустого списка:
 * «таких перевозчиков нет» и «не смог узнать» человеку говорятся по-разному).
 * Пустой список — раздела нет вовсе: говорить «под заказ никого нет» значило
 * бы утверждать больше, чем знает инструмент о рынке.
 */
export function charterSection(
  carriers: CharterCarrier[] | null,
  place: string | undefined,
  base: string,
  opts: { surface?: 'chat' | 'mcp' } = {},
): string {
  if (carriers === null) {
    return '\n\nНе смог проверить прайс вахтовок под заказ — сбой на нашей стороне. Не говори, что таких перевозчиков нет; предложи посмотреть позже на /transfers.';
  }
  if (carriers.length === 0) return '';
  const needle = (place ?? '').trim().toLowerCase();
  const blocks = carriers.map(c => {
    const hit = needle
      ? matchDestinations(c.destinations, needle, { includeFrom: true })
      : c.destinations;
    const shown = hit.length > 0 ? hit : c.destinations;
    const miss = needle && hit.length === 0 ? `Направления «${place}» в прайсе нет; весь прайс: ` : '';
    const prices = shown.map(d => `${d.to} ${d.priceRub} руб${d.note ? ` (${d.note})` : ''}`).join('; ');
    const extra = c.extraDay
      ? `; доплата ${c.extraDay.priceRub} руб в день${c.extraDay.note ? ` (${c.extraDay.note})` : ''}`
      : '';
    const fleet = describeFleet(c.vehicles);
    const note = charterFootnote(c);
    return `${c.name}${fleet ? ` — ${fleet}` : ''}. ${miss}Цена за машину целиком: ${prices}${extra}.${note ? ` ${note}` : ''} Связь, фото и заказ — на карточке: ${base}/operators/${c.slug}`;
  });
  // Заявку на машину умеет оставить только внешний агент (MCP): у Кузьмича в
  // чате такого инструмента нет, и отсылать его к request_charter значило бы
  // обещать путь, которого нет (§4, объявленный исход без источника).
  const order = opts.surface === 'mcp'
    ? '\nОставить заявку на машину: request_charter (куда, даты выезда, сколько человек, имя, телефон, согласие). Машина этим не закрепляется — подтверждает менеджер с перевозчиком.'
    : '';
  return `\n\nПод заказ целой машиной (дат и мест нет; цена за машину, не за место; сколько дней и что входит в цену — в прайсе не сказано, уточняется у перевозчика; расчёт напрямую, через платформу не оплачивается):\n${blocks.join('\n')}${order}`;
}

export async function searchTransfersForKuzmich(args: TransferSearchArgs, opts: { surface?: 'chat' | 'mcp' } = {}): Promise<string> {
  const { from, to } = resolveWindow(args);
  const seatsNum = Number(args.seats);
  const minSeats = args.seats && Number.isFinite(seatsNum) && seatsNum >= 1 ? Math.min(60, Math.floor(seatsNum)) : 1;
  const base = getPublicBaseUrl();

  // Прайс «под заказ» читается рядом и независимо: отказ одной витрины не
  // должен прятать другую.
  const charterPromise: Promise<CharterCarrier[] | null> = loadCharterCarriers().catch((err: unknown) => {
    console.error('[kuzmich/search_transfers/charter]', (err as { code?: string } | null)?.code ?? '', err instanceof Error ? err.message : err);
    return null;
  });

  let trips;
  try {
    trips = await listPublishedTrips({ fromDate: from, toDate: to, minSeats, placeId: null });
  } catch (err) {
    console.error('[kuzmich/search_transfers]', err instanceof Error ? err.message : err);
    // Не «поездок нет», а «не смог проверить»: одно от другого турист обязан отличать.
    return 'Не смог проверить витрину поездок перевозчиков — сбой на нашей стороне. Не говори, что мест нет; предложи посмотреть позже на /transfers.'
      + charterSection(await charterPromise, args.place, base, opts);
  }
  const charter = charterSection(await charterPromise, args.place, base, opts);

  // Фильтр по направлению — по тексту «куда», как его написал перевозчик.
  const needle = (args.place ?? '').trim().toLowerCase();
  const matched = needle
    ? trips.filter(t => t.to_text.toLowerCase().includes(needle) || t.from_text.toLowerCase().includes(needle))
    : trips;

  if (matched.length === 0) {
    const where = needle ? ` в сторону «${args.place}»` : '';
    return `Искал с ${from} по ${to}${where}, мест от ${minSeats}: опубликованных поездок нет — в эти дни никто не едет. Это факт витрины, не сбой. Другие даты или направление — ${base}/transfers.${charter}`;
  }

  const lines = matched.slice(0, 6).map(t => {
    const price = t.price_per_seat ? `${Math.round(Number(t.price_per_seat))} руб/место` : 'цена по запросу';
    const when = t.departure_note ? `${t.trip_date}, ${t.departure_note}` : t.trip_date;
    return `${when}: ${t.from_text} — ${t.to_text}, ${KIND_LABEL[t.vehicle_kind] ?? t.vehicle_kind} «${t.vehicle_title}», свободно ${t.seats_free} из ${t.seats_total}, ${price}. Перевозчик: ${t.partner_name}.`;
  });
  return `Поездки с ${from} по ${to} (мест от ${minSeats}):\n${lines.join('\n')}\n\nЗапросить место (нужен вход; место занимается после подтверждения перевозчика, ${platformAcceptsPayments() ? 'оплата по QR СБП' : 'оплата перевозчику напрямую'}): ${base}/transfers${charter}`;
}
