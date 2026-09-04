/**
 * GET /api/cron/payment-config — какими способами турист МОЖЕТ заплатить прямо
 * сейчас. Bearer CRON_SECRET, только чтение, без обращения к БД.
 *
 * Зачем. 04.09: воронка за неделю — 88 визитов, 22 просмотра тура, 1 заявка,
 * 0 оплат. Причина нашлась чтением кода: страница брони читала публичный ключ
 * CloudPayments под именем `CLOUDPAYMENTS_PUBLIC_ID`, модал оплаты — под
 * `NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID`, а `.env.example` документировал
 * только второе. При пустом ключе платёжный блок исчезал МОЛЧА, и «0 оплат»
 * было неотличимо от «никто не захотел».
 *
 * Проба отвечает на вопрос «настроено ли», а не «работает ли»: настоящую
 * оплату подтверждает только прошедший платёж, и выдавать наличие ключа за
 * рабочий приём денег нельзя. Отсюда `verdict: 'configured' | 'nothing'` —
 * без слова «работает».
 *
 * ЗНАЧЕНИЙ КЛЮЧЕЙ ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ. Возвращаются только имена
 * переменных и признаки настроенности: проба, отдающая ключ, — это утечка,
 * а не диагностика (09.08, секрет в query уехал на сторонний хост).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { paymentAvailability, paymentConfigNames } from '@/lib/payments/availability';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const availability = paymentAvailability();
  const names = paymentConfigNames();

  return NextResponse.json({
    probe: 'payment_config_v1',
    checked_at: new Date().toISOString(),
    card: {
      configured: names.card.configured,
      // Каким именно именем задан ключ. Именно расхождение имён и стоило нам
      // платёжного блока — поэтому имя показывается, а значение нет.
      via: names.card.via,
      accepted_names: ['CLOUDPAYMENTS_PUBLIC_ID', 'NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID'],
    },
    sbp: {
      configured: names.sbp.configured,
      missing: names.sbp.missing,
    },
    // Ни одного способа — турист оставляет заявку и не может заплатить.
    nothing_available: availability.none,
    verdict: availability.none ? 'nothing' : 'configured',
    note: availability.none
      ? 'Ни карта, ни СБП не настроены: страница брони покажет «онлайн-оплата недоступна» и контакты оператора'
      : 'Способ оплаты настроен. Это факт о конфигурации, а не доказательство прошедшего платежа',
  });
}
