/**
 * Обстановка у места на сегодня — одно правило на карточку места, совет
 * Кузьмича на ней и чат Кузьмича (15.10, §0 «честность»).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * Полоса «Сейчас» на карточке писала «Сегодня можно идти» и «Запретов и
 * предупреждений нет» почти у всех мест. Держалось это на трёх вещах, и ни
 * одна не была проверкой места:
 *
 *   - `is_open = TRUE` — значение ПО УМОЛЧАНИЮ, проставленное всем местам
 *     при заведении (070/0645). TRUE значит «никто не закрыл», а не
 *     «проверили — открыто»; закрывает только администратор;
 *   - своя шкала уровня: `alert_severity` 2 читался «идти можно, но
 *     осторожно», 1 — зелёным. У источника шкала 0–3: 1 — предупреждение,
 *     2 — критично, 3 — чрезвычайно (lib/services/safety/seismic-parser.ts).
 *     Красный (≥ 4) не наступал никогда, а действующее предупреждение
 *     уровня 1 печаталось под «предупреждений нет»;
 *   - «Проверили <время>» — время пересчёта сводок кроном, а не проверки
 *     места человеком; к тому же читалось без пояса и уезжало на три часа.
 *
 * А вердикт, который платформа на самом деле считает, лежал рядом и карточкой
 * не читался: `recommender_status` пересчитывает safety-ingest каждые пять
 * минут — с зональным правилом владельца (03.10, #2195: предупреждение по
 * зоне края даёт жёлтый, красный — только своё или чрезвычайное) и шкалами
 * вулканов KVERT и КФ ЕГС. Его же печатает Кузьмич в чате — со словами «это
 * не гарантия безопасности» и без цвета, если пересчёт встал. Карточка и чат
 * отвечали на один вопрос двумя правилами, и одно из них было выдумкой.
 *
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 *   закрыто администратором            → closed
 *   пересчёта не было / он старше 3 ч  → unknown (цвет не показывается)
 *   иначе                              → red / yellow / green пересчёта
 *
 * Зелёный значит ровно то, что посчитано: в сводках нет предупреждений,
 * которые поднимают уровень места. Это не проверка тропы, погоды и
 * обстановки на месте, и называть его «можно идти» нельзя.
 */

export type PlaceDayLevel = 'closed' | 'red' | 'yellow' | 'green' | 'unknown';

/**
 * Свежесть пересчёта. Крон safety-ingest пересчитывает все строки каждые
 * 5 минут; три часа тишины — пересчёт встал, и цвет на экране уже не про
 * сегодня (проверка MCP 29.09: цвет печатался без времени).
 */
export const PLACE_STATUS_FRESH_MS = 3 * 60 * 60 * 1000;

export interface PlaceDayInput {
  isOpen: boolean | null;
  /** `location_real_time_status.recommender_status`. */
  status: string | null;
  /** Время пересчёта в ISO с поясом (isoUtcSql), не стенное время базы. */
  updatedAt: string | null;
}

export interface PlaceDay {
  level: PlaceDayLevel;
  /** Пересчёт был, но давно: цвет не показываем и говорим почему. */
  stale: boolean;
}

export function placeDayStatus(rt: PlaceDayInput, now: number = Date.now()): PlaceDay {
  // Закрытие ставит человек, и оно не протухает вместе с пересчётом сводок.
  if (rt.isOpen === false) return { level: 'closed', stale: false };
  const at = rt.updatedAt ? Date.parse(rt.updatedAt) : NaN;
  if (!Number.isFinite(at)) return { level: 'unknown', stale: false };
  if (now - at > PLACE_STATUS_FRESH_MS) return { level: 'unknown', stale: true };
  if (rt.status === 'red' || rt.status === 'yellow' || rt.status === 'green') {
    return { level: rt.status, stale: false };
  }
  return { level: 'unknown', stale: false };
}

/** Пересчёт был, и он старше порога свежести: цвет уже может быть не про сегодня. */
export function recomputeIsStale(iso: string | null, now: number = Date.now()): boolean {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && now - at > PLACE_STATUS_FRESH_MS;
}

/** Время по Камчатке — одинаково на сервере и в браузере в любом поясе. */
export function kamchatkaStamp(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Asia/Kamchatka', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
