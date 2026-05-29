/**
 * RAG prompt-injection protection.
 *
 * Layer 1 (write): strip injection instructions before storing in agent_knowledge.
 * Layer 2 (read):  wrap retrieved content in XML delimiters so the model
 *                  treats it as external data, not instructions.
 *
 * Design note: the XML wrap is the primary defense. The regex sanitizer is
 * best-effort logging + cleanup — it cannot be exhaustive (encoding bypasses,
 * confusables, novel phrasings). Do not rely on it as a sole gate.
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

// Zero-width / invisible chars that can hide injection text from the regex
const ZERO_WIDTH_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Normalize text before matching:
 *  1. NFKC (decomposes confusable lookalikes, e.g. ｉｇｎｏｒｅ → ignore)
 *  2. Strip zero-width chars
 *
 * Stored content keeps its original form; normalization is only for matching.
 */
function normalize(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH_RE, '');
}

export interface SanitizeResult {
  safe: boolean;
  sanitized: string;
  flaggedPatterns: string[];
}

/**
 * Sanitize content before storing in agent_knowledge.
 * Returns cleaned text and a flag indicating whether injection was detected.
 *
 * Fix applied to the stored string, not just the normalized form, so
 * that the stored value never contains the raw injection text either.
 */
export function sanitizeKnowledgeContent(raw: string): SanitizeResult {
  const flaggedPatterns: string[] = [];
  let sanitized = raw;
  const normalized = normalize(raw);

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      flaggedPatterns.push(pattern.source);
      // Replace ALL occurrences (g flag via new RegExp to avoid lastIndex mutation)
      sanitized = sanitized.replace(new RegExp(pattern.source, 'gi'), '[REMOVED]');
    }
  }

  return {
    safe: flaggedPatterns.length === 0,
    sanitized: sanitized.trim(),
    flaggedPatterns,
  };
}

// Delimiter that content cannot break out of: strip the closing tag from
// both title and content before interpolation.
const CLOSING_TAG_RE = /<\/knowledge_base_entry\s*>/gi;

/**
 * Wrap RAG content in XML delimiters at read time.
 * The closing tag is stripped from both title and content so that
 * malicious stored content cannot escape the delimiter boundary.
 */
export function wrapForRAG(title: string, content: string): string {
  const safeTitle = title
    .replace(/"/g, '')              // can't break out of attribute
    .replace(CLOSING_TAG_RE, '')    // can't prematurely close wrapper
    .replace(/[\r\n]/g, ' ');       // no newlines in attribute value
  const safeContent = content.replace(CLOSING_TAG_RE, '[REMOVED]');
  return `<knowledge_base_entry title="${safeTitle}">\n${safeContent}\n</knowledge_base_entry>`;
}

/**
 * Check whether a string contains injection patterns (for audit/reporting).
 * Matches against NFKC-normalized form to catch encoding tricks.
 */
export function detectInjection(content: string): string[] {
  const normalized = normalize(content);
  return INJECTION_PATTERNS
    .filter(p => p.test(normalized))
    .map(p => p.source);
}
