import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { query } from '@/lib/database';
import PlaceDetailClient from './_PlaceDetailClient';
import PlaceSOS from '@/components/places/PlaceSOS';
import { isUuid } from '@/lib/text/slugify';
import { resolveMergedTarget } from '@/lib/places/aliases';
import { JsonLd, BreadcrumbJsonLd } from '@/components/seo/JsonLd';
import { stripTags } from '@/lib/html/text';
// Словарь разделов — общий с контекстом Хранителя (lib/places/type-label.ts).
import { PLACE_TYPE_LABEL } from '@/lib/places/type-label';
import { shownPhotoSql } from '@/lib/images/origin';
import { defaultOgImages } from '@/lib/seo/og-image';
import { loadPlaceDetail } from '@/lib/places/place-detail';
import type { PlaceData } from '@/components/places/types';
import { placeTitle, placeDescription } from '@/lib/seo/place-meta';
import { brandedTitle } from '@/lib/seo/title-fit';
import { locationTypeLabelLower } from '@/lib/places/location-types';
import { asProfileSource, mayStateAsFact } from '@/lib/safety/profile-source';
import { NEARBY_PLACES_SQL } from '@/lib/places/nearby';
import { ownPlacePhoto } from '@/lib/images/own-image-url';
import { zhPlaceAlternatePath } from '@/lib/zh/content';

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
              p.id AS place_pk, p.slug, p.ark_id::text AS ark_id, p.lat, p.lng,
              p.zone, p.best_season,
              -- Факты для заголовка и сниппета (lib/seo/place-meta): те же
              -- таблицы, что кормят блоки «Что знать» и «Сейчас» карточки.
              sp.altitude_m, sp.hazard_types, sp.registration_required, sp.profile_source,
              rs.is_open,
              (CASE WHEN EXISTS(SELECT 1 FROM ai_route_images ai
                                 WHERE ai.route_id = p.ark_id
                                   AND ${shownPhotoSql('ai.model')})
                    THEN '/api/images/route/' || p.ark_id ELSE NULL END) AS real_photo
       FROM places p
       LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
       LEFT JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
       WHERE (p.ark_id::text = $1 OR p.id = $1 OR p.slug = $1) AND p.is_visible = true`,
      [id]
    );
    const r = result.rows[0];
    if (!r) return { title: 'Место не найдено' };

    // Заголовок и сниппет — из фактов карточки, очерк добирает остаток
    // (срез 02.10: «место на Камчатке» и первая фраза очерка не отвечали ни
    // на один запрос человека). Опасности из шаблона фактом не считаются
    // (profile-source) — как и на самой карточке.
    const hazards = Array.isArray(r.hazard_types) ? (r.hazard_types as string[]) : [];
    const facts = {
      name: r.name as string,
      typeLabel: locationTypeLabelLower(r.location_type as string | null),
      zone: (r.zone as string | null) ?? null,
      bestSeason: (r.best_season as string | null) ?? null,
      altitudeM: r.altitude_m != null ? Number(r.altitude_m) : null,
      hazardsRecorded: hazards.length > 0 && mayStateAsFact(asProfileSource(r.profile_source)),
      registrationRequired: r.registration_required === true,
      isOpen: typeof r.is_open === 'boolean' ? r.is_open : null,
      essence: ((r.essence as string | null) || (r.description as string | null)) ?? null,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      // Без очерка описание добирается блоком «Рядом» — тем же запросом.
      nearby: hasEssenceText(r) ? [] : await nearbyForMeta(r),
    };
    const desc = placeDescription(facts) || 'Место на Камчатке';
    // Canonical — ЧПУ места. До 29.09 его не было у всех 379 карточек (Н4):
    // место открывается по ark_id, id и slug, и без canonical это три адреса.
    const canonical = `/places/${(r.slug as string | null) ?? (r.ark_id as string)}`;
    // Превью ссылки — только наш снимок и первым свой (14.10, «Только используй
    // наши фотографии»): до этого чужая ссылка импорта стояла впереди своего.
    const imgUrl = ownPlacePhoto((r.real_photo as string | null) ?? null, r.photo_url, r.images);
    // Пара ru ↔ zh-CN — только у места с китайским конспектом и переводом
    // описания с нынешнего текста (аудит 15.10, CN-pages). Отказ чтения — без
    // пары, причина в логе (lib/zh/content).
    const zh = await zhPlaceAlternatePath({
      id: String(r.place_pk),
      slug: (r.slug as string | null) ?? null,
      description: (r.description as string | null) ?? null,
    });

    return {
      // Хвост — из ответов карточки, и только если помещается в выдачу
      // (lib/seo/place-meta поверх lib/seo/title-fit).
      title: brandedTitle(placeTitle(facts)),
      description: desc,
      alternates: {
        canonical,
        ...(zh ? { languages: { ru: `${BASE}${canonical}`, 'zh-CN': `${BASE}${zh}` } } : {}),
      },
      openGraph: {
        url: canonical,
        title: r.name as string,
        description: desc,
        // Нет снимка места — картинка сайта, а не голая ссылка: openGraph
        // страницы заменяет картинку layout целиком (аудит 01.10).
        images: imgUrl ? [{ url: imgUrl }] : defaultOgImages(),
      },
    };
  } catch (e) {
    // Без метаданных страница уходит в выдачу без canonical и описания, с
    // общим заголовком. Отказ виден в логе, а не только в выдаче (§4.0).
    const err = e as { code?: string; message?: string };
    console.error('[places/page] метаданные места не прочитаны:', id, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return { title: 'Место на Камчатке' };
  }
}

/** Очерк есть — «Рядом» в описание не идёт, и лишний запрос не нужен. */
function hasEssenceText(r: Record<string, unknown>): boolean {
  const text = ((r.essence as string | null) || (r.description as string | null)) ?? '';
  return stripTags(text).trim().length >= 30;
}

/**
 * «Рядом» для описания — тем же запросом, что блок карточки (lib/places/nearby).
 * Не прочиталось — описание без него, а отказ в логе (§4.0).
 */
async function nearbyForMeta(r: Record<string, unknown>): Promise<Array<{ name: string; km: number }>> {
  if (r.lat == null || r.lng == null) return [];
  try {
    const { rows } = await query(NEARBY_PLACES_SQL, [r.lat, r.lng, r.ark_id]);
    return rows.map((n) => ({ name: String(n.name), km: Number(n.distance_km) }));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[places/page] «Рядом» для описания не прочитано:', String(r.ark_id), `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return [];
  }
}

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/** В структурированных данных адрес нужен абсолютный. */
function absoluteImage(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith('http') ? url : `${BASE}${url}`;
}


