/**
 * GET /api/public/danger-summary
 * Публичный. Риск по зонам Камчатки из danger_assessments.
 * Без персональных данных — только агрегат.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface ZoneRow {
  zone: string;
  risk_score: number;
  risk_level: string;
  recommended_action: string;
  analysis_text: string | null;
  threat_types: string[];
  updated_at: string;
}

export async function GET() {
  try {
    const { rows } = await pool.query<ZoneRow>(`
      SELECT DISTINCT ON (zone)
        zone,
        risk_score,
        risk_level,
        recommended_action,
        analysis_text,
        COALESCE(threat_types, ARRAY[]::TEXT[]) AS threat_types,
        updated_at::text
      FROM danger_assessments
      WHERE expires_at > NOW()
      ORDER BY zone, updated_at DESC
    `);

    const ZONE_NAMES: Record<string, string> = {
      avachinsky: 'Авачинско-Петропавловский',
      northern:   'Северная Камчатка',
      eastern:    'Восточное побережье',
      western:    'Западное побережье',
    };

    const zones = rows.map(r => ({
      ...r,
      zone_name: ZONE_NAMES[r.zone] ?? r.zone,
    }));

    return NextResponse.json({ zones, updatedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ zones: [], updatedAt: null });
  }
}
