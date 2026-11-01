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
import { getPublicBaseUrl } from '@/lib/config';

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

const MANAGER_PENDING = '__manager_pending__';

/** Страница поездки: ключи частей — во фрагменте (#), на сервер и в метрику не уходят. */
export function tripPageUrl(tripId: string, keys: string[], base = getPublicBaseUrl()): string {
  return `${base.replace(/\/$/, '')}/trip-request/${tripId}#${keys.join('.')}`;
}

export function newTripId(): string {
  return 'TRIP-' + randomBytes(3).toString('hex').toUpperCase();
}

export async function runTripRequest(raw: Record<string, unknown>, deps: TripDeps): Promise<{ text: string; tripId: string | null; legs: TripLegResult[]; tripUrl?: string | null }> {
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
  // Жильё без названия объекта (02.11): отдельная часть «жильё на подбор» —
  // менеджеру Ведара с датами и гостями, а не строчка в комментарии.
  const wantStayMatch = !wantStay && (raw.stay_wanted === true || raw.stay_wanted === 'true' || str(raw.lodging) !== '');
  const wantTransfer = Boolean(dest);
  if (!wantTour && !wantStay && !wantStayMatch && !wantTransfer) {
    return { tripId: null, legs: [], text: 'В поездке нет ни одной части — заявка не создана. Передайте tour+tour_date, stay+check_in+check_out и/или transfer_destination+transfer_date.' };
  }
  const missing: string[] = [];
  if (wantTour && !tourDate) missing.push('tour_date');
  if (wantStay && (!checkIn || !checkOut)) missing.push('check_in/check_out');
  if (wantStayMatch && !checkIn) missing.push('check_in');
  if (wantTransfer && !tDate) missing.push('transfer_date');
  if (missing.length) {
    return { tripId: null, legs: [], text: `Не хватает дат: ${missing.join(', ')} — заявка не создана.` };
  }

  const tripId = (deps.newTripId ?? newTripId)();
  const parts: string[] = [];
  if (wantTour) parts.push(`тур «${tour}» ${tourDate}`);
  if (wantStay) parts.push(`жильё «${stay}» ${checkIn}–${checkOut}`);
  if (wantStayMatch) parts.push(`жильё на подбор ${checkIn}${checkOut ? `–${checkOut}` : ''}`);
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
  // Части без адресата (машина без перевозчика, жильё на подбор) — ОДНА
  // заявка менеджеру: две create_lead на один телефон за сутки не пропустит write-guard.
  const manager: { kind: LegKind; line: string }[] = [];
  if (wantTransfer) {
    await run('transfer', async () => {
      const charterArgs = {
        ...common, destination: dest, date_from: tDate, ...(tDateTo ? { date_to: tDateTo } : {}),
        passengers: people ?? 1, ...(str(raw.carrier) ? { carrier: str(raw.carrier) } : {}), notify_url: raw.notify_url,
      };
      const t = await deps.requestCharter(charterArgs);
      if (!needsCarrierChoice(t)) return t;
      manager.push({ kind: 'transfer', line: `Машина под заказ: ${dest}, ${tDate}${tDateTo ? `–${tDateTo}` : ''}, перевозчика подобрать.` });
      return MANAGER_PENDING;
    });
  }
  if (wantStayMatch) {
    legs.push({ kind: 'stay', ok: true, text: MANAGER_PENDING });
    manager.push({ kind: 'stay', line: `Жильё на подбор: заезд ${checkIn}${checkOut ? `, выезд ${checkOut}` : ''}${people !== undefined ? `, гостей ${str(people)}` : ''}.` });
  }
  if (manager.length) {
    let leadText: string;
    let ok = true;
    try {
      leadText = await deps.createLead({
        ...common,
        comment: `${comment} ${manager.map((m) => m.line).join(' ')}`.slice(0, 2000),
        interest: manager.map((m) => (m.kind === 'stay' ? 'Жильё на подбор' : 'Трансфер / машина под заказ')).join(' + '),
        ...(people !== undefined ? { participants: people } : {}),
      });
      ok = !legFailed(leadText);
    } catch (err) {
      leadText = err instanceof Error ? err.message : 'Часть не создана.';
      ok = false;
    }
    const what = (k: LegKind) => (k === 'stay' ? 'Жильё подберёт менеджер Ведара (объект не назван)' : 'Машину подберёт менеджер Ведара (перевозчик не выбран)');
    manager.forEach((m, i) => {
      const leg = legs.find((l) => l.kind === m.kind && l.text === MANAGER_PENDING);
      if (!leg) return;
      leg.ok = ok;
      leg.text = i === 0 ? `${what(m.kind)}: ${leadText}` : `${what(m.kind)} — в той же заявке менеджеру.`;
    });
  }

  const LABEL: Record<LegKind, string> = { tour: 'Тур', stay: 'Жильё', transfer: 'Машина' };
  const strip = (t: string) => (deps.confirmNote ? t.split(deps.confirmNote).join('') : t).trim();
  const okCount = legs.filter((l) => l.ok).length;
  const head = okCount === 0
    ? `Поездка ${tripId}: ни одна часть не создана.`
    : `Поездка ${tripId}: создано частей ${okCount} из ${legs.length}. Каждый партнёр видит в заявке всю поездку (номер ${tripId}).`;
  const keys = [...new Set(legs.flatMap((l) => [...l.text.matchAll(/Ключ статуса заявки: ([\w-]{16,64})/g)].map((m) => m[1])))];
  const tripUrl = okCount > 0 && keys.length ? tripPageUrl(tripId, keys) : null;
  const tripNote = tripUrl ? `\nВся поездка одной ссылкой для человека: ${tripUrl} (части, статус каждой, согласие). Ссылку не публикуйте.` : '';
  const body = legs.map((l) => `— ${LABEL[l.kind]}: ${l.ok ? 'создано' : 'НЕ создано'}. ${strip(l.text)}`).join('\n');
  return { tripId, legs, tripUrl, text: `${head}\n${body}${tripNote}${okCount > 0 ? deps.confirmNote : ''}` };
}
