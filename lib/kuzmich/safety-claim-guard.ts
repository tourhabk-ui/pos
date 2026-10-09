/**
 * lib/kuzmich/safety-claim-guard.ts — утверждения Кузьмича о безопасности
 * сверяются с данными этого же хода (#2300, решение владельца 09.10).
 *
 * Находка эволюции предлагала держать предупреждения Кузьмича до
 * подтверждения человеком. Владелец выбрал другое: предупреждения уходят
 * сразу — ночью подтвердить некому, а турист в поле должен узнать об опасности
 * без очереди, — но каждое утверждение о безопасности сверяется с тем, что
 * вернули инструменты этого хода, а человек разбирает их потом
 * (`kuzmich_safety_reviews`, /hub/admin/kuzmich-safety).
 *
 * Две ошибки модели здесь не равны по цене:
 *   - «безопасно, можно идти» без данных или вопреки им — самая дорогая:
 *     человек пойдёт. Такое утверждение получает поправку в том же ответе;
 *   - «дорога закрыта», «паводок» без опоры в данных — дешевле: человек
 *     перестрахуется. Предупреждение НЕ вырезается (ложная тревога лучше
 *     пропущенной), а помечается: в сводках этого ответа такого нет.
 *
 * Четыре исхода, как требует §4.0: опирается на данные; без опоры; вопреки
 * данным; проверить не на чем (ответ пришёл запасным путём без инструментов).
 * Последний — не «хорошо»: «безопасно» без проверки получает ту же поправку.
 *
 * Модуль чистый: текст и журнал инструментов на входе, текст и вердикт на
 * выходе. Сторож: tests/unit/kuzmich-safety-claim-guard.test.ts.
 */

import type { ToolRun } from '@/lib/agents/eval/grounding';
import { isNegated } from './safety-eval';

/** Инструменты, чей ответ — сводка об обстановке. */
export const SAFETY_TOOLS: ReadonlySet<string> = new Set([
  'get_guardian_context', 'safety_status', 'get_volcano_status', 'get_weather',
]);

export type ClaimKind = 'all_clear' | 'hazard';

export interface SafetyClaim {
  kind: ClaimKind;
  /** Совпавшая фраза — для журнала разбора. */
  phrase: string;
  /** Для опасности — ключ явления, по которому ищется опора в данных. */
  hazard?: string;
}

export type ClaimVerdict =
  | 'none'          // утверждений о безопасности нет
  | 'backed'        // всё сказанное есть в данных хода
  | 'unbacked'      // сказано без опоры в данных
  | 'contradicted'  // «безопасно», а данные говорят о действующих предупреждениях
  | 'unverifiable'; // ответ без инструментов — сверять не с чем

/**
 * «Безопасно» — граница слова руками: JS \b кириллицу не знает. «Небезопасно»
 * и «опасно» сюда не попадают — это не обещание безопасности.
 */
const ALL_CLEAR_RE = /(?<![а-яё])(безопасн(?:о|а|ы|ен)|опасност[иь] нет|угроз[ыа]? нет|предупреждений нет|ничего не угрожает|всё спокойно|все спокойно|можно (смело |спокойно )?(идти|ехать|выходить|подниматься))(?![а-яё])/gi;

const CONDITION_RE = /^[\s,]*(только|если|при условии|при хорошей|при ясной|с гидом|в сопровождении|когда)/i;

/** Явление → как оно звучит в ответе и в сводках. Сводки Ведара пишут теми же корнями. */
const HAZARDS: ReadonlyArray<{ key: string; re: RegExp; evidence: RegExp }> = [
  { key: 'паводок', re: /(?<![а-яё])(паводо?к|подъ[её]м[а-яё]* уровн[яе]? воды|наводнени|подтоплени)/i, evidence: /паводо?к|уровн[яеи]? воды|наводнени|подтоплени|гидролог/i },
  { key: 'перекрытие', re: /(?<![а-яё])(дорог[а-яё]*(?:\s+[^\s.,;!?]+){0,3}\s+(закрыт|перекрыт)|(закрыт|перекрыт)[а-яё]* (дорог|участ|проезд|трасс)|ограничен[а-яё]* (движени|проезд))/i, evidence: /закрыт|перекрыт|ограничен[а-яё]* (движени|проезд)/i },
  { key: 'парк закрыт', re: /(?<![а-яё])(закрыт[а-яё]* (парк|маршрут)|посещени[а-яё]* (приостановлен|запрещен|запрещён))/i, evidence: /закрыт|приостановлен|запрещ/i },
  { key: 'лавины', re: /(?<![а-яё])лавин/i, evidence: /лавин/i },
  { key: 'извержение', re: /(?<![а-яё])(извержени|пеплов|выброс[а-яё]* пепла)/i, evidence: /извержени|пепел|пепл|оранжев|красн/i },
  { key: 'цунами', re: /(?<![а-яё])цунами/i, evidence: /цунами/i },
  { key: 'эвакуация', re: /(?<![а-яё])эвакуац/i, evidence: /эвакуац/i },
  { key: 'медведи', re: /(?<![а-яё])медвед[а-яё]* (вышел|выход|замечен|у |в районе|на )/i, evidence: /медвед/i },
  { key: 'шторм', re: /(?<![а-яё])(шторм|ураган)/i, evidence: /шторм|ураган|волнени[ея] моря|сильн[а-яё]* ветер/i },
  { key: 'землетрясение', re: /(?<![а-яё])землетрясени/i, evidence: /землетрясени|магнитуд|сейсм/i },
];

