/**
 * POST /api/webhooks/payments — НЕ РАБОТАЕТ, отвечает 501.
 *
 * История (аудит бизнес-процессов 25.07): маршрут изображал мульти-шлюзовой
 * приём вебхуков (Yandex Kassa / Stripe / Sberbank), но:
 *  - подпись читалась из заголовка и НИКОГДА не проверялась (проверка жила
 *    только в комментарии);
 *  - вся обработка звала `paymentService.handleWebhook(...)`, которого у
 *    PaymentService нет — метод был выдуман приведением
 *    `paymentService as unknown as { handleWebhook(...) }`, поэтому tsc молчал,
 *    а рантайм падал на TypeError;
 *  - падение ловилось и наружу уходило 200 OK, так что шлюз считал уведомление
 *    принятым и не повторял его.
 *
 * То есть маршрут молча терял платежи и рапортовал об успехе. Для платформы,
 * которая обещает «не врать», честный 501 лучше красивого 200.
 *
 * Живые приёмники платежей:
 *  - CloudPayments: /api/payments/webhook и /api/hub/operator/payments/webhook
 *    (HMAC X-Content-HMAC + сверка суммы с operator_bookings.final_price);
 *  - СБП Точка: /api/payments/tochka/webhook (факт оплаты подтверждается
 *    обратным запросом в банк).
 */

import { NextResponse } from 'next/server';

const NOT_IMPLEMENTED =
  'Мульти-шлюзовой приём вебхуков не реализован. CloudPayments — ' +
  '/api/payments/webhook, СБП Точка — /api/payments/tochka/webhook.';

export async function POST() {
  return NextResponse.json({ status: 'not_implemented', message: NOT_IMPLEMENTED }, { status: 501 });
}

export async function GET() {
  return NextResponse.json({ status: 'not_implemented', message: NOT_IMPLEMENTED }, { status: 501 });
}
