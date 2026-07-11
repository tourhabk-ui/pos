/**
 * OperatorRegistryService — сверка операторов с официальным реестром
 * visitkamchatka.ru/registry/ (issue #368).
 *
 * Разделение ответственности:
 *   - Скрипт scripts/scrape-registry-visitkamchatka.js наполняет таблицу
 *     official_registry_operators (сеть, парсинг HTML).
 *   - Этот сервис делает ТОЛЬКО сверку по данным из БД (без сети):
 *     матчит partners ↔ official_registry_operators и проставляет
 *     partners.registry_status. Разбит на чистые функции (матчинг,
 *     нормализация, классификация) — они покрыты юнит-тестами.
 *
 * Модель матчинга: сначала по ИНН/ОГРН (сильный сигнал), затем по
 * нормализованному названию (слабый — только если ИНН у нас нет).
 */

import { pool } from '@/lib/db-pool';

export type RegistryStatus = 'unknown' | 'verified' | 'not_found' | 'mismatch';
export type MatchMethod = 'inn' | 'ogrn' | 'name';

/** Запись официального реестра (подмножество official_registry_operators). */
export interface RegistryEntry {
  id: string;
  name: string;
  nameNormalized: string;
  inn: string | null;
  ogrn: string | null;
  registryNumber: string | null;
  registryStatus: string | null; // статус в реестре: «действующий» / «исключён» / ...
}

/** Наш оператор (подмножество partners) для сверки. */
export interface PartnerForMatch {
  id: number;
  name: string;
  inn: string | null;
  ogrn: string | null;
}

export interface MatchResult {
  entry: RegistryEntry;
  method: MatchMethod;
}

export interface PartnerReconcileResult {
  partnerId: number;
  status: RegistryStatus;
  registryNumber: string | null;
  matchedEntryId: string | null;
  method: MatchMethod | null;
}

export interface ReconcileSummary {
  partnersTotal: number;
  verified: number;
  notFound: number;
  mismatch: number;
  registryEntries: number;
  acquisitionLeads: number; // записи реестра без соответствия нашему оператору
  dryRun: boolean;
}

// ── Чистые функции (юнит-тестируемы) ─────────────────────────────────────────

/**
 * Организационно-правовые формы и родовые слова, которые не помогают
 * различать операторов (убираются перед сравнением названий).
 * NB: `\b` в JS-regex не работает с кириллицей, поэтому фильтруем по токенам.
 */
const ORG_FORM_TOKENS = new Set([
  'ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'нп', 'ано', 'тоо',
  'туроператор', 'турагентство', 'турфирма', 'турагент',
  'туристическая', 'туристический', 'туристическое',
  'компания', 'фирма',
  'общество', 'ограниченной', 'ответственностью',
  'индивидуальный', 'предприниматель',
]);

/**
 * Нормализация названия оператора для сравнения: убираем организационно-правовую
 * форму (ООО, ИП, АО...), кавычки и пунктуацию, схлопываем пробелы, lowercase.
 */
export function normalizeOperatorName(raw: string): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/g, ' ')
    .split(' ')
    .filter((tok) => tok.length > 0 && !ORG_FORM_TOKENS.has(tok))
    .join(' ')
    .trim();
}

/** Нормализация ИНН/ОГРН: оставляем только цифры, пустое → null. */
export function normalizeDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  return digits.length > 0 ? digits : null;
}

/** Активна ли запись реестра (не «исключён»/«прекращена деятельность»). */
export function isRegistryEntryActive(entry: RegistryEntry): boolean {
  const status = (entry.registryStatus ?? '').toLowerCase();
  if (!status) return true; // статус не указан — считаем действующим
  return !/(исключ|прекра|аннулир|недейств|приостан)/.test(status);
}

/**
 * Матчинг оператора с записями реестра. Возвращает лучший матч или null.
 * Приоритет: ИНН → ОГРН → нормализованное название.
 */
export function matchPartner(
  partner: PartnerForMatch,
  entries: RegistryEntry[],
): MatchResult | null {
  const inn = normalizeDigits(partner.inn);
  const ogrn = normalizeDigits(partner.ogrn);
  const nameNorm = normalizeOperatorName(partner.name);

  if (inn) {
    const byInn = entries.find((e) => normalizeDigits(e.inn) === inn);
    if (byInn) return { entry: byInn, method: 'inn' };
  }
  if (ogrn) {
    const byOgrn = entries.find((e) => normalizeDigits(e.ogrn) === ogrn);
    if (byOgrn) return { entry: byOgrn, method: 'ogrn' };
  }
  if (nameNorm) {
    const byName = entries.find((e) => e.nameNormalized === nameNorm);
    if (byName) return { entry: byName, method: 'name' };
  }
  return null;
}

