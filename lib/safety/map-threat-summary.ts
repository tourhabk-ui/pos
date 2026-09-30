/**
 * Сводка природных угроз для полевой карты (#1428, решение владельца 30.09).
 *
 * Карта /map показывала вулканы маркерами и геофенс у зоны, но ответа на
 * вопрос «что сейчас опасно в крае» на ней не было — он жил на /safety#radar.
 * Человек с картой в руках до радара не доходит.
 *
 * Источник — тот же `GET /api/public/safety-status`, что у главной и MCP:
 * своего запроса нет. У сводки три исхода, не два (§4.0):
 *  - `alert`   — есть действующие тревоги, названа верхняя;
 *  - `calm`    — источник ответил и тревог нет;
 *  - `unknown` — источник недоступен или ответа нет. «Спокойно» из
 *    отсутствия данных не рисуется: по этой плашке решают, выходить ли.
 * Офлайн показывается последний ответ с его возрастом — «было спокойно
 * пять часов назад» и «спокойно» разные утверждения.
 */

export interface SafetyStatusPayload {
  unavailable?: boolean;
  hasAlert?: boolean;
  maxSeverity?: number;
  activeCount?: number;
  topTitle?: string | null;
}

export type MapThreatState = 'alert' | 'calm' | 'unknown';

export interface MapThreatSummary {
  state: MapThreatState;
  /** Короткая строка плашки. */
  label: string;
  /** Вторая строка: верхняя тревога или возраст данных; null — нет. */
  detail: string | null;
}

/** «2 ч назад» / «3 дн назад»; меньше часа — «только что» не пишем, «<1 ч». */
export function ageLabel(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return 'меньше часа назад';
  if (h < 24) return `${Math.round(h)} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

function alertsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'тревога';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'тревоги';
  return 'тревог';
}

/**
 * Сводка из ответа safety-status. `ageMs` — возраст ответа, если он взят из
 * кеша телефона (офлайн); null — ответ свежий из сети.
 */
export function mapThreatSummary(
  payload: SafetyStatusPayload | null,
  ageMs: number | null = null,
): MapThreatSummary {
  const stale = ageMs != null ? `данные ${ageLabel(ageMs)}` : null;
  if (!payload || payload.unavailable === true) {
    return { state: 'unknown', label: 'Обстановка неизвестна', detail: stale ?? 'источник тревог не ответил' };
  }
  const count = typeof payload.activeCount === 'number' && payload.activeCount > 0 ? payload.activeCount : 0;
  if (payload.hasAlert === true || count > 0) {
    const n = Math.max(count, 1);
    const top = (payload.topTitle ?? '').trim().slice(0, 90) || null;
    return {
      state: 'alert',
      label: `${n} ${alertsWord(n)} в крае`,
      detail: [top, stale].filter(Boolean).join(' · ') || null,
    };
  }
  return { state: 'calm', label: 'Действующих тревог нет', detail: stale };
}
