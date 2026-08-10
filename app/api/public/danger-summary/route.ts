/**
 * GET /api/public/danger-summary
 * Публичный. Риск по зонам Камчатки из danger_assessments.
 * Без персональных данных — только агрегат.
 *
 * Роут селектил `updated_at`, которого в danger_assessments нет никогда не
 * было (миграция 069: assessed_at и created_at). Запрос падал, catch отдавал
 * `{zones: [], updatedAt: null}`, а страница /safety при пустом списке просто
 * не рисует блок зон. Снаружи это выглядело как «оценка спокойная» — на самом
 * деле оценки не было вовсе, и узнать об этом было неоткуда.
 *
 * Отсюда два правила этого файла:
 *  1. Время берётся из данных (`assessed_at` последней оценки), а не из часов
 *     сервера. `new Date()` в ответе означал бы «данные свежие» всегда, даже
 *     когда последней оценке сутки.
 *  2. Сбой не выдаётся за пустоту. Пустой список и упавший запрос — разные
 *     вещи, и клиент обязан их различать: молчащий датчик не равен тишине.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { zoneName } from '@/lib/safety/zone-names';

export const dynamic = 'force-dynamic';

interface ZoneRow {
  zone: string;
  risk_score: number;
  risk_level: string;
  recommended_action: string;
  analysis_text: string | null;
  threat_types: string[];
  assessed_at: string;
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
        assessed_at::text
      FROM danger_assessments
      WHERE expires_at > NOW()
      ORDER BY zone, assessed_at DESC
    `);

    const zones = rows.map(r => ({
      ...r,
      // Прежнее имя поля оставлено: им пользуются готовые клиенты.
      updated_at: r.assessed_at,
      zone_name: zoneName(r.zone),
    }));

    // Самая свежая из оценок — это и есть возраст всего ответа.
    const updatedAt = zones.reduce<string | null>(
      (newest, z) => (newest === null || z.assessed_at > newest ? z.assessed_at : newest),
      null
    );

    return NextResponse.json({ ok: true, zones, updatedAt });
  } catch {
    // Подробности наружу не выносим — публичный роут. Но и спокойствия не
    // обещаем: ok: false говорит клиенту, что зоны неизвестны, а не безопасны.
    return NextResponse.json({ ok: false, zones: [], updatedAt: null }, { status: 503 });
  }
}
