import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { callGeminiPDF } from '@/lib/ai/providers';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const EXTRACT_PROMPT = `Ты извлекаешь данные из паспорта маршрута на Камчатке (PDF на русском языке).
Верни JSON строго в этом формате (без markdown, только JSON):
{
  "description": "подробное описание маршрута 200-600 символов",
  "distance_km": число или null,
  "elevation_gain_m": целое или null,
  "duration_hours": число или null,
  "duration_days": целое или null,
  "difficulty": "easy" | "medium" | "hard" | "expert" | null,
  "season": "summer" | "winter" | "all" | null,
  "route_type": "radial" | "linear" | "loop" | null,
  "hazards": ["перечень опасностей из документа"] или [],
  "equipment": ["перечень снаряжения из документа"] или [],
  "mchs_registration_required": true | false,
  "mchs_phone": "номер телефона МЧС или null",
  "park_name": "название природного парка или null",
  "park_approval_url": "URL согласования или null",
  "flora_fauna": "краткое описание флоры и фауны или null",
  "accessibility": "описание доступности или null"
}
Правила: если данных нет — null, не выдумывай. difficulty: лёгкий→easy, средний→medium, сложный→hard, для опытных→expert.`;

interface RouteRow {
  id: number;
  title: string;
  source_url: string;
}

interface ExtractedData {
  description?: string;
  distance_km?: number | null;
  elevation_gain_m?: number | null;
  duration_hours?: number | null;
  duration_days?: number | null;
  difficulty?: string | null;
  season?: string | null;
  route_type?: string | null;
  hazards?: string[];
  equipment?: string[];
  mchs_registration_required?: boolean;
  mchs_phone?: string | null;
  park_name?: string | null;
  park_approval_url?: string | null;
  flora_fauna?: string | null;
  accessibility?: string | null;
}

async function fetchPdfBase64(url: string): Promise<string | null> {
  try {
    // Try direct fetch first (PDFs on govt sites usually accessible)
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      return Buffer.from(buf).toString('base64');
    }
  } catch { /* fall through to BrightData */ }

  // Fallback: BrightData for protected PDFs
  try {
    const html = await fetchViaBrightData(url);
    if (html && html.length > 1000) {
      // BrightData returned content as string — treat as binary
      return Buffer.from(html, 'binary').toString('base64');
    }
  } catch { /* give up */ }

  return null;
}

function parseExtracted(raw: string): ExtractedData | null {
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const data = JSON.parse(clean) as ExtractedData;
    // Validate difficulty enum
    const DIFF = ['easy', 'medium', 'hard', 'expert'];
    if (data.difficulty && !DIFF.includes(data.difficulty)) data.difficulty = null;
    const SEASON = ['summer', 'winter', 'all'];
    if (data.season && !SEASON.includes(data.season)) data.season = null;
    const RTYPE = ['radial', 'linear', 'loop'];
    if (data.route_type && !RTYPE.includes(data.route_type)) data.route_type = null;
    return data;
  } catch { return null; }
}

