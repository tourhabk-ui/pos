/**
 * Совет Кузьмича «сегодня здесь» — проактивный, ДЕТЕРМИНИРОВАННЫЙ, из данных.
 *
 * До этого Кузьмич на карточке места был пассивным: показывал заготовленный
 * отзыв и ссылку «спросить». Турист открывал вулкан и не видел ГЛАВНОГО —
 * стоит ли туда сегодня. Эта функция собирает честный совет из живых данных
 * места (код КВЕРТ + его свежесть, реалтайм-алерты, опасности), без ИИ и без
 * выдумки: критичные факты — из инструментов (§7), устаревшие данные понижают
 * уверенность, а не молчат зелёным. ИИ может позже «оживить» тон, но источник
 * правды и фолбэк — этот детерминированный расчёт.
 */
import {
  isVolcanoObservationStale, volcanoObservationAgeDays, formatObservationAge,
} from '@/lib/services/safety/kvert-vona';

export type AdvisoryTone = 'ok' | 'caution' | 'danger' | 'unknown';

export interface PlaceAdvisory {
  tone: AdvisoryTone;
  headline: string;
  lines: string[];
}

export interface AdvisoryInput {
  volcano: { colorCode: string; observedAt: string | null } | null;
  realtime: { isOpen: boolean | null; activeAlerts: string[] | null; alertSeverity: number | null } | null;
  hazardTypes: string[];
}

// Опасности — свойство места, не тревога (называем кратко). Ключи совпадают с
// HazardBadgeStrip; неизвестные молча пропускаем, а не гадаем.
const HAZARD_LABELS: Record<string, string> = {
  bears: 'медведи', wildlife: 'дикие животные', avalanche: 'лавины', rockfall: 'камнепад',
  thermal: 'термальные зоны', volcanic_gas: 'вулканические газы', altitude: 'высота',
  ice: 'лёд', weather: 'непогода', river_crossing: 'переправы', fog: 'туман', no_signal: 'нет связи',
};

const VOLCANO: Record<string, { tone: AdvisoryTone; text: string }> = {
  green: { tone: 'ok', text: 'Вулкан спокоен — код зелёный' },
  yellow: { tone: 'caution', text: 'У вулкана повышенная активность (жёлтый код)' },
  orange: { tone: 'caution', text: 'Высокая активность вулкана (оранжевый код) — будь осторожен' },
  red: { tone: 'danger', text: 'Опасное извержение (красный код) — идти нельзя' },
};

const RANK: Record<AdvisoryTone, number> = { unknown: 0, ok: 1, caution: 2, danger: 3 };
const worst = (a: AdvisoryTone, b: AdvisoryTone): AdvisoryTone => (RANK[a] >= RANK[b] ? a : b);

export function buildPlaceAdvisory(p: AdvisoryInput, now: number = Date.now()): PlaceAdvisory {
  const lines: string[] = [];
  let tone: AdvisoryTone = 'unknown';

  // 1. Вулкан — цвет несёт состояние; устаревшее наблюдение понижает уверенность.
  if (p.volcano && VOLCANO[p.volcano.colorCode]) {
    const v = VOLCANO[p.volcano.colorCode];
    tone = worst(tone, v.tone);
    let line = v.text;
    if (isVolcanoObservationStale(p.volcano.observedAt, now)) {
      const age = volcanoObservationAgeDays(p.volcano.observedAt, now);
      line += `, но данные КВЕРТ не обновлялись ${age != null ? formatObservationAge(age) : 'давно'} — сверься на KVERT`;
      tone = worst(tone, 'caution');
    }
    lines.push(line);
  }

  // 2. Реалтайм-обстановка.
  if (p.realtime) {
    if (p.realtime.alertSeverity != null && p.realtime.alertSeverity >= 2) tone = worst(tone, 'danger');
    else if (p.realtime.alertSeverity === 1) tone = worst(tone, 'caution');
    if (p.realtime.activeAlerts && p.realtime.activeAlerts.length > 0) {
      lines.push(`Активное предупреждение: ${p.realtime.activeAlerts[0]}`);
    }
    if (p.realtime.isOpen === false) { tone = worst(tone, 'caution'); lines.push('Сейчас закрыто для посещения'); }
    else if (p.realtime.isOpen === true && tone === 'unknown') tone = 'ok';
  }

  // 3. Опасности места — краткое напоминание (не тревога).
  const named = (p.hazardTypes ?? []).map((h) => HAZARD_LABELS[h]).filter(Boolean).slice(0, 3);
  if (named.length > 0) lines.push(`Держи в голове: ${named.join(', ')}`);

  // 4. Честный итог. Нет живых данных — так и говорим, зелёным не притворяемся.
  if (tone === 'unknown') {
    return {
      tone: 'unknown',
      headline: 'Живых данных сейчас нет',
      lines: ['Свежей обстановки по этому месту сейчас нет — сверься перед выходом и держи связь.'],
    };
  }
  if (lines.length === 0) lines.push('Обычные меры предосторожности, следи за погодой.');

  const headline = tone === 'danger' ? 'Сегодня сюда — нет'
    : tone === 'caution' ? 'Можно, но с оглядкой'
    : 'Сегодня спокойно';
  return { tone, headline, lines };
}
