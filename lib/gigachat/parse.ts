/**
 * Разбор ответа chat/completions GigaChat. Форма ответа и регулярка
 * упоминания Ведара совпадают с /workspace/seo/measure-gigachat/measure_gigachat.py.
 * Никогда не возвращаем и не оставляем в объектах ключи/токены.
 */

export const VEDAR_RE = /vedarai|ведар/i;

export const DEFAULT_QUESTION = 'что взять на Камчатку';
export const DEFAULT_MODEL = 'GigaChat';
export const MAX_QUESTION_LENGTH = 500;

export function redact(obj: unknown): unknown {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/token|authorization|credential|secret|password/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  return obj;
}

/** Текст сообщения модели: строка, массив частей или устаревшее поле text. */
export function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string') parts.push(p.text);
        else if (typeof p.content === 'string') parts.push(p.content);
      }
    }
    return parts.join('');
  }
  if (typeof m.text === 'string') return m.text;
  return '';
}

export function extractAnswer(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload as Record<string, unknown>;
  let message: unknown = null;
  if (Array.isArray(data.messages) && data.messages.length > 0) {
    message = data.messages[0];
  } else if (Array.isArray(data.choices) && data.choices.length > 0) {
    const choice = data.choices[0] as Record<string, unknown> | undefined;
    message = choice?.message ?? choice;
  }
  const fromMessage = extractText(message);
  if (fromMessage) return fromMessage;
  return extractText(data);
}

export function mentionsVedar(...chunks: string[]): boolean {
  return chunks.some((c) => VEDAR_RE.test(c));
}

export function clampQuestion(raw: string | null | undefined): string {
  const q = (raw ?? '').trim();
  if (!q) return DEFAULT_QUESTION;
  return q.length > MAX_QUESTION_LENGTH ? q.slice(0, MAX_QUESTION_LENGTH) : q;
}

export interface GigachatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export function extractUsage(payload: unknown): GigachatUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const out: GigachatUsage = {};
  if (typeof u.prompt_tokens === 'number') out.prompt_tokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.completion_tokens = u.completion_tokens;
  if (typeof u.total_tokens === 'number') out.total_tokens = u.total_tokens;
  return Object.keys(out).length > 0 ? out : null;
}
