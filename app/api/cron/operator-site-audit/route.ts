/**
 * GET /api/cron/operator-site-audit
 *
 * Проверка внешней поверхности сайтов операторов (issue #1275, решение
 * владельца 19.08). Платформа ручается за оператора, и его сайт — часть этого
 * ручательства.
 *
 * Границы проверки описаны в lib/security/site-audit.ts: только то, что видит
 * обычный посетитель. Эксплуатации нет.
 *
 * За прогон берётся LIMIT операторов, дольше всех не проверявшихся, — чтобы
 * ни один сайт не получал наш трафик чаще раза в сутки и чтобы очередь
 * обходилась целиком, а не крутилась по первым записям.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { auditSnapshot, summarize, isAuditableUrl } from '@/lib/security/site-audit';
import { probeSite } from '@/lib/security/site-probe';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const LIMIT = 10;

interface PartnerRow { id: string; name: string; website: string | null }

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeCompare(getCronSecret(request) ?? '', secret)) {
    if (!secret) console.error('[operator-site-audit] CRON_SECRET не настроен: проверка не выполнится');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Дольше всех не проверявшиеся — первыми. LEFT JOIN, потому что у ни разу
    // не проверенного записи нет вовсе, и он обязан идти впереди, а не выпасть.
    const { rows } = await pool.query<PartnerRow>(
      `SELECT p.id, p.name, p.website
         FROM partners p
         LEFT JOIN LATERAL (
           SELECT MAX(checked_at) AS last_at
             FROM operator_site_audits a
            WHERE a.partner_id = p.id
         ) a ON TRUE
        WHERE p.website IS NOT NULL AND p.website <> ''
          AND p.site_audit_consent <> 'declined'
        ORDER BY a.last_at ASC NULLS FIRST
        LIMIT $1`,
      [LIMIT],
    );

    const report: Array<{ partner: string; verdict: string; bad: number; unknown: number }> = [];

    for (const p of rows) {
      // Негодный адрес — это исход «не знаю», а не пропуск: пропущенный молча
      // выглядит как проверенный.
      if (!isAuditableUrl(p.website)) {
        await pool.query(
          `INSERT INTO operator_site_audits (partner_id, site_url, verdict, checks, bad_count, unknown_count, failure)
           VALUES ($1, $2, 'unknown', '[]'::jsonb, 0, 0, $3)`,
          [p.id, p.website ?? '', 'адрес не годится для проверки'],
        );
        report.push({ partner: p.name, verdict: 'unknown', bad: 0, unknown: 0 });
        continue;
      }

      const snap = await probeSite(p.website as string);
      const checks = auditSnapshot(snap);
      const { verdict, badCount, unknownCount } = summarize(checks);

      await pool.query(
        `INSERT INTO operator_site_audits
           (partner_id, site_url, verdict, checks, bad_count, unknown_count, failure)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [p.id, p.website, verdict, JSON.stringify(checks), badCount, unknownCount, snap.failure],
      );
      report.push({ partner: p.name, verdict, bad: badCount, unknown: unknownCount });
    }

    // Ноль операторов при непустом реестре — отказ, а не успех (CLAUDE.md §4.0).
    return NextResponse.json({
      success: true,
      checked: report.length,
      note: report.length === 0 ? 'ни одного оператора с сайтом не нашлось — проверять было нечего' : undefined,
      report,
    });
  } catch (err) {
    console.error('[operator-site-audit] отказ:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Проверка сайтов операторов не выполнена' }, { status: 500 });
  }
}
