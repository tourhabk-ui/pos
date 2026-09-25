/**
 * Карта маршрута в телефон — ОДНО правило на все кнопки (25.09).
 *
 * До этого дня кнопок «сохранить карту» было две, и работала одна. Полевой
 * экран с 24.09 качал свои пакеты (клетки под маршрутом, обзор края, глифы
 * подписей) в Cache Storage, откуда их отдаёт service worker, — это
 * проверено делом на раннере: без связи карта нарисовалась целиком. Кнопка
 * «Скачать для похода» на карточке маршрута по-прежнему слала service
 * worker'у список растровых тайлов OSM (`CACHE_TILES`), чья массовая закачка
 * выключена с 28.08, — то есть не сохраняла ни разу. Хуже того: без service
 * worker'а она сразу рисовала «Готово к офлайн», не положив ни байта.
 *
 * Правило, реализованное на двух экранах дважды, — это два правила, и они
 * уже разошлись. Поэтому здесь обе половины целиком — план (что качать и
 * сколько это весит) и сохранение (закачка с проверками и запись о ней), —
 * а экраны только показывают результат.
 *
 * У каждого исхода — слова: план не посчитан, сохранять нечем, места не
 * хватит, легло не всё. Молчание перед выходом в поле читается как
 * «сохранилось» (§4.0).
 */
import { planPackFiles, type PackFile } from '@/lib/offline/pack-files';
import { measurePackFiles, downloadPackFiles, totalMb, type PackDownloadResult } from '@/lib/offline/pack-download';
import { savedMapKey, requestPersistentStorage, SAVED_PROBE_SIZE, type SavedMapRecord } from '@/lib/offline/saved-map';
import { evenSample } from '@/lib/offline/coverage';
import type { RegionPack } from '@/lib/map/field-base-map';

/** Что будет лежать в телефоне и сколько это весит — до нажатия. */
export interface RouteMapPlan {
  tiles: number;
  mb: number;
  zooms: number[];
  dropped: number[];
  coverage: 'corridor' | 'bbox' | 'packs';
  bufferKm: number | null;
  urls: string[];
  /** Файлы своих пакетов (24.09) — то, что кнопка кладёт в телефон. */
  files: PackFile[];
  /** Сколько файлов хранилище не назвало по весу: МБ на кнопке — нижняя граница. */
  unknownSize: number;
}

/** Ответ /offline-bundle целиком: линию и точки экраны кладут себе сами. */
export type OfflineBundle = Record<string, unknown>;

export type RouteMapPlanResult =
  | { ok: true; plan: RouteMapPlan; bundle: OfflineBundle }
  | { ok: false; error: string };

export interface RouteMapProgress { done: number; total: number; unit: 'МБ' | 'файлов' }

export type RouteMapSaveResult =
  | {
      ok: true;
      rec: SavedMapRecord;
      persisted: boolean;
      failed: PackDownloadResult['failed'];
      /** Легло не всё — сказать человеку, но запись о сохранённом сделать. */
      warning: string | null;
    }
  | { ok: false; error: string };

/**
 * План карты маршрута: рамка с сервера → клетки из реестра пакетов → вес.
 *
 * Сервер отдаёт рамку маршрута; клетки по ней выбираются здесь, из того же
 * реестра пакетов, которым карта рисует поле.
 */
