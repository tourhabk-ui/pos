import type { Metadata } from 'next';
import { CarRentalPage } from '@/components/rental/CarRentalPage';
import { loadRentalCompanies, type RentalState } from '@/lib/rental/rental';

export const metadata: Metadata = {
  alternates: { canonical: '/car-rental' },
  title: 'Аренда автомобилей на Камчатке — машина без водителя',
  description:
    'Машины напрокат без водителя у прокатчиков Камчатки: цена за сутки за машину по прайсу, внедорожники и микроавтобусы. Заявка — на странице прокатчика, оплата — ему напрямую.',
};

// Прайс читается из базы на каждый запрос: статическая страница запекла бы
// в HTML состояние сборки (в Docker базы нет), а цены меняются.
export const dynamic = 'force-dynamic';

/**
 * Аренда автомобилей — машина без водителя за сутки (решение владельца 23.10
 * «пока берем аренду автомобилей и трансфер»). Витрина читает прайс проката
 * (схема 1317) тем же загрузчиком, что планер и сайтмап.
 */
export default async function CarRentalRoute() {
  let rental: RentalState;
  try {
    rental = { state: 'ok', companies: await loadRentalCompanies() };
  } catch (err) {
    // Не «прокатчиков нет», а «не смогли проверить»: экран говорит это вслух.
    const code = (err as { code?: string } | null)?.code ?? '';
    console.error('[car-rental]', code, err instanceof Error ? err.message : err);
    rental = { state: 'failed' };
  }
  return <CarRentalPage rental={rental} />;
}
