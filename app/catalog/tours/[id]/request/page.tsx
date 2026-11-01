import type { Metadata } from 'next';
import CatalogTourDetailPage, { generateMetadata as baseMetadata } from '../page';

/**
 * Динамический двойник карточки тура для адресов с ?date=/?guests=
 * (rewrite в next.config.js). Значения из адреса попадают в HTML формы на
 * сервере — ИИ-агент без JavaScript видит заполненную заявку. Канон — у
 * голой карточки (canonical из её метаданных), здесь noindex.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const base = await baseMetadata({ params });
  return { ...base, robots: { index: false, follow: true } };
}

export default async function TourRequestPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') qs.set(k, v);
  return CatalogTourDetailPage({ params: Promise.resolve({ id: `${id}~${qs.toString()}` }) });
}
