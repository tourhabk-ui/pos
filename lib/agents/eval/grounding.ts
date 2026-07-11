/**
 * lib/agents/eval/grounding.ts
 *
 * Детектор незаземлённых фактов в ответах Кузьмича.
 *
 * Правило платформы (CLAUDE.md §8): критичные факты — цены, телефоны,
 * наличие мест — только из инструментов/БД, самоотчётам модели не верить.
 * Инсайт J-Lens (Anthropic, июль 2026): модель не имеет доступа к ~90%
 * собственных процессов — её «я проверил» ничего не гарантирует. Проверять
 * можно только поведение: если в ответе есть конкретика, а инструменты
 * в этом ходу не вызывались — факт взят «из головы».
 *
 * Чистый модуль без сети/БД — детектор вызывается из outcomes-грейдера.
 */

/** Имена инструментов Кузьмича, дающие заземление фактам (данные из БД). */
const DATA_TOOL_PREFIXES = ['search_', 'get_guardian_context', 'get_tour', 'check_'];

export type GroundingSignal = 'price' | 'phone' | 'availability';

const SIGNAL_PATTERNS: Record<GroundingSignal, RegExp> = {
  // «15000 ₽», «15 000 руб», «от 15 тыс. рублей», «стоит 15к»
  price: /\d[\d\s]*\s*(₽|руб|тыс\.?\s*руб|тысяч|к\b)|цена\s+\d|стоит\s+\d/i,
  // Телефоны: +7/8 с 10 цифрами в любых разделителях
  phone: /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/,
  // «есть места», «осталось 3 места», «свободно на завтра»
  availability: /есть (свободные )?места|осталось \d+ мест|свободн(о|ы) (на|в)|места (есть|доступны)/i,
};

// Экстренные телефоны — легитимны без инструментов: их источник — код
// (lib/safety/sos-detector.ts, промпт), а не выдумка модели.
const EMERGENCY_PHONES_RE = /(?<!\d)112(?!\d)|23-53-62|30-10-50|41-27-30/;

export interface GroundingAssessment {
  ungrounded: boolean;
  signals: GroundingSignal[];
}

/** Какие сигналы «конкретных фактов» есть в ответе. Экспортирован для тестов. */
export function detectFactSignals(answer: string): GroundingSignal[] {
  const signals: GroundingSignal[] = [];
  for (const [signal, re] of Object.entries(SIGNAL_PATTERNS) as [GroundingSignal, RegExp][]) {
    if (signal === 'phone') {
      // Ответ, где все телефоны — экстренные, не флагуем
      const stripped = answer.replace(EMERGENCY_PHONES_RE, '');
      if (re.test(stripped)) signals.push(signal);
    } else if (re.test(answer)) {
      signals.push(signal);
    }
  }
  return signals;
}

/** Был ли среди выполненных инструментов хотя бы один «данных». */
export function ranDataTool(toolsRan: readonly string[]): boolean {
  return toolsRan.some((name) => DATA_TOOL_PREFIXES.some((p) => name.startsWith(p)));
}

/**
 * Ответ с конкретикой (цены/телефоны/наличие) без единого вызова
 * инструмента данных — незаземлён: факты взяты не из БД платформы.
 */
export function assessGrounding(answer: string, toolsRan: readonly string[]): GroundingAssessment {
  const signals = detectFactSignals(answer);
  if (signals.length === 0) return { ungrounded: false, signals: [] };
  if (ranDataTool(toolsRan)) return { ungrounded: false, signals };
  return { ungrounded: true, signals };
}
