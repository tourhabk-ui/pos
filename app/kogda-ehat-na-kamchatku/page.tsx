/** «Когда ехать на Камчатку» — туры по месяцам из сезонов в базе (lib/seo/trip-guides). */
import { Header } from '@/components/layout/Header';
import { TripSeasonView } from '@/components/seo/TripGuides';
import { TRIP_SEASON, guideMetadata, seasonLead, seasonTable, seasonTitle } from '@/lib/seo/trip-guides';
import { loadGuideTours } from '@/lib/seo/trip-guides-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const tours = await loadGuideTours();
  const table = tours && tours.length > 0 ? seasonTable(tours) : null;
  return guideMetadata(TRIP_SEASON, seasonTitle(table), seasonLead(table));
}

export default async function Page() {
  const tours = await loadGuideTours();
  return (
    <>
      <Header />
      <TripSeasonView tours={tours} />
    </>
  );
}