export default async function PlaceDetailPage({ params }: Props) {
  const { id } = await params;

  // Резолв ссылки: принимаем ark_id | id | slug → реальный ark_id + slug.
  // Клиенту всегда отдаём ark_id (он и его API не меняются), канонический URL —
  // по slug. Пришли по UUID, а slug есть → 301 на ЧПУ.
  let arkId = id;
  let slug: string | null = null;
  // Три исхода резолва (§4.0): нашли / не нашли / не смогли спросить. Только
  // второй — настоящий 404; при отказе БД страница рисуется как раньше и
  // клиент сам покажет свою ошибку. До 10.09 несуществующее место отдавало
  // HTTP 200 с надписью «не найдено» (#1776) — поисковики и мониторинг
  // читали это как живую страницу.
  let found: boolean | null = null;
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
      found = true;
    } else {
      found = false;
    }
  } catch (err) {
    console.error('[places/page] резолв места не удался', {
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // Место слито в другое → 301 туда. Раньше публичная сторона про
  // merged_into_id не знала вовсе (его уважали только админка и кроны дедупа),
  // и слитая запись открывалась отдельной карточкой: турист видел две страницы
  // одного вулкана с разными данными, а админка при этом уверяла, что дубль
  // «скрыт из публички». Редирект постоянный: ссылки и выдача поисковиков на
  // старый адрес существуют и должны вести к живому месту.
  const mergedTo = await resolveMergedTarget(id);
  if (mergedTo) {
    permanentRedirect(`/places/${mergedTo.canonical}`);
  }
  if (found === false) notFound();
  if (isUuid(id) && slug && slug !== id) {
    permanentRedirect(`/places/${slug}`);
  }
  const canonicalId = slug ?? id;

  // Данные карточки — сразу в HTML: поисковик и человек без JS видят имя,
  // описание, факты и ссылки на маршруты (Н1). Браузер потом обновит их сам.
  let initialPlace: PlaceData | null = null;
  if (found) {
    const detail = await loadPlaceDetail(arkId, { countView: false });
    if (detail.status === 200 && detail.body.data) {
      // JSON-круг снимает Date и прочее, чего клиентский компонент не ждёт:
      // та же форма, что приходит из /api/places/{id}.
      initialPlace = JSON.parse(JSON.stringify(detail.body.data)) as PlaceData;
    }
  }

  // JSON-LD для поисковых систем
  let jsonLd: Record<string, unknown> | null = null;
  let breadcrumbItems: Array<{ name: string; url: string }> | null = null;
  try {
    const result = await query(
      `SELECT p.name, p.description, p.essence, p.location_type, p.lat, p.lng,
              p.photo_url, p.images, p.ark_id,
              EXISTS(SELECT 1 FROM ai_route_images ai
                      WHERE ai.route_id = p.ark_id
                        AND ${shownPhotoSql('ai.model')}) AS has_real_photo,
              lsp.altitude_m, lsp.difficulty_level
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
       WHERE (p.ark_id::text = $1 OR p.id = $1 OR p.slug = $1) AND p.is_visible = true
       LIMIT 1`,
      [id]
    );
    const r = result.rows[0];
    if (r) {
      // Изображение в структурированных данных — только когда оно реально есть,
      // оно настоящее и оно наше (14.10: чужая ссылка импорта стояла здесь
      // впереди своего снимка — тем же порядком, что превью, теперь его нет).
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
      const fullImgUrl = absoluteImage(ownPlacePhoto(
        r.has_real_photo ? `/api/images/route/${r.ark_id}` : null, r.photo_url, r.images));
      const typeLabel = PLACE_TYPE_LABEL[r.location_type as string] ?? 'Место';
      const desc = stripTags(((r.essence || r.description) as string | null) ?? '').slice(0, 300) || `${typeLabel} на Камчатке`;

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
        // Ни provider, ни touristType (15.10, §0). provider: TravelAgency
        // «Ведар» объявлял платформу поставщиком самого места — Долины
        // гейзеров, Кроноцкого озера, — а место никто не «предоставляет»,
        // и Ведар не его оператор. touristType — это аудитория («семьи»,
        // «рыбаки»), а сюда ставился тип места («Вулкан»).
      };
      // Хлебные крошки — отдельным узлом, а не свойством TouristAttraction:
      // у этого типа такого свойства нет, и поисковик их не читал (аудит 02.10:
      // BreadcrumbList был у 389 маршрутов и у 0 из 382 мест).
      breadcrumbItems = [
        { name: 'Главная', url: BASE },
        { name: 'Карта мест', url: `${BASE}/map` },
        { name: r.name as string, url: `${BASE}/places/${canonicalId}` },
      ];
    }
  } catch (e) {
    // Страница рисуется и без разметки, но её пропажа — отказ, а не «данных
    // нет»: поисковик молча теряет TouristAttraction и крошки (§4.0).
    const err = e as { code?: string; message?: string };
    console.error('[places/page] JSON-LD места не собран:', id, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
  }

  return (
    <>
      {jsonLd && (
        <JsonLd data={jsonLd} />
      )}
      {breadcrumbItems && <BreadcrumbJsonLd items={breadcrumbItems} />}
      <PlaceDetailClient id={arkId} initialPlace={initialPlace} />
      <PlaceSOS />
    </>
  );
}
