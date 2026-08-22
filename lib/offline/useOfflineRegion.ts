'use client';

/**
 * Хук для управления скачиванием региона для офлайн-доступа.
 * Координирует SW (тайлы) + IndexedDB (маршруты) + SOS-контакты.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RegionId } from '@/lib/geo/regions';
import { REGIONS } from '@/lib/geo/regions';
import { generateTileUrls } from '@/lib/offline/tiles';
import {
  saveRegion,
  getRegion,
  deleteRegion,
  saveRoutes,
  listRegions,
  listFieldPackRecords,
  getRoutesByRegion,
  type RegionMeta,
  type OfflineRoute,
} from '@/lib/offline/db';
import {
  planTileRelease, regionTileUrls, packTileHolder, type TileHolder,
} from '@/lib/offline/tile-ownership';

/**
 * `partial` — регион скачан не целиком: часть тайлов не легла в кэш (или
 * уже вычищена системой). Это отдельное честное состояние: раньше частичная
 * закачка становилась либо `error` (неотличимо от «ничего нет»), либо
 * `cached` (ложь о готовности) — а в поле разница между «карта есть местами»
 * и «карты нет» решает, выходить ли вообще.
 */
export type DownloadStatus = 'idle' | 'fetching-routes' | 'caching-tiles' | 'cached' | 'partial' | 'error';

export interface DownloadProgress {
  done: number;
  failed: number;
  total: number;
  /** 0-100 */
  percent: number;
}

export interface UseOfflineRegionReturn {
  status: DownloadStatus;
  progress: DownloadProgress;
  regionMeta: RegionMeta | null;
  error: string | null;
  download: () => Promise<void>;
  remove: () => Promise<void>;
}

const EMPTY_PROGRESS: DownloadProgress = { done: 0, failed: 0, total: 0, percent: 0 };

/**
 * Выборочная проверка: лежат ли тайлы региона в Cache Storage НА САМОМ ДЕЛЕ.
 *
 * Метаданные в IndexedDB — это память о том, что закачка когда-то прошла.
 * Сами тайлы живут в другом хранилище, и система вправе вычистить его при
 * нехватке места, не тронув метаданные. Верить записи без проверки — значит
 * показать «скачано» человеку, у которого карты уже нет.
 *
 * Проверяем пробу из нескольких тайлов по краям и середине списка: полная
 * проверка тысяч URL при каждом монтировании не нужна, а проба ловит главный
 * сценарий — кэш вычищен целиком.
 *
 * `null` — проверить нечем (нет Cache Storage API): остаётся верить записи.
 */
async function sampleTilesPresent(tileUrls: string[]): Promise<boolean | null> {
  if (typeof caches === 'undefined' || tileUrls.length === 0) return null;
  const idxs = [0, Math.floor(tileUrls.length / 2), tileUrls.length - 1];
  const sample = [...new Set(idxs)].map(i => tileUrls[i]);
  try {
    // Request объектом, не строкой: `x.match(строка)` неотличимо от
    // String.prototype.match, и анализатор читает URL как регулярное
    // выражение (CodeQL js/incomplete-hostname-regexp). Поведение то же.
    const hits = await Promise.all(sample.map(u => caches.match(new Request(u))));
    return hits.some(h => h !== undefined);
  } catch {
    return null;
  }
}

