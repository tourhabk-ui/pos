/**
 * lib/ai/interest-extractor.ts
 *
 * Extracts user interests from chat messages and stores them encrypted.
 * Reuses parseInterestsFromText from routes-recommender (80+ keyword dictionary).
 */

import { encrypt, decrypt } from '@/lib/encryption';
import { parseInterestsFromText } from '@/lib/planner/interests';

interface InterestScores {
  scores: Record<string, number>;
  updatedAt: number;
}

/**
 * Parse interests from a user message and merge with existing encrypted data.
 * Returns new encrypted string or null if encryption is unavailable.
 */
export function extractAndEncryptInterests(
  userMessage: string,
  existingEncrypted: string | null
): string | null {
  const parsed = parseInterestsFromText(userMessage);
  if (parsed.interests.length === 0 && !existingEncrypted) return null;

  // Decrypt existing scores
  let existing: InterestScores = { scores: {}, updatedAt: Date.now() };
  if (existingEncrypted) {
    const decrypted = decrypt(existingEncrypted);
    if (decrypted) {
      try {
        existing = JSON.parse(decrypted) as InterestScores;
      } catch {
        // corrupted — start fresh
      }
    }
  }

  // Merge new interests (+1 for each detected)
  for (const interest of parsed.interests) {
    existing.scores[interest] = (existing.scores[interest] ?? 0) + 1;
  }
  existing.updatedAt = Date.now();

  // Encrypt and return
  return encrypt(JSON.stringify(existing));
}

/**
 * Расшифровка интересов. `null` — расшифровать не удалось.
 *
 * ВЫЗОВА НЕТ НАМЕРЕННО. Интересы туриста шифруются при записи
 * (`extractAndEncryptInterests`), и это осознанный выбор: они относятся к
 * персональным данным. Читатель существует, но никуда не подключён, и это
 * правильное положение дел до тех пор, пока нет экрана с законным основанием
 * их показывать: подключить расшифровку «чтобы было» значит завести
 * распечатку ПД раньше, чем решение о ней.
 *
 * Хранить шифрование без расшифровки нельзя (получится запись в никуда),
 * поэтому функция остаётся — как вторая половина пары, а не как забытый код
 * (перепись 22.08.2026).
 */
export function decryptInterests(encrypted: string): InterestScores | null {
  const decrypted = decrypt(encrypted);
  if (!decrypted) return null;
  try {
    return JSON.parse(decrypted) as InterestScores;
  } catch {
    return null;
  }
}
