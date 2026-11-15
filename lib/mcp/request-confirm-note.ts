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

/**
 * Дойдёт ли заявка до оператора его мессенджером (разбор промпта 15.11, п. 3).
 *
 * `channel` — у оператора есть MAX или Telegram: заявка уходит ему лично.
 * `none` — адреса нет: заявку ему передаст команда Ведара (она получает
 * каждую заявку в рабочий чат). `unknown` — адреса прочитать не удалось.
 * До этого человек всегда слышал «оператор свяжется», и тогда, когда оператор
 * о заявке не знал.
 */
export type OperatorReach = 'channel' | 'none' | 'unknown';

/** Начало строки «передаст команда Ведара» — по нему чат узнаёт исход (lib/kuzmich/chat-request). */
export const OPERATOR_NO_CHANNEL_MARK = 'Оператор пока не подключил мессенджер';
export const OPERATOR_REACH_UNKNOWN_MARK = 'Дошла ли заявка до оператора, проверить не удалось';

/** Строка о передаче оператору — словами для человека; у `channel` пусто. */
export function operatorReachLine(reach: OperatorReach): string {
  if (reach === 'none') return `${OPERATOR_NO_CHANNEL_MARK}: заявку ему передаст команда Ведара, после этого он свяжется с вами.`;
  if (reach === 'unknown') return `${OPERATOR_REACH_UNKNOWN_MARK}: если не дойдёт, её передаст команда Ведара.`;
  return '';
}

export function requestConfirmNote(acceptsPayments: boolean = platformAcceptsPayments(), reach: OperatorReach = 'channel'): string {
  // Строка о передаче (`operatorReachLine`) стоит в ответе инструмента
  // отдельно: поездка целиком вырезает эту фразу из частей, а исход передачи
  // по каждой части должен остаться виден.
  const contactRu = reach === 'channel'
    ? 'Оператор свяжется с вами для подтверждения.'
    : reach === 'none'
      ? 'Оператор свяжется с вами, когда заявку ему передаст команда Ведара.'
      : 'Если заявка не дойдёт до оператора, её передаст команда Ведара.';
  const contactEn = reach === 'channel'
    ? 'The operator will contact you to confirm.'
    : reach === 'none'
      ? 'The operator has not connected a messenger yet: the Vedar team will pass the request on, then the operator will contact you.'
      : 'We could not check that the request reached the operator: if it does not, the Vedar team will pass it on.';
  const contactZh = reach === 'channel'
    ? '运营方会联系您确认。'
    : reach === 'none' ? '运营方尚未连接即时通讯：Vedar 团队会转交申请，之后运营方会联系您。' : '无法确认申请是否已送达运营方：如未送达，Vedar 团队会转交。';
  const ru = `Заявка создана. ${contactRu} Мгновенного бронирования нет — подтверждает человек`
    + (acceptsPayments ? '.' : ', оплаты через платформу нет.');
  const en = `Request created. ${contactEn} There is no instant booking — a human confirms`
    + (acceptsPayments ? '.' : ', no payment through the platform.');
  const zh = `申请已创建。${contactZh}没有即时预订——由人工确认` + (acceptsPayments ? '。' : '，平台不收款。');
  return `\n\nСкажи человеку его языком: RU: ${ru} EN: ${en} ZH: ${zh} `
    + 'Это штатный порядок, а не сбой: не пиши, что база недоступна, доступ временно ограничен или заявка обрабатывается в ручном режиме из-за ограничений.';
}

