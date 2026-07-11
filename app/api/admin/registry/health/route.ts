/**
 * GET /api/admin/registry/health — метрика сверки операторов с официальным
 * реестром visitkamchatka.ru/registry/ (issue #368).
 *
 * Показывает: сколько наших операторов подтверждено реестром, сколько не
 * найдено / с расхождениями, насколько свеж снимок реестра, и лид-лист
 * acquisition (операторы из реестра, которых у нас нет).
 *
 * READ-ONLY. Auth: requireAdmin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

const STALE_DAYS = 30;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const partners = await query<{
      total: string;
      verified: string;
      not_found: string;
      mismatch: string;
      unknown: string;
      stale: string;
    }>(
      `SELECT
         COUNT(*)                                                    AS total,
         COUNT(*) FILTER (WHERE registry_status = 'verified')        AS verified,
         COUNT(*) FILTER (WHERE registry_status = 'not_found')       AS not_found,
         COUNT(*) FILTER (WHERE registry_status = 'mismatch')        AS mismatch,
         COUNT(*) FILTER (WHERE registry_status = 'unknown')         AS unknown,
         COUNT(*) FILTER (
           WHERE registry_checked_at IS NULL
              OR registry_checked_at < NOW() - ($1 || ' days')::interval
         )                                                           AS stale
       FROM partners`,
      [String(STALE_DAYS)],
    );

    const snapshot = await query<{ total: string; last_scraped: string | null; matched: string }>(
      `SELECT
         COUNT(*)                                              AS total,
         MAX(scraped_at)                                       AS last_scraped,
         COUNT(*) FILTER (WHERE matched_partner_id IS NOT NULL) AS matched
       FROM official_registry_operators`,
    );

    const leads = await query<{
      id: string;
      name: string;
      inn: string | null;
      registry_number: string | null;
      region: string | null;
      registry_status: string | null;
      source_url: string | null;
    }>(
      `SELECT id, name, inn, registry_number, region, registry_status, source_url
       FROM official_registry_operators
       WHERE matched_partner_id IS NULL
       ORDER BY name
       LIMIT 50`,
    );

    const p = partners.rows[0];
    const snap = snapshot.rows[0];
    const registryTotal = Number(snap?.total ?? 0);
    const acquisitionLeads = registryTotal - Number(snap?.matched ?? 0);

    return NextResponse.json({
      status: registryTotal === 0 ? 'degraded' : 'ok',
      reason:
        registryTotal === 0
          ? 'Снимок реестра пуст — скрипт scrape-registry-visitkamchatka.js ещё не прогонялся'
          : undefined,
      partners: {
        total: Number(p?.total ?? 0),
        verified: Number(p?.verified ?? 0),
        not_found: Number(p?.not_found ?? 0),
        mismatch: Number(p?.mismatch ?? 0),
        unknown: Number(p?.unknown ?? 0),
        stale: Number(p?.stale ?? 0),
      },
      registry: {
        total: registryTotal,
        matched: Number(snap?.matched ?? 0),
        last_scraped_at: snap?.last_scraped ?? null,
      },
      acquisition_leads_count: acquisitionLeads,
      acquisition_leads_sample: leads.rows.map((r) => ({
        id: r.id,
        name: r.name,
        inn: r.inn,
        registry_number: r.registry_number,
        region: r.region,
        registry_status: r.registry_status,
        source_url: r.source_url,
      })),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { status: 'error', error: 'Ошибка расчёта метрики реестра', detail: msg },
      { status: 500 },
    );
  }
}
