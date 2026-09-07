'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Navigation, Download, Video } from 'lucide-react';
import type { PlaceData } from '@/components/places/types';
import { HazardBadgeStrip } from '@/components/shared/HazardBadgeStrip';
import { hasVolcanoCamera, VOLCANO_CAMERAS_URL, VOLCANO_CAMERAS_SOURCE } from '@/lib/safety/volcano-cameras';
import { buildPlaceAdvisory } from '@/lib/kuzmich/place-advisory';

const PlaceHero             = dynamic(() => import('@/components/places/PlaceHero'),             { ssr: false });
const OfflineGPSBanner      = dynamic(() => import('@/components/shared/OfflineGPSBanner'),      { ssr: false });
const PlaceRealtimeStatus   = dynamic(() => import('@/components/places/PlaceRealtimeStatus'),   { ssr: false });
const VolcanoAccBadge       = dynamic(() => import('@/components/places/VolcanoAccBadge'),       { ssr: false });
const PlaceDescription      = dynamic(() => import('@/components/places/PlaceDescription'),      { ssr: false });
const PlaceCharacteristics  = dynamic(() => import('@/components/places/PlaceCharacteristics'),  { ssr: false });
const PlaceSafety           = dynamic(() => import('@/components/places/PlaceSafety'),           { ssr: false });
const PlaceAccess           = dynamic(() => import('@/components/places/PlaceAccess'),           { ssr: false });
const PlaceSeason           = dynamic(() => import('@/components/places/PlaceSeason'),           { ssr: false });
const PlaceRoutes           = dynamic(() => import('@/components/places/PlaceRoutes'),           { ssr: false });
const PlaceTours            = dynamic(() => import('@/components/places/PlaceTours'),            { ssr: false });
const PlaceKuzmich          = dynamic(() => import('@/components/places/PlaceKuzmich'),          { ssr: false });
const PlaceReviews          = dynamic(() => import('@/components/places/PlaceReviews'),          { ssr: false });
const PlaceNearby           = dynamic(() => import('@/components/places/PlaceNearby'),           { ssr: false });
const PlaceEco              = dynamic(() => import('@/components/places/PlaceEco'),              { ssr: false });
const PlaceLNT              = dynamic(() => import('@/components/places/PlaceLNT'),              { ssr: false });
const PlaceIndigenous       = dynamic(() => import('@/components/places/PlaceIndigenous'),       { ssr: false });
const PlaceFooter           = dynamic(() => import('@/components/places/PlaceFooter'),           { ssr: false });
const PlaceFieldReports     = dynamic(() => import('@/components/places/PlaceFieldReports'),     { ssr: false });
const PhotoUpload           = dynamic(() => import('@/components/places/PhotoUpload').then(m => ({ default: m.PhotoUpload })), { ssr: false });
const PlaceUserPhotos       = dynamic(() => import('@/components/places/PlaceUserPhotos'),       { ssr: false });
const PlaceActionBar        = dynamic(() => import('@/components/places/PlaceActionBar').then(m => ({ default: m.PlaceActionBar })), { ssr: false });
const Header                = dynamic(() => import('@/components/layout/Header').then(m => ({ default: m.Header })), { ssr: false });
const NavigateTo            = dynamic(() => import('@/components/shared/NavigateTo'),            { ssr: false });

function Skeleton() {
  return (
    <div className="animate-pulse">
      <div className="w-full bg-[var(--bg-hover)]" style={{ height: 'clamp(320px, 68vh, 720px)' }} />
      <div className="max-w-3xl mx-auto px-4 pt-8 space-y-4">
        <div className="h-5 bg-[var(--bg-hover)] rounded-full w-20" />
        <div className="h-9 bg-[var(--bg-hover)] rounded-lg w-3/4" />
        <div className="h-4 bg-[var(--bg-hover)] rounded w-full" />
        <div className="h-4 bg-[var(--bg-hover)] rounded w-5/6" />
        <div className="h-4 bg-[var(--bg-hover)] rounded w-4/6" />
        <div className="flex gap-2 mt-6">
          {[1,2,3,4].map(i => <div key={i} className="h-9 bg-[var(--bg-hover)] rounded-xl w-28" />)}
        </div>
      </div>
    </div>
  );
}

