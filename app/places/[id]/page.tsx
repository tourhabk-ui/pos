import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { query } from '@/lib/database';
import PlaceDetailClient from './_PlaceDetailClient';
import PlaceSOS from '@/components/places/PlaceSOS';
import { isUuid } from '@/lib/text/slugify';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const result = await query(
      // Только РЕАЛЬНЫЕ снимки: wikimedia и ручная загрузка. Прежде подзапрос
      // брал любую строку ai_route_images, включая сгенерированные моделью, и
      // они уходили в OpenGraph — ссылка на карточку вулкана раскрывалась в
      // мессенджере нарисованной картинкой этого вулкана. Карточка точки по
      // CLAUDE.md §9 — географический факт; фото в превью должно быть фото.
      `SELECT p.name, p.essence, p.description, p.photo_url, p.location_type, p.images,
              (CASE WHEN EXISTS(SELECT 1 FROM ai_route_images ai
                                 WHERE ai.route_id = p.ark_id
                                   AND ai.model IN ('wikimedia', 'manual-upload'))
                    THEN '/api/images/route/' || p.ark_id ELSE NULL END) AS real_photo
       FROM places p
       WHERE (p.ark_id::text = $1 OR p.id = $1 OR p.slug = $1) AND p.is_visible = true`,
      [id]
    );
    const r = result.rows[0];
    if (!r) return { title: 'Место не найдено' };

    const desc = (r.essence as string | null) ??
      ((r.description as string | null)?.slice(0, 150) ?? 'Место на Камчатке');
    const imgs = r.images as unknown[] | null;
    const imagesFirst = Array.isArray(imgs) && imgs.length > 0 && typeof imgs[0] === 'string' ? imgs[0] as string : null;
    const imgUrl = (r.photo_url ?? imagesFirst ?? r.real_photo) as string | null;

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

  // Резолв ссылки: принимаем ark_id | id | slug → реальный ark_id + slug.
  // Клиенту всегда отдаём ark_id (он и его API не меняются), канонический URL —
  // по slug. Пришли по UUID, а slug есть → 301 на ЧПУ.
  let arkId = id;
  let slug: string | null = null;
  try {
    const ref = await query(
      `SELECT ark_id::text AS ark_id, slug FROM places
       WHERE (ark_id::text = $1 OR id = $1 OR slug = $1) AND is_visible = true
       LIMIT 1`,
      [id]
    );
    if (ref.rows[0]) {
      arkId = (ref.rows[0].ark_id as string) ?? id;
      slug = (ref.rows[0].slug as string | null) ?? null;
    }
  } catch { /* резолв не критичен — работаем по исходному id */ }
  if (isUuid(id) && slug && slug !== id) {
    permanentRedirect(`/places/${slug}`);
  }
  const canonicalId = slug ?? id;

  // JSON-LD для поисковых систем
  let jsonLd: Record<string, unknown> | null = null;
  try {
    const result = await query(
      `SELECT p.name, p.description, p.essence, p.location_type, p.lat, p.lng,
              p.photo_url, p.images, p.ark_id,
              EXISTS(SELECT 1 FROM ai_route_images ai
                      WHERE ai.route_id = p.ark_id
                        AND ai.model IN ('wikimedia', 'manual-upload')) AS has_real_photo,
              lsp.altitude_m, lsp.difficulty_level
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
       WHERE (p.ark_id::text = $1 OR p.id = $1 OR p.slug = $1) AND p.is_visible = true
       LIMIT 1`,
      [id]
    );
    const r = result.rows[0];
    if (r) {
      const imgs = r.images as string[] | null;
      const imgUrl = (r.photo_url ?? (Array.isArray(imgs) && imgs[0]) ?? null) as string | null;
      // Изображение в структурированных данных — только когда оно реально есть
      // и оно настоящее.
      //
      // Прежде фолбэк был безусловным: `/api/images/route/{ark_id}` уходил в
      // JSON-LD всегда. Две беды в одной строке. Если у точки лежало только
      // сгенерированное изображение — поисковику отдавалась нарисованная
      // картинка как ImageObject реального географического объекта. Если
      // изображения не было вовсе — отдавался URL, который вернёт 404, да ещё
      // и относительный, хотя в структурированных данных нужен абсолютный.
      //
      // Схема описывает действительность. Нет снимка — нет поля, это честнее
      // ссылки в никуда.
      const fullImgUrl = imgUrl
        ? (imgUrl.startsWith('http') ? imgUrl : `${BASE}${imgUrl}`)
        : (r.has_real_photo ? `${BASE}/api/images/route/${r.ark_id}` : null);
      const typeLabel = PLACE_TYPE_LABEL[r.location_type as string] ?? 'Место';
      const desc = ((r.essence ?? r.description) as string | null)?.replace(/<[^>]+>/g, '').slice(0, 300) ?? `${typeLabel} на Камчатке`;

      jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'TouristAttraction',
        '@id': `${BASE}/places/${canonicalId}`,
        name: r.name as string,
        description: desc,
        url: `${BASE}/places/${canonicalId}`,
        inLanguage: 'ru',
        ...(fullImgUrl
          ? { image: [{ '@type': 'ImageObject', url: fullImgUrl, name: r.name as string }] }
          : {}),
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
            { '@type': 'ListItem', position: 3, name: r.name as string, item: `${BASE}/places/${canonicalId}` },
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
      <PlaceDetailClient id={arkId} />
      <PlaceSOS />
    </>
  );
}
