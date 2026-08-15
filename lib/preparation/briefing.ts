/**
 * Брифинг похода — что видит контакт вне маршрута (план FCN, этап 5).
 *
 * Договор простой и узкий: ссылка отдаёт ПЛАН и ВРЕМЯ, а не положение.
 * Телефонная PWA не спутниковый маяк; обещать «группа наблюдает» нельзя
 * ни онлайн, ни тем более офлайн. Поэтому в снимке нет и не может быть
 * координат, а страница брифинга говорит о времени возврата — том, по
 * чему человек снаружи поймёт, что пора звонить.
 *
 * Контактных данных получателя мы тоже не собираем: турист отправляет
 * ссылку сам своим мессенджером. Меньше ПД — меньше поводов для утечки
 * и никакой трансграничной передачи ради «поделиться».
 */

import type { PackAssetState } from '@/lib/offline/field-pack';
import { fieldPackReadiness } from '@/lib/offline/field-pack';
import type { PrepAnswers, PrepDomainSummary } from './types';

/** Снимок брифинга. Всё, что увидит получатель, — только эти поля. */
export interface BriefingSnapshot {
  routeTitle: string;
  routeVersion: number;
  /** Род данных маршрута словом — получатель тоже вправе знать границу. */
  routeGrade: string;
  waypointsCount: number;
  /** Когда выходят (ISO-дата) — если человек указал. */
  departureAt: string | null;
  /** К какому времени ждать обратно (ISO) — главное число брифинга. */
  returnBy: string | null;
  duration: PrepAnswers['duration'] | null;
  party: PrepAnswers['party'] | null;
  /** Готовность полевого пакета на момент отправки. */
  packReadiness: 'ready' | 'partial' | 'not_ready' | 'unknown';
  preparedDomains: number;
  totalDomains: number;
  /** Открытые действия — по названиям, без личных заметок. */
  openActions: string[];
  /** Когда снимок сделан (ISO). Возраст обязан быть виден на странице. */
  takenAt: string;
}

export const BRIEFING_MAX_DAYS = 30;
export const BRIEFING_DEFAULT_DAYS = 14;

/**
 * Срок жизни ссылки. Ссылка без срока — это публикация, а не «поделиться».
 * По умолчанию две недели; если известно время возврата — двое суток после
 * него (брифинг нужен, пока человек не вернулся, и ещё немного).
 */
export function briefingExpiry(returnBy: string | null, now: number = Date.now()): Date {
  const dflt = now + BRIEFING_DEFAULT_DAYS * 86_400_000;
  const max = now + BRIEFING_MAX_DAYS * 86_400_000;
  if (!returnBy) return new Date(dflt);
  const ts = Date.parse(returnBy);
  if (!Number.isFinite(ts)) return new Date(dflt);
  return new Date(Math.min(Math.max(ts + 2 * 86_400_000, now + 86_400_000), max));
}

export interface BuildBriefingInput {
  routeTitle: string;
  routeVersion: number;
  routeGrade: string;
  waypointsCount: number;
  departureAt: string | null;
  returnBy: string | null;
  answers: PrepAnswers;
  packStates: PackAssetState[] | null;
  domains: PrepDomainSummary[];
  openActionTitles: string[];
  now?: number;
}

export function buildBriefingSnapshot(i: BuildBriefingInput): BriefingSnapshot {
  return {
    routeTitle: i.routeTitle,
    routeVersion: i.routeVersion,
    routeGrade: i.routeGrade,
    waypointsCount: i.waypointsCount,
    departureAt: i.departureAt,
    returnBy: i.returnBy,
    duration: i.answers.duration ?? null,
    party: i.answers.party ?? null,
    packReadiness: i.packStates ? fieldPackReadiness(i.packStates) : 'unknown',
    preparedDomains: i.domains.filter(d => d.prepared).length,
    totalDomains: i.domains.length,
    openActions: i.openActionTitles,
    takenAt: new Date(i.now ?? Date.now()).toISOString(),
  };
}

/**
 * Что делать получателю, если время возврата прошло. Это не автоматика и
 * не тревога от платформы: мы не знаем, где человек, и не притворяемся,
 * что знаем. Это инструкция человеку у телефона.
 */
export function overdueGuidance(returnBy: string | null, now: number = Date.now()): string | null {
  if (!returnBy) return null;
  const ts = Date.parse(returnBy);
  if (!Number.isFinite(ts) || now <= ts) return null;
  return 'Время возврата прошло. Свяжитесь с участником. Если связи нет — звоните 112 '
    + 'и передайте название маршрута, дату выхода и планового возврата с этой страницы.';
}
