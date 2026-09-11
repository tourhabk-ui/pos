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

/**
 * Три исхода, а не два (§4.0).
 *
 * `unknown` — телеметрия вызовов не пришла: чем заземлён ответ, неизвестно.
 * Это НЕ `grounded`. Находка аудита 08.09: при отсутствии `toolsRan` грейдер
 * писал `ungrounded: false`, то есть отвечал «заземлено» на вопрос, которого
 * не проверял. Место, где нельзя сказать «не знаю», заполняется враньём.
 */
export type GroundingVerdict = 'grounded' | 'ungrounded' | 'unknown';

export interface GroundingAssessment {
  verdict: GroundingVerdict;
  signals: GroundingSignal[];
  /** Почему так решено — для строки в отчёте и в логе. */
  reason: string;
}

/**
 * Один вызов инструмента и его исход.
 *
 * Имя — не доказательство: инструмент мог выполниться и вернуть «ничего не
 * найдено», а ответ всё равно назвал цену. Заземляет только вызов, который
 * ПРИНЁС ДАННЫЕ.
 */
export interface ToolRun {
  name: string;
  producedData: boolean;
  /**
   * Сырой вывод инструмента. Нужен ОЦЕНКЕ faithfulness, а не этой оценке
   * заземления: судье нужно показать то, ЧЕМ ответ обоснован, иначе он судит
   * против пустоты и всякий содержательный ответ объявляет выдумкой (прогон
   * 07.09: context_len 0 во всех десяти вопросах, pass_rate 0.5).
   *
   * `assessGrounding` его НЕ читает и читать не должен: заземление судится по
   * факту «инструмент принёс данные», а не по их содержанию. Поле необязательно
   * — вызывающие, которым содержимое не нужно, его не заполняют.
   */
  output?: string;
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

/** Принёс ли данные хотя бы один инструмент «данных». */
export function ranDataTool(runs: readonly ToolRun[]): boolean {
  return runs.some(
    (r) => r.producedData && DATA_TOOL_PREFIXES.some((p) => r.name.startsWith(p)),
  );
}

/**
 * Ответ с конкретикой (цены/телефоны/наличие) без единого инструмента данных,
 * принёсшего результат, — незаземлён: факты взяты не из БД платформы.
 *
 * `runs === undefined` — телеметрии нет. Тогда исход `unknown`: судить не о
 * чем, и молча записывать «заземлено» нельзя.
 */
export function assessGrounding(
  answer: string,
  runs: readonly ToolRun[] | undefined,
): GroundingAssessment {
  const signals = detectFactSignals(answer);
  if (signals.length === 0) {
    return { verdict: 'grounded', signals: [], reason: 'конкретики в ответе нет — заземлять нечего' };
  }
  if (runs === undefined) {
    return {
      verdict: 'unknown',
      signals,
      reason: 'конкретика есть, а список вызовов инструментов не передан — проверить заземление не на чем',
    };
  }
  if (ranDataTool(runs)) {
    return { verdict: 'grounded', signals, reason: 'инструмент данных отработал и вернул результат' };
  }
  const tried = runs.length === 0
    ? 'инструменты не вызывались'
    : `инструменты вызывались (${runs.map((r) => r.name).join(', ')}), но данных не принесли`;
  return { verdict: 'ungrounded', signals, reason: `конкретика без данных платформы: ${tried}` };
}
