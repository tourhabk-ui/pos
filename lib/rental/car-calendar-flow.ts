/**
 * Календарь проката в чате партнёра. Пишет только кнопка заверенного
 * апдейта из личного диалога; фраза «календарь» ничего не отмечает.
 * Партнёр и slug — из привязанного чата, не из payload.
 */

import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import {
  type CalendarButton, type CalendarCar, calendarAsk, calendarBody, calendarButtons, carPickButtons,
  horizonEnd, pageStartFor, parseCalendarPress,
} from '@/lib/rental/car-calendar';
import { loadCalendarCars, loadCalendarMarks, setOperatorMark } from '@/lib/rental/car-calendar-store';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';

export interface CalendarActor {
  partnerId: string;
  partnerName: string;
  slug?: string | null;
}

export type CalendarSend = (
  text: string,
  buttons: CalendarButton[][],
  editMid: string | null,
) => Promise<void>;

const READ_FAILED = 'НЕ УДАЛОСЬ ПРОЧИТАТЬ календарь проката. Не говорите, свободна машина или занята; спросите позже.';
const NOT_A_DIALOG = 'Календарь проката отмечается в личном диалоге с ботом. В этом чате отметку не ставлю и список машин не показываю.';

function owned(cars: CalendarCar[], offerId: string): CalendarCar | undefined {
  return cars.find((c) => c.id === offerId);
}

async function show(opts: {
  cars: CalendarCar[];
  query: string;
  today: string;
  focus: CalendarCar | null;
  canMark: boolean;
  notice: string | null;
  editMid: string | null;
  send: CalendarSend;
}): Promise<void> {
  let marks = new Map<string, boolean>();
  if (opts.focus) {
    const loaded = await loadCalendarMarks(opts.focus.id, opts.today, horizonEnd(opts.today));
    if (loaded === 'db_error') {
      await opts.send(READ_FAILED, [], opts.editMid);
      return;
    }
    marks = loaded;
  }
  const text = calendarBody({
    cars: opts.cars, query: opts.query, today: opts.today, focus: opts.focus, marks, canMark: opts.canMark, notice: opts.notice,
  });
  const buttons = !opts.canMark ? []
    : opts.focus
      ? calendarButtons({
        today: opts.today, offerId: opts.focus.id, start: pageStartFor(opts.today, opts.today) ?? opts.today, showList: opts.cars.length > 1,
      })
      : carPickButtons(opts.cars);
  await opts.send(text, buttons, opts.editMid);
}

async function showWindow(opts: {
  car: CalendarCar;
  cars: CalendarCar[];
  today: string;
  start: string;
  canMark: boolean;
  notice: string | null;
  editMid: string | null;
  send: CalendarSend;
}): Promise<void> {
  const loaded = await loadCalendarMarks(opts.car.id, opts.today, horizonEnd(opts.today));
  if (loaded === 'db_error') {
    await opts.send(opts.notice ? `${opts.notice}\n${READ_FAILED}` : READ_FAILED, [], opts.editMid);
    return;
  }
  const text = calendarBody({
    cars: opts.cars, query: '', today: opts.today, focus: opts.car, marks: loaded, canMark: opts.canMark, notice: opts.notice,
  });
  const buttons = opts.canMark
    ? calendarButtons({ today: opts.today, offerId: opts.car.id, start: opts.start, showList: opts.cars.length > 1 })
    : [];
  await opts.send(text, buttons, opts.editMid);
}

export async function handleRentalCalendarText(opts: {
  partner: CalendarActor;
  text: string;
  nowMs: number;
  dialog: boolean;
  canMark: boolean;
  send: CalendarSend;
}): Promise<boolean> {
  const ask = calendarAsk(opts.text);
  if (!ask || !isRentalPilotSlug(opts.partner.slug)) return false;
  if (!opts.dialog) {
    await opts.send(NOT_A_DIALOG, [], null);
    return true;
  }
  const today = kamchatkaDate(new Date(opts.nowMs));
  const loaded = await loadCalendarCars(opts.partner.partnerId, ask.car);
  if (loaded.outcome === 'db_error') {
    await opts.send(READ_FAILED, [], null);
    return true;
  }
  const focus = loaded.cars.length === 1 ? loaded.cars[0]! : null;
  await show({
    cars: loaded.cars, query: ask.car, today, focus,
    canMark: opts.canMark, notice: null, editMid: null, send: opts.send,
  });
  return true;
}

