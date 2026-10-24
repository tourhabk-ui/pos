/**
 * Топ адресов за камчатские сутки для кабинета администратора.
 *
 * Наружу уходит усечённый суточный хэш, число просмотров и короткая метка
 * семейства. Полный хэш, сырой IP и сырой User-Agent в ответ не входят.
 * Пустой список — за сутки нет строк с хэшем. rows === null — посчитать
 * не удалось: это не ноль адресов.
 */

export const ADDRESS_HASH_PREFIX = 12;

export interface AddressTopRow {
  hash: string;
  hits: number;
  /** Семейство, «несколько» или «не записано». Не сырой User-Agent. */
  ua: string;
}

export interface AddressTop {
  day: string;
  rows: AddressTopRow[] | null;
  errorCode: string | null;
}

interface AddressSqlRow {
  hash: string | null;
  hits: number | string | null;
  family_n: number | string | null;
  family: string | null;
}

export interface DayBounds {
  day: string;
  start: Date;
  end: Date;
}

/** Короткая подпись UA: одна метка, несколько семейств или «не записано». */
export function shortUaLabel(familyCount: number, family: string | null): string {
  if (familyCount === 1 && family) return family;
  if (familyCount > 1) return 'несколько';
  return 'не записано';
}

/** Первые 12 hex-знаков. Иное в ответ не проходит. */
export function maskAddressHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const slice = hash.slice(0, ADDRESS_HASH_PREFIX);
  return /^[0-9a-f]{12}$/.test(slice) ? slice : null;
}

export function toAddressTopRow(row: AddressSqlRow): AddressTopRow | null {
  const hash = maskAddressHash(row.hash);
  const hits = Number(row.hits);
  if (!hash || !Number.isFinite(hits)) return null;
  const familyCount = Number(row.family_n);
  return {
    hash,
    hits,
    ua: shortUaLabel(Number.isFinite(familyCount) ? familyCount : 0, row.family),
  };
}

const ADDRESS_TOP_SQL = `
  SELECT left(ip_hash, ${ADDRESS_HASH_PREFIX}) AS hash,
         COUNT(*)::int AS hits,
         COUNT(DISTINCT ua_family) FILTER (WHERE ua_family IS NOT NULL)::int AS family_n,
         MIN(ua_family) FILTER (WHERE ua_family IS NOT NULL) AS family
    FROM page_views
   WHERE ip_hash IS NOT NULL
     AND created_at >= $1
     AND created_at < $2
   GROUP BY ip_hash
   ORDER BY COUNT(*) DESC, left(ip_hash, ${ADDRESS_HASH_PREFIX})
   LIMIT 10
`;

function sqlState(e: unknown): string {
  if (typeof e === 'object' && e && 'code' in e && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return 'нет SQLSTATE';
}

export async function queryAddressTop(
  run: (sql: string, params: unknown[]) => Promise<{ rows: AddressSqlRow[] }>,
  bounds: DayBounds,
): Promise<AddressTop> {
  try {
    const res = await run(ADDRESS_TOP_SQL, [bounds.start, bounds.end]);
    const rows: AddressTopRow[] = [];
    for (const row of res.rows) {
      const mapped = toAddressTopRow(row);
      if (mapped) rows.push(mapped);
    }
    return { day: bounds.day, rows, errorCode: null };
  } catch (e) {
    return { day: bounds.day, rows: null, errorCode: sqlState(e) };
  }
}
