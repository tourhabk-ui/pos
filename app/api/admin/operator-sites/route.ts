/**
 * GET /api/admin/operator-sites
 *
 * Последний отчёт проверки сайта по каждому оператору — для экрана владельца.
 *
 * Проверка без поверхности ничего не говорит никому: отчёты ложились бы в
 * operator_site_audits каждую ночь, и первым, кто их увидел бы, был psql.
 * Это тот же дефект, что мы правили весь день, только с другой стороны:
 * не «зелёное вместо неизвестного», а «известное, о котором не сказали».
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import type { CheckResult } from '@/lib/security/site-audit';

export const dynamic = 'force-dynamic';

interface Row {
  partner_id: string;
  partner_name: string;
  site_url: string | null;
  consent: string;
  checked_at: string | null;
  verdict: string | null;
  checks: CheckResult[] | null;
  bad_count: number | null;
  unknown_count: number | null;
  failure: string | null;
}

export async function GET(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  try {
    // DISTINCT ON — последний отчёт по каждому оператору. LEFT JOIN, потому что
    // ни разу не проверенный обязан быть В СПИСКЕ и виден как непроверенный:
    // выпав из выборки, он выглядел бы как отсутствующий, а не как неизвестный.
    const { rows } = await pool.query<Row>(
      `SELECT p.id                AS partner_id,
              p.name              AS partner_name,
              p.website           AS site_url,
              p.site_audit_consent AS consent,
              a.checked_at, a.verdict, a.checks, a.bad_count, a.unknown_count, a.failure
         FROM partners p
         LEFT JOIN LATERAL (
           SELECT checked_at, verdict, checks, bad_count, unknown_count, failure
             FROM operator_site_audits s
            WHERE s.partner_id = p.id
            ORDER BY s.checked_at DESC
            LIMIT 1
         ) a ON TRUE
        WHERE p.website IS NOT NULL AND p.website <> ''
        ORDER BY
          -- Сначала то, что требует внимания: плохое, затем непроверенное,
          -- затем благополучное. Список, отсортированный по имени, читают
          -- сверху и бросают на середине.
          CASE a.verdict WHEN 'issues' THEN 1 WHEN 'unknown' THEN 2 WHEN 'ok' THEN 4 ELSE 3 END,
          a.bad_count DESC NULLS LAST,
          p.name ASC
        LIMIT 200`,
    );

    const items = rows.map((r) => ({
      partnerId: r.partner_id,
      name: r.partner_name,
      siteUrl: r.site_url,
      consent: r.consent,
      // Никогда не проверявшийся — это состояние, а не пустая строка.
      checkedAt: r.checked_at,
      verdict: r.checked_at ? r.verdict : 'never',
      checks: Array.isArray(r.checks) ? r.checks : [],
      badCount: r.bad_count ?? 0,
      unknownCount: r.unknown_count ?? 0,
      failure: r.failure,
    }));

    return NextResponse.json({
      success: true,
      total: items.length,
      // Сводка считается здесь, а не на клиенте: два счёта одного и того же
      // разъезжаются — это мы уже проходили.
      summary: {
        issues: items.filter((i) => i.verdict === 'issues').length,
        unknown: items.filter((i) => i.verdict === 'unknown').length,
        never: items.filter((i) => i.verdict === 'never').length,
        ok: items.filter((i) => i.verdict === 'ok').length,
      },
      items,
    });
  } catch (err) {
    // Пустой catch превратил бы поломку в «операторов нет».
    console.error('[admin/operator-sites] отказ:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось прочитать отчёты проверки сайтов' },
      { status: 500 },
    );
  }
}