export async function planRouteMap(routeId: string, regionPacks: readonly RegionPack[]): Promise<RouteMapPlanResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // Связи нет — план посчитать нечем, и это НЕ «сохранять нечего».
    return { ok: false, error: 'Нет связи — размер пакета не посчитать. Подключитесь, пока не ушли в поле' };
  }
  try {
    const res = await fetch(`/api/routes/${routeId}/offline-bundle`);
    const data = await res.json() as OfflineBundle;
    if (!res.ok) {
      const why = typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`;
      console.error('[offline-bundle] план не посчитан:', why);
      return { ok: false, error: `Сервер не отдал план карты (${why})` };
    }
    const b = (data.route_bounds ?? data.bbox) as Record<string, unknown> | undefined;
    const bounds = b && [b.south, b.west, b.north, b.east].every(x => typeof x === 'number' && Number.isFinite(x))
      ? { south: b.south as number, west: b.west as number, north: b.north as number, east: b.east as number }
      : null;
    const plan = planPackFiles(bounds, regionPacks);
    if (!plan || plan.files.length === 0) {
      // Ноль файлов при живом ответе — не «карта не нужна»: либо у
      // маршрута нет координат, либо пакетов под ним не собрано.
      console.error('[offline-bundle] план пуст:', bounds ? 'под рамкой нет пакетов' : 'рамки нет');
      return {
        ok: false,
        error: bounds
          ? 'Под этим маршрутом нет собранных пакетов карты — сохранить нечего'
          : 'Для этого маршрута карту выбрать не из чего: нет линии или координат',
      };
    }
    const measured = await measurePackFiles(plan.files);
    // Диапазона глифов, которого в хранилище нет, нет и в плане: качать
    // нечего, а «не лёг» у него делало бы карту вечно неполной. Хранилище
    // на отсутствующий ключ отвечает 403, а не 404 (offline-pack-check,
    // прогон 1). Прочие отказы остаются — это пропавший файл пакета, и о
    // нём скажут при закачке.
    const sized = measured.filter(f => !(f.kind === 'glyphs' && (f.status === 403 || f.status === 404)));
    const { mb, unknown } = totalMb(sized);
    return {
      ok: true,
      bundle: data,
      plan: {
        tiles: sized.length,
        mb,
        // Обзор края — зумы 4-7, клетки и районы — 8-13 (pack-source).
        zooms: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
        dropped: [],
        coverage: 'packs',
        bufferKm: null,
        urls: sized.map(f => f.url),
        files: sized.map(({ url, kind, pack }) => ({ url, kind, pack })),
        unknownSize: unknown,
      },
    };
  } catch (err) {
    // Молчать нельзя: без плана нет и кнопки сохранения.
    const why = err instanceof Error ? err.message : String(err);
    console.error('[offline-bundle] запрос плана не выполнен:', why);
    return { ok: false, error: 'Не смогли спросить сервер о карте — проверьте связь и повторите' };
  }
}

/**
 * Положить карту в телефон по плану и записать, что лежит.
 *
 * Запись идёт под `savedMapKey(routeId)` — её читает полевой экран, так что
 * карта, сохранённая с карточки маршрута, видна и там, и проверяется делом.
 */
export async function saveRouteMap(
  routeId: string,
  plan: RouteMapPlan,
  onProgress: (p: RouteMapProgress) => void,
): Promise<RouteMapSaveResult> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return { ok: false, error: 'Браузер не умеет сохранять карту офлайн (нет service worker)' };
  }
  if (typeof caches === 'undefined') {
    return { ok: false, error: 'Браузер не даёт хранилища для карты (нет Cache Storage)' };
  }
  // Закрепление просим ЖЕСТОМ: без него система вправе вычистить кэш при
  // нехватке места — без предупреждения и, по закону подлости, перед
  // выходом. Отказ браузера не скрываем, он попадёт в запись.
  const persisted = await requestPersistentStorage();
  try {
    const reg = await navigator.serviceWorker.ready;
    // Без активного service worker'а файлы лягут в кэш, но отдать их карте
    // без связи будет некому.
    if (!reg.active) {
      return { ok: false, error: 'Офлайн-хранилище ещё не проснулось — повторите через несколько секунд' };
    }
    // Места — до закачки, а не после сотни мегабайт трафика.
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est && typeof est.quota === 'number' && typeof est.usage === 'number' && plan.mb > 0) {
      const freeMb = Math.floor((est.quota - est.usage) / 1e6);
      if (freeMb < plan.mb * 1.1) {
        return { ok: false, error: `Не хватит места: карта ~${plan.mb} МБ, свободно ~${freeMb} МБ` };
      }
    }
    const byMb = plan.mb > 0;
    onProgress(byMb ? { done: 0, total: plan.mb, unit: 'МБ' } : { done: 0, total: plan.tiles, unit: 'файлов' });
    const res = await downloadPackFiles(plan.files, (p) => {
      onProgress(byMb
        ? { done: Math.min(plan.mb, Math.floor(p.bytesDone / 1e6)), total: plan.mb, unit: 'МБ' }
        : { done: p.done, total: p.total, unit: 'файлов' });
    });
    if (res.failed.length > 0) {
      console.error('[field-pack] не легли файлы карты, маршрут', routeId,
        res.failed.map(f => `${f.kind}: ${f.why}`).join('; '));
    }
    if (res.saved === 0) {
      return { ok: false, error: `Карта не сохранилась: ${res.failed[0]?.why ?? 'причина неизвестна'}` };
    }
    const warning = res.failed.length > 0
      ? `Сохранено ${res.saved} из ${plan.tiles} файлов карты — не легли: `
        + res.failed.map(f => f.kind).join(', ') + '. Повторите, пока есть связь'
      : null;
    const rec: SavedMapRecord = {
      at: Date.now(), tiles: plan.tiles, mb: Math.round(res.bytes / 1e6) || plan.mb,
      zooms: plan.zooms, droppedZooms: plan.dropped,
      coverage: plan.coverage, bufferKm: plan.bufferKm, persisted,
      sampleUrls: evenSample(plan.urls, SAVED_PROBE_SIZE),
    };
    // Приватный режим отказывает в записи, а карта при этом уже сохранена —
    // пугать этим человека нечем.
    try { localStorage.setItem(savedMapKey(routeId), JSON.stringify(rec)); } catch { /* ignore */ }
    return { ok: true, rec, persisted, failed: res.failed, warning };
  } catch (err) {
    // Пустой catch превращал поломку в «ничего не случилось», что перед
    // выходом в поле дороже.
    console.error('[field-pack] сохранение карты не удалось, маршрут',
      routeId, err instanceof Error ? err.message : err);
    return { ok: false, error: 'Не удалось сохранить карту. Попробуйте ещё раз.' };
  }
}
