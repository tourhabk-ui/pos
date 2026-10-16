import { HAZARDS } from '@/lib/safety/hazard-labels';
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
import type { PlaceDay, PlaceDayLevel } from '@/lib/safety/place-day-status';
import { KURIL_NORTH_NOTE } from '@/lib/safety/kuril-north';

export type AdvisoryTone = 'ok' | 'caution' | 'danger' | 'unknown';

export interface PlaceAdvisory {
  tone: AdvisoryTone;
  headline: string;
  lines: string[];
}

export interface AdvisoryInput {
  volcano: { colorCode: string; observedAt: string | null } | null;
  /**
   * Обстановка дня — тот же `placeDayStatus`, что у полосы «Сейчас» над
   * советом (15.10). До этого совет считал уровень сам, по `alert_severity` и
   * `is_open`: значение по умолчанию TRUE давало «Сегодня спокойно» любому
   * месту, а закрытое место получало «Можно, но с оглядкой» строкой выше
   * «Сейчас закрыто». Две оценки одного дня на одном экране — человек сверяет
   * их и перестаёт верить обеим.
   */
  realtime: (PlaceDay & { activeAlerts: string[] | null }) | null;
  hazardTypes: string[];
}

const DAY_TONE: Record<PlaceDayLevel, AdvisoryTone> = {
  closed: 'danger', red: 'danger', yellow: 'caution', green: 'ok', unknown: 'unknown',
};

// Опасности — свойство места, не тревога (называем кратко). Ключи совпадают с
// HazardBadgeStrip; неизвестные молча пропускаем, а не гадаем.

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

  // 2. Обстановка дня — пересчёт сводок. Первое предупреждение — самое
  // опасное: агрегат safety-ingest упорядочивает их по убыванию опасности.
  let dayUnknown = false;
  const alerts = (p.realtime?.activeAlerts ?? []).map((a) => a.trim()).filter(Boolean);
  if (p.realtime) {
    const { level, stale, outsideSources } = p.realtime;
    tone = worst(tone, DAY_TONE[level]);
    if (level === 'closed') lines.push('Сейчас закрыто для посещения');
    if (level === 'unknown') {
      dayUnknown = true;
      // Северные Курилы — та же фраза, что у полосы «Сейчас» (16.10).
      lines.push(outsideSources
        ? KURIL_NORTH_NOTE
        : stale
          ? 'Пересчёт обстановки по сводкам давно не обновлялся — сверься перед выходом'
          : 'Пересчёта обстановки по этому месту у нас нет — сверься перед выходом');
      if (alerts.length > 0) lines.push(`В последнем пересчёте было: ${alerts[0]}`);
    } else if (alerts.length > 0) {
      // Под зелёным предупреждения слабее уровня места: они есть, но не
      // поднимают его — «активным» его не называем.
      lines.push(level === 'green' ? `В сводках: ${alerts[0]}` : `Активное предупреждение: ${alerts[0]}`);
    }
  }

  // 3. Опасности места — краткое напоминание (не тревога).
  const named = (p.hazardTypes ?? [])
    // Неизвестный ключ пропускается МОЛЧА, и это решение именно этой
    // поверхности: Кузьмич произносит фразу человеку, и сырое английское
    // слово посреди русского совета хуже пропуска. На экране (бейдж, PDF)
    // выбор обратный — там сырой ключ виден и чинится.
    .map((h) => HAZARDS[h]?.label.toLocaleLowerCase('ru-RU'))
    .filter(Boolean).slice(0, 3);
  if (named.length > 0) lines.push(`Держи в голове: ${named.join(', ')}`);

  // 4. Честный итог. Нет живых данных — так и говорим, зелёным не притворяемся.
  if (tone === 'unknown') {
    return {
      tone: 'unknown',
      headline: 'Живых данных сейчас нет',
      lines: lines.length > 0 ? lines
        : ['Свежей обстановки по этому месту сейчас нет — сверься перед выходом и держи связь.'],
    };
  }
  // Спокойный вулкан не делает спокойным место, чьи сводки не пересчитаны:
  // про МЧС и дороги мы тогда не знаем ничего.
  if (tone === 'ok' && dayUnknown) {
    return { tone: 'unknown', headline: 'Свежей сводки по месту нет', lines };
  }
  if (tone === 'ok') {
    lines.push('Это пересчёт по сводкам, а не проверка тропы — погоду и обстановку сверь перед выходом.');
  }

  const headline = tone === 'danger' ? 'Сегодня сюда — нет'
    // Не «можно»: разрешения платформа не даёт, она знает только сводки.
    : tone === 'caution' ? 'Сегодня — с оглядкой'
    : alerts.length > 0 ? 'Серьёзных предупреждений нет'
    : 'По сводкам спокойно';
  return { tone, headline, lines };
}
