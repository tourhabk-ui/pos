import type { Metadata } from 'next';
import TransfersClient from './_TransfersClient';
import { loadCharterCarriers, type CharterState } from '@/lib/transfers/charter';

export const metadata: Metadata = {
  alternates: { canonical: '/transfers' },
  title: 'Трансферы и вахтовки на Камчатке — места в поездках и машины под заказ',
  description:
    'Свободные места в джипах и вахтовках перевозчиков Камчатки и вахтовки под заказ с ценой за машину: к вулканам, источникам и на побережье. Запрос места и подтверждение перевозчика; оплата — перевозчику напрямую.',
};

// Прайс читается из базы на каждый запрос: статическая страница запекла бы
// в HTML состояние сборки (в Docker базы нет), а цены меняются.
export const dynamic = 'force-dynamic';

export default async function TransfersPage() {
  let charter: CharterState;
  try {
    charter = { state: 'ok', carriers: await loadCharterCarriers() };
  } catch (err) {
    // Не «перевозчиков нет», а «не смогли проверить»: экран говорит это вслух.
    const code = (err as { code?: string } | null)?.code ?? '';
    console.error('[transfers/charter]', code, err instanceof Error ? err.message : err);
    charter = { state: 'failed' };
  }
  return <TransfersClient charter={charter} />;
}
