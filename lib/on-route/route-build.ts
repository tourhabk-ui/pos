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
