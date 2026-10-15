/**
 * GET /api/cron/place-eco-census — что карточка места говорит о режиме
 * охраняемой территории и на чём это держится. Bearer CRON_SECRET, только
 * чтение, ничего не меняет.
 *
 * ЗАЧЕМ (15.10, §0 «честность»). Режим места завели миграции 169 и 170 одним
 * проходом по ILIKE: «кроноцк» в имени или описании — заповедник с пропуском
 * kronoki.ru; «unesco» в описании — объект ЮНЕСКО с тем же пропуском; всем
 * остальным видимым — `none`. Каждому роду — один абзац правил. 1273 сняла
 * абзацы-шаблоны в архив; какой режим и какой пропуск остались у мест, и
 * сколько их держится на том же ILIKE, не знал никто.
 *
 * Перепись СЧИТАЕТ и больше ничего не делает: вердикт по месту выносит
 * человек, сверив режим с положением о территории. Правила 1240–1257,
 * написанные по источникам, она от шаблонных не отличает — их отличает
 * архив (1273), а не догадка по тексту.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ZoneRow {
  eco_zone: string | null;
  places: string;
  permit_true: string;
  permit_false: string;
  permit_null: string;
  rules_present: string;
  rules_withdrawn: string;
}
interface PermitUrlRow { eco_zone: string | null; eco_permit_url: string | null; places: string }
interface TemplateZoneRow { id: string; name: string; eco_zone: string | null; eco_permit_required: boolean | null; eco_permit_url: string | null }
interface UnrecordedRow { id: string; name: string; lat: string | null; lng: string | null; eco_zone: string | null }

/** Сколько мест без режима отдаётся поимённо: сейчас их около 260. */
const UNRECORDED_LIMIT = 500;

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const visible = `p.is_visible = TRUE AND p.merged_into_id IS NULL`;
    const [byZone, byPermitUrl, templateZone, unrecorded] = await Promise.all([
      pool.query<ZoneRow>(
        `SELECT p.eco_zone,
                COUNT(*)::text AS places,
                COUNT(*) FILTER (WHERE p.eco_permit_required IS TRUE)::text  AS permit_true,
                COUNT(*) FILTER (WHERE p.eco_permit_required IS FALSE)::text AS permit_false,
                COUNT(*) FILTER (WHERE p.eco_permit_required IS NULL)::text  AS permit_null,
                COUNT(*) FILTER (WHERE p.eco_rules IS NOT NULL AND btrim(p.eco_rules) <> '')::text AS rules_present,
                COUNT(*) FILTER (WHERE p.eco_rules_withdrawn IS NOT NULL)::text AS rules_withdrawn
           FROM places p
          WHERE ${visible}
          GROUP BY p.eco_zone
          ORDER BY COUNT(*) DESC`,
      ),
      pool.query<PermitUrlRow>(
        `SELECT p.eco_zone, p.eco_permit_url, COUNT(*)::text AS places
           FROM places p
          WHERE ${visible} AND p.eco_permit_url IS NOT NULL
          GROUP BY p.eco_zone, p.eco_permit_url
          ORDER BY COUNT(*) DESC
          LIMIT 30`,
      ),
      // Места, чей режим пришёл вместе с шаблоном 169/170: их правила 1273
      // сняла как шаблон, значит и род территории, и пропуск им ставил тот же
      // ILIKE. Поимённо — для сверки с положением каждой территории.
      pool.query<TemplateZoneRow>(
        `SELECT p.id::text AS id, p.name, p.eco_zone, p.eco_permit_required, p.eco_permit_url
           FROM places p
          WHERE ${visible} AND p.eco_rules_withdrawn IS NOT NULL
          ORDER BY p.eco_zone, p.name
          LIMIT 50`,
      ),
      // Места без записанного режима — с точкой, для сверки с контурами
      // охраняемых территорий (15.10, перепись по схеме парков). 'none'
      // проставила миграция 170 всем оставшимся видимым местам одним UPDATE,
      // без сверки, поэтому оно здесь наравне с «не записано».
      pool.query<UnrecordedRow>(
        `SELECT p.id::text AS id, p.name, p.lat::text AS lat, p.lng::text AS lng, p.eco_zone
           FROM places p
          WHERE ${visible} AND (p.eco_zone IS NULL OR p.eco_zone = 'none')
          ORDER BY p.lat DESC, p.lng, p.name
          LIMIT ${UNRECORDED_LIMIT}`,
      ),
    ]);

    return NextResponse.json({
      ok: true,
      checked_at: new Date().toISOString(),
      visible_places_by_zone: byZone.rows.map((r) => ({
        eco_zone: r.eco_zone,
        places: Number(r.places),
        permit: { required: Number(r.permit_true), not_required: Number(r.permit_false), not_recorded: Number(r.permit_null) },
        rules_present: Number(r.rules_present),
        rules_withdrawn: Number(r.rules_withdrawn),
      })),
      permit_urls: byPermitUrl.rows.map((r) => ({ eco_zone: r.eco_zone, url: r.eco_permit_url, places: Number(r.places) })),
      template_zone_places: templateZone.rows.map((r) => ({
        id: r.id, name: r.name, eco_zone: r.eco_zone, permit_required: r.eco_permit_required, permit_url: r.eco_permit_url,
      })),
      regime_unrecorded: {
        // Отрезано по пределу — сказано, а не умолчано (§4.0).
        truncated: unrecorded.rows.length >= UNRECORDED_LIMIT,
        places: unrecorded.rows.map((r) => ({
          id: r.id,
          name: r.name,
          lat: r.lat != null ? Number(r.lat) : null,
          lng: r.lng != null ? Number(r.lng) : null,
          zone: r.eco_zone,
        })),
      },
    });
  } catch (err) {
    // Отказ называется вслух: «переписи нет» не равно «режимов нет» (§4.0).
    const code = (err as { code?: string }).code;
    console.error('[place-eco-census] перепись не выполнилась:', code ?? (err instanceof Error ? err.message : err));
    return NextResponse.json({ ok: false, error: 'перепись не выполнилась', sqlstate: code ?? null }, { status: 500 });
  }
}
