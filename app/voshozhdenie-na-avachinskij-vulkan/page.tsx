/**
 * «Восхождение на Авачинский вулкан» — текст Сыщика (третья партия 21.11,
 * lib/landings) вместо прежней посадочной lib/seo/query-landings (ru-avacha).
 * Туры — та же тема `avacha` из базы на запросе (lib/landings/tours).
 * Высота — 2751 м по KVERT, как во всём сайте (1479).
 */
import { LandingPage, landingPageMetadata } from '@/components/landings/LandingPage';
import { landingBySlug } from '@/lib/landings/landings';

export const dynamic = 'force-dynamic';

const SLUG = 'voshozhdenie-na-avachinskij-vulkan';

export function generateMetadata() {
  return landingPageMetadata(landingBySlug(SLUG));
}

export default function Page() {
  return <LandingPage slug={SLUG} />;
}
