import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface IncidentRow {
  id: number;
  slug: string;
  incident_date: string;
  title: string;
  location_name: string;
  location_type: string;
  casualties: number;
  injured: number;
  description: string;
  cause: string;
  lessons: string[];
  mchs_involved: boolean;
  source_url: string | null;
}

export async function GET(_req: NextRequest) {
  const { rows } = await pool.query<IncidentRow>(
    `SELECT id, slug, incident_date, title, location_name, location_type,
            casualties, injured, description, cause, lessons, mchs_involved, source_url
     FROM tourist_incidents
     ORDER BY incident_date DESC`
  );

  return NextResponse.json({ success: true, data: rows });
}