const QuerySchema = z.object({
  batch: z.coerce.number().min(1).max(20).default(5),
  dry_run: z.coerce.boolean().default(false),
  offset: z.coerce.number().min(0).default(0),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = QuerySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Bad params' }, { status: 400 });

  const { batch, dry_run, offset } = parsed.data;

  // Find routes with PDF passport URLs that still need enrichment
  const { rows: routes } = await pool.query<RouteRow>(
    `SELECT id, title, source_url
     FROM kamchatka_routes
     WHERE source_url LIKE '%route_passports%'
       AND (
         distance_km IS NULL
         OR elevation_gain_m IS NULL
         OR (description IS NULL OR LENGTH(description) < 150)
         OR hazards IS NULL
       )
     ORDER BY id
     LIMIT $1 OFFSET $2`,
    [batch, offset],
  );

  if (routes.length === 0) {
    return NextResponse.json({ ok: true, message: 'No routes need PDF extraction', processed: 0 });
  }

  const results: Array<{ id: number; title: string; status: string; fields?: string[] }> = [];

  for (const route of routes) {
    if (dry_run) {
      results.push({ id: route.id, title: route.title, status: 'would_process' });
      continue;
    }

    const pdfBase64 = await fetchPdfBase64(route.source_url);
    if (!pdfBase64) {
      results.push({ id: route.id, title: route.title, status: 'pdf_fetch_failed' });
      continue;
    }

    const raw = await callGeminiPDF(pdfBase64, EXTRACT_PROMPT);
    if (!raw) {
      results.push({ id: route.id, title: route.title, status: 'gemini_failed' });
      continue;
    }

    const data = parseExtracted(raw);
    if (!data) {
      results.push({ id: route.id, title: route.title, status: 'parse_failed' });
      continue;
    }

    const updated: string[] = [];

    await pool.query(
      `UPDATE kamchatka_routes SET
         description           = COALESCE(NULLIF($2, ''), description),
         distance_km           = COALESCE($3::numeric,   distance_km),
         elevation_gain_m      = COALESCE($4::int,       elevation_gain_m),
         duration_hours        = COALESCE($5::numeric,   duration_hours),
         duration_days         = COALESCE($6::int,       duration_days),
         difficulty            = COALESCE(NULLIF($7,''), difficulty),
         season                = COALESCE(NULLIF($8,''), season),
         route_type            = COALESCE(NULLIF($9,''), route_type),
         hazards               = CASE WHEN $10::text[] IS NOT NULL AND array_length($10::text[],1) > 0
                                      THEN $10::text[] ELSE hazards END,
         equipment             = CASE WHEN $11::text[] IS NOT NULL AND array_length($11::text[],1) > 0
                                      THEN $11::text[] ELSE equipment END,
         mchs_registration_required = COALESCE($12::boolean, mchs_registration_required),
         mchs_phone            = COALESCE(NULLIF($13,''), mchs_phone),
         park_name             = COALESCE(NULLIF($14,''), park_name),
         park_approval_url     = COALESCE(NULLIF($15,''), park_approval_url),
         flora_fauna           = COALESCE(NULLIF($16,''), flora_fauna),
         accessibility         = COALESCE(NULLIF($17,''), accessibility),
         updated_at            = NOW()
       WHERE id = $1`,
      [
        route.id,
        data.description ?? null,
        data.distance_km ?? null,
        data.elevation_gain_m ?? null,
        data.duration_hours ?? null,
        data.duration_days ?? null,
        data.difficulty ?? null,
        data.season ?? null,
        data.route_type ?? null,
        data.hazards?.length ? data.hazards : null,
        data.equipment?.length ? data.equipment : null,
        data.mchs_registration_required ?? null,
        data.mchs_phone ?? null,
        data.park_name ?? null,
        data.park_approval_url ?? null,
        data.flora_fauna ?? null,
        data.accessibility ?? null,
      ],
    );

    if (data.description)              updated.push('description');
    if (data.distance_km)              updated.push('distance_km');
    if (data.elevation_gain_m)         updated.push('elevation_gain_m');
    if (data.duration_hours)           updated.push('duration_hours');
    if (data.hazards?.length)          updated.push('hazards');
    if (data.equipment?.length)        updated.push('equipment');
    if (data.mchs_registration_required !== undefined) updated.push('mchs');
    if (data.park_name)                updated.push('park_name');

    results.push({ id: route.id, title: route.title, status: 'ok', fields: updated });
  }

  const ok    = results.filter(r => r.status === 'ok').length;
  const fails = results.filter(r => r.status !== 'ok' && r.status !== 'would_process').length;

  return NextResponse.json({
    ok: true,
    processed: results.length,
    enriched: ok,
    failed: fails,
    dry_run,
    results,
  });
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { rows } = await pool.query<{
    total: string;
    has_pdf: string;
    needs_extraction: string;
    has_description: string;
    has_distance: string;
    has_geometry: string;
  }>(
    `SELECT
       COUNT(*)::text                                                                      AS total,
       COUNT(*) FILTER (WHERE source_url LIKE '%route_passports%')::text                  AS has_pdf,
       COUNT(*) FILTER (
         WHERE source_url LIKE '%route_passports%'
           AND (distance_km IS NULL OR elevation_gain_m IS NULL
                OR description IS NULL OR LENGTH(description) < 150)
       )::text                                                                             AS needs_extraction,
       COUNT(*) FILTER (WHERE description IS NOT NULL AND LENGTH(description) >= 150)::text AS has_description,
       COUNT(*) FILTER (WHERE distance_km IS NOT NULL)::text                              AS has_distance,
       COUNT(*) FILTER (WHERE geometry IS NOT NULL)::text                                 AS has_geometry
     FROM kamchatka_routes
     WHERE is_visible = true OR is_visible IS NULL`,
  );

  return NextResponse.json({ stats: rows[0] });
}