/**
 * SOS живёт ТОЛЬКО в `PlaceSOS` (page.tsx) — не здесь. До 24.08 у этого бара
 * был свой `<a href="tel:112">СОС</a>` (кириллица — мимо латинского regex
 * сторожа sos-always-reachable.test.ts), и он рисовался ОДНОВРЕМЕННО с
 * `PlaceSOS`: два fixed bottom-0 бара поверх друг друга, верхний по z-index
 * прятал «Навигация»/«Оффлайн». Раз SOS всегда есть снизу, здесь остаётся
 * только то, что PlaceSOS не делает — offset подобран под высоту PlaceSOS без
 * safe-area (см. её собственный комментарий), чтобы бары не перекрывались.
 *
 * «Навигация» отсюда убрана 07.09 (владелец, скрин: «почему 2 кнопки
 * навигация?») — `PlaceActionBar` уже держит sticky «Навигация» с тем же
 * geo:-адресом, и она видна на мобильном НАРАВНЕ с этим баром: до правки
 * человек видел два одинаковых CTA на одном экране. `PlaceActionBar` не
 * знает про Organic Maps deep link — «Оффлайн» остаётся только здесь.
 */
function MobileBottomBar({ place }: { place: PlaceData }) {
  const orgMapsUrl = `om://map?v=1&ll=${place.lat},${place.lng}&n=${encodeURIComponent(place.name)}`;

  return (
    <div
      className="fixed left-0 right-0 z-50 md:hidden"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 52px)' }}
    >
      <div className="flex items-center gap-2 px-3 py-3 bg-[var(--bg-card)] border-t border-[var(--border)]">
        <a
          href={orgMapsUrl}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-hover)] border border-[var(--border)] rounded-xl py-3 hover:border-[var(--accent)] transition-colors"
        >
          <Download className="w-4 h-4" />
          Оффлайн — Organic Maps
        </a>
      </div>
    </div>
  );
}

const LS_PREFIX = 'kh_place_';

function lsRead(id: string): PlaceData | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + id);
    return raw ? (JSON.parse(raw) as PlaceData) : null;
  } catch { return null; }
}

function lsWrite(id: string, data: PlaceData) {
  try {
    localStorage.setItem(LS_PREFIX + id, JSON.stringify(data));
  } catch { /* localStorage full */ }
}

