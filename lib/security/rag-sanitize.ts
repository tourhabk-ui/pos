/**
 * RAG prompt-injection protection.
 *
 * Layer 1 (write): strip injection instructions before storing in agent_knowledge.
 * Layer 2 (read):  wrap retrieved content in XML delimiters so the model
 *                  treats it as external data, not instructions.
 *
 * Patterns from OWASP LLM01 + Perez & Ribeiro (2022).
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|prompts?|rules?)/i,
  /override\s+(your\s+)?(system\s+)?prompt/i,
  /new\s+(system\s+)?instructions?:/i,
  /you\s+are\s+now\s+/i,
  /act\s+as\s+(a\s+|an\s+)?(?!guide|navigator|assistant\s+for\s+kamchatka)/i,
  /you\s+must\s+now\s+/i,
  /\[system\]/i,
  /<\/?system>/i,
  /\[inst\]/i,
  /\[\/inst\]/i,
  /bypass\s+(your\s+)?(safety|content|guidelines?|filter)/i,
  /jailbreak/i,
  /игнорир(уй|уйте)\s+(все\s+)?(предыдущие|прошлые|ваши)\s+(инструкции|правила)/i,
  /забудь\s+(все\s+)?(предыдущие|прошлые|ваши)\s+(инструкции|правила)/i,
  /ты\s+теперь\s+/i,
  /новые\s+инструкции:/i,
];

export interface SanitizeResult {
  safe: boolean;
  sanitized: string;
  flaggedPatterns: string[];
}

/**
 * Sanitize content before storing in agent_knowledge.
 * Returns cleaned text and a flag indicating whether injection was detected.
 */
export function sanitizeKnowledgeContent(content: string): SanitizeResult {
  const flaggedPatterns: string[] = [];

  let sanitized = content;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      flaggedPatterns.push(pattern.source);
      // Remove the sentence containing the injection attempt
      sanitized = sanitized.replace(pattern, '[REMOVED]');
    }
  }

  return {
    safe: flaggedPatterns.length === 0,
    sanitized: sanitized.trim(),
    flaggedPatterns,
  };
}

/**
 * Wrap RAG content in XML delimiters at read time.
 * This signals to the model that what follows is external reference data,
 * not instructions — providing defense-in-depth even if stored content
 * was not sanitized.
 */
export function wrapForRAG(title: string, content: string): string {
  return `<knowledge_base_entry title="${title.replace(/"/g, '')}">\n${content}\n</knowledge_base_entry>`;
}

/**
 * Check whether a string contains injection patterns (for audit/reporting).
 * Does not modify the string.
 */
export function detectInjection(content: string): string[] {
  return INJECTION_PATTERNS
    .filter(p => p.test(content))
    .map(p => p.source);
}
