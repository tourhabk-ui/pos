'use client';

import Link from 'next/link';
import FinancePageClient from './_FinancePageClient';
import { paymentsOpen } from '@/lib/payments/launch';

/** До старта оплат (не раньше 03.2027) — спокойная заглушка вместо выплат и реквизитов. */
export default function FinanceGate() {
  if (paymentsOpen()) return <FinancePageClient />;
  return (
    <div className="max-w-xl mx-auto p-4 md:p-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]/70 backdrop-blur p-6 space-y-3">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Финансы</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Платежи через платформу пока не принимаются. Туристы оплачивают туры напрямую вам,
          комиссий и выплат нет. Раздел откроется вместе с оплатами — не раньше марта 2027.
        </p>
        <Link href="/hub/operator" className="inline-block text-sm hover:underline" style={{ color: 'var(--ocean)' }}>
          Вернуться в кабинет
        </Link>
      </div>
    </div>
  );
}
