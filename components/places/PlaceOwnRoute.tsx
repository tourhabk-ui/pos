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

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Navigation, Footprints, Car } from 'lucide-react';
import type { MapMarker, MapMarkerGeometry } from '@/components/shared/leaflet-types';
import { MarkerType } from '@/components/shared/leaflet-types';
import { calculatedLine } from '@/lib/map/line-standard';
import { calculatedCarToLeafletCoordinates, type CalculatedCarRoute } from '@/lib/on-route/calculated-route';
import type { RouteBuildResult } from '@/lib/on-route/route-build';

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

interface Props {
  lat: number;
  lng: number;
  name: string;
  /**
   * Начать расчёт сразу, не дожидаясь нажатия. Ставится, когда человек уже
   * нажал «Навигация» на ДРУГОМ экране (лист места на карте) и приехал сюда
   * с `?route=1`: заставлять его нажимать второй раз то же самое — потерянный
   * тап и потерянная секунда в поле.
   */
  autoStart?: boolean;
  /**
   * Не рисовать собственную кнопку запуска: на этом экране её роль уже играет
   * другая, и обе видны ОДНОВРЕМЕННО.
   *
   * Заведено 14.09 по снимку карточки места на телефоне: под фотографией шли
   * «Навигация» (липкая шапка, оранжевая, во всю ширину) и сразу под ней
   * «Построить свой путь на автомобиле» — две кнопки одного действия в сорока
   * пикселях друг от друга. Владелец уже ловил ровно это 07.09 («почему 2
   * кнопки навигация?»), тогда убрали третью, а эти две остались.
   *
   * Считает по-прежнему этот блок — он же показывает ход и результат;
   * снаружи приходит только событие OWN_ROUTE_EVENT. Пока считать не о чем,
   * блок молчит, а не занимает первый экран приглашением, которое уже есть
   * выше.
   */
  hideIdleTrigger?: boolean;
}

/**
 * Событие «построй свой путь» — для кнопки, которая стоит на том же экране,
 * но в другом поддереве (липкая шапка PlaceActionBar). Иначе пришлось бы
 * поднимать состояние расчёта в клиент страницы и тащить его через половину
 * дерева ради одного тапа.
 */
export const OWN_ROUTE_EVENT = 'vedar:build-own-route';

/** Якорь блока — к нему прокручивает кнопка из шапки. */
export const OWN_ROUTE_ANCHOR = 'own-route';

type State =
  | { phase: 'idle' }
  | { phase: 'locating' }
  | { phase: 'building' }
  | { phase: 'found'; car: ModeOutcome; foot: ModeOutcome; selected: TravelMode }
  | { phase: 'refused'; message: string }
  | { phase: 'error'; message: string };

type TravelMode = 'foot' | 'car';

/** Итог одного режима: путь, отказ словами или непригодный ответ. */
type ModeOutcome =
  | { kind: 'route'; route: CalculatedCarRoute; title: string | null }
  | { kind: 'refused'; message: string };

/**
 * Какой режим показать первым, когда посчитаны оба (03.10, как у Яндекса):
 * пешком — если пеший путь есть и не длиннее этого; иначе машина. Человек
 * переключит сам — выбор по умолчанию только экономит тап.
 */
export const FOOT_DEFAULT_MAX_M = 8_000;

export function defaultMode(car: ModeOutcome, foot: ModeOutcome): TravelMode {
  if (foot.kind === 'route' && foot.route.distanceM <= FOOT_DEFAULT_MAX_M) return 'foot';
  if (car.kind === 'route') return 'car';
  return foot.kind === 'route' ? 'foot' : 'car';
}

