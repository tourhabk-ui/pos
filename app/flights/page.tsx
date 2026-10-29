import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { FlightBoardView } from '@/components/flights/FlightBoardView';
import { loadPkcBoard } from '@/lib/flights/pkc-board';
import { loadAirportMetar } from '@/lib/flights/metar';
import { defaultOgImages } from '@/lib/seo/og-image';

/**
 * Табло аэропорта Елизово — задержки и отмены (карт-бланш владельца 29.10, #2788).
 *
 * Рендер на каждый запрос: табло меняется каждые несколько минут. Сайт
 * аэропорта на каждый заход не дёргается — у loadPkcBoard своя память на три
 * минуты (lib/flights/pkc-board.ts).
 *
 * Рядом — сводка погоды аэродрома (METAR, lib/flights/metar.ts, 29.10): табло
 * причину задержки не называет, а погоду у полосы показать можно. Обе загрузки
 * идут параллельно и не ждут друг друга.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Табло аэропорта Елизово — задержки и отмены рейсов',
  description:
    'Задержанные и отменённые рейсы аэропорта Петропавловск-Камчатский (Елизово, PKC): вылет и прилёт по табло аэропорта, камчатское время, погода в аэропорту по сводке METAR.',
  alternates: { canonical: 'https://vedarai.ru/flights' },
  openGraph: {
    images: defaultOgImages(),
    title: 'Табло аэропорта Елизово',
    description: 'Задержки и отмены рейсов по табло аэропорта.',
    url: 'https://vedarai.ru/flights',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

export default async function FlightsPage() {
  const [board, metar] = await Promise.all([loadPkcBoard(), loadAirportMetar()]);
  return (
    <>
      <Header />
      <main className="ds-page px-4 pt-20 pb-24">
        <FlightBoardView board={board} metar={metar} />
      </main>
      <BottomNav activePath="/flights" />
    </>
  );
}
