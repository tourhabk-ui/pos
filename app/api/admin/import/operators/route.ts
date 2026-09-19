/**
 * POST /api/admin/import/operators
 *
 * Три действия в одном endpoint:
 *   scrape_operators — парсит visitkamchatka.ru/tour-operators/ → partners
 *   scrape_tours     — парсит tours.visitkamchatka.ru/tours → operator_tours + tour_availability
 *
 * Auth: requireAdmin
 * Timeweb cron или ручной запуск из /hub/admin
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { scrapeOperatorDirectory } from '@/lib/services/ingest/visitkamchatka-operators';
import { scrapeGuideDirectory } from '@/lib/services/ingest/visitkamchatka-guides';
import { auditVisitKamchatka } from '@/lib/services/ingest/visitkamchatka-audit';
import { scrapeTourMarketplace, debugFetchTours } from '@/lib/services/tours/tours-visitkamchatka';
import { scrapeOperatorTours } from '@/lib/services/operators/operator-tour-scraper';
import { fetchViaBrightData, diagnoseBrightData } from '@/lib/scraping/brightdata';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BodySchema = z.object({
  action: z.enum(['scrape_operators', 'scrape_guides', 'scrape_tours', 'scrape_tours_per_operator', 'debug_fetch', 'debug_fetch_tours', 'audit_site', 'diagnose_brightdata']),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  activity: z.string().optional(),
  categories: z.array(z.string()).optional(),
  operator_slug: z.string().optional(),
  dry_run: z.boolean().optional(),
  max_operators: z.number().int().min(1).max(50).optional(),
  section_key: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation error', details: parsed.error.flatten() }, { status: 400 });
  }

  const { action, date_from, date_to, activity,
          categories, operator_slug, dry_run, max_operators, section_key } = parsed.data;
  const t0 = Date.now();

  try {
    if (action === 'scrape_operators') {
      const result = await scrapeOperatorDirectory();
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    if (action === 'scrape_tours_per_operator') {
      const result = await scrapeOperatorTours({
        categories,
        operatorSlug: operator_slug,
        dryRun: dry_run,
        maxOperators: max_operators,
      });
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    if (action === 'scrape_guides') {
      const result = await scrapeGuideDirectory();
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    if (action === 'scrape_tours') {
      const result = await scrapeTourMarketplace({
        dateFrom: date_from,
        dateTo: date_to,
        activity,
      });
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    if (action === 'debug_fetch') {
      const url = 'https://visitkamchatka.ru/tour-operators/';
      const html = await fetchViaBrightData(url, { country: 'ru', timeoutMs: 30_000 });
      const classes = html
        ? [...new Set(Array.from(html.matchAll(/class="([^"]+)"/g)).flatMap(m => m[1].split(/\s+/)).filter(c => c.length > 2))]
        : [];
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        html_fetched: !!html,
        html_length: html?.length ?? 0,
        html_preview: html?.slice(0, 3000) ?? null,
        top_classes: classes.slice(0, 30),
      });
    }

    if (action === 'diagnose_brightdata') {
      const diag = await diagnoseBrightData();
      return NextResponse.json({
        ok: diag.reachable,
        action,
        duration_ms: Date.now() - t0,
        ...diag,
      });
    }

    if (action === 'audit_site') {
      const audit = await auditVisitKamchatka(section_key ? [section_key] : undefined);
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...audit,
      });
    }

    if (action === 'debug_fetch_tours') {
      const debug = await debugFetchTours();
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...debug,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg, duration_ms: Date.now() - t0 }, { status: 500 });
  }
}
