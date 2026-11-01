/**
 * Заявка на поездку целиком: тур + жильё + машина одним вызовом (break-map
 * 01.11). Сама ничего не пишет — раскладывает поездку на части и зовёт те же
 * исполнители, что у отдельных инструментов (проверки дат, мест, согласия,
 * доставка партнёру — их). Общее: номер поездки и строка «в этой же
 * поездке …» в комментарии каждой части, чтобы оператор тура, владелец
 * жилья и менеджер с перевозчиком видели одну поездку, а не три заявки.
 *
 * Машина без перевозчика при нескольких перевозчиках — не отказ, а заявка
 * менеджеру Ведара (create_lead) с той же строкой поездки.
 */
import { randomBytes } from 'node:crypto';
import { pickHeadcount } from '@/lib/agent/headcount';

export type LegKind = 'tour' | 'stay' | 'transfer';

export interface TripLegResult {
  kind: LegKind;
  ok: boolean;
  text: string;
}

export interface TripDeps {
  bookTour(args: Record<string, unknown>): Promise<string>;
  requestStay(args: Record<string, unknown>): Promise<string>;
  requestCharter(args: Record<string, unknown>): Promise<string>;
  createLead(args: Record<string, unknown>): Promise<string>;
  /** Штатная фраза RU/EN/ZH (requestConfirmNote) — вырезается из частей и ставится один раз. */
  confirmNote: string;
  newTripId?: () => string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** «Не создана» в тексте исполнителя — часть не прошла (исполнители так и отвечают). */
export function legFailed(text: string): boolean {
  return /не создан|не отправлен|не найден|не принимает/i.test(text);
}

/** Исполнитель просит выбрать перевозчика — машину берёт менеджер. */
export function needsCarrierChoice(text: string): boolean {
  return /укажите, кому адресовать/i.test(text);
}

export function newTripId(): string {
  return 'TRIP-' + randomBytes(3).toString('hex').toUpperCase();
}

export async function runTripRequest(raw: Record<string, unknown>, deps: TripDeps): Promise<{ text: string; tripId: string | null; legs: TripLegResult[] }> {
  const people = pickHeadcount(raw);
  const tour = str(raw.tour);
  const tourDate = str(raw.tour_date) || str(raw.date);
  const stay = str(raw.stay) || str(raw.accommodation);
  const checkIn = str(raw.check_in);
  const checkOut = str(raw.check_out);
  const dest = str(raw.transfer_destination) || str(raw.destination);
  const tDate = str(raw.transfer_date) || str(raw.date_from);
  const tDateTo = str(raw.transfer_date_to) || str(raw.date_to);

  const wantTour = Boolean(tour);
  const wantStay = Boolean(stay);
  const wantTransfer = Boolean(dest);
  if (!wantTour && !wantStay && !wantTransfer) {
    return { tripId: null, legs: [], text: 'В поездке нет ни одной части — заявка не создана. Передайте tour+tour_date, stay+check_in+check_out и/или transfer_destination+transfer_date.' };
  }
  const missing: string[] = [];
  if (wantTour && !tourDate) missing.push('tour_date');
  if (wantStay && (!checkIn || !checkOut)) missing.push('check_in/check_out');
  if (wantTransfer && !tDate) missing.push('transfer_date');
  if (missing.length) {
    return { tripId: null, legs: [], text: `Не хватает дат: ${missing.join(', ')} — заявка не создана.` };
  }

  const tripId = (deps.newTripId ?? newTripId)();
  const parts: string[] = [];
  if (wantTour) parts.push(`тур «${tour}» ${tourDate}`);
  if (wantStay) parts.push(`жильё «${stay}» ${checkIn}–${checkOut}`);
  if (wantTransfer) parts.push(`машина «${dest}» ${tDate}${tDateTo ? `–${tDateTo}` : ''}`);
  const peopleLine = people !== undefined ? `, ${str(people)} чел.` : '';
  const tripLine = `[Поездка ${tripId}${peopleLine}] В этой же поездке: ${parts.join('; ')}.`;
  const userComment = str(raw.comment);
  const comment = (tripLine + (userComment ? ` ${userComment}` : '')).slice(0, 1000);

  const common = { name: raw.name, phone: raw.phone, consent: raw.consent, comment };
  const legs: TripLegResult[] = [];
  const run = async (kind: LegKind, fn: () => Promise<string>) => {
    try {
      const text = await fn();
      legs.push({ kind, ok: !legFailed(text), text });
    } catch (err) {
      legs.push({ kind, ok: false, text: err instanceof Error ? err.message : 'Часть не создана.' });
    }
  };

  if (wantTour) {
    await run('tour', () => deps.bookTour({ ...common, tour, date: tourDate, ...(people !== undefined ? { participants: people } : {}), notify_url: raw.notify_url }));
  }
  if (wantStay) {
    await run('stay', () => deps.requestStay({ ...common, accommodation: stay, check_in: checkIn, check_out: checkOut, ...(people !== undefined ? { guests: people } : {}) }));
  }
  if (wantTransfer) {
    await run('transfer', async () => {
      const charterArgs = {
        ...common, destination: dest, date_from: tDate, ...(tDateTo ? { date_to: tDateTo } : {}),
        passengers: people ?? 1, ...(str(raw.carrier) ? { carrier: str(raw.carrier) } : {}), notify_url: raw.notify_url,
      };
      const t = await deps.requestCharter(charterArgs);
      if (!needsCarrierChoice(t)) return t;
      // Перевозчик не выбран — машину подберёт менеджер Ведара.
      const lead = await deps.createLead({
        ...common,
        comment: `${comment} Машина под заказ: ${dest}, ${tDate}${tDateTo ? `–${tDateTo}` : ''}, перевозчика подобрать.`.slice(0, 1000),
        interest: 'Трансфер / машина под заказ',
      });
      return `Машину подберёт менеджер Ведара (перевозчик не выбран): ${lead}`;
    });
  }

  const LABEL: Record<LegKind, string> = { tour: 'Тур', stay: 'Жильё', transfer: 'Машина' };
  const strip = (t: string) => (deps.confirmNote ? t.split(deps.confirmNote).join('') : t).trim();
  const okCount = legs.filter((l) => l.ok).length;
  const head = okCount === 0
    ? `Поездка ${tripId}: ни одна часть не создана.`
    : `Поездка ${tripId}: создано частей ${okCount} из ${legs.length}. Каждый партнёр видит в заявке всю поездку (номер ${tripId}).`;
  const body = legs.map((l) => `— ${LABEL[l.kind]}: ${l.ok ? 'создано' : 'НЕ создано'}. ${strip(l.text)}`).join('\n');
  return { tripId, legs, text: `${head}\n${body}${okCount > 0 ? deps.confirmNote : ''}` };
}
