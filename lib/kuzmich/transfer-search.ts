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
 */
import { listPublishedTrips } from '@/lib/transfers/service';
import { getPublicBaseUrl } from '@/lib/config';

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
  const from = args.from && DATE.test(args.from) ? args.from : isoDate(now);
  let to = args.to && DATE.test(args.to) ? args.to : isoDate(new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * 86_400_000));
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isFinite(span) || span < 0 || span > MAX_WINDOW_DAYS) {
    to = isoDate(new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * 86_400_000));
  }
  return { from, to };
}

export async function searchTransfersForKuzmich(args: TransferSearchArgs): Promise<string> {
  const { from, to } = resolveWindow(args);
  const seatsNum = Number(args.seats);
  const minSeats = args.seats && Number.isFinite(seatsNum) && seatsNum >= 1 ? Math.min(60, Math.floor(seatsNum)) : 1;

  let trips;
  try {
    trips = await listPublishedTrips({ fromDate: from, toDate: to, minSeats, placeId: null });
  } catch (err) {
    console.error('[kuzmich/search_transfers]', err instanceof Error ? err.message : err);
    // Не «поездок нет», а «не смог проверить»: одно от другого турист обязан отличать.
    return 'Не смог проверить витрину поездок перевозчиков — сбой на нашей стороне. Не говори, что мест нет; предложи посмотреть позже на /transfers.';
  }

  // Фильтр по направлению — по тексту «куда», как его написал перевозчик.
  const needle = (args.place ?? '').trim().toLowerCase();
  const matched = needle
    ? trips.filter(t => t.to_text.toLowerCase().includes(needle) || t.from_text.toLowerCase().includes(needle))
    : trips;

  const base = getPublicBaseUrl();
  if (matched.length === 0) {
    const where = needle ? ` в сторону «${args.place}»` : '';
    return `Искал с ${from} по ${to}${where}, мест от ${minSeats}: опубликованных поездок нет — в эти дни никто не едет. Это факт витрины, не сбой. Другие даты или направление — ${base}/transfers.`;
  }

  const lines = matched.slice(0, 6).map(t => {
    const price = t.price_per_seat ? `${Math.round(Number(t.price_per_seat))} руб/место` : 'цена по запросу';
    const when = t.departure_note ? `${t.trip_date}, ${t.departure_note}` : t.trip_date;
    return `${when}: ${t.from_text} — ${t.to_text}, ${KIND_LABEL[t.vehicle_kind] ?? t.vehicle_kind} «${t.vehicle_title}», свободно ${t.seats_free} из ${t.seats_total}, ${price}. Перевозчик: ${t.partner_name}.`;
  });
  return `Поездки с ${from} по ${to} (мест от ${minSeats}):\n${lines.join('\n')}\n\nЗапросить место (нужен вход; место занимается после подтверждения перевозчика, оплата по QR СБП): ${base}/transfers`;
}
