/**
 * Шифрование платёжных реквизитов оператора (partners.payout_details).
 *
 * Контекст: онбординг оператора обещает «реквизиты хранятся в зашифрованном
 * виде», а схема (migration 051) помечает колонку «encrypted by app layer» —
 * но app-слой писал JSON.stringify(details) в открытом виде. Здесь закрываем
 * этот невыполненный контракт: р/с, ИНН, БИК, телефон СБП шифруются AES-256-GCM
 * (та же lib/encryption, что и для интересов чата) перед записью.
 *
 * Хранение: колонка JSONB. Шифртекст "iv:tag:ct" кладём как JSON-строку
 * (JSON.stringify), чтобы значение осталось валидным JSON. Legacy-строки
 * (объект-JSONB до шифрования) читаются как есть — грациозная деградация.
 */
import { encrypt, decrypt } from '@/lib/encryption';

export type PayoutDetails = Record<string, unknown>;

/**
 * Шифрует реквизиты для записи в payout_details (JSONB-совместимая строка).
 * Возвращает null, если шифрование недоступно (нет ENCRYPTION_KEY) — тогда
 * вызывающий ОБЯЗАН вернуть честную ошибку, а НЕ писать plaintext под
 * обещанием шифрования.
 */
export function encryptPayoutDetails(details: PayoutDetails): string | null {
  const ct = encrypt(JSON.stringify(details));
  if (ct === null) return null;
  return JSON.stringify(ct); // jsonb-совместимая строка-шифртекст
}

/**
 * Расшифровывает payout_details. Терпимо к двум формам хранения:
 *  - новый путь: строка-шифртекст "iv:tag:ct" → decrypt + JSON.parse;
 *  - legacy: объект JSONB (записи до шифрования) → как есть.
 * null — если пусто или расшифровать/распарсить не удалось.
 */
export function decryptPayoutDetails(stored: unknown): PayoutDetails | null {
  if (stored == null) return null;

  // Legacy plaintext: pg вернул JSONB-объект.
  if (typeof stored === 'object') return stored as PayoutDetails;

  if (typeof stored !== 'string') return null;

  // Новый путь: шифртекст.
  const plain = decrypt(stored);
  if (plain !== null) {
    try { return JSON.parse(plain) as PayoutDetails; } catch { return null; }
  }

  // Не расшифровалось — возможно, legacy JSON-строка. Пробуем как есть.
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? (parsed as PayoutDetails) : null;
  } catch {
    return null;
  }
}
