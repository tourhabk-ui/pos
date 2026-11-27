'use client';

import { useWishlist, wishlistLabel, WISHLIST_LOCAL_ONLY_HINT } from '@/hooks/use-wishlist';
import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { X, Navigation, Bookmark, Share2, ArrowRight, MapPin } from 'lucide-react';
import { shareLink, shareOutcomeMessage } from '@/lib/share';
import { hazardLabelLower } from '@/lib/safety/hazard-labels';

interface InitialData {
  id: string;
  title: string;
  locationType: string | null;
  lat: number;
  lng: number;
  description: string;
}

interface RouteLink {
  id: string;
  title: string;
}

interface DetailData {
  photoUrl: string | null;
  routes: RouteLink[];
  description: string | null;
  /** Опасности из профиля безопасности места (как `get_place_info`). */
  hazards: string[];
}

/** Как прочиталась карточка места: опасности без неё назвать нечем (§4.0). */
type DetailState = 'loading' | 'ok' | 'failed';

export const SHEET_HAZARDS_NONE = 'Опасности в карточке места не записаны — это не значит, что их нет.';
export const SHEET_HAZARDS_FAILED = 'Опасности места не загрузились — откройте карточку места.';
export const SHEET_HAZARDS_LOADING = 'Опасности места загружаются…';

/** Строка опасностей листа места. */
export function sheetHazardsLine(state: DetailState, hazards: readonly string[]): string {
  if (state === 'loading') return SHEET_HAZARDS_LOADING;
  if (state === 'failed') return SHEET_HAZARDS_FAILED;
  return hazards.length > 0
    ? `Опасности: ${hazards.map(hazardLabelLower).join(', ')}.`
    : SHEET_HAZARDS_NONE;
}

interface Props {
  initialData: InitialData;
  userPos: { lat: number; lng: number } | null;
  isOffline: boolean;
  onClose: () => void;
  distLabel: string | null;
}

const LOCATION_LABELS: Record<string, string> = {
  volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Источник', mountain: 'Гора',
  geyser: 'Гейзер', waterfall: 'Водопад', beach: 'Пляж', valley: 'Долина',
  river: 'Река', cave: 'Пещера', bay: 'Бухта', forest: 'Лес',
  historical: 'Историческое место', ethnic: 'Этнокультурное место', museum: 'Музей', rock: 'Скала',
  viewpoint: 'Смотровая', cape: 'Мыс', island: 'Остров', other: 'Место',
  // Перевал заведён 20.09 вместе с миграцией 992: «Каньон Сноубордистов»
  // оказался перевалом над Эссо, а не ущельем, и без этой строки лист карты
  // подписал бы его английским `pass`. Слова здесь короче платформенных
  // НАМЕРЕННО (решение владельца, см. place-type-label) — потому это не
  // копия справочника, а свой словарь, и пополняется он по одному слову.
  pass: 'Перевал',
  // Заповедник и национальный парк — 14.10, вместе с типами (миграции 1240,
  // 1243): без этих строк лист карты подписывал Кроноцкий заповедник «Место».
  reserve: 'Заповедник',
  national_park: 'Нацпарк',
  zakaznik: 'Заказник',
  // Природный парк — 14.10, «Быстринский» (миграция 1246).
  park: 'Природный парк',
};

