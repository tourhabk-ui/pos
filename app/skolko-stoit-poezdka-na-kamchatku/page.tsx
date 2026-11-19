/** «Сколько стоит поездка на Камчатку» — цены туров по видам из базы (lib/seo/trip-guides). */
import { Header } from '@/components/layout/Header';
import { TripCostView } from '@/components/seo/TripGuides';
import { TRIP_COST, costLead, costTitle, guideMetadata } from '@/lib/seo/trip-guides';
import { loadGuideTours, loadStayPrices } from '@/lib/seo/trip-guides-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const tours = await loadGuideTours();
  return guideMetadata(TRIP_COST, costTitle(tours), costLead(tours));
}

export default async function Page() {
  const [tours, stay] = await Promise.all([loadGuideTours(), loadStayPrices()]);
  return (
    <>
      <Header />
      <TripCostView tours={tours} stay={stay} />
    </>
  );
}
