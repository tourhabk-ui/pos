import type { Metadata } from 'next';
import { CarRentalPage } from '@/components/rental/CarRentalPage';
import { loadRentalCompanies, type RentalState } from '@/lib/rental/rental';
import { RENTAL_SITE_PAUSE, rentalOnSite } from '@/lib/rental/site-pause';

export const metadata: Metadata = {
  alternates: { canonical: '/car-rental' },
  title: 'Аренда автомобилей на Камчатке — машина без водителя',
  description:
    'Машины напрокат без водителя у прокатчиков Камчатки: цена за сутки за машину по прайсу. Заявка — на странице прокатчика, оплата — ему напрямую.',
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
    // Пауза владельца 23.10 (lib/rental/site-pause): спрятанный прокатчик
    // людям не показывается, а пустая витрина говорит, когда он вернётся.
    const { shown, hidden } = rentalOnSite(await loadRentalCompanies());
    rental = hidden > 0
      ? { state: 'ok', companies: shown, pausedReturnsOn: RENTAL_SITE_PAUSE.returnsOn }
      : { state: 'ok', companies: shown };
  } catch (err) {
    // Не «прокатчиков нет», а «не смогли проверить»: экран говорит это вслух.
    const code = (err as { code?: string } | null)?.code ?? '';
    console.error('[car-rental]', code, err instanceof Error ? err.message : err);
    rental = { state: 'failed' };
  }
  return <CarRentalPage rental={rental} />;
}
