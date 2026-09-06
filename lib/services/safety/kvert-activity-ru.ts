/**
 * Разговорник KVERT: английская формула → русская фраза. Без модели.
 *
 * ПОВОД. Разделы активности выпуска KVERT написаны по-английски, русской
 * версии у выпуска нет (замер 06.09, kvert-probe run 2: `lend=ru` отдаёт тот
 * же английский текст). Экран безопасности русский, и туристу нужна фраза на
 * его языке.
 *
 * ПОЧЕМУ НЕ МОДЕЛЬЮ. Это текст про извержение: высота выброса и слово
 * «продолжается» — то, по чему человек решает, идти ли на вулкан. Модель здесь
 * добавит правдоподобия там, где нужна точность (§8: критичные факты — только
 * из инструментов, самоотчётам модели не верить), и однажды скажет «активность
 * снижается» там, где источник этого не говорил.
 *
 * ПОЧЕМУ РАЗГОВОРНИК РАБОТАЕТ. Словарь KVERT закрытый: типов извержения
 * несколько, фраза про пепел одна и та же годами. Формулы ниже сняты с
 * настоящего выпуска (06.09). Нераспознанное НЕ переводится: лучше показать
 * только то, что поняли, чем пересказать наугад.
 */

/** Типы извержения, как их называет KVERT. Порядок важен: длинные формы раньше. */
const ERUPTION_PHRASES: ReadonlyArray<{ en: RegExp; ru: string }> = [
  { en: /explosive[-\s]extrusive\s+eruption/i, ru: 'эксплозивно-экструзивное извержение' },
  { en: /extrusive[-\s]effusive\s+eruption/i,  ru: 'экструзивно-эффузивное извержение' },
  { en: /explosive[-\s]effusive\s+eruption/i,  ru: 'эксплозивно-эффузивное извержение' },
  { en: /moderate\s+explosive\s+eruption/i,    ru: 'умеренное эксплозивное извержение' },
  { en: /summit\s+explosive\s+eruption/i,      ru: 'вершинное эксплозивное извержение' },
  { en: /explosive\s+eruption/i,               ru: 'эксплозивное извержение' },
  { en: /extrusive\s+eruption/i,               ru: 'экструзивное извержение' },
  { en: /effusive\s+eruption/i,                ru: 'эффузивное извержение' },
];

/** Состояние вулкана вне извержения — тоже закрытый список формул KVERT. */
const STATE_PHRASES: ReadonlyArray<{ en: RegExp; ru: string }> = [
  { en: /moderate\s+gas[-\s]steam\s+activity/i, ru: 'умеренная газо-паровая активность' },
  { en: /thermal\s+anomaly/i,                   ru: 'термальная аномалия по спутниковым данным' },
];

function highMeters(m: number): string {
  // Километры с одним знаком, если высота не круглая: KVERT пишет «up to
  // 2.5 km», и округление до 3 км завысило бы выброс почти вдвое по опасности.
  const km = m / 1000;
  const shown = Number.isInteger(km) ? String(km) : km.toFixed(1).replace('.', ',');
  return `${shown} км`;
}

export interface ActivityFacts {
  /** Абзац прогноза из выпуска, как есть. */
  hazardEn: string | null;
  /** Абзац наблюдений за неделю, как есть. */
  activityEn?: string | null;
  ashHeightM: number | null;
}

/**
 * Русская фраза для экрана. `null` — из выпуска не распознано ничего, и тогда
 * экран показывает только цвет: пустое место честнее пересказа.
 */
export function describeActivityRu(facts: ActivityFacts): string | null {
  const source = [facts.hazardEn ?? '', facts.activityEn ?? ''].join(' ');
  if (!source.trim()) return null;

  const parts: string[] = [];

  const eruption = ERUPTION_PHRASES.find((p) => p.en.test(source));
  if (eruption) {
    parts.push(`Продолжается ${eruption.ru}`);
  } else {
    const state = STATE_PHRASES.find((p) => p.en.test(source));
    if (state) parts.push(state.ru.charAt(0).toUpperCase() + state.ru.slice(1));
  }

  // Про пепел говорим, только если источник назвал высоту И сказал, что
  // выбросы возможны. «Ash plumes extended for 200 km» — про шлейф, а не про
  // высоту, и в эту фразу не годится.
  if (facts.ashHeightM != null && /could\s+occur|possible/i.test(facts.hazardEn ?? '')) {
    parts.push(`пепловые взрывы до ${highMeters(facts.ashHeightM)} над уровнем моря возможны в любое время`);
  }

  if (parts.length === 0) return null;
  // Каждая часть — отдельное предложение, поэтому и заглавная у каждой:
  // «…извержение. пепловые взрывы…» читается как обрывок, а не как фраза.
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .map((p) => (p.endsWith('.') ? p : `${p}.`))
    .join(' ');
}
