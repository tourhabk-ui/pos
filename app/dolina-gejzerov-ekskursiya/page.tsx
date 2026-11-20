/**
 * «Долина гейзеров: как попасть» — текст Сыщика (20.11, lib/landings) вместо
 * прежней посадочной lib/seo/query-landings (ru-geysers). Туры — та же тема
 * `geysers` из базы на запросе (lib/landings/tours).
 */
import { LandingPage, landingPageMetadata } from '@/components/landings/LandingPage';
import { landingBySlug } from '@/lib/landings/landings';

export const dynamic = 'force-dynamic';

const SLUG = 'dolina-gejzerov-kak-popast';

export function generateMetadata() {
  return landingPageMetadata(landingBySlug(SLUG));
}

export default function Page() {
  return <LandingPage slug={SLUG} />;
}
