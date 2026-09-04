/**
 * lib/payments/availability.ts — какими способами турист может заплатить.
 *
 * ── Что нашлось 04.09 ──────────────────────────────────────────────────────
 *
 * Воронка за неделю: 88 визитов, 22 просмотра тура, 1 заявка, **0 оплат**.
 * Причина нашлась не в спросе, а в расхождении ИМЁН одной переменной:
 *
 *   components/booking/TourPaymentModal.tsx  → NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID
 *   app/api/hub/bookings/[id]/route.ts       → CLOUDPAYMENTS_PUBLIC_ID
 *   .env.example                             → только NEXT_PUBLIC_…
 *
 * Какое бы одно имя ни было заведено на проде, одна из двух поверхностей
 * оставалась без ключа. А страница брони, куда приходит КАЖДАЯ заявка с сайта,
 * прячет весь платёжный блок при пустом ключе — молча, продолжая обещать
 * «переходите к оплате». Турист видел заявку, контакты оператора и ни одной
 * кнопки заплатить.
 *
 * Отсюда правило: имя переменной спрашивают ЗДЕСЬ, а не в месте применения.
 * Оба имени равноправны — серверному коду префикс NEXT_PUBLIC_ не нужен, но и
 * не мешает, а заставлять владельца заводить одно и то же дважды — способ
 * получить третье расхождение.
 *
 * ── Третье состояние (§4.0) ────────────────────────────────────────────────
 *
 * «Способ не настроен» — не то же самое, что «способа нет». Вызывающий обязан
 * различать: показать другой способ, а если способов не осталось — сказать
 * человеку прямо, а не прятать блок. Прятать значит выдавать поломку за
 * замысел.
 */

/** Публичный id CloudPayments под любым из двух имён. null — не настроен. */
export function cloudPaymentsPublicId(): string | null {
  const raw = process.env.CLOUDPAYMENTS_PUBLIC_ID
    ?? process.env.NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID
    ?? '';
  const id = raw.trim();
  return id.length > 0 ? id : null;
}

/**
 * СБП через Точку готова только когда есть ВСЕ три: ключ, мерчант, счёт.
 * Частичная настройка — это «не настроено»: QR не выпустится, а кнопка
 * пообещает.
 */
export function sbpConfigured(): boolean {
  return Boolean(
    process.env.TOCHKA_JWT_TOKEN?.trim()
    && process.env.TOCHKA_MERCHANT_ID?.trim()
    && process.env.TOCHKA_ACCOUNT_ID?.trim(),
  );
}

export interface PaymentAvailability {
  /** Публичный id для виджета карты; null — картой платить нельзя. */
  cardPublicId: string | null;
  /** Готова ли оплата по QR СБП. */
  sbp: boolean;
  /** Ни одного способа. Не «скрыть блок», а сказать вслух. */
  none: boolean;
}

export function paymentAvailability(): PaymentAvailability {
  const cardPublicId = cloudPaymentsPublicId();
  const sbp = sbpConfigured();
  return { cardPublicId, sbp, none: !cardPublicId && !sbp };
}

/**
 * Какими ИМЕНАМИ переменных настроен каждый способ — для диагностики.
 * Возвращает только имена и признаки, НИКОГДА значения: этим ответом
 * пользуются пробы, а проба не должна становиться утечкой ключа.
 */
export function paymentConfigNames(): {
  card: { configured: boolean; via: string | null };
  sbp: { configured: boolean; missing: string[] };
} {
  const via = process.env.CLOUDPAYMENTS_PUBLIC_ID?.trim()
    ? 'CLOUDPAYMENTS_PUBLIC_ID'
    : process.env.NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID?.trim()
      ? 'NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID'
      : null;
  const missing = (['TOCHKA_JWT_TOKEN', 'TOCHKA_MERCHANT_ID', 'TOCHKA_ACCOUNT_ID'] as const)
    .filter((name) => !process.env[name]?.trim());
  return {
    card: { configured: via !== null, via },
    sbp: { configured: missing.length === 0, missing: [...missing] },
  };
}