/** Текст для модели: только чтение, без обещания кнопок под этим ответом. */
export async function rentalCalendarToolText(partnerId: string, car: string, nowMs: number): Promise<string> {
  const today = kamchatkaDate(new Date(nowMs));
  const loaded = await loadCalendarCars(partnerId, car);
  if (loaded.outcome === 'db_error') return READ_FAILED;
  const focus = loaded.cars.length === 1 ? loaded.cars[0]! : null;
  let marks = new Map<string, boolean>();
  if (focus) {
    const read = await loadCalendarMarks(focus.id, today, horizonEnd(today));
    if (read === 'db_error') return READ_FAILED;
    marks = read;
  }
  return calendarBody({ cars: loaded.cars, query: car, today, focus, marks, canMark: false });
}

export async function handleRentalCalendarPress(opts: {
  lookup: { outcome: 'found'; partner: CalendarActor } | { outcome: 'unavailable' | 'none' };
  payload: string;
  nowMs: number;
  editMid: string | null;
  send: CalendarSend;
}): Promise<void> {
  const press = parseCalendarPress(opts.payload);
  if (!press) {
    await opts.send('Кнопка календаря не распознана. Отметка не записана.', [], opts.editMid);
    return;
  }
  if (opts.lookup.outcome === 'unavailable') {
    await opts.send('Не удалось проверить, ваш ли это чат. Отметка не записана.', [], opts.editMid);
    return;
  }
  if (opts.lookup.outcome !== 'found') {
    await opts.send('Этот чат не подключён к прокатчику. Отметка не записана.', [], opts.editMid);
    return;
  }
  const partner = opts.lookup.partner;
  if (!isRentalPilotSlug(partner.slug)) {
    await opts.send('Календарь проката в этом чате не ведётся. Отметка не записана.', [], opts.editMid);
    return;
  }
  const today = kamchatkaDate(new Date(opts.nowMs));
  const loaded = await loadCalendarCars(partner.partnerId, '');
  if (loaded.outcome === 'db_error') {
    await opts.send(READ_FAILED, [], opts.editMid);
    return;
  }

  if (press.kind === 'list') {
    await show({
      cars: loaded.cars, query: '', today, focus: loaded.cars.length === 1 ? loaded.cars[0]! : null,
      canMark: true, notice: null, editMid: opts.editMid, send: opts.send,
    });
    return;
  }

  const car = owned(loaded.cars, press.offerId);
  if (!car) {
    await opts.send('Эта машина не в вашем прайсе. Отметка не записана.', [], opts.editMid);
    return;
  }

  if (press.kind === 'open') {
    const start = pageStartFor(today, today);
    if (!start) {
      await opts.send(READ_FAILED, [], opts.editMid);
      return;
    }
    await showWindow({
      car, cars: loaded.cars, today, start, canMark: true, notice: null, editMid: opts.editMid, send: opts.send,
    });
    return;
  }

  if (press.kind === 'window') {
    if (pageStartFor(today, press.start) !== press.start) {
      await opts.send('Эта страница календаря не открывается. Отметка не записана.', [], opts.editMid);
      return;
    }
    await showWindow({
      car, cars: loaded.cars, today, start: press.start, canMark: true, notice: null, editMid: opts.editMid, send: opts.send,
    });
    return;
  }

  const start = pageStartFor(today, press.day);
  if (!start) {
    await opts.send('Этот день вне ближайших 30. Отметка не записана.', [], opts.editMid);
    return;
  }
  const wrote = await setOperatorMark(partner.partnerId, car.id, press.day, press.busy);
  if (wrote === 'not_yours') {
    await opts.send('Эта машина не в вашем прайсе. Отметка не записана.', [], opts.editMid);
    return;
  }
  const notice = wrote === 'db_error'
    ? 'Отметку записать не удалось. Календарь ниже — как был до нажатия, если его удалось прочитать.'
    : null;
  await showWindow({
    car, cars: loaded.cars, today, start, canMark: true, notice, editMid: opts.editMid, send: opts.send,
  });
}
