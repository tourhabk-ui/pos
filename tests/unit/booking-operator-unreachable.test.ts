/**
 * Оператор без мессенджера: турист узнаёт, что ответ может задержаться
 * (04.10, владелец: «нет канала оператору — сообщать туристу»).
 *
 * Администратору задача уже уходит (notifyNewBooking, исход no_channel).
 * Туристу страница заявки обещала обычный ответ оператора, хотя заявка до
 * оператора не доехала и её несёт человек.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const API = readFileSync('app/api/hub/bookings/[id]/route.ts', 'utf8');
const PAGE = readFileSync('app/booking-success/[id]/_BookingSuccessClient.tsx', 'utf8');

describe('страница заявки знает, дойдёт ли заявка до оператора', () => {
  it('роут отдаёт факт достижимости по общему правилу, а не адреса', () => {
    expect(API).toMatch(/operator_reachable: row\.partner_id \? reachFrom\(row\)\.reachable : null/);
    // Адреса оператора наружу не уходят — только булево.
    const payload = API.slice(API.indexOf('return NextResponse.json({\n    success: true'));
    expect(payload).not.toMatch(/telegram_chat_id:|max_chat_id:|user_telegram_id:/);
  });

  it('при false страница говорит, что заявку передаст администрация', () => {
    expect(PAGE).toMatch(/booking\.operator_reachable === false &&/);
    expect(PAGE).toMatch(/заявку ему передаст администрация платформы/);
  });
});