export function useOfflineRegion(regionId: RegionId): UseOfflineRegionReturn {
  const [status, setStatus] = useState<DownloadStatus>('idle');
  const [progress, setProgress] = useState<DownloadProgress>(EMPTY_PROGRESS);
  const [regionMeta, setRegionMeta] = useState<RegionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const swMessageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);

  // Загружаем сохранённые метаданные при монтировании — и проверяем их
  // делом: запись «скачано» без тайлов в Cache Storage — это partial,
  // а не cached. Система чистит кэш тайлов, не трогая IndexedDB.
  useEffect(() => {
    let cancelled = false;
    getRegion(regionId).then(async (meta) => {
      if (cancelled || !meta) return;
      setRegionMeta(meta);
      const region = REGIONS[regionId];
      const present = region ? await sampleTilesPresent(generateTileUrls(region.bbox)) : null;

      // Маршруты тоже проверяются ДЕЛОМ, а не записью. Прежний комментарий
      // утверждал, что при пропавших тайлах «маршруты в IndexedDB живы», —
      // и это нигде не проверялось. Браузер, вычищая хранилище источника,
      // снимает и IndexedDB: тогда «41 маршрут скачан» становится неправдой
      // ровно в тот момент, когда правда нужнее всего.
      let routesShort = false;
      try {
        const stored = await getRoutesByRegion(regionId);
        routesShort = stored.length < meta.routesCount;
      } catch {
        // Прочитать не смогли — это не «маршрутов нет». Оставляем как есть:
        // выдать непроверенное за проверенное хуже, чем не проверить.
      }

      if (cancelled) return;
      if (present === false || routesShort) {
        // Что-то из обещанного не на месте: карта, маршруты или и то и другое.
        setStatus('partial');
      } else {
        // Тайлы на месте (или проверить нечем — верим записи), но закачка
        // могла пройти с потерями: это записано в самой записи.
        setStatus((meta.tilesFailed ?? 0) > 0 ? 'partial' : 'cached');
      }
    });
    return () => { cancelled = true; };
  }, [regionId]);

  // Очищаем SW listener при размонтировании
  useEffect(() => {
    return () => {
      if (swMessageHandlerRef.current) {
        navigator.serviceWorker?.removeEventListener('message', swMessageHandlerRef.current);
      }
    };
  }, []);

  const download = useCallback(async () => {
    if (status === 'fetching-routes' || status === 'caching-tiles') return;

    setError(null);
    setProgress(EMPTY_PROGRESS);

    const region = REGIONS[regionId];
    if (!region) {
      setError('Регион не найден');
      setStatus('error');
      return;
    }

    try {
      // ── Шаг 1: Запрашиваем маршруты из API ────────────────────────────
      setStatus('fetching-routes');

      const { bbox } = region;
      const params = new URLSearchParams({
        south: String(bbox.south),
        west: String(bbox.west),
        north: String(bbox.north),
        east: String(bbox.east),
        limit: '500',
      });

      const res = await fetch(`/api/routes/by-region?${params.toString()}`);
      if (!res.ok) throw new Error(`API вернул ${res.status}`);

      const { routes } = (await res.json()) as { routes: OfflineRoute[] };

      // ── Шаг 2: Сохраняем маршруты в IndexedDB ─────────────────────────
      const routesWithRegion: OfflineRoute[] = routes.map((r) => ({
        ...r,
        regionId,
        // Дефолты на случай ответа старого билда (#836): пустой список честнее
        // undefined — «ограничений не зафиксировано», а не «поле сломано».
        activeAlerts: r.activeAlerts ?? [],
        alertSeverity: r.alertSeverity ?? 0,
        alertsAt: r.alertsAt ?? null,
        cachedAt: Date.now(),
      }));
      await saveRoutes(routesWithRegion);

      // Шага «сохранить SOS-контакты» здесь больше нет. Номера спасения
      // живут в lib/safety/emergency-numbers.ts, приезжают в бандл каждого
      // экрана и лежат в офлайн-странице /emergency. Копия в IndexedDB
      // писалась и не читалась ни разу — то есть могла молча разойтись с
      // реестром, не давая взамен ничего (перепись 22.08.2026).

      // ── Шаг 4: Отправляем тайлы в SW ──────────────────────────────────
      const tileUrls = generateTileUrls(bbox);
      const totalTiles = tileUrls.length;

      if (!('serviceWorker' in navigator)) {
        throw new Error('Service Worker не поддерживается в этом браузере');
      }

      const sw = await navigator.serviceWorker.ready;
      if (!sw.active) throw new Error('Service Worker не активен');

      setStatus('caching-tiles');
      setProgress({ done: 0, failed: 0, total: totalTiles, percent: 0 });

      // ── Шаг 5: Слушаем прогресс от SW ─────────────────────────────────
      // Промис отдаёт число НЕскачанных тайлов: ноль — пакет целый,
      // больше нуля — частичный, и это различие обязано доехать до статуса.
      const failedTiles = await new Promise<number>((resolve, reject) => {
        const handler = (event: MessageEvent) => {
          const data = event.data;
          if (!data || data.regionId !== regionId) return;

          if (data.type === 'TILE_PROGRESS') {
            const percent = data.total > 0
              ? Math.round(((data.done + data.failed) / data.total) * 100)
              : 0;
            setProgress({ done: data.done, failed: data.failed, total: data.total, percent });
          }

          if (data.type === 'TILES_DONE') {
            navigator.serviceWorker.removeEventListener('message', handler);
            swMessageHandlerRef.current = null;
            setProgress({
              done: data.done,
              failed: data.failed,
              total: data.total,
              percent: 100,
            });
            // Если тайлы не скачались вовсе — ошибка, а не "скачано"
            if (data.failed > 0 && data.done === 0) {
              reject(new Error(`Тайлы не скачаны: ${data.failed} ошибок из ${data.total}`));
            } else {
              resolve(Number(data.failed) || 0);
            }
          }
        };

        swMessageHandlerRef.current = handler;
        navigator.serviceWorker.addEventListener('message', handler);

        // Таймаут 15 минут (большой регион)
        const timeout = setTimeout(() => {
          navigator.serviceWorker.removeEventListener('message', handler);
          swMessageHandlerRef.current = null;
          reject(new Error('Таймаут скачивания тайлов (15 мин)'));
        }, 15 * 60 * 1000);

        sw.active!.postMessage({
          type: 'CACHE_TILES',
          tiles: tileUrls,
          regionId,
        });

        // Отменяем таймаут в случае resolve
        void Promise.resolve().then(() => clearTimeout(timeout));
      });

      // ── Шаг 6: Сохраняем метаданные региона ───────────────────────────
      const meta: RegionMeta = {
        id: regionId,
        downloadedAt: Date.now(),
        version: 1,
        tilesCount: totalTiles,
        routesCount: routesWithRegion.length,
        sizeBytes: 0, // точный размер — через StorageEstimate
        tilesFailed: failedTiles,
      };
      await saveRegion(meta);
      setRegionMeta(meta);
      // Частичная закачка не становится «cached»: неполный пакет, выданный
      // за готовый, обнаруживается уже в поле — без связи и без шанса дочитать.
      setStatus(failedTiles > 0 ? 'partial' : 'cached');

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
      setError(message);
      setStatus('error');
    }
  }, [regionId, status]);

  const remove = useCallback(async () => {
    try {
      // ── 1. Тайлы. Основной объём региона — от 6 до 22 МБ, и до 22.08.2026
      //    они не удалялись НИКОГДА: команда service worker'у отвечала
      //    «готово», не удалив ничего. Считаем адреса, которые не держит
      //    никто из остающихся, и отдаём готовый список.
      //
      //    Считается ДО удаления метаданных: список скачанных регионов нужен,
      //    чтобы не проделать дыру в карте соседа.
      if ('serviceWorker' in navigator) {
        try {
          const [regions, packs] = await Promise.all([listRegions(), listFieldPackRecords()]);
          const leaving: TileHolder = { id: `region:${regionId}`, urls: regionTileUrls(regionId) };
          const remaining: TileHolder[] = [
            ...regions
              .filter((m) => m.id !== regionId)
              .map((m) => ({ id: `region:${m.id}`, urls: regionTileUrls(m.id) })),
            ...packs.map(packTileHolder),
          ];
          const plan = planTileRelease(leaving, remaining);
          const sw = await navigator.serviceWorker.ready;
          sw.active?.postMessage({ type: 'CLEAR_TILES', urls: plan.release, reason: `region:${regionId}` });
        } catch (err) {
          // Тайлы не сняты — регион всё равно удаляем: остаться с записью о
          // регионе, которого нет, хуже. Но молчать нельзя: место не
          // освободилось, и это не то же самое, что «освободилось».
          console.error('[offline] тайлы региона не удалены:',
            err instanceof Error ? err.message : err);
        }
      }

      // ── 2. Метаданные и маршруты из IndexedDB
      await deleteRegion(regionId);

      setRegionMeta(null);
      setStatus('idle');
      setProgress(EMPTY_PROGRESS);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка удаления';
      setError(message);
    }
  }, [regionId]);

  return { status, progress, regionMeta, error, download, remove };
}
