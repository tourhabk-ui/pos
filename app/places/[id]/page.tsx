import type { Metadata } from 'next';
import { query } from '@/lib/database';
import PlaceDetailClient from './_PlaceDetailClient';
import PlaceSOS from '@/components/places/PlaceSOS';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const result = await query(
      `SELECT p.name, p.essence, p.description, p.photo_url, p.location_type, p.images,
              (CASE WHEN EXISTS(SELECT 1 FROM ai_route_images ai WHERE ai.route_id = p.ark_id)
                    THEN '/api/images/route/' || p.ark_id ELSE NULL END) AS ai_photo
       FROM places p
       WHERE (p.ark_id::text = $1 OR p.id = $1) AND p.is_visible = true`,
      [id]
    );
    const r = result.rows[0];
    if (!r) return { title: 'Место не найдено' };

    const desc = (r.essence as string | null) ??
      ((r.description as string | null)?.slice(0, 150) ?? 'Место на Камчатке');
    const imgs = r.images as unknown[] | null;
    const imagesFirst = Array.isArray(imgs) && imgs.length > 0 && typeof imgs[0] === 'string' ? imgs[0] as string : null;
    const imgUrl = (r.photo_url ?? imagesFirst ?? r.ai_photo) as string | null;

    return {
      title: `${r.name} — место на Камчатке`,
      description: desc,
      openGraph: {
        title: r.name as string,
        description: desc,
        ...(imgUrl ? { images: [{ url: imgUrl }] } : {}),
      },
    };
  } catch {
    return { title: 'Место на Камчатке' };
  }
}

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

const PLACE_TYPE_LABEL: Record<string, string> = {
  volcano: 'Вулкан', geyser: 'Гейзер', hot_spring: 'Термальный источник',
  lake: 'Озеро', mountain: 'Гора', bay: 'Бухта', river: 'Река',
  waterfall: 'Водопад', beach: 'Пляж', forest: 'Лес',
  historical: 'Историческое место', museum: 'Музей',
  viewpoint: 'Смотровая площадка', cape: 'Мыс', island: 'Остров',
};

export default async function PlaceDetailPage({ params }: Props) {
  const { id } = await params;

  // JSON-LD для поисковых систем
  let jsonLd: Record<string, unknown> | null = null;
  try {
    const result = await query(
      `SELECT p.name, p.description, p.essence, p.location_type, p.lat, p.lng,
              p.photo_url, p.images, p.ark_id,
              lsp.altitude_m, lsp.difficulty_level
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
       WHERE (p.ark_id::text = $1 OR p.id = $1) AND p.is_visible = true
       LIMIT 1`,
      [id]
    );
    const r = result.rows[0];
    if (r) {
      const imgs = r.images as string[] | null;
      const imgUrl = (r.photo_url ?? (Array.isArray(imgs) && imgs[0]) ?? null) as string | null;
      const fullImgUrl = imgUrl
        ? (imgUrl.startsWith('http') ? imgUrl : `${BASE}${imgUrl}`)
        : `/api/images/route/${r.ark_id}`;
      const typeLabel = PLACE_TYPE_LABEL[r.location_type as string] ?? 'Место';
      const desc = ((r.essence ?? r.description) as string | null)?.replace(/<[^>]+>/g, '').slice(0, 300) ?? `${typeLabel} на Камчатке`;

      jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'TouristAttraction',
        '@id': `${BASE}/places/${id}`,
        name: r.name as string,
        description: desc,
        url: `${BASE}/places/${id}`,
        inLanguage: 'ru',
        image: [{ '@type': 'ImageObject', url: fullImgUrl, name: r.name as string }],
        address: {
          '@type': 'PostalAddress',
          addressRegion: 'Камчатский край',
          addressCountry: 'RU',
        },
        ...(r.lat != null && r.lng != null ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: parseFloat(r.lat as string),
            longitude: parseFloat(r.lng as string),
          },
          hasMap: `https://maps.yandex.ru/?ll=${r.lng},${r.lat}&z=13`,
        } : {}),
        ...(r.altitude_m != null ? { elevation: `${r.altitude_m} м` } : {}),
        touristType: typeLabel,
        provider: {
          '@type': 'TravelAgency',
          name: 'Ведар',
          url: BASE,
        },
        breadcrumb: {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Главная', item: BASE },
            { '@type': 'ListItem', position: 2, name: 'Карта мест', item: `${BASE}/map` },
            { '@type': 'ListItem', position: 3, name: r.name as string, item: `${BASE}/places/${id}` },
          ],
        },
      };
    }
  } catch { /* JSON-LD не критичен */ }

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      <PlaceDetailClient id={id} />
      <PlaceSOS />
    </>
  );
}
