/**
 * Действия над бронью: ответ читается, отмена спрашивает (#1802).
 *
 * `updateStatus` глотал ответ в пустой catch — 4xx/5xx выглядели как успех,
 * список просто перезагружался со старым статусом. «Отменить» при этом
 * срабатывало с первого касания, кнопкой в 24 px, рядом с «Принять».
 * Отмена видна туристу и необратима для оператора — значит спрашиваем до.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const LIST = read('app/hub/operator/bookings/_BookingsManagementClient.tsx');
const DETAIL = read('app/hub/operator/bookings/[id]/_BookingDetailClient.tsx');

describe('список броней: смена статуса', () => {
  it('ответ PATCH читается, отказ виден и в логе, и на экране', () => {
    expect(LIST).toMatch(/const res = await fetch\(`\/api\/hub\/operator\/bookings\/\$\{id\}`/);
    expect(LIST).toMatch(/if \(!res\.ok \|\| json\?\.success === false\)/);
    expect(LIST).toMatch(/console\.error\('\[bookings\] статус не изменён'/);
    expect(LIST).toMatch(/setActionError\(/);
    // Ни один запрос экрана больше не глушится молча — ни статус, ни список.
    expect(LIST).not.toMatch(/non-fatal/);
    expect(LIST).toMatch(/console\.error\('\[bookings\] список не загружен:'/);
  });

  it('двойное нажатие не шлёт второй PATCH', () => {
    expect(LIST).toMatch(/if \(busyId\) return;/);
    expect(LIST).toMatch(/disabled=\{busyId !== null\}/);
  });

  it('отмена и «не явился» идут через подтверждение, остальное — сразу', () => {
    expect(LIST).toMatch(/status === 'cancelled' \|\| status === 'no_show'/);
    expect(LIST).toMatch(/setConfirmAction\(/);
    expect(LIST).toMatch(/Отменить бронь\?/);
    expect(LIST).toMatch(/Вернуть бронь самостоятельно нельзя/);
    // Прямых вызовов updateStatus из разметки не осталось — только requestStatus.
    expect(LIST).not.toMatch(/onClick=\{\(\) => updateStatus\(/);
  });

  it('диалог непрозрачный: стекла на критичном действии нет (DS §5)', () => {
    const dialog = LIST.slice(LIST.indexOf('booking-confirm-title'), LIST.indexOf('Не надо'));
    expect(dialog).toMatch(/bg-\[var\(--bg-card\)\]/);
    expect(dialog).not.toMatch(/backdrop-blur/);
  });

  it('тач-цели действий на телефоне — 44 px', () => {
    const actions = LIST.slice(LIST.indexOf('{/* Actions */}'), LIST.indexOf('{/* Actions */}') + 1900);
    const buttons = actions.split('<button').slice(1);
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) {
      const cls = (b.match(/className="[^"]*"/) ?? [''])[0];
      expect(cls, cls).toMatch(/min-h-\[44px\]/);
    }
  });
});

describe('карточка брони: отмена уже спрашивала причину', () => {
  it('читает ответ и показывает исход', () => {
    expect(DETAIL).toMatch(/if \(!res\.ok\) throw new Error/);
    expect(DETAIL).toMatch(/setNotification\(\{ type: 'error'/);
  });
});
