/**
 * lib/mcp/request-confirm-note.ts — честная строка после успешной заявки.
 *
 * Повод — снимок CTO 31.10: после create_booking_request ассистент сказал
 * человеку «прямой доступ к базе сервиса временно ограничен, заявки
 * передаются специалисту в ручном режиме». База не лежала: мгновенного
 * бронирования нет by design, заявку всегда подтверждает человек. Модель,
 * не найдя объяснения, придумала сбой. Теперь объяснение приходит в ответе
 * инструмента — готовой фразой для человека на RU / EN / ZH.
 *
 * Модуль чистый (без базы): его читают route.ts и сторож Кузьмича.
 */
import { platformAcceptsPayments } from '@/lib/payments/accepting';

export function requestConfirmNote(acceptsPayments: boolean = platformAcceptsPayments()): string {
  const ru = 'Заявка создана. Оператор свяжется с вами для подтверждения. Мгновенного бронирования нет — подтверждает человек'
    + (acceptsPayments ? '.' : ', оплаты через платформу нет.');
  const en = 'Request created. The operator will contact you to confirm. There is no instant booking — a human confirms'
    + (acceptsPayments ? '.' : ', no payment through the platform.');
  const zh = '申请已创建。运营方会联系您确认。没有即时预订——由人工确认' + (acceptsPayments ? '。' : '，平台不收款。');
  return `\n\nСкажи человеку его языком: RU: ${ru} EN: ${en} ZH: ${zh} `
    + 'Это штатный порядок, а не сбой: не пиши, что база недоступна, доступ временно ограничен или заявка обрабатывается в ручном режиме из-за ограничений.';
}

