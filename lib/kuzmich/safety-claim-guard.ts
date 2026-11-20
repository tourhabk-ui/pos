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

import { stripBannedAdvice } from '@/lib/kuzmich/banned-advice';
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

/**
 * Явление → как оно звучит в ответе и в сводках. Сводки Ведара пишут теми же
 * корнями. `about` — имя явления после «про» (винительный падеж: «про
 * эвакуацию», а не «про эвакуация» — разбор 19.11, #3179 п.3). `advice` —
 * слова перед упоминанием, при которых это совет, а не сведения об
 * обстановке: «нужна эвакуация» в первой помощи при переохлаждении — не
 * утверждение, что эвакуацию объявили.
 */
const HAZARDS: ReadonlyArray<{ key: string; about: string; re: RegExp; evidence: RegExp; advice?: RegExp }> = [
  { key: 'паводок', about: 'паводок', re: /(?<![а-яё])(паводо?к|подъ[её]м[а-яё]* уровн[яе]? воды|наводнени|подтоплени)/gi, evidence: /паводо?к|уровн[яеи]? воды|наводнени|подтоплени|гидролог/i },
  { key: 'перекрытие', about: 'перекрытие', re: /(?<![а-яё])(дорог[а-яё]*(?:\s+[^\s.,;!?]+){0,3}\s+(закрыт|перекрыт)|(закрыт|перекрыт)[а-яё]* (дорог|участ|проезд|трасс)|ограничен[а-яё]* (движени|проезд))/gi, evidence: /закрыт|перекрыт|ограничен[а-яё]* (движени|проезд)/i },
  { key: 'парк закрыт', about: 'закрытие парка или маршрута', re: /(?<![а-яё])(закрыт[а-яё]* (парк|маршрут)|посещени[а-яё]* (приостановлен|запрещен|запрещён))/gi, evidence: /закрыт|приостановлен|запрещ/i },
  { key: 'лавины', about: 'лавины', re: /(?<![а-яё])лавин/gi, evidence: /лавин/i },
  { key: 'извержение', about: 'извержение', re: /(?<![а-яё])(извержени|пеплов|выброс[а-яё]* пепла)/gi, evidence: /извержени|пепел|пепл|оранжев|красн/i },
  { key: 'цунами', about: 'цунами', re: /(?<![а-яё])цунами/gi, evidence: /цунами/i },
  { key: 'эвакуация', about: 'эвакуацию', re: /(?<![а-яё])эвакуац/gi, evidence: /эвакуац/i,
    advice: /(нужн|нуж[её]н|требу|потребу|понадоб|вызыв|вызов|вызвать|вызови|организ|медицинск|санитарн|санавиац|срочн|экстренн|ждать|ждите|дождит)[а-яё]*[^.!?\n]{0,25}$/i },
  { key: 'медведи', about: 'медведей', re: /(?<![а-яё])медвед[а-яё]* (вышел|выход|замечен|у |в районе|на )/gi, evidence: /медвед/i },
  { key: 'шторм', about: 'шторм', re: /(?<![а-яё])(шторм|ураган)/gi, evidence: /шторм|ураган|волнени[ея] моря|сильн[а-яё]* ветер/i },
  { key: 'землетрясение', about: 'землетрясение', re: /(?<![а-яё])землетрясени/gi, evidence: /землетрясени|магнитуд|сейсм/i },
];

/**
 * Признаки действующих предупреждений в выводе инструментов обстановки.
 *
 * Метка в скобках у названия читается целиком, а не одним словом: у места
 * она бывает составной — «[ЖЁЛТЫЙ — ЗАКРЫТО]», «[ЗАКРЫТО]»
 * (lib/kuzmich/guardian-context). До 12.11 выражение ждало ровно
 * «[КРАСНЫЙ]», «[ОРАНЖЕВЫЙ]» или «[ЖЁЛТЫЙ]», и «можно идти» о ЗАКРЫТОМ месте
 * проходило без поправки. «ОСТОРОЖНО» и «НЕ СЕГОДНЯ» — метки оценки маршрута
 * на сегодня (lib/routes/route-today, #3302): при них «можно идти» без
 * оговорок — вопреки данным, в том числе когда причина — «данных мало».
 */
const ACTIVE_ALERTS_RE = /Активные алерты:\s*\S|\[[^\]\n]*(?:КРАСНЫЙ|ОРАНЖЕВЫЙ|ЖЁЛТЫЙ|ЗАКРЫТО|ОСТОРОЖНО|НЕ СЕГОДНЯ)[^\]\n]*\]|Активных предупреждений по Камчатскому краю:\s*[1-9]|ДЕЙСТВУЮЩИЕ ПРЕДУПРЕЖДЕНИЯ|Повышенная активность хотя бы по одной шкале/;

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
    for (const m of answer.matchAll(h.re)) {
      const i = m.index ?? 0;
      if (isNegated(answer, i, m[0].length)) continue;
      if (h.advice?.test(answer.slice(Math.max(0, i - 40), i))) continue;
      claims.push({ kind: 'hazard', phrase: m[0], hazard: h.key });
      break;
    }
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

/** Пометка к предупреждению без опоры. Предупреждение остаётся. `keys` — ключи HAZARDS. */
export function unbackedHazardNote(keys: string[]): string {
  const about = keys.map((k) => HAZARDS.find((h) => h.key === k)?.about ?? k);
  return `Уточнение: про ${about.join(', ')} в сводках, которые я смотрел для этого ответа, сведений нет. `
    + 'Предупреждение оставляю — лучше перестраховаться, — но проверь его в МЧС Камчатки (112) или спроси меня про конкретное место.';
}

/**
 * Сверить утверждения ответа с данными хода. `toolRuns === null` — ответ
 * пришёл без инструментов (запасной путь): сверять не с чем.
 */
export function guardSafetyClaims(
  rawAnswer: string, toolRuns: readonly ToolRun[] | null,
  /**
   * Вопрос человека. Явление, о котором он сообщил сам («было сильное
   * землетрясение»), — не утверждение Кузьмича без опоры: пометка «в
   * сводках сведений нет» под ним сбивала человека в беде (#3179 п.3).
   */
  question?: string,
): GuardResult {
  // Опасный совет вырезается до сверки утверждений: этот сторож стоит на всех
  // поверхностях (чат, поток, виджет, Telegram/MAX, A2A), поэтому и запрет здесь.
  const banned = stripBannedAdvice(rawAnswer);
  if (banned.removed.length > 0) {
    console.error('[kuzmich-banned-advice] вырезан опасный совет', { count: banned.removed.length });
  }
  if (banned.ranking.length > 0) {
    console.error('[kuzmich-banned-advice] вырезана выдуманная оценка безопасности способа или тура', { count: banned.ranking.length });
  }
  if (banned.sms112.length > 0) {
    console.error('[kuzmich-banned-advice] вырезан совет писать SMS на 112 (не подтверждено)', { count: banned.sms112.length });
  }
  const answer = banned.text;
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
      if (!ev) return false;
      if (question && ev.test(question)) return false; // назвал сам человек
      return !ev.test(allOutputs);
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
