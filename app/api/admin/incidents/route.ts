import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAdmin } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

const IncidentSchema = z.object({
  slug:          z.string().min(3).max(120).regex(/^[a-z0-9-]+$/),
  incident_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title:         z.string().min(5).max(500),
  location_name: z.string().min(2).max(300),
  location_type: z.enum(['volcano', 'river', 'trail', 'sea', 'glacier']),
  casualties:    z.number().int().min(0),
  injured:       z.number().int().min(0),
  description:   z.string().min(10),
  cause:         z.string().min(10),
  lessons:       z.array(z.string().min(5)).min(1).max(10),
  mchs_involved: z.boolean().default(true),
  source_url:    z.string().url().nullable().optional(),
});

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { rows } = await pool.query(
    `SELECT id, slug, incident_date, title, location_name, location_type,
            casualties, injured, description, cause, lessons,
            mchs_involved, source_url, created_at
     FROM tourist_incidents
     ORDER BY incident_date DESC`
  );
  return NextResponse.json({ success: true, data: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const body: unknown = await req.json();
  const parsed = IncidentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues }, { status: 400 });
  }

  const d = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO tourist_incidents
       (slug, incident_date, title, location_name, location_type,
        casualties, injured, description, cause, lessons, mchs_involved, source_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [d.slug, d.incident_date, d.title, d.location_name, d.location_type,
     d.casualties, d.injured, d.description, d.cause, d.lessons,
     d.mchs_involved, d.source_url ?? null]
  );
  return NextResponse.json({ success: true, data: rows[0] }, { status: 201 });
}
