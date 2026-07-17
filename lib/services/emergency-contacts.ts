/**
 * lib/services/emergency-contacts.ts
 *
 * Справочник официальных/экстренных телефонов (issue #366) и сверка
 * расхождений между источниками: code (зашито в приложении),
 * visitkamchatka (портал), seed (старый сид 0645, происхождение
 * неизвестно), verified (подтверждено после сверки).
 *
 * ВАЖНО: сервис НИЧЕГО не меняет в SOS-файлах — только читает справочник
 * и считает расхождения «на сверку с Артёмом». Переключение потребителей
 * на справочник — отдельный шаг после сверки.
 */

import { pool } from '@/lib/db-pool';

export interface EmergencyContact {
  id: string;
  zone: string | null;
  contactType: string | null;
  name: string | null;
  phone: string | null;
  purpose: string | null;
  source: string | null;
  sourceUrl: string | null;
  verifiedAt: string | null;
  notes: string | null;
}

export interface PhoneDiscrepancy {
  purpose: string;
  phones: { phone: string; source: string; name: string | null }[];
}

export interface SimilarPhonePair {
  codePhone: string;
  codeName: string | null;
  portalPhone: string;
  portalName: string | null;
  /** Сколько цифр различаются в 6-значных «хвостах» */
  digitDiff: number;
}

export interface EmergencyContactsHealth {
  total: number;
  bySource: Record<string, number>;
  byPurpose: Record<string, number>;
  /** Один purpose — разные номера у разных источников */
  discrepancies: PhoneDiscrepancy[];
  /** Похожие, но не совпадающие номера code vs портал (вероятная опечатка) */
  similarPairs: SimilarPhonePair[];
  /** Инвентаризация файлов с хардкод-номерами */
  hardcodedSites: typeof HARDCODED_PHONE_SITES;
}

/**
 * Инвентаризация файлов с хардкод-номерами.
 *
 * ИСТОРИЯ: до июля 2026 экстренные номера были зашиты хардкодом вразнобой (6+
 * разных МЧС/спасательных номеров в 18 файлах). После жалобы владельца
 * («везде разные номера, я такие не знаю») все user-facing SOS/safety-экраны
 * переведены на ЕДИНЫЙ источник lib/safety/emergency-numbers.ts (только
 * федеральные короткие 112/101/102/103, региональные — до верификации
 * владельцем). Поэтому список теперь пуст: хардкод-сайтов не осталось.
 * Проверенные региональные номера добавляются в emergency-numbers.ts
 * (VERIFIED_REGIONAL) и/или сюда в таблицу с source='verified'.
 */
export const HARDCODED_PHONE_SITES: {
  phone: string;
  role: string;
  files: readonly string[];
  sosCritical: boolean;
}[] = [];

/** Нормализация для сравнения: только цифры, без кода страны 7/8 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return digits.slice(1);
  }
  return digits;
}

export async function getEmergencyContacts(
  zone?: string,
  purpose?: string
): Promise<EmergencyContact[]> {
  const { rows } = await pool.query(
    `SELECT id::text, zone, contact_type, name, phone, purpose, source,
            source_url, verified_at, notes
     FROM emergency_contacts
     WHERE ($1::text IS NULL OR zone = $1 OR zone IS NULL)
       AND ($2::text IS NULL OR purpose = $2)
     ORDER BY source, purpose, name`,
    [zone ?? null, purpose ?? null]
  );

  return rows.map(r => ({
    id: r.id,
    zone: r.zone,
    contactType: r.contact_type,
    name: r.name,
    phone: r.phone,
    purpose: r.purpose,
    source: r.source,
    sourceUrl: r.source_url,
    verifiedAt: r.verified_at,
    notes: r.notes,
  }));
}

interface ContactRow {
  phone: string | null;
  name: string | null;
  purpose: string | null;
  source: string | null;
}

/** Различие 6-значных «хвостов» двух номеров (позиции с разными цифрами) */
function tailDigitDiff(a: string, b: string): number {
  const tailA = normalizePhone(a).slice(-6);
  const tailB = normalizePhone(b).slice(-6);
  if (tailA.length !== 6 || tailB.length !== 6) return 6;
  let diff = 0;
  for (let i = 0; i < 6; i++) {
    if (tailA[i] !== tailB[i]) diff++;
  }
  return diff;
}

/**
 * Расхождения между источниками:
 * - discrepancies: внутри одного purpose разные нормализованные номера
 *   у разных источников;
 * - similarPairs: номер из кода и номер портала различаются 1–2 цифрами
 *   «хвоста» — вероятная опечатка (пример из issue #366: наш 41-03-03 vs
 *   портальный 41-03-95).
 */
export function computePhoneDiscrepancies(rows: ContactRow[]): {
  discrepancies: PhoneDiscrepancy[];
  similarPairs: SimilarPhonePair[];
} {
  const withPhone = rows.filter(
    (r): r is ContactRow & { phone: string } => !!r.phone && !!r.phone.trim()
  );

  // 1. Конфликты внутри назначения
  const byPurpose = new Map<string, (ContactRow & { phone: string })[]>();
  for (const r of withPhone) {
    if (!r.purpose) continue;
    const list = byPurpose.get(r.purpose) ?? [];
    list.push(r);
    byPurpose.set(r.purpose, list);
  }

  const discrepancies: PhoneDiscrepancy[] = [];
  for (const [purpose, list] of byPurpose) {
    const normalized = new Set(list.map(r => normalizePhone(r.phone)));
    const sources = new Set(list.map(r => r.source));
    if (normalized.size > 1 && sources.size > 1) {
      discrepancies.push({
        purpose,
        phones: list.map(r => ({ phone: r.phone, source: r.source ?? 'unknown', name: r.name })),
      });
    }
  }

  // 2. Похожие номера code vs портал (опечатки)
  const codeRows = withPhone.filter(r => r.source === 'code');
  const portalRows = withPhone.filter(r => r.source === 'visitkamchatka');
  const similarPairs: SimilarPhonePair[] = [];
  for (const c of codeRows) {
    for (const p of portalRows) {
      const diff = tailDigitDiff(c.phone, p.phone);
      if (diff >= 1 && diff <= 2) {
        similarPairs.push({
          codePhone: c.phone,
          codeName: c.name,
          portalPhone: p.phone,
          portalName: p.name,
          digitDiff: diff,
        });
      }
    }
  }

  return { discrepancies, similarPairs };
}

export async function computeEmergencyContactsHealth(): Promise<EmergencyContactsHealth> {
  const { rows } = await pool.query<ContactRow & { source: string | null }>(
    `SELECT phone, name, purpose, source FROM emergency_contacts`
  );

  const bySource: Record<string, number> = {};
  const byPurpose: Record<string, number> = {};
  for (const r of rows) {
    const source = r.source ?? 'unknown';
    bySource[source] = (bySource[source] ?? 0) + 1;
    if (r.purpose) byPurpose[r.purpose] = (byPurpose[r.purpose] ?? 0) + 1;
  }

  const { discrepancies, similarPairs } = computePhoneDiscrepancies(rows);

  return {
    total: rows.length,
    bySource,
    byPurpose,
    discrepancies,
    similarPairs,
    hardcodedSites: HARDCODED_PHONE_SITES,
  };
}
