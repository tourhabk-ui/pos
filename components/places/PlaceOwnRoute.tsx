'use client';

/**
 * components/places/PlaceOwnRoute.tsx
 *
 * Свой рассчитанный автопуть до места — прямо на карточке (владелец 07.09:
 * «добавить свой трек на место»). До этой правки обе ссылки навигации на
 * карточке места (PlaceActionBar, MobileBottomBar) вели во внешние
 * навигаторы (осознанное решение 11.08 — «строить дорогу лучше нас»), а
 * свой роутер (roadGraphCarProvider, свой граф Камчатки, миграция 760)
 * был подключён только в /planning. Здесь — тот же расчёт, та же линия
 * (calculatedCarLine, §12), но без похода на отдельный экран.
 *
 * mayNavigate/mayPersist у этого провайдера — false (см.
 * lib/on-route/calculated-route.ts): модель скоростей графа сама себя
 * называет «стартовые оценки, калибровать по полевым прогонам» и ещё не
 * проверена в поле. Поэтому это ПРЕВЬЮ — линия на карте и факты под ней,
 * без кнопки «Начать маршрут» и без сохранения пути. Тот же контракт, что
 * уже действует в /planning (renderDestinationPicker, ветка calculatedPreview).
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Navigation } from 'lucide-react';
import type { MapMarker, MapMarkerGeometry } from '@/components/shared/leaflet-types';
import { MarkerType } from '@/components/shared/leaflet-types';
import { calculatedCarLine } from '@/lib/map/line-standard';
import { calculatedCarToLeafletCoordinates, type CalculatedCarRoute } from '@/lib/on-route/calculated-route';
import type { RouteBuildResult } from '@/lib/on-route/route-build';

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

interface Props {
  lat: number;
  lng: number;
  name: string;
}

type State =
  | { phase: 'idle' }
  | { phase: 'locating' }
  | { phase: 'building' }
  | { phase: 'found'; route: CalculatedCarRoute }
  | { phase: 'refused'; message: string }
  | { phase: 'error'; message: string };

/**
 * Три честных отказа контракта RouteBuildResult сведены к одному тексту
 * человеку — все три означают «пути не будет», причина у каждого своя, но
 * действие одинаковое (§4.0: третье состояние — «не смог», не выдумка).
 */
function refusalText(result: Extract<RouteBuildResult, { status: 'not_found' | 'unsupported' | 'failed' }>): string {
  if (result.status === 'unsupported') return result.reason;
  if (result.status === 'not_found') return result.reason;
  return result.message;
}

export function PlaceOwnRoute({ lat, lng, name }: Props) {
  const [state, setState] = useState<State>({ phase: 'idle' });

  function build() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ phase: 'error', message: 'Геолокация недоступна в этом браузере' });
      return;
    }
    setState({ phase: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setState({ phase: 'building' });
        fetch('/api/routes/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin: { kind: 'current', lat: pos.coords.latitude, lon: pos.coords.longitude },
            destination: { kind: 'coordinate', lat, lon: lng, title: name },
            mode: 'car',
          }),
        })
          .then(r => r.json())
          .then((json: { success: boolean; result?: RouteBuildResult; error?: string }) => {
            if (!json.success || !json.result) {
              setState({ phase: 'error', message: json.error ?? 'Сервер не ответил' });
              return;
            }
            const { result } = json;
            if (result.status === 'found') {
              const calculated = result.options[0]?.calculated;
              if (!calculated) {
                setState({ phase: 'error', message: 'Ответ сервера не содержит рассчитанного пути' });
                return;
              }
              setState({ phase: 'found', route: calculated });
              return;
            }
            setState({ phase: 'refused', message: refusalText(result) });
          })
          .catch(() => setState({ phase: 'error', message: 'Ошибка сети — проверьте соединение' }));
      },
      () => setState({ phase: 'error', message: 'Не удалось определить ваше местоположение' }),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }

  if (state.phase === 'idle') {
    return (
      <button type="button" onClick={build}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]">
        <Navigation className="h-4 w-4 text-[var(--accent)]" aria-hidden />
        Построить свой путь на автомобиле
      </button>
    );
  }

  if (state.phase === 'locating' || state.phase === 'building') {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-secondary)]">
        {state.phase === 'locating' ? 'Определяем ваше местоположение…' : 'Считаем путь по дорожной сети…'}
      </div>
    );
  }

  if (state.phase === 'error' || state.phase === 'refused') {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
        <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>
        <button type="button" onClick={build} className="mt-2 text-xs font-semibold text-[var(--accent)]">
          Попробовать снова
        </button>
      </div>
    );
  }

  // state.phase === 'found'
  const { route } = state;
  const leafletLine = calculatedCarToLeafletCoordinates(route);
  if (!leafletLine || !route.mayDisplay) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
        <p className="text-sm text-[var(--text-secondary)]">
          {!route.mayDisplay
            ? 'Провайдер не разрешил показать геометрию этого пути.'
            : 'Путь посчитан, но геометрия непригодна для отображения.'}
        </p>
      </div>
    );
  }
  const line = calculatedCarLine();
  const center: [number, number] = leafletLine[Math.floor(leafletLine.length / 2)];
  const markers: MapMarker[] = [
    {
      coords: center,
      title: line.title,
      color: 'teal',
      type: MarkerType.POI,
      geometry: { type: 'polyline', coordinates: leafletLine, ...line.style } as MapMarkerGeometry,
    },
    {
      coords: [route.originSnapped.lat, route.originSnapped.lon],
      title: 'Старт на дороге',
      description: `Старт привязан к дороге в ${Math.round(route.originSnapped.snapDistanceM)} м`,
      color: 'orange',
      type: MarkerType.POI,
    },
    {
      coords: [route.destinationSnapped.lat, route.destinationSnapped.lon],
      title: 'Цель на дороге',
      description: `Цель привязана к дороге в ${Math.round(route.destinationSnapped.snapDistanceM)} м`,
      color: 'green',
      type: MarkerType.POI,
    },
  ];

  return (
    <div>
      <div className="rounded-xl overflow-hidden mb-3" style={{ height: 220, border: '1px solid var(--border)' }}>
        <LeafletMap markers={markers} center={center} zoom={11} height="220px" showUserLocation />
      </div>
      {/* Подпись линии — НЕИЗМЕННА по контракту calculatedCarLine() (§12). */}
      <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>{line.caption}</p>
      <div className="space-y-1 mb-3 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-hover)' }}>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {(route.distanceM / 1000).toFixed(1)} км · {Math.round(route.durationS / 60)} мин
        </p>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          Построил {route.provider}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          Пробки {route.traffic ? 'учтены' : 'не учитывались'}
        </p>
      </div>
      {/* Кнопки «Начать маршрут» здесь нет НАМЕРЕННО — mayNavigate: false у
          первого провайдера (см. шапку файла): передавать эту линию в
          полевой навигатор нельзя, пока модель скоростей не проверена в поле. */}
      <button type="button" onClick={() => setState({ phase: 'idle' })}
        className="w-full text-xs font-semibold px-4 py-2.5 rounded-lg"
        style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
        Скрыть путь
      </button>
    </div>
  );
}
