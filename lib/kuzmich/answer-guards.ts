/**
 * Один выход ответа Кузьмича (аудит 15.10, пункт 1.14; P3-08).
 *
 * Мозг у Кузьмича один (aiChatAgentLoop + KUZMICH_SYSTEM), а выходов было
 * шесть: Telegram и MAX (lib/kuzmich/core.ts), сайт, стрим сайта, виджет
 * партнёра и A2A. Каждый собирал сторожей сам, и набор разошёлся: сторож
 * выдуманного километража (#1883) стоял только в мессенджерах — на сайте, в
 * стриме, виджете и у внешнего агента «от Петропавловска около 400 км» без
 * единого числа в данных уходило как есть.
 *
 * Здесь порядок задан один раз — тот, что был в мессенджерах:
 *
 *   расстояния → безопасность → доставка → SOS-блок.
 *
 * Сначала правится текст модели (вырезанное предложение заменяется честной
 * строкой), потом к нему дописываются поправки, и последним — блок 112: он
 * наша вставка, и сторожа его не судят.
 *
 * Два входа, потому что у стрима два положения:
 * - `finishKuzmichAnswer` — ответ ещё не показан: правим целиком;
 * - `correctShownAnswer` — текст уже у человека (запасной стрим идёт
 *   токенами): вырезать нечем, поправки уходят хвостом.
 *
 * Журнал проверок безопасности пишется отсюда же, с именем поверхности: до
 * этого виджет и A2A писали «other», и разбор не мог их отличить от
 * мессенджера.
 */

import { stripUngroundedDistanceClaims, DISTANCE_HONEST_LINE } from '@/lib/kuzmich/distance-guard';
import { guardSafetyClaims, type GuardResult } from '@/lib/kuzmich/safety-claim-guard';
import { appendOfferingFlags, appendUnreadSafety, MCHS_UNREAD_NOTE, warningsFromBlock } from '@/lib/safety/mchs-bulletin';
import { stripBannedAdvice, BANNED_ADVICE_NOTE } from '@/lib/kuzmich/banned-advice';
import { guardDeliveryClaims, DELIVERY_HONEST_LINE, type DeliveryGuardResult } from '@/lib/kuzmich/delivery-claim-guard';
import { guardOutageClaims } from '@/lib/kuzmich/outage-claim-guard';
import { recordSafetyReview } from '@/lib/kuzmich/safety-review-log';
import { withSosBlock, type SosLang } from '@/lib/safety/sos-detector';
import type { ToolRun } from '@/lib/agents/eval/grounding';

/** Где прозвучал ответ. Имя идёт в лог и в журнал проверок безопасности. */
export type GuardSurface = 'telegram' | 'max' | 'web' | 'web-stream' | 'widget' | 'a2a';

export interface FinishInput {
  surface: GuardSurface;
  /** Ответ модели. */
  answer: string;
  /** Вопрос человека: по нему решается, нужен ли блок 112. */
  question: string;
  /**
   * Журнал инструментов хода. `null` — ответ пришёл без них (запасной путь):
   * сверять не с чем, и это «не смог проверить», а не «опора есть».
   */
  toolRuns: readonly ToolRun[] | null;
  /**
   * Данные хода, кроме вывода инструментов: то, что поверхность положила в
   * промпт (места, маршруты, туры, сводка). Ими обосновывается километраж.
   */
  context: string;
  /** Язык блока 112 (виджет на английском и китайском). */
  lang?: SosLang;
  /**
   * Ставить ли блок 112. `false` — его уже отдали первыми токенами (стрим):
   * второй блок под ответом был бы повтором.
   */
  sos?: boolean;
}

export interface FinishedAnswer {
  /** Что получает человек. */
  text: string;
  /** Блок 112 поставлен (или уже был отдан стримом). */
  emergency: boolean;
  /** Вырезанные предложения с километражем — для лога и теста. */
  distanceRemoved: string[];
  safety: GuardResult;
  delivery: DeliveryGuardResult;
}

/**
 * Чем обоснован ответ: вывод инструментов, принёсших данные, и контекст
 * промпта. Инструмент, вернувший пустоту, не обосновывает ничего — так же, как
 * у судьи faithfulness (askKuzmichForEval).
 */
export function groundingContext(toolRuns: readonly ToolRun[] | null, context: string): string {
  const fromTools = (toolRuns ?? [])
    .filter((r) => r.producedData && r.output)
    .map((r) => `[инструмент ${r.name}]\n${r.output}`)
    .join('\n\n');
  return [fromTools, context].filter(Boolean).join('\n\n');
}

