/**
 * «Когда ехать на Камчатку» — хаб Сыщика (21.11, lib/landings/texts-hubs):
 * текст по месяцам и целям, а на месте блока туров — живой раздел «По месяцам»
 * (сколько туров идёт в месяц по данным операторов и какая рыба в сезоне).
 * Число туров по месяцам в тексте не пишется: оно только в этом разделе.
 */
import { LandingPage, landingPageMetadata } from '@/components/landings/LandingPage';
import { MonthsNav } from '@/components/landings/LandingContent';
import { KamchatkaGuide } from '@/components/landings/KamchatkaGuide';
import { WhenToGoMonths } from '@/components/seo/TripFactsPages';
import { landingBySlug } from '@/lib/landings/landings';
import { loadTripCost } from '@/lib/seo/trip-cost-data';
import { fishByMonth, toursByMonth } from '@/lib/seo/trip-cost';
import { FISH_SPECIES } from '@/lib/fish-species';

export const dynamic = 'force-dynamic';

const SLUG = 'kogda-ehat-na-kamchatku';

export function generateMetadata() {
  return landingPageMetadata(landingBySlug(SLUG));
}

export default async function Page() {
  const { tours } = await loadTripCost();
  return (
    <LandingPage
      slug={SLUG}
      middle={<WhenToGoMonths byMonth={tours ? toursByMonth(tours) : null} fish={fishByMonth(FISH_SPECIES)} />}
      /* Хаб месячных страниц (Сыщик, 20.11): каждая ссылается сюда и на соседей. */
      footer={
        <>
          <MonthsNav current="/kogda-ehat-na-kamchatku" />
          <KamchatkaGuide variant="index" />
        </>
      }
    />
  );
}
