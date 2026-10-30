/**
 * lib/mcp/payment-rule.ts — что говорить агентам об оплате, на трёх языках.
 *
 * Оплата тура — по выключателю (lib/payments/accepting.ts, решение владельца
 * 05.10). Машина под заказ, прокат и жильё через платформу не оплачиваются
 * никогда (CLAUDE.md §14, описания request_charter, create_car_rental_request,
 * create_stay_request) — эта половина от выключателя не зависит.
 *
 * Читают: инструкция сервера в рукопожатии MCP (server-instructions) и файлы
 * для агентов /llms.txt, /llms-en.txt, /llms-zh.txt. До 30.10 llms-файлы
 * говорили «оплаты через платформу нет» безусловно: включи владелец оплату —
 * инструкция сервера сказала бы одно, а llms.txt другое.
 *
 * Модуль чистый — без базы: /llms-*.txt и страница /mcp собираются без неё.
 * Выключатель передаётся параметром, чтобы сторож проверил оба положения.
 */

/** По-русски: инструкция сервера (правило 8) и /llms.txt. */
export function paymentRule(acceptsPayments: boolean): string {
  return (acceptsPayments
    ? 'Оплата тура — только после подтверждения оператором; как оплатить, скажет он'
    : 'Ведар сейчас оплату не принимает: тур оплачивают исполнителю напрямую')
    + '; машина под заказ, прокат и жильё через платформу не оплачиваются.';
}

/** In English: /llms-en.txt and the English block of /llms.txt. */
export function paymentRuleEn(acceptsPayments: boolean): string {
  return (acceptsPayments
    ? 'A tour is paid only after the operator confirms the request, and the operator tells how to pay'
    : 'Vedar does not accept payments right now: tours are paid to the operator directly')
    + '; vehicle charters, self-drive car rental and accommodation are not paid through the platform.';
}

/** 中文: /llms-zh.txt и китайский раздел /llms.txt. */
export function paymentRuleZh(acceptsPayments: boolean): string {
  return (acceptsPayments
    ? '团队游须经旅行社确认后付款，付款方式由旅行社告知'
    : 'Vedar 目前不收款：团队游费用直接付给旅行社')
    + '；包车、租车和住宿不通过平台付款。';
}
