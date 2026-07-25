/**
 * Сторож разрастания промптов.
 *
 * CLAUDE.md §8 требует: «правки промптов агентов — добавлять принципы, а не
 * перечни кейсов. Разрастающийся список исключений в промпте — признак того,
 * что нужен инструмент или серверный guard». Но это правило о правилах: его
 * никто не проверял, и держалось оно на памяти того, кто правит промпт.
 *
 * Здесь оно становится проверкой. Считаются не символы (длинный промпт бывает
 * оправдан), а ПЕРЕЧНИ: строки-запреты и строки-исключения. Именно они растут,
 * когда вместо инструмента дописывают ещё один случай.
 *
 * Порог мягкий и подобран по факту: на 25.07.2026 самый нагруженный промпт
 * (KUZMICH_SYSTEM) имел 5 строк-запретов. Пороги оставляют запас на осмысленный
 * рост и падают, когда список превращается в свалку исключений.
 */

/** Строка-запрет: НИКОГДА, НЕЛЬЗЯ, ЗАПРЕЩЕНО, «не делай». */
const PROHIBITION = /НИКОГДА|НЕЛЬЗЯ|ЗАПРЕЩ|\bНЕ\s+[А-ЯЁ]{3,}|не пиши|не говори|не выдумывай|не придумывай|не указывай/;

/** Строка-исключение: «кроме», «за исключением», «если только». */
const EXCEPTION = /кроме\b|за исключением|исключение:|если только|но если|однако если/i;

export interface PromptBloatReport {
  name: string;
  chars: number;
  lines: number;
  prohibitions: number;
  exceptions: number;
  /** Превышен ли порог — тогда пора делать инструмент, а не дописывать абзац. */
  bloated: boolean;
  reason?: string;
}

/** Пороги. Превышение — сигнал «здесь нужен гвард, а не ещё одна строка». */
export const MAX_PROHIBITIONS = 12;
export const MAX_EXCEPTIONS = 8;

export function analyzePrompt(name: string, text: string): PromptBloatReport {
  const lines = text.split('\n');
  const prohibitions = lines.filter((l) => PROHIBITION.test(l)).length;
  const exceptions = lines.filter((l) => EXCEPTION.test(l)).length;

  const reasons: string[] = [];
  if (prohibitions > MAX_PROHIBITIONS) {
    reasons.push(`строк-запретов ${prohibitions} > ${MAX_PROHIBITIONS}`);
  }
  if (exceptions > MAX_EXCEPTIONS) {
    reasons.push(`строк-исключений ${exceptions} > ${MAX_EXCEPTIONS}`);
  }

  return {
    name,
    chars: text.length,
    lines: lines.length,
    prohibitions,
    exceptions,
    bloated: reasons.length > 0,
    reason: reasons.length > 0
      ? `${reasons.join('; ')}. §8: перечень исключений в промпте — признак, что нужен детерминированный инструмент, а не ещё один абзац.`
      : undefined,
  };
}

/** Вытащить шаблонные литералы, присвоенные ИМЕНАМ_ПРОМПТОВ, из исходника. */
export function extractPromptLiterals(source: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const re = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*(?:SYSTEM|PROMPT)[A-Z0-9_]*)\s*=\s*`([\s\S]*?)`/g;
  for (const m of source.matchAll(re)) {
    out.push({ name: m[1], text: m[2] });
  }
  return out;
}
