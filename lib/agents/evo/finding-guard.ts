/**
 * Страж достоверности находок — детерминированный слой между LLM-сканером
 * (aiCodeReview, Gemini) и записью в evo_growth_issues.
 *
 * Зачем: ночью Growth Scan выдавал галлюцинации, которые тихо копились как
 * «проблемы» и пошли бы в GitHub Issues:
 *   - «Прямой вызов callAIFast — нарушение конвенции» — ЛОЖЬ: CLAUDE.md §4
 *     разрешает callAIFast() наравне с callAIWaterfall().
 *   - «console.error в saveBotMemory — нарушение» — ЛОЖЬ: запрещён console.log,
 *     а console.error в catch разрешён.
 *   - «Использование callAIWaterfall вместо callAIWaterfall» — бессмыслица
 *     (заменить X на тот же X).
 *
 * Guard кодирует РЕАЛЬНЫЕ правила проекта и режет находки, им противоречащие.
 * Консервативен: глушит только явно-ложное, настоящие находки (SQL-инъекция,
 * дыра auth, console.log в проде, прямой callDeepSeek) проходят.
 *
 * Чистые функции — под тестом. НЕ ловит семантические галлюцинации, требующие
 * сверки с телом файла (напр. «внешний вызов без try/catch», когда try/catch
 * есть) — это отдельный класс, для него нужен верификационный проход.
 */

export interface CandidateFinding {
  title: string;
  description: string;
  suggestion: string;
}

/** «X вместо X» / «заменить X на X» — предложение заменить токен на тот же токен. */
function incoherentSameToken(text: string): boolean {
  // Латинские идентификаторы (callAIFast и т.п.); кириллицу не трогаем —
  // «строк вместо параметров» это осмысленно.
  const m1 = text.match(/([A-Za-z_][\w.]{3,})\s+(?:вместо|instead of)\s+([A-Za-z_][\w.]{3,})/i);
  if (m1 && m1[1].toLowerCase() === m1[2].toLowerCase()) return true;

  const m2 = text.match(/замен\w*\s+([A-Za-z_][\w.]{3,})\s+на\s+([A-Za-z_][\w.]{3,})/i);
  if (m2 && m2[1].toLowerCase() === m2[2].toLowerCase()) return true;

  return false;
}

/**
 * callAIFast заклеймён нарушением. CLAUDE.md §4: callAIFast() — санкционированная
 * точка входа наравне с callAIWaterfall(). Находка «заменить callAIFast на
 * callAIWaterfall» / «callAIFast нарушает конвенцию» — ложная.
 * НЕ глушим «callAIFast без try/catch» (это другой, возможно реальный, класс).
 */
function flagsSanctionedCallAIFast(text: string): boolean {
  if (!/callAIFast/i.test(text)) return false;
  return /callAIWaterfall/i.test(text) || /(нарушени|конвенци|instead|вместо|замен)/i.test(text);
}

/**
 * console.error заклеймён нарушением. CLAUDE.md: запрещён console.log; console.error
 * в catch — разрешён. Глушим только когда клеймят именно console.error и рядом нет
 * console.log (тот — реальное нарушение, не трогаем).
 */
function flagsSanctionedConsoleError(text: string): boolean {
  if (!/console\.error/i.test(text)) return false;
  if (/console\.log/i.test(text)) return false;
  return /(нарушени|конвенци|логгер|logger|замен|вместо|instead|не следует|запрещ)/i.test(text);
}

/**
 * Причина отклонить находку как недостоверную, либо null если находка проходит.
 * Строка-код причины идёт в телеметрию скана.
 */
export function findingRejectionReason(f: CandidateFinding): string | null {
  const text = `${f.title} ${f.description} ${f.suggestion}`;
  if (incoherentSameToken(text)) return 'incoherent_same_token';
  if (flagsSanctionedCallAIFast(text)) return 'sanctioned_callaifast';
  if (flagsSanctionedConsoleError(text)) return 'sanctioned_console_error';
  return null;
}

export function isCredibleFinding(f: CandidateFinding): boolean {
  return findingRejectionReason(f) === null;
}
