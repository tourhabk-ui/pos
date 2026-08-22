/**
 * GET /api/cron/partner-junk-census — партнёры, у которых имя не имя.
 * ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод. 22.08 владелец нашёл в админке карточку «В031-00161-77/01529555» и
 * не понял, откуда она. Это номер в федеральном реестре туроператоров,
 * который разбор каталога visitkamchatka.ru принял за название компании.
 * Разбор починен (#1345), но уже сохранённые записи остались.
 *
 * Судит ТЕМ ЖЕ правилом, что импортёр: `isValidOperatorName`. Завести здесь
 * свою проверку значило бы повторить ошибку, из-за которой мусор и появился —
 * в импортёре было две разные проверки имени, и они разошлись.
 *
 * Перед удалением нужно знать не только «сколько», но и «к чему привязано»:
 * партнёр с турами или бронями — не мусор, чем бы ни было его имя. Поэтому
 * рядом с каждой записью идут счётчики.
 *
 * Наружу уходят имя, slug и флаги. Контакты (телефон, почта) НЕ отдаются:
 * ответ читают в логах Actions, а это персональные данные (152-ФЗ).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { isValidOperatorName } from '@/lib/services/ingest/visitkamchatka-operators';

export const dynamic = 'force-dynamic';

interface PartnerRow {
  id: string;
  slug: string | null;
  name: string;
  category: string;
  external_source: string | null;
  is_public: boolean | null;
  is_verified: boolean | null;
  has_user: boolean;
  tours: number;
  bookings: number;
  certifications: number;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<PartnerRow>(
      `SELECT p.id::text,
              p.slug,
              COALESCE(p.company_name, p.name) AS name,
              p.category,
              p.external_source,
              p.is_public,
              p.is_verified,
              (p.user_id IS NOT NULL)                                   AS has_user,
              (SELECT COUNT(*)::int FROM operator_tours t
                WHERE t.operator_id = p.id)                             AS tours,
              (SELECT COUNT(*)::int FROM operator_bookings b
                JOIN operator_tours t2 ON t2.id = b.operator_tour_id
               WHERE t2.operator_id = p.id)                             AS bookings,
              (SELECT COUNT(*)::int FROM guide_certifications g
                WHERE g.guide_id = p.id)                                AS certifications
         FROM partners p
        ORDER BY p.created_at NULLS LAST`,
    );

    // Правило импортёра, а не своё.
    const badName = (r: PartnerRow) => !isValidOperatorName(r.name ?? '');

    // Чем запись держится за жизнь. Порядок важен: туры — товар, брони —
    // деньги, вход — живой человек в кабинете, аттестации — собранные данные
    // о гиде. Любого из четырёх достаточно, чтобы удаление было потерей.
    const links = (r: PartnerRow) =>
      [
        r.tours > 0 ? 'tours' : null,
        r.bookings > 0 ? 'bookings' : null,
        r.has_user ? 'user' : null,
        r.certifications > 0 ? 'certifications' : null,
      ].filter(Boolean) as string[];

    const strip = (r: PartnerRow) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      category: r.category,
      source: r.external_source,
      is_public: r.is_public,
      tours: r.tours,
      bookings: r.bookings,
      certifications: r.certifications,
      links: links(r),
      bad_name: badName(r),
    });

    const byCategory: Record<string, number> = {};
    for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;

    const withTours = rows.filter((r) => r.tours > 0);
    const linkedOnly = rows.filter((r) => r.tours === 0 && links(r).length > 0);
    const orphan = rows.filter((r) => links(r).length === 0);

    return NextResponse.json({
      ok: true,
      collected_at: new Date().toISOString(),
      partners_total: rows.length,
      by_category: byCategory,
      bad_name_total: rows.filter(badName).length,

      // Товар есть — трогать нельзя ни при каких условиях.
      with_tours_count: withTours.length,
      with_tours: withTours.map(strip),

      // Туров нет, но есть брони, вход в кабинет или аттестации. Удаление
      // такого — потеря, даже если имя выглядит мусором.
      linked_count: linkedOnly.length,
      linked: linkedOnly.map(strip),

      // Ни к чему не привязаны. Только это — настоящие кандидаты на удаление.
      orphan_count: orphan.length,
      orphan_bad_name: orphan.filter(badName).length,
      orphan_sample: orphan.slice(0, 25).map(strip),
    });
  } catch (err) {
    // Третий исход: не смог посчитать — это не «мусора нет».
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[partner-junk-census] перепись не выполнена:', message);
    return NextResponse.json({ ok: false, reason: message }, { status: 500 });
  }
}