/**
 * Классификация результата сверки.
 *   - нет матча                                     → not_found
 *   - матч по ИНН/ОГРН, запись действующая          → verified
 *   - матч по ИНН/ОГРН, но запись исключена          → mismatch
 *   - матч только по названию, но у нас есть ИНН,
 *     которого нет в реестре                         → mismatch (подозрительно)
 *   - матч только по названию, ИНН у нас нет          → verified (best-effort)
 */
export function classifyStatus(
  partner: PartnerForMatch,
  match: MatchResult | null,
): RegistryStatus {
  if (!match) return 'not_found';

  if (!isRegistryEntryActive(match.entry)) return 'mismatch';

  if (match.method === 'inn' || match.method === 'ogrn') return 'verified';

  // match.method === 'name'
  const partnerInn = normalizeDigits(partner.inn);
  const entryInn = normalizeDigits(match.entry.inn);
  if (partnerInn && entryInn && partnerInn !== entryInn) return 'mismatch';
  return 'verified';
}

/** Агрегация статусов для health-метрики (чистая, тестируемая). */
export function summarizeStatuses(statuses: RegistryStatus[]): {
  verified: number;
  notFound: number;
  mismatch: number;
  unknown: number;
} {
  return statuses.reduce(
    (acc, s) => {
      if (s === 'verified') acc.verified += 1;
      else if (s === 'not_found') acc.notFound += 1;
      else if (s === 'mismatch') acc.mismatch += 1;
      else acc.unknown += 1;
      return acc;
    },
    { verified: 0, notFound: 0, mismatch: 0, unknown: 0 },
  );
}

// ── Работа с БД ──────────────────────────────────────────────────────────────

interface PartnerDbRow {
  id: number;
  name: string;
  inn: string | null;
  ogrn: string | null;
}

interface RegistryDbRow {
  id: string;
  name: string;
  name_normalized: string;
  inn: string | null;
  ogrn: string | null;
  registry_number: string | null;
  registry_status: string | null;
  source_url: string | null;
}

function toRegistryEntry(r: RegistryDbRow): RegistryEntry {
  return {
    id: r.id,
    name: r.name,
    nameNormalized: r.name_normalized,
    inn: r.inn,
    ogrn: r.ogrn,
    registryNumber: r.registry_number,
    registryStatus: r.registry_status,
  };
}

/**
 * Сверить всех операторов с уже загруженным снимком реестра.
 * Обновляет partners.registry_* и official_registry_operators.matched_partner_id.
 * При dryRun ничего не пишет — только считает.
 */
export async function reconcileRegistry(dryRun = false): Promise<ReconcileSummary> {
  const client = await pool.connect();
  try {
    const partnersRes = await client.query<PartnerDbRow>(
      `SELECT id,
              name,
              legal_info->>'inn'  AS inn,
              legal_info->>'ogrn' AS ogrn
       FROM partners`,
    );

    const registryRes = await client.query<RegistryDbRow>(
      `SELECT id, name, name_normalized, inn, ogrn,
              registry_number, registry_status, source_url
       FROM official_registry_operators`,
    );

    const entries = registryRes.rows.map(toRegistryEntry);
    const sourceUrlByEntryId = new Map(
      registryRes.rows.map((r) => [r.id, r.source_url]),
    );

    const results: PartnerReconcileResult[] = partnersRes.rows.map((p) => {
      const match = matchPartner(p, entries);
      const status = classifyStatus(p, match);
      return {
        partnerId: p.id,
        status,
        registryNumber: match?.entry.registryNumber ?? null,
        matchedEntryId: match?.entry.id ?? null,
        method: match?.method ?? null,
      };
    });

    const matchedEntryIds = new Set(
      results.map((r) => r.matchedEntryId).filter((x): x is string => x !== null),
    );

    if (!dryRun) {
      await client.query('BEGIN');
      try {
        // Сбрасываем прошлые сопоставления, затем проставляем заново
        await client.query(
          `UPDATE official_registry_operators
           SET matched_partner_id = NULL, match_method = NULL`,
        );

        for (const r of results) {
          await client.query(
            `UPDATE partners
             SET registry_status     = $1,
                 registry_number     = $2,
                 registry_source_url = $3,
                 registry_checked_at = NOW()
             WHERE id = $4`,
            [
              r.status,
              r.registryNumber,
              r.matchedEntryId ? (sourceUrlByEntryId.get(r.matchedEntryId) ?? null) : null,
              r.partnerId,
            ],
          );

          if (r.matchedEntryId) {
            await client.query(
              `UPDATE official_registry_operators
               SET matched_partner_id = $1, match_method = $2
               WHERE id = $3`,
              [r.partnerId, r.method, r.matchedEntryId],
            );
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    const summary = summarizeStatuses(results.map((r) => r.status));
    return {
      partnersTotal: partnersRes.rows.length,
      verified: summary.verified,
      notFound: summary.notFound,
      mismatch: summary.mismatch,
      registryEntries: entries.length,
      acquisitionLeads: entries.length - matchedEntryIds.size,
      dryRun,
    };
  } finally {
    client.release();
  }
}