export function PlaceMapSheet({ initialData, userPos, isOffline, onClose, distLabel }: Props) {
  const [detail, setDetail] = useState<DetailData | null>(null);
  // Чья карточка прочиталась: лист переиспользуется при тапе по другому месту,
  // и опасности прежнего места под новым названием были бы ложью.
  const [loaded, setLoaded] = useState<{ id: string; state: 'ok' | 'failed' } | null>(null);
  const detailState: DetailState = loaded && loaded.id === initialData.id ? loaded.state : 'loading';
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  // Лист карты писал отметку только в localStorage — в личный кабинет она не
  // попадала (владелец 09.08). Тот же контракт, что у витрины и панели точки.
  const fav = useWishlist('place', initialData.id);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);

  // Swipe-down to close
  function onTouchStart(e: React.TouchEvent) {
    dragStartY.current = e.touches[0].clientY;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (dragStartY.current === null) return;
    const delta = e.changedTouches[0].clientY - dragStartY.current;
    if (delta > 80) onClose();
    dragStartY.current = null;
  }

  // Fetch detail async (only online)
  useEffect(() => {
    if (isOffline) return;
    const id = initialData.id;
    fetch(`/api/places/${id}`)
      .then(r => r.json())
      .then((d: unknown) => {
        const body = typeof d === 'object' && d !== null
          ? (d as Record<string, unknown>).data as Record<string, unknown> | undefined
          : undefined;
        if (!body) { setLoaded({ id, state: 'failed' }); return; }
        const safety = typeof body.safety === 'object' && body.safety !== null ? body.safety as Record<string, unknown> : null;
        const hazards = Array.isArray(safety?.hazardTypes)
          ? (safety.hazardTypes as unknown[]).filter((h): h is string => typeof h === 'string' && h.trim() !== '')
          : [];
        const routes = Array.isArray(body.routes)
          ? (body.routes as Array<Record<string, unknown>>).slice(0, 3).map(r => ({
              id: r.id as string,
              title: r.title as string,
            }))
          : [];
        setDetail({
          photoUrl: body.photoUrl as string | null,
          routes,
          description: typeof body.description === 'string' ? body.description : null,
          hazards,
        });
        setLoaded({ id, state: 'ok' });
      })
      .catch((err: unknown) => {
        // Сеть или разбор ответа — лист говорит «не загрузились», а не молчит.
        console.error('[place-sheet] карточка места не загрузилась:', err instanceof Error ? err.name : 'unknown');
        setLoaded({ id, state: 'failed' });
      });
  }, [initialData.id, isOffline]);

  const typeLabel = LOCATION_LABELS[initialData.locationType ?? 'other'] ?? 'Место';
  // Своя навигация, не чужая (владелец 13.09: «кнопка навигация до сих пор
  // открывает сторонние сервисы»). Здесь стоял `geo:` — а это даже не
  // конкретный навигатор, а системный выбор приложения: человек тапал
  // «Навигация» на НАШЕЙ карте и попадал в чужой список.
  //
  // Путь считает свой дорожный граф Камчатки (миграция 760,
  // roadGraphCarProvider) — тот же расчёт, что на карточке места.
  // `?route=1` говорит карточке начать сразу: человек уже нажал «Навигация»
  // здесь, и просить его нажать то же самое второй раз — потерянный тап.
  const ownRouteUrl = `/places/${initialData.id}?route=1`;
  // Своя карта (VedarMap) несёт с тапа только id/имя/тип/координаты —
  // initialData.description там всегда пустая строка. Полный текст едет
  // отдельным запросом ниже; до его прихода полагаемся на initialData
  // (у старой Leaflet-карты он уже есть из allRoutes).
  const description = detail?.description ?? (initialData.description || null);

  // Фолбэк копировал ссылку МОЛЧА: нажал — экран не дрогнул, и от отказа это
  // было неотличимо. Теперь исход называется вслух.
  async function handleShare() {
    const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/places/${initialData.id}`;
    const outcome = await shareLink({ title: initialData.title, url });
    const message = shareOutcomeMessage(outcome);
    if (message) {
      setShareStatus(message);
      setTimeout(() => setShareStatus(null), 2500);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[498]" onClick={onClose} />

      {/* Sheet */}
      <div
        ref={sheetRef}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className="fixed bottom-0 left-0 right-0 z-[499] rounded-t-2xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: '0 -8px 40px rgba(0,0,0,0.18)' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-[var(--border)]" />
        </div>
        {/* Photo strip */}
        <div className="relative h-40 bg-[var(--bg-hover)]">
          {detail?.photoUrl ? (
            <Image src={detail.photoUrl} alt={initialData.title} fill className="object-cover" sizes="100vw" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <MapPin className="w-8 h-8 text-[var(--text-muted)] opacity-40" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
          {/* Type badge */}
          <span className="absolute top-3 left-3 text-[10px] font-bold uppercase tracking-widest text-white px-2.5 py-1 rounded-full"
            style={{ background: 'var(--accent)' }}>
            {typeLabel}
          </span>
          {/* Close */}
          <button onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-full"
            style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.2)' }}>
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-[var(--text-primary)] text-base leading-snug"
                style={{ fontFamily: 'var(--font-playfair)' }}>
                {initialData.title}
              </h3>
              {distLabel && (
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{distLabel} от вас</p>
              )}
            </div>
          </div>

          {/* Description */}
          {description && (
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-2 mb-3">
              {description.split('\n')[0]}
            </p>
          )}

          {/* Опасности места — как в ответе get_place_info: из профиля
              безопасности; нет записи — так и сказано, не «безопасно». */}
          {!isOffline && (
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed mb-3" data-testid="sheet-hazards">
              {sheetHazardsLine(detailState, detail?.hazards ?? [])}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 mb-3">
            <Link href={ownRouteUrl}
              className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-xl text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)' }}>
              <Navigation className="w-4 h-4" /> Навигация
            </Link>
            <button onClick={fav.toggle}
              aria-label={wishlistLabel(fav)}
              title={fav.localOnly ? WISHLIST_LOCAL_ONLY_HINT : undefined}
              className="p-2.5 rounded-xl border transition-colors"
              style={{
                background: fav.on ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))' : 'var(--bg-hover)',
                borderColor: fav.on ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border)',
                color: fav.on ? 'var(--accent)' : 'var(--text-secondary)',
              }}>
              <Bookmark className="w-4 h-4" fill={fav.on ? 'currentColor' : 'none'} />
            </button>
            <button onClick={handleShare}
              aria-label="Поделиться"
              className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors">
              <Share2 className="w-4 h-4" />
            </button>
          </div>
          {fav.localOnly && (
            <p className="mb-3 text-xs text-[var(--warning)]" aria-live="polite">{WISHLIST_LOCAL_ONLY_HINT}</p>
          )}
          {shareStatus && (
            <p className="mb-3 text-xs text-[var(--text-secondary)]" aria-live="polite">{shareStatus}</p>
          )}

          {/* Routes through this place */}
          {(detail?.routes?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {detail!.routes.map(r => (
                <Link key={r.id} href={`/routes/${r.id}`}
                  className="text-xs font-medium px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:border-[var(--ocean)] hover:text-[var(--ocean)] transition-colors">
                  {r.title}
                </Link>
              ))}
            </div>
          )}

          {/* Open details */}
          <Link href={`/places/${initialData.id}`}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-hover)] hover:bg-[var(--bg-card)] transition-colors mb-1">
            Открыть подробнее <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </>
  );
}
