/**
 * lib/on-route/route-build.ts — контракт построения пути (владелец 27.08, PR 5A).
 *
 * PR 1-4 развели три независимые сущности: Destination (куда), Origin
 * (откуда), RouteOption (готовый путь у цели, найденный текстовым поиском
 * места — не построенный между конкретными Origin/Destination). Пятый шаг
 * роадмапа — научиться СЧИТАТЬ путь между произвольными Origin и
 * Destination. Владелец разделил его на 5A (контракт + машина состояний
 * UI, этот файл) и 5B (подключение конкретного источника маршрутизации,
 * решение о режимах/офлайн-графе/безопасности — отдельно, не здесь).
 *
 * PR 5A НЕ подключает ни одного реального маршрутизатора. `notWiredBuilder`
 * — единственная реализация: она всегда честно отвечает `unsupported`, а не
 * молчит и не выдумывает путь. Так UI получает полную машину состояний
 * (idle → building → found/not_found/unsupported/failed) уже сейчас, и
 * подключение 5B не потребует переделывать экран — только заменить
 * реализацию `RouteBuilder`.
 *
 * PR 5B-1 (инфраструктурная часть, владелец 28.08) добавляет `httpRouteBuilder`
 * — РЕАЛЬНЫЙ транспорт до `POST /api/routes/build`, а не локальная заглушка:
 * ключи и провайдер живут на сервере (решение владельца — «не вызывать
 * провайдера напрямую из браузера»), браузер лишь получает нормализованный
 * RouteBuildResult. Источник маршрутизации при этом остаётся не выбран
 * (см. lib/on-route/route-provider.ts) — сервер сегодня тоже отвечает
 * `unsupported`, но уже настоящим сетевым запросом, а не синхронным стабом:
 * это проверяет весь транспортный слой (валидация, rate-limit, конверт края)
 * до того, как появится сам провайдер.
 */

import type { Destination, RouteOption } from '@/lib/on-route/destination';
import type { Origin } from '@/lib/on-route/origin';

export type RouteBuildMode = 'foot' | 'car';

export interface RouteBuildRequest {
  origin: Origin;
  destination: Destination;
  mode: RouteBuildMode;
}

export type RouteBuildResult =
  | { status: 'found'; options: RouteOption[] }
  | { status: 'not_found'; reason: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; retryable: boolean; message: string };

export interface RouteBuilder {
  build(request: RouteBuildRequest): Promise<RouteBuildResult>;
}

/**
 * Причина честного отказа — одна строка, не выдумка вида «не найдено»:
 * платформа НЕ ИСКАЛА путь, потому что искать им пока нечем.
 */
export const BUILDER_NOT_WIRED_REASON =
  'Платформа ещё не считает путь между произвольными точками — это следующий шаг (PR 5B).';

/**
 * Заглушка-по-умолчанию до PR 5B. Реализует контракт RouteBuilder честно:
 * НЕ пытается угадать путь, НЕ рисует прямую линию как маршрут — просто
 * называет своё отсутствие словами (§4.0: третье состояние, не тихий 0).
 */
export const notWiredBuilder: RouteBuilder = {
  async build(): Promise<RouteBuildResult> {
    return { status: 'unsupported', reason: BUILDER_NOT_WIRED_REASON };
  },
};

/**
 * Самоотмена устаревшего запроса ВНУТРИ билдера (не только в UI-эффекте).
 * Экран уже игнорирует запоздалый ответ через cleanup своего useEffect —
 * это не даёт устаревшему результату попасть на экран. Но сам HTTP-запрос
 * без этого продолжал бы идти впустую: смена origin/destination посреди
 * загрузки не отменяла сетевой запрос, только его РЕЗУЛЬТАТ. Один
 * AbortController на модуль — билдер синглтон, второй параллельный запрос
 * всегда означает «предыдущий больше не актуален».
 */
let activeBuildController: AbortController | null = null;

/**
 * Транспорт до серверного адаптера (владелец 28.08, PR 5B-1). Сам билдер
 * НЕ знает, какой провайдер стоит за /api/routes/build — эта граница и
 * есть смысл контракта: сервер отвечает тем же RouteBuildResult, что уже
 * умеет показывать экран, и подключение реального источника (следующий
 * шаг) не потребует менять ни эту функцию, ни экран — только серверный
 * маршрут.
 */
export const httpRouteBuilder: RouteBuilder = {
  async build(request: RouteBuildRequest): Promise<RouteBuildResult> {
    activeBuildController?.abort();
    const controller = new AbortController();
    activeBuildController = controller;
    try {
      const res = await fetch('/api/routes/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null) as { success?: boolean; result?: RouteBuildResult; error?: string } | null;
      if (!res.ok || !json?.success || !json.result) {
        return {
          status: 'failed',
          retryable: res.status >= 500 || res.status === 429,
          message: json?.error ?? 'Сервер не ответил на запрос пути',
        };
      }
      return json.result;
    } catch (err) {
      // Отменено более новым запросом — какой бы результат мы ни вернули,
      // до экрана он не доедет (тот же cleanup гасит его в UI); честный
      // failed здесь просто не оставляет промис вечно висеть.
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      return {
        status: 'failed',
        retryable: !aborted,
        message: aborted ? 'Отменено новым запросом' : 'Нет связи с сервером',
      };
    }
  },
};