/** Признаки действующих предупреждений в выводе инструментов обстановки. */
const ACTIVE_ALERTS_RE = /Активные алерты:\s*\S|\[(КРАСНЫЙ|ОРАНЖЕВЫЙ|ЖЁЛТЫЙ)\]|Активных предупреждений по Камчатскому краю:\s*[1-9]|ДЕЙСТВУЮЩИЕ ПРЕДУПРЕЖДЕНИЯ|Повышенная активность хотя бы по одной шкале/;

/** Утверждения о безопасности в ответе. Под отрицанием — не утверждение. */
export function findSafetyClaims(answer: string): SafetyClaim[] {
  const claims: SafetyClaim[] = [];
  for (const m of answer.matchAll(ALL_CLEAR_RE)) {
    const i = m.index ?? 0;
    if (isNegated(answer, i, m[0].length)) continue;
    // Условие — не обещание: «безопасно только с гидом», «можно идти, если
    // ветер стихнет» говорят, ЧТО нужно для безопасности, а не что она есть.
    if (CONDITION_RE.test(answer.slice(i + m[0].length, i + m[0].length + 25))) continue;
    claims.push({ kind: 'all_clear', phrase: m[0] });
  }
  for (const h of HAZARDS) {
    const m = h.re.exec(answer);
    if (!m) continue;
    if (isNegated(answer, m.index, m[0].length)) continue;
    claims.push({ kind: 'hazard', phrase: m[0], hazard: h.key });
  }
  return claims;
}

export interface GuardResult {
  text: string;
  verdict: ClaimVerdict;
  claims: SafetyClaim[];
  /** Утверждения без опоры или вопреки данным — для журнала. */
  flagged: SafetyClaim[];
}

/** Поправка к «безопасно» без проверки. Одна на все поверхности. */
export const UNCHECKED_ALL_CLEAR_NOTE =
  'Поправка: в этом ответе я не сверялся со сводками МЧС, Росгидромета и вулканологов — это не подтверждение безопасности. '
  + 'Назови место, и я проверю обстановку; в экстренной ситуации — 112.';

/** Поправка к «безопасно» вопреки данным. */
export const CONTRADICTED_ALL_CLEAR_NOTE =
  'Поправка: по сводкам этого ответа сейчас действуют предупреждения — «безопасно» без оговорок сказать нельзя. '
  + 'Перед выходом проверь их и при сомнении не выходи; экстренно — 112.';

/** Пометка к предупреждению без опоры. Предупреждение остаётся. */
export function unbackedHazardNote(keys: string[]): string {
  return `Уточнение: про ${keys.join(', ')} в сводках, которые я смотрел для этого ответа, сведений нет. `
    + 'Предупреждение оставляю — лучше перестраховаться, — но проверь его в МЧС Камчатки (112) или спроси меня про конкретное место.';
}

/**
 * Сверить утверждения ответа с данными хода. `toolRuns === null` — ответ
 * пришёл без инструментов (запасной путь): сверять не с чем.
 */
export function guardSafetyClaims(answer: string, toolRuns: readonly ToolRun[] | null): GuardResult {
  const claims = findSafetyClaims(answer);
  if (claims.length === 0) return { text: answer, verdict: 'none', claims, flagged: [] };

  const safetyOutputs = (toolRuns ?? [])
    .filter((r) => SAFETY_TOOLS.has(r.name) && r.producedData && r.output)
    .map((r) => r.output as string);
  const allOutputs = (toolRuns ?? []).filter((r) => r.producedData && r.output).map((r) => r.output as string).join('\n');
  const alertsActive = safetyOutputs.some((o) => ACTIVE_ALERTS_RE.test(o));

  const allClear = claims.filter((c) => c.kind === 'all_clear');
  const hazards = claims.filter((c) => c.kind === 'hazard');
  const notes: string[] = [];
  const flagged: SafetyClaim[] = [];
  let verdict: ClaimVerdict = toolRuns === null ? 'unverifiable' : 'backed';

  if (allClear.length > 0) {
    if (toolRuns === null || safetyOutputs.length === 0) {
      notes.push(UNCHECKED_ALL_CLEAR_NOTE);
      flagged.push(...allClear);
      if (verdict !== 'unverifiable') verdict = 'unbacked';
    } else if (alertsActive) {
      notes.push(CONTRADICTED_ALL_CLEAR_NOTE);
      flagged.push(...allClear);
      verdict = 'contradicted';
    }
  }

  // Предупреждения без опоры помечаются, но только когда сверять было с чем:
  // без инструментов любое предупреждение было бы «без опоры», и пометка
  // висела бы на каждом ответе запасного пути.
  if (toolRuns !== null) {
    const unbacked = hazards.filter((h) => {
      const ev = HAZARDS.find((x) => x.key === h.hazard)?.evidence;
      return ev ? !ev.test(allOutputs) : false;
    });
    if (unbacked.length > 0) {
      notes.push(unbackedHazardNote([...new Set(unbacked.map((h) => h.hazard as string))]));
      flagged.push(...unbacked);
      if (verdict === 'backed') verdict = 'unbacked';
    }
  }

  return {
    text: notes.length > 0 ? `${answer}\n\n${notes.join('\n\n')}` : answer,
    verdict,
    claims,
    flagged,
  };
}