export default function PlaceDetailClient({ id }: { id: string }) {
  const [place, setPlace] = useState<PlaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Показываем кэш сразу — пока грузится сеть
      const cached = lsRead(id);
      if (cached && !cancelled) {
        setPlace(cached);
        setLoading(false);
        setFromCache(true);
      }

      try {
        const res = await fetch(`/api/places/${id}`);
        if (!res.ok) {
          // HTTP error — show server message, not "offline"
          const errBody = await res.json().catch(() => null) as Record<string, unknown> | null;
          if (!cancelled && !cached) {
            setError((errBody?.error as string | null) ?? `Ошибка сервера (${res.status})`);
            setLoading(false);
          } else if (!cancelled) {
            setLoading(false);
          }
          return;
        }
        const j = await res.json();
        if (!cancelled) {
          if (j?.success && j.data) {
            setPlace(j.data);
            setFromCache(false);
            lsWrite(id, j.data);
          } else if (!cached) {
            setError(j.error ?? 'Место не найдено');
          }
          setLoading(false);
        }
      } catch {
        // Network error (offline / host unreachable)
        if (!cancelled) {
          if (!cached) setError('Нет подключения. Откройте карточку онлайн заранее.');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return <><Header /><Skeleton /></>;

  if (error || !place) {
    return (
      <>
        <Header />
        <div className="max-w-3xl mx-auto px-4 py-24 text-center">
          <p className="text-[var(--text-secondary)] mb-4">{error ?? 'Место не найдено'}</p>
          <Link href="/routes?kind=place" className="ds-btn ds-btn-secondary">← Все места</Link>
        </div>
      </>
    );
  }

  const hasSeason = place.safety.openFromDate || place.safety.openToDate || place.bestSeason || place.seasonalNotes;

  return (
    <>
      <Header />
      <OfflineGPSBanner />

      {/* 1. Hero — full-width photo with name overlay */}
      <PlaceHero
        placeId={place.id}
        name={place.name}
        locationType={place.locationType}
        lat={place.lat}
        lng={place.lng}
        photoUrl={place.photoUrl}
        photoCount={place.photoCount}
        images={place.images as string[]}
      />

      {/* Атрибуция фото (CC-BY / CC-BY-SA — Wikimedia Commons) */}
      {place.photoAttribution && (place.photoAttribution.author || place.photoAttribution.license) && (
        <div className="max-w-3xl mx-auto px-4 pt-1.5 text-[11px] text-[var(--text-muted)]">
          Фото:{' '}
          {place.photoAttribution.sourceUrl ? (
            <a href={place.photoAttribution.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
              {place.photoAttribution.author || 'Wikimedia Commons'}
            </a>
          ) : (
            <span>{place.photoAttribution.author || 'Wikimedia Commons'}</span>
          )}
          {place.photoAttribution.license && (
            <>
              {' · '}
              {place.photoAttribution.licenseUrl ? (
                <a href={place.photoAttribution.licenseUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
                  {place.photoAttribution.license}
                </a>
              ) : (
                <span>{place.photoAttribution.license}</span>
              )}
            </>
          )}
        </div>
      )}

      {/* Action bar: navigate, bookmark, share, weather */}
      <PlaceActionBar lat={place.lat} lng={place.lng} placeId={place.id} name={place.name} />

      {/* Offline cache notice */}
      {fromCache && (
        <div className="w-full px-4 py-2 bg-[var(--bg-hover)] border-b border-[var(--border)] flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] flex-shrink-0" />
          Данные из кэша — нет подключения к сети
        </div>
      )}

      {/* Hazard quick-view */}
      {(place.safety.hazardTypes.length > 0 || place.safety.registrationRequired) && (
        <div className="max-w-3xl mx-auto px-4 pt-3 pb-1">
          <HazardBadgeStrip
            hazards={place.safety.hazardTypes}
            mchsRequired={place.safety.registrationRequired}
          />
        </div>
      )}

      {/* 1b. Авиационный цветовой код вулкана (KVERT) */}
      {place.volcanoStatus && <VolcanoAccBadge status={place.volcanoStatus} />}

      {/* 1c. Живая камера вулкана — только для вулканов под видеонаблюдением
          КФ ФИЦ ЕГС РАН (см. lib/safety/volcano-cameras). Внешний онлайн-ресурс:
          обычная ссылка (не iframe, не офлайн), с честной пометкой про сеть.
          Визуальное подтверждение состояния кратера рядом с кодом КВЕРТ. */}
      {place.locationType === 'volcano' && hasVolcanoCamera(place.name) && (
        <a
          href={VOLCANO_CAMERAS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors"
        >
          <Video className="w-5 h-5 text-[var(--ocean)] shrink-0" strokeWidth={1.8} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[var(--text-primary)]">Камеры вулкана вживую</span>
            <span className="block text-xs text-[var(--text-secondary)]">{VOLCANO_CAMERAS_SOURCE} · внешний источник, нужна сеть</span>
          </span>
        </a>
      )}

      {/* 2. Realtime alert — sticky on danger */}
      {place.realtime && <PlaceRealtimeStatus realtime={place.realtime} />}

      {/* 3. Description */}
      <PlaceDescription
        name={place.name}
        essence={place.essence}
        description={place.description}
        placeId={place.id}
      />

      {/* 3b. Indigenous — context before characteristics */}
      {place.indigenous && <PlaceIndigenous indigenous={place.indigenous} />}

      {/* 4. Stat pills + hazard chips */}
      <PlaceCharacteristics
        locationType={place.locationType}
        zone={place.zone}
        safety={place.safety}
        terrainType={place.safety.terrainType}
      />

      {/* 5. Safety block */}
      <PlaceSafety safety={place.safety} placeId={place.id} />

      {/* 5b. Field reports from tourists */}
      <PlaceFieldReports placeId={place.id} />

      {/* 6. Eco */}
      {place.eco && (
        <div className="max-w-3xl mx-auto px-4 mt-6">
          <PlaceEco eco={place.eco} placeName={place.name} />
        </div>
      )}

      {/* 6b. Universal LNT — for all places */}
      <PlaceLNT
        capacityPerDay={place.safety.capacityPerDay}
        ecoZone={place.eco?.zone ?? null}
      />

      {/* 7. Season */}
      {hasSeason && (
        <div className="max-w-3xl mx-auto px-4 mt-6">
          <PlaceSeason
            openFromDate={place.safety.openFromDate}
            openToDate={place.safety.openToDate}
            bestSeason={place.bestSeason}
            seasonalNotes={place.seasonalNotes}
          />
        </div>
      )}

      {/* 8. Routes through this place */}
      {place.routes.length > 0 && (
        <div className="max-w-3xl mx-auto px-4 mt-8">
          <PlaceRoutes routes={place.routes} placeId={place.id} />
        </div>
      )}

      {/* 9. Tours to this place — компактные ссылки (CLAUDE.md §9, блок 11);
          коммерция остаётся на странице тура, здесь только переходы */}
      {place.tours.length > 0 && (
        <div className="mt-8">
          <PlaceTours tours={place.tours} />
        </div>
      )}

      {/* 10. Map + access */}
      <div className="mt-8">
        <PlaceAccess
          placeId={place.id}
          name={place.name}
          lat={place.lat}
          lng={place.lng}
          accessInfo={place.accessInfo}
          nearbyMarkers={place.nearby}
        />
      </div>

      {/* 10b. Отдать дорогу тем, кто её умеет строить */}
      <div className="max-w-3xl mx-auto px-4 mt-6">
        <NavigateTo to={{ lat: place.lat, lng: place.lng, name: place.name }} mode="car" />
      </div>

      {/* 10c. Дальше — наше: путь сюда пешком, с компасом и GPS вместо чужого
          навигатора. NavigateTo выше довозит до начала тропы, здесь начинается
          то, что не делают Organic Maps и 2ГИС (см. её же комментарий). Ищет
          путь ТЕМ ЖЕ полем поиска, что заполнил бы человек сам — предзаполнен
          именем места через ?q=. auto=1 (владелец 30.08: «сразу на маршруте
          от места, где находится пользователь») доводит цель и старт (живой
          GPS) до автовыбора — человеку остаётся выбрать способ передвижения
          и сам путь, если их несколько. */}
      <div className="max-w-3xl mx-auto px-4 mt-4">
        <Link
          href={`/planning?mode=trail&q=${encodeURIComponent(place.name)}&auto=1`}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
        >
          <Navigation className="h-4 w-4 text-[var(--accent)]" aria-hidden />
          Пройти сюда с компасом и GPS
        </Link>
      </div>

      {/* 11. Kuzmich */}
      <div className="max-w-3xl mx-auto px-4 mt-6">
        <PlaceKuzmich
          placeId={place.id}
          placeName={place.name}
          kuzmichReview={place.kuzmichReview}
          advisory={buildPlaceAdvisory({
            volcano: place.volcanoStatus
              ? { colorCode: place.volcanoStatus.colorCode, observedAt: place.volcanoStatus.observedAt }
              : null,
            realtime: place.realtime
              ? { isOpen: place.realtime.isOpen, activeAlerts: place.realtime.activeAlerts, alertSeverity: place.realtime.alertSeverity }
              : null,
            hazardTypes: place.safety.hazardTypes,
          })}
        />
      </div>

      {/* 12. Reviews */}
      <div className="max-w-3xl mx-auto px-4 mt-6">
        <PlaceReviews placeId={place.id} reviews={place.reviews} />
      </div>

      {/* 12b. Фото туристов, прошедшие модерацию — ПЕРЕД формой загрузки:
          человек сначала видит, куда попадёт его снимок, и только потом
          загружает. Блока нет, если одобренных фото нет (см. компонент). */}
      <div className="mt-6">
        <PlaceUserPhotos placeId={place.id} />
      </div>

      {/* 12c. Tourist photo upload */}
      <div className="max-w-3xl mx-auto px-4 mt-6">
        <PhotoUpload placeId={place.id} placeName={place.name} />
      </div>

      {/* 13. Nearby places — horizontal scroll mobile */}
      {place.nearby.length > 0 && (
        <div className="mt-6">
          <PlaceNearby nearby={place.nearby} placeId={place.id} />
        </div>
      )}

      {/* Footer */}
      <div className="max-w-3xl mx-auto px-4 mt-10 mb-24 md:mb-12">
        <PlaceFooter
          sourceUrl={place.sourceUrl}
          sourceName={place.sourceName}
          updatedAt={place.updatedAt}
        />
      </div>

      {/* Mobile sticky bottom bar */}
      <MobileBottomBar place={place} />
    </>
  );
}
