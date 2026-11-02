/**
 * Черновик для оператора (02.11, владелец: «хорошо Карт-бланш»): к новой
 * заявке — живые места на запрошенную дату и ближайшая свободная дата из
 * базы, в момент отправки (без кэша). Это только подсказка оператору: гостю
 * ничего не уходит, решает оператор кнопками заявки (#2931). Без ПД — строки
 * видны и в Telegram. Не прочиталось — так и сказано, цифр не выдумываем.
 */
import { liveFreeSeats } from '@/lib/operators/live-seats';
import { loadNearestFreeDates } from '@/lib/tours/nearest-free-date';

export interface PredraftFacts {
  /** null — на дату нет строки календаря; 'failed' — база не ответила. */
  seatsOnDate: number | null | 'failed';
  nearest: { date: string; seats: number | null } | null | 'failed';
}

export function predraftLines(date: string, participants: number | null, f: PredraftFacts): string[] {
  const out = ['<b>Черновик для вас</b> (гостю не отправлен):'];
  if (f.seatsOnDate === 'failed') out.push(`- Места на ${date}: не прочитались, проверьте календарь.`);
  else if (f.seatsOnDate == null) out.push(`- На ${date} даты в календаре нет.`);
  else {
    const enough = participants == null || f.seatsOnDate >= participants;
    out.push(`- Свободно на ${date}: ${f.seatsOnDate}${participants ? ` (просят ${participants})` : ''}.`);
    if (enough && f.seatsOnDate > 0) { out.push('- Мест хватает — можно «Подтвердить».'); return out; }
  }
  if (f.nearest === 'failed') out.push('- Ближайшая свободная дата не прочиталась.');
  else if (f.nearest && f.nearest.date !== date) out.push(`- Ближайшая свободная дата: ${f.nearest.date}${f.nearest.seats != null ? ` (мест ${f.nearest.seats})` : ''} — можно «Другая дата».`);
  else if (!f.nearest) out.push('- Свободных дат в календаре нет.');
  return out;
}

export async function loadPredraftFacts(tourId: number, date: string): Promise<PredraftFacts> {
  const seatsOnDate: PredraftFacts['seatsOnDate'] = await liveFreeSeats(tourId, date);
  const nd = await loadNearestFreeDates([tourId]);
  const nearest: PredraftFacts['nearest'] = nd.state === 'failed' ? 'failed'
    : nd.byId.get(String(tourId)) ? { date: nd.byId.get(String(tourId))!, seats: nd.seatsById.get(String(tourId)) ?? null } : null;
  return { seatsOnDate, nearest };
}

export async function operatorPredraft(tourId: number, date: string, participants: number | null): Promise<string[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  return predraftLines(date, participants, await loadPredraftFacts(tourId, date));
}
