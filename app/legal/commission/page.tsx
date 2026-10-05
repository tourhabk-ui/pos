import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import PageShell from '@/components/shared/PageShell';
import { REQUISITES } from '@/lib/legal/requisites';

/**
 * Условия комиссии Ведар — не действуют.
 *
 * Не действует с 05.10.2026: владелец выключил приём платежей через платформу
 * (lib/payments/accepting). Прежняя редакция описывала Ведар как агента,
 * принимающего оплату (гл. 52 ГК РФ), — она лежит в истории git и
 * возвращается вместе с включением оплаты, отдельным решением.
 * Адрес оставлен, чтобы старые ссылки вели к объяснению, а не к 404.
 */
export const metadata = {
  alternates: { canonical: '/legal/commission' },
  title: 'Условия комиссионного вознаграждения',
  description: 'Условия комиссии Ведар не действуют с 5 октября 2026 г.: платформа не принимает платежи и не удерживает вознаграждение из оплаты.',
  robots: { index: false, follow: true },
};

export default function Page() {
  return (
    <PageShell title="Условия комиссионного вознаграждения">
    <main className="bg-transparent text-[var(--text-primary)] py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <Link href="/legal/offer" className="inline-flex items-center text-[var(--accent)] hover:text-[var(--accent)]/80 mb-8">
          <ChevronLeft className="w-5 h-5 mr-1" />
          Публичная оферта для партнёров
        </Link>

        <h1 className="text-3xl font-bold mb-6">Условия комиссионного вознаграждения</h1>

        <div className="space-y-4 text-[var(--text-secondary)]">
          <p className="text-[var(--text-primary)] font-semibold">Документ не действует с 5 октября 2026 г.</p>
          <p>
            {REQUISITES.brand} ({REQUISITES.shortName}) не принимает платежи пользователей и не является
            агентом партнёров по приёму оплаты. Оплату услуги турист вносит партнёру напрямую, вознаграждение
            платформы из оплаты не удерживается.
          </p>
          <p>
            Действующие условия работы с партнёрами — в{' '}
            <Link href="/legal/offer" className="text-[var(--ocean)] hover:underline">Публичной оферте</Link>,
            условия для пользователей — в{' '}
            <Link href="/legal/terms" className="text-[var(--ocean)] hover:underline">Пользовательском соглашении</Link>.
          </p>
        </div>
      </div>
    </main>
    </PageShell>
  );
}