/** «1 ч 3 мин» / «28 мин» — как у навигаторов. */
export function formatDuration(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

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

/** Сколько ждать координату для подъезда, мс. */
export const LOCATE_TIMEOUT_MS = 20_000;

/** Отказ геолокации — словами, по коду GeolocationPositionError. */
export function locateFailureText(code: number | undefined): string {
  if (code === 1) return 'Доступ к геопозиции запрещён — разрешите его для сайта в настройках браузера';
  if (code === 2) return 'Телефон не смог определить место — включите геолокацию и выйдите под открытое небо';
  if (code === 3) return `Телефон не отдал координату за ${LOCATE_TIMEOUT_MS / 1000} с — попробуйте ещё раз`;
  return 'Не удалось определить ваше местоположение';
}

export function PlaceOwnRoute({ lat, lng, name, autoStart = false, hideIdleTrigger = false }: Props) {
  const [state, setState] = useState<State>({ phase: 'idle' });

  const build = useCallback(function build() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ phase: 'error', message: 'Геолокация недоступна в этом браузере' });
      return;
    }
    setState({ phase: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setState({ phase: 'building' });
        // Оба режима сразу (03.10): человек выбирает, видя время каждого, —
        // как в навигаторах. Отказ одного режима не гасит другой.
        const origin = { kind: 'current', lat: pos.coords.latitude, lon: pos.coords.longitude };
        const destination = { kind: 'coordinate', lat, lon: lng, title: name };
        const one = (mode: TravelMode): Promise<ModeOutcome> => fetch('/api/routes/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin, destination, mode }),
        })
          .then(r => r.json())
          .then((json: { success: boolean; result?: RouteBuildResult; error?: string }): ModeOutcome => {
            if (!json.success || !json.result) {
              return { kind: 'refused', message: json.error ?? 'Сервер не ответил' };
            }
            const { result } = json;
            if (result.status === 'found') {
              const option = result.options[0];
              if (!option?.calculated) {
                return { kind: 'refused', message: 'Ответ сервера не содержит рассчитанного пути' };
              }
              // Заголовок сервера несёт остаток без тропы/дороги («последние
              // 700 м без тропы, по азимуту») — показывается как есть.
              return { kind: 'route', route: option.calculated, title: option.title !== name ? option.title : null };
            }
            return { kind: 'refused', message: refusalText(result) };
          })
          .catch((): ModeOutcome => ({ kind: 'refused', message: 'Ошибка сети — проверьте соединение' }));
        Promise.all([one('car'), one('foot')]).then(([car, foot]) => {
          if (car.kind === 'refused' && foot.kind === 'refused') {
            setState({ phase: 'refused', message: `Пешком: ${foot.message}. На машине: ${car.message}.` });
            return;
          }
          setState({ phase: 'found', car, foot, selected: defaultMode(car, foot) });
        });
      },
      // Причина — словами по коду отказа (03.10, скрин владельца на маршруте
      // «Гора Замок»: «Не удалось определить ваше местоположение» без единого
      // намёка, что делать). Запрет, «нет спутников» и таймаут лечатся
      // по-разному, а одна фраза на все три оставляла человека гадать.
      (err) => setState({ phase: 'error', message: locateFailureText(err?.code) }),
      // Для подъезда на машине хватает и точки десятиминутной давности:
      // ошибка в сотни метров дорогу не меняет. Ждём дольше прежних 8 с —
      // в машине и в посёлке телефон отдаёт первый фикс небыстро (SOS на том
      // же телефоне 03.10 искал 11 с).
      { enableHighAccuracy: false, timeout: LOCATE_TIMEOUT_MS, maximumAge: 10 * 60_000 },
    );
  }, [lat, lng, name]);

  // Приход с «Навигации» другого экрана: считаем сразу. Только из idle —
  // иначе повторный рендер сбрасывал бы уже показанный путь.
  useEffect(() => {
    if (autoStart && state.phase === 'idle') build();
    // Намеренно без state.phase в зависимостях: эффект должен сработать один
    // раз на приход, а не заново после каждого «Скрыть путь».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, build]);

  // Кнопка из липкой шапки — то же действие, другое поддерево.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener(OWN_ROUTE_EVENT, build);
    return () => window.removeEventListener(OWN_ROUTE_EVENT, build);
  }, [build]);

  if (state.phase === 'idle') {
    if (hideIdleTrigger) return null;
    return (
      <button type="button" onClick={build}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]">
        <Navigation className="h-4 w-4 text-[var(--accent)]" aria-hidden />
        Построить путь — пешком или на машине
      </button>
    );
  }

  if (state.phase === 'locating' || state.phase === 'building') {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-secondary)]">
        {state.phase === 'locating' ? 'Определяем ваше местоположение…' : 'Считаем путь пешком и на машине…'}
      </div>
    );
  }

  if (state.phase === 'error' || state.phase === 'refused') {
    // Отказ обязан оставлять человека с чем-то в руках. До 13.09 рядом стояли
    // марки чужих навигаторов, и «пути нет» означало «возьми другой навигатор»;
    // теперь их нет, и голое «Попробовать снова» было бы тупиком в поле.
    // Координата — то, что работает всегда: её диктуют по рации, вбивают в
    // прибор, шлют спасателям.
    const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
        <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          {/* Чья координата — названо (03.10): на карточке маршрута это
              старт тропы, и «координаты места» без имени владелец прочёл
              как старую координату самой горы. */}
          Координаты места «{name}»: <span className="font-semibold text-[var(--text-primary)]">{coords}</span>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" onClick={build} className="text-xs font-semibold text-[var(--accent)]">
            Попробовать снова
          </button>
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(coords).catch(() => {}); }}
            className="text-xs font-semibold text-[var(--ocean)]"
          >
            Скопировать координаты
          </button>
        </div>
      </div>
    );
  }

  // state.phase === 'found'
  const outcome = state[state.selected];
  const tabs = (
    <div className="mb-3 grid grid-cols-2 gap-2" role="tablist" aria-label="Как добираться">
      {(['foot', 'car'] as const).map((m) => {
        const o = state[m];
        const active = state.selected === m;
        const Icon = m === 'foot' ? Footprints : Car;
        return (
          <button key={m} type="button" role="tab" aria-selected={active}
            onClick={() => setState({ ...state, selected: m })}
            className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
              active
                ? 'bg-[var(--accent)] text-[var(--text-primary)]'
                : 'border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)]'
            }`}>
            <Icon className="h-4 w-4" aria-hidden />
            {o.kind === 'route' ? formatDuration(o.route.durationS) : (m === 'foot' ? 'Пешком — нет' : 'Машина — нет')}
          </button>
        );
      })}
    </div>
  );
  if (outcome.kind === 'refused') {
    return (
      <div>
        {tabs}
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
          <p className="text-sm text-[var(--text-secondary)]">{outcome.message}</p>
        </div>
      </div>
    );
  }
  const { route } = outcome;
  const foot = state.selected === 'foot';
  const leafletLine = calculatedCarToLeafletCoordinates(route);
  if (!leafletLine || !route.mayDisplay) {
    return (
      <div>
        {tabs}
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
          <p className="text-sm text-[var(--text-secondary)]">
            {!route.mayDisplay
              ? 'Провайдер не разрешил показать геометрию этого пути.'
              : 'Путь посчитан, но геометрия непригодна для отображения.'}
          </p>
        </div>
      </div>
    );
  }
  const line = calculatedLine(route.travelMode ?? state.selected);
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
      title: foot ? 'Начало пути' : 'Старт на дороге',
      description: foot
        ? `До тропы или дороги от вас ${Math.round(route.originSnapped.snapDistanceM)} м`
        : `Старт привязан к дороге в ${Math.round(route.originSnapped.snapDistanceM)} м`,
      color: 'orange',
      type: MarkerType.POI,
    },
    {
      coords: [route.destinationSnapped.lat, route.destinationSnapped.lon],
      title: foot ? 'Конец тропы' : 'Цель на дороге',
      description: foot
        ? `От конца тропы до места ${Math.round(route.destinationSnapped.snapDistanceM)} м`
        : `Цель привязана к дороге в ${Math.round(route.destinationSnapped.snapDistanceM)} м`,
      color: 'green',
      type: MarkerType.POI,
    },
  ];

  return (
    <div>
      {tabs}
      {outcome.title && (
        <p className="text-sm font-semibold mb-2 text-[var(--text-primary)]">{outcome.title}</p>
      )}
      <div className="rounded-xl overflow-hidden mb-3" style={{ height: 220, border: '1px solid var(--border)' }}>
        <LeafletMap markers={markers} center={center} zoom={11} height="220px" showUserLocation />
      </div>
      {/* Подпись линии — НЕИЗМЕННА по контракту calculatedCarLine() /
          calculatedFootLine() (§12). */}
      <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>{line.caption}</p>
      <div className="space-y-1 mb-3 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-hover)' }}>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {(route.distanceM / 1000).toFixed(1)} км · {formatDuration(route.durationS)}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          Построил {route.provider}
        </p>
        {!foot && (
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Пробки {route.traffic ? 'учтены' : 'не учитывались'}
          </p>
        )}
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