function logGuards(surface: GuardSurface, distance: string[], safety: GuardResult, delivery: DeliveryGuardResult): void {
  if (distance.length > 0) {
    console.error('[kuzmich-distance-guard] вырезан незаземлённый километраж', { surface, removed: distance });
  }
  if (safety.flagged.length > 0) {
    console.error('[kuzmich-safety-claim-guard] утверждение о безопасности без опоры', {
      surface, verdict: safety.verdict, flagged: safety.flagged.map((c) => c.phrase),
    });
  }
  if (delivery.verdict === 'unbacked') {
    console.error('[kuzmich-delivery-claim-guard] отчёт о доставке без инструмента заявки', {
      surface, phrases: delivery.phrases,
    });
  }
}

/** Ответ ещё не показан: правим целиком, в порядке расстояния → безопасность → доставка → SOS. */
export function finishKuzmichAnswer(input: FinishInput): FinishedAnswer {
  const distance = stripUngroundedDistanceClaims(input.answer, groundingContext(input.toolRuns, input.context));
  const safety = guardSafetyClaims(distance.cleaned, input.toolRuns);
  void recordSafetyReview(input.surface, safety, input.toolRuns);
  const delivery = guardDeliveryClaims(safety.text, input.toolRuns);
  logGuards(input.surface, distance.removed, safety, delivery);
  // Выдуманный «сбой базы» вместо штатной заявки (снимок CTO 31.10).
  const outage = guardOutageClaims(delivery.text);
  if (outage.removed.length > 0) console.error('[kuzmich-outage-claim-guard] выдуманный сбой вместо заявки', { surface: input.surface, removed: outage.removed });
  const flagged = appendUnreadSafety(
    appendOfferingFlags(outage.text, warningsFromBlock(input.context)),
    input.context.includes(MCHS_UNREAD_NOTE),
  );

  if (input.sos === false) {
    return { text: flagged, emergency: false, distanceRemoved: distance.removed, safety, delivery };
  }
  const sos = withSosBlock(flagged, input.question, input.lang ?? 'ru');
  return { text: sos.text, emergency: sos.emergency, distanceRemoved: distance.removed, safety, delivery };
}

/**
 * Поправка к опасному совету, который человек уже прочитал: вырезать его из
 * показанного текста нечем, поэтому он назван неверным словами. Что делать
 * взамен — то же правило, что в KUZMICH_SYSTEM («МЕДВЕДЬ»).
 */
export const SHOWN_BANNED_ADVICE_CORRECTION =
  `Поправка к сказанному выше: притворяться мёртвым нельзя. Не беги, не поворачивайся спиной, медленно отходи. ${BANNED_ADVICE_NOTE}`;

export interface ShownCorrection {
  /** Что дописать к уже отданному тексту; пусто — поправок нет. */
  tail: string;
  distanceRemoved: string[];
  safety: GuardResult;
  delivery: DeliveryGuardResult;
}

/**
 * Текст уже у человека (запасной стрим): вырезать нечем, поправки уходят
 * хвостом в том же порядке. Блок 112 стрим отдаёт первыми токенами сам.
 */
export function correctShownAnswer(input: Omit<FinishInput, 'sos' | 'lang'>): ShownCorrection {
  const distance = stripUngroundedDistanceClaims(input.answer, groundingContext(input.toolRuns, input.context));
  const safety = guardSafetyClaims(input.answer, input.toolRuns);
  void recordSafetyReview(input.surface, safety, input.toolRuns);
  const delivery = guardDeliveryClaims(input.answer, input.toolRuns);
  logGuards(input.surface, distance.removed, safety, delivery);

  // Сторож безопасности сначала вырезает опасный совет (banned-advice), потом
  // дописывает поправки. Вырезанное уже прочитано — оно названо неверным
  // отдельной строкой, а дописанное берётся после очищенного текста.
  const banned = stripBannedAdvice(input.answer);
  const notes: string[] = [];
  if (distance.removed.length > 0) notes.push(DISTANCE_HONEST_LINE);
  if (banned.removed.length > 0) notes.push(SHOWN_BANNED_ADVICE_CORRECTION);
  if (safety.text.startsWith(banned.text) && safety.text.length > banned.text.length) {
    notes.push(safety.text.slice(banned.text.length).trim());
  }
  if (delivery.verdict === 'unbacked') notes.push(DELIVERY_HONEST_LINE);
  const flagged = appendUnreadSafety(
    appendOfferingFlags(input.answer, warningsFromBlock(input.context)),
    input.context.includes(MCHS_UNREAD_NOTE),
  );
  if (flagged !== input.answer) notes.push(flagged.slice(input.answer.length).trim());
  return {
    tail: notes.length > 0 ? `\n\n${notes.join('\n\n')}` : '',
    distanceRemoved: distance.removed,
    safety,
    delivery,
  };
}
