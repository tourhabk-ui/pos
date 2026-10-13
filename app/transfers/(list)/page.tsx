import type { Metadata } from 'next';
import { TransfersPage } from '@/components/transfers/TransfersPage';
import { loadCharterCarriers, type CharterState } from '@/lib/transfers/charter';

export const metadata: Metadata = {
  alternates: { canonical: '/transfers' },
  title: 'Трансферы и вахтовки на Камчатке — машина под заказ',
  description:
    'Вахтовки и машины целиком под заказ у перевозчиков Камчатки: цена за машину по прайсу, к вулканам, источникам и на побережье. Оплата — перевозчику напрямую.',
};

// Прайс читается из базы на каждый запрос: статическая страница запекла бы
// в HTML состояние сборки (в Docker базы нет), а цены меняются.
export const dynamic = 'force-dynamic';

/**
 * Трансфер — машина целиком под заказ (владелец 13.10: «бронируют целую машину
 * а не место в ней»). Параметры прежних ссылок на «места в поездках»
 * (?from&to&seats&trip — их строили планер и кабинет туриста до 13.10)
 * страница не читает: такого
 * товара нет, и ссылка открывает ту же витрину машин.
 */
export default async function TransfersRoute() {
  let charter: CharterState;
  try {
    charter = { state: 'ok', carriers: await loadCharterCarriers() };
  } catch (err) {
    // Не «перевозчиков нет», а «не смогли проверить»: экран говорит это вслух.
    const code = (err as { code?: string } | null)?.code ?? '';
    console.error('[transfers/charter]', code, err instanceof Error ? err.message : err);
    charter = { state: 'failed' };
  }
  return <TransfersPage charter={charter} />;
}
