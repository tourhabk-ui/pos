import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { callGeminiPDF } from '@/lib/ai/providers';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

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
  "hazards": ["перечень опасностей"] или [],
  "equipment": ["перечень снаряжения"] или [],
  "mchs_registration_required": true | false,
  "mchs_phone": "номер телефона МЧС или null",
  "park_name": "название природного парка или null",
  "park_approval_url": "URL согласования или null",
  "flora_fauna": "краткое описание флоры и фауны или null",
  "accessibility": "описание доступности или null"
}
Правила: если данных нет — null, не выдумывай. difficulty: лёгкий→easy, средний→medium, сложный→hard, для опытных→expert.`;

interface RouteRow { id: number; title: string; source_url: string }

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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch { /* fall through */ }
  try {
    const html = await fetchViaBrightData(url);
    if (html && html.length > 1000) return Buffer.from(html, 'binary').toString('base64');
  } catch { /* give up */ }
  return null;
}

function parseExtracted(raw: string): ExtractedData | null {
  try {
    const data = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()) as ExtractedData;
    if (data.difficulty && !['easy','medium','hard','expert'].includes(data.difficulty)) data.difficulty = null;
    if (data.season    && !['summer','winter','all'].includes(data.season))             data.season = null;
    if (data.route_type && !['radial','linear','loop'].includes(data.route_type))       data.route_type = null;
    return data;
  } catch { return null; }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const batch  = Math.min(parseInt(searchParams.get('batch')  ?? '5',  10), 15);
  const offset = Math.max(parseInt(searchParams.get('offset') ?? '0',  10), 0);

  const { rows: routes } = await pool.query<RouteRow>(
    `SELECT id, title, source_url
     FROM kamchatka_routes
     WHERE source_url LIKE '%route_passports%'
       AND (
         distance_km IS NULL
         OR elevation_gain_m IS NULL
         OR description IS NULL
         OR LENGTH(description) < 150
         OR hazards IS NULL
       )
     ORDER BY id
     LIMIT $1 OFFSET $2`,
    [batch, offset],
  );

  // Count total remaining
  const { rows: countRows } = await pool.query<{ remaining: string }>(
    `SELECT COUNT(*)::text AS remaining
     FROM kamchatka_routes
     WHERE source_url LIKE '%route_passports%'
       AND (distance_km IS NULL OR elevation_gain_m IS NULL
            OR description IS NULL OR LENGTH(description) < 150 OR hazards IS NULL)`,
  );
  const remaining = Number(countRows[0]?.remaining ?? 0);

  if (routes.length === 0) {
    return NextResponse.json({ ok: true, message: 'All routes already enriched', remaining: 0, enriched: 0 });
  }

  const results: Array<{ id: number; title: string; status: string }> = [];

  for (const route of routes) {
    const pdfBase64 = await fetchPdfBase64(route.source_url);
    if (!pdfBase64) { results.push({ id: route.id, title: route.title, status: 'pdf_failed' }); continue; }

    const raw = await callGeminiPDF(pdfBase64, EXTRACT_PROMPT);
    if (!raw) { results.push({ id: route.id, title: route.title, status: 'gemini_failed' }); continue; }

    const data = parseExtracted(raw);
    if (!data) { results.push({ id: route.id, title: route.title, status: 'parse_failed' }); continue; }

    await pool.query(
      `UPDATE kamchatka_routes SET
         description           = COALESCE(NULLIF($2,''), description),
         distance_km           = COALESCE($3::numeric,  distance_km),
         elevation_gain_m      = COALESCE($4::int,      elevation_gain_m),
         duration_hours        = COALESCE($5::numeric,  duration_hours),
         duration_days         = COALESCE($6::int,      duration_days),
         difficulty            = COALESCE(NULLIF($7,''), difficulty),
         season                = COALESCE(NULLIF($8,''), season),
         route_type            = COALESCE(NULLIF($9,''), route_type),
         hazards               = CASE WHEN $10::text[] IS NOT NULL AND array_length($10::text[],1)>0
                                      THEN $10::text[] ELSE hazards END,
         equipment             = CASE WHEN $11::text[] IS NOT NULL AND array_length($11::text[],1)>0
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
        data.description ?? null, data.distance_km ?? null, data.elevation_gain_m ?? null,
        data.duration_hours ?? null, data.duration_days ?? null, data.difficulty ?? null,
        data.season ?? null, data.route_type ?? null,
        data.hazards?.length ? data.hazards : null,
        data.equipment?.length ? data.equipment : null,
        data.mchs_registration_required ?? null, data.mchs_phone ?? null,
        data.park_name ?? null, data.park_approval_url ?? null,
        data.flora_fauna ?? null, data.accessibility ?? null,
      ],
    );

    results.push({ id: route.id, title: route.title, status: 'ok' });
  }

  const enriched = results.filter(r => r.status === 'ok').length;
  return NextResponse.json({
    ok: true,
    enriched,
    failed: results.length - enriched,
    remaining: remaining - enriched,
    next_offset: offset + batch,
    results,
  });
}
