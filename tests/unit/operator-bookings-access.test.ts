/**
 * Кабинет оператора, брони — чужое не трогается, запрещённый переход не
 * ставится, отмена записывает возврат (аудит роли оператора 25.09).
 *
 * Найдено: `/api/bookings/[id]/confirm` проверял владение комментарием,
 * `/complete` — никак; кабинет ставил любой статус из любого («отменена» →
 * «подтверждена» при отданных местах), при отмене не писал refund_due, а
 * письмо «подтверждено» не вело туриста к оплате. Статус `pending_payment`
 * тип не знал — такая бронь зависала без кнопок. Календарь глушил ошибки,
 * а список лидов у оператора без партнёрской записи не ставил фильтра вовсе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_TRANSITIONS } from '@/types/booking.types';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('подтверждение и завершение — только своей брони', () => {
  for (const route of ['app/api/bookings/[id]/confirm/route.ts', 'app/api/bookings/[id]/complete/route.ts']) {
    it(route, () => {
      const src = read(route);
      expect(src).toMatch(/operatorOwnsBooking\(bookingId, auth\.userId\)/);
      expect(src).toMatch(/own === 'unknown'[\s\S]{0,300}status: 503/);
      expect(src).toMatch(/own === 'denied'[\s\S]{0,300}status: 404/);
    });
  }

  it('владение идёт через тур к партнёру пользователя, отказ базы — не «нет доступа»', () => {
    const src = read('lib/bookings/operator-owns.ts');
    expect(src).toMatch(/JOIN operator_tours t ON b\.operator_tour_id = t\.id/);
    expect(src).toMatch(/JOIN partners p ON t\.operator_id = p\.id/);
    expect(src).toMatch(/p\.user_id = \$2/);
    expect(src).toMatch(/catch[\s\S]{0,200}console\.error[\s\S]{0,200}return 'unknown'/);
  });
});

describe('переходы статуса брони', () => {
  it('из отменённой и завершённой вернуть нельзя', () => {
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
  });

  it('бронь в оплате можно подтвердить или отменить', () => {
    expect(ALLOWED_TRANSITIONS.pending_payment).toEqual(expect.arrayContaining(['confirmed', 'cancelled']));
  });

  it('кабинет проверяет переход и отвечает 409', () => {
    const src = read('app/api/hub/operator/bookings/[id]/route.ts');
    expect(src).toMatch(/ALLOWED_TRANSITIONS/);
    expect(src).toMatch(/allowed\.includes\(input\.booking_status/);
    expect(src).toMatch(/badTransition[\s\S]{0,300}status: 409/);
  });
});

describe('отмена из кабинета записывает возврат, подтверждение ведёт к оплате', () => {
  const src = read('app/api/hub/operator/bookings/[id]/route.ts');

  it('recordRefundDue в транзакции отмены, как у остальных дверей', () => {
    expect(src).toMatch(/refund = await recordRefundDue\(client, id, true\)/);
  });

  it('письмо о подтверждении ведёт на страницу брони с ключом', () => {
    expect(src).toMatch(/access_token::text AS access_token/);
    expect(src).toMatch(/\/booking-success\/\$\{id\}\?t=/);
    expect(src).toMatch(/<a href="\$\{bookingUrl\}">/);
  });
});

describe('Telegram: мёртвый ловец кнопок снят, уведомление туриста живёт в кабинете', () => {
  it('confirm_/cancel_ в вебхуке бота больше не ловятся', () => {
    const src = read('app/api/telegram/webhook/route.ts');
    expect(src).not.toMatch(/data\.startsWith\('confirm_'\)/);
    expect(src).not.toMatch(/data\.startsWith\('cancel_'\)/);
  });

  it('кабинет шлёт туристу подтверждение со ссылкой на оплату и отмену с возвратом', () => {
    const src = read('app/api/hub/operator/bookings/[id]/route.ts');
    expect(src).toMatch(/notifyTouristBookingConfirmed\(row\.user_id,[\s\S]{0,300}url: bookingUrl/);
    expect(src).toMatch(/notifyTouristBookingCancelled\(row\.user_id,/);
  });

  it('причина отмены от оператора экранируется в письме', () => {
    expect(read('app/api/hub/operator/bookings/[id]/route.ts')).toMatch(/escapeHtml\(input\.cancellation_reason\)/);
  });
});

describe('экраны оператора знают «ждёт оплаты»', () => {
  for (const f of [
    'app/hub/operator/bookings/_BookingsManagementClient.tsx',
    'app/hub/operator/bookings/[id]/_BookingDetailClient.tsx',
    'app/hub/operator/calendar/_CalendarPageClient.tsx',
    'app/hub/tourist/bookings/_BookingHistoryPageClient.tsx',
  ]) {
    it(f, () => {
      expect(read(f)).toMatch(/pending_payment/);
    });
  }

  it('«Отмена» в окне причины не отменяет бронь', () => {
    expect(read('app/hub/operator/bookings/[id]/_BookingDetailClient.tsx')).toMatch(/if \(reason === null\) return;/);
  });

  it('календарь показывает отказ, а не молчит', () => {
    const src = read('app/hub/operator/calendar/_CalendarPageClient.tsx');
    expect(src).toMatch(/role="alert"/);
    expect(src).toMatch(/res\.ok/);
  });
});

describe('ручная бронь доходит до Telegram оператора', () => {
  it('chat id — из колонки, которую пишет привязка бота', () => {
    const src = read('app/api/hub/operator/bookings/route.ts');
    expect(src).toMatch(/p\.telegram_chat_id::text AS telegram_chat_id/);
    expect(src).not.toMatch(/p\.contacts->>'telegram_chat_id' as/);
    expect(src).toMatch(/p\.category = 'operator'/);
  });
});

describe('лиды: скоуп один, ничейный лид становится своим', () => {
  it('список берёт общую формулу владения', () => {
    const src = read('app/api/leads/route.ts');
    expect(src).toMatch(/leadOwnershipCond\(user, vals\.length \+ 1\)/);
    expect(src).not.toMatch(/if \(!isAdmin && operatorId\)/);
  });

  it('правка ничейного лида оператором его занимает', () => {
    expect(read('app/api/leads/[id]/route.ts')).toMatch(/operator_id = COALESCE\(operator_id, \$/);
  });
});
