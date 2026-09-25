/**
 * lib/home/briefing.ts
 *
 * Статус и время сводки Кузьмича на десктопной главной
 * (components/homepage/KuzmichBriefing). Чистые функции со сторожем
 * tests/unit/home-kuzmich-briefing.test.ts.
 *
 * Аудит 24.09 (#37): «Норма» зелёным рисовалась при safety = null, а
 * «обновлено ЧЧ:ММ» бралось из часов браузера. У статуса теперь четыре
 * исхода, и один из них — «не знаю» (§4.0):
 *   - danger  — maxSeverity ≥ 3;
 *   - caution — maxSeverity = 2;
 *   - calm    — данные есть, у них есть время, и оно не старше порога;
 *   - unknown — данных нет, у них нет времени (ingest ни разу не писал) или
 *               они старше порога. «Мы не знаем» не равно «спокойно».
 * Порог свежести — тот же, что у героя главной (HeroStatus, 48 ч).
 */

export interface BriefingSafety {
  hasAlert: boolean;
  maxSeverity: number;
  activeCount: number;
  topTitle: string | null;
  topType: string | null;
  /** Когда источник последний раз что-то записал; null — не писал ни разу. */
  dataUpdatedAt?: string | null;
}

export type BriefingStatus = 'danger' | 'caution' | 'calm' | 'unknown';

export const BRIEFING_STALE_MS = 48 * 60 * 60 * 1000;

function updatedMs(s: BriefingSafety): number | null {
  if (!s.dataUpdatedAt) return null;
  const t = new Date(s.dataUpdatedAt).getTime();
  return Number.isFinite(t) ? t : null;
}

export function briefingStatus(s: BriefingSafety | null | undefined, now: Date = new Date()): BriefingStatus {
  if (!s) return 'unknown';
  const t = updatedMs(s);
  if (t == null || now.getTime() - t > BRIEFING_STALE_MS) return 'unknown';
  const sev = Number(s.maxSeverity) || 0;
  if (sev >= 3) return 'danger';
  if (sev >= 2) return 'caution';
  return 'calm';
}

/**
 * «14:05» по камчатскому времени — момент ДАННЫХ, не открытия страницы;
 * null — времени у данных нет, и строки «данные на …» быть не должно.
 */
export function briefingUpdatedAt(s: BriefingSafety | null | undefined): string | null {
  if (!s) return null;
  const t = updatedMs(s);
  if (t == null) return null;
  return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka' });
}
