/**
 * POST /api/tools/safety
 * Анализ безопасности места: данные из БД + краткий синтез Кузьмича.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { callAIFast } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

const BodySchema = z.union([
  z.object({ placeId: z.string() }),
  z.object({
    lat: z.number().min(50).max(58),
    lng: z.number().min(155).max(165),
  }),
]);

const HAZARD_LABELS: Record<string, string> = {
  bears: 'Медведи',
  wildlife: 'Дикие животные',
  avalanche: 'Лавины',
  rockfall: 'Камнепад',
  thermal: 'Термальные зоны',
  volcanic_gas: 'Вулканические газы',
  altitude: 'Высота',
  ice: 'Лёд / гололёд',
  weather: 'Непогода',
  river_crossing: 'Переправа',
  fog: 'Туман',
  no_signal: 'Нет связи',
};

function computeRiskScore(
  hazards: string[],
  alertSeverity: number | null,
  difficultyLevel: number | null,
): number {
  let score = 1;
  if (alertSeverity != null) score = Math.max(score, Math.min(5, alertSeverity + 1));
  const dangerousHazards = ['volcanic_gas', 'avalanche'];
  if (hazards.some(h => dangerousHazards.includes(h))) score = Math.max(score, 3);
  if (hazards.includes('bears')) score = Math.max(score, 2);
  if (difficultyLevel != null && difficultyLevel >= 4) score = Math.max(score, 3);
  return score;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Нужен placeId или координаты lat/lng' }, { status: 400 });
  }

  const data = parsed.data;

  try {
    const params: unknown[] = 'placeId' in data ? [data.placeId] : [data.lat, data.lng];

    const sql = 'placeId' in data
      ? `SELECT
           p.id, p.name, p.location_type, p.description,
           p.lat, p.lng,
           sp.hazard_types, sp.difficulty_level, sp.altitude_m,
           sp.nearest_medical_km, sp.sat_communicator_required,
           sp.registration_required,
           rs.is_open, rs.current_crowds, rs.alert_severity,
           rs.alert_message, rs.active_alerts
         FROM places p
         LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
         LEFT JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
         WHERE p.id = $1
         LIMIT 1`
      : `SELECT
           p.id, p.name, p.location_type, p.description,
           p.lat, p.lng,
           sp.hazard_types, sp.difficulty_level, sp.altitude_m,
           sp.nearest_medical_km, sp.sat_communicator_required,
           sp.registration_required,
           rs.is_open, rs.current_crowds, rs.alert_severity,
           rs.alert_message, rs.active_alerts
         FROM places p
         LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
         LEFT JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
         WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
         ORDER BY ((p.lat::float - $1)^2 + (p.lng::float - $2)^2) ASC
         LIMIT 1`;

    const result = await query(sql, params);

    if (!result.rows.length) {
      return NextResponse.json({ success: false, error: 'Место не найдено' }, { status: 404 });
    }

    const r = result.rows[0];
    const hazards: string[] = Array.isArray(r.hazard_types) ? (r.hazard_types as string[]) : [];
    const alertSeverity = r.alert_severity != null ? Number(r.alert_severity) : null;
    const difficultyLevel = r.difficulty_level != null ? Number(r.difficulty_level) : null;
    const riskScore = computeRiskScore(hazards, alertSeverity, difficultyLevel);

    const contextParts: string[] = [
      `МЕСТО: ${r.name as string} (тип: ${(r.location_type as string | null) ?? 'неизвестно'})`,
    ];
    if (r.altitude_m) contextParts.push(`ВЫСОТА: ${r.altitude_m} м`);
    if (hazards.length) contextParts.push(`ОПАСНОСТИ: ${hazards.map(h => HAZARD_LABELS[h] ?? h).join(', ')}`);
    if (difficultyLevel != null) contextParts.push(`СЛОЖНОСТЬ ДОСТУПА: ${difficultyLevel}/5`);
    if (r.nearest_medical_km != null) contextParts.push(`БЛИЖАЙШАЯ МЕДПОМОЩЬ: ${r.nearest_medical_km} км`);
    if (r.sat_communicator_required) contextParts.push('Спутниковая связь: рекомендуется');
    if (r.registration_required) contextParts.push('Регистрация в МЧС: обязательна');
    if (alertSeverity != null && alertSeverity > 0) {
      contextParts.push(`ТЕКУЩИЙ АЛЕРТ (уровень ${alertSeverity}/4): ${(r.alert_message as string | null) ?? 'повышенная осторожность'}`);
    }

    const messages = [
      {
        role: 'system' as const,
        content: 'Ты Кузьмич — опытный гид по Камчатке. Давай честные, конкретные оценки безопасности. Говори прямо о реальных рисках. Отвечай ТОЛЬКО валидным JSON без markdown-блоков.',
      },
      {
        role: 'user' as const,
        content: contextParts.join('\n') + `

Дай оценку безопасности строго по схеме JSON:
{
  "assessment": "2-3 предложения честной оценки безопасности для туриста",
  "recommendations": ["конкретная рекомендация", "максимум 5 штук"],
  "emergencyTip": "что делать при ЧС на этом месте (1 предложение)"
}`,
      },
    ];

    const aiText = await callAIFast(messages);

    let synthesis: { assessment?: string; recommendations?: string[]; emergencyTip?: string } = {};
    try {
      const cleaned = aiText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      synthesis = JSON.parse(cleaned) as typeof synthesis;
    } catch {
      synthesis = { assessment: aiText.slice(0, 300) };
    }

    return NextResponse.json({
      success: true,
      data: {
        placeId:        r.id as string,
        placeName:      r.name as string,
        placeType:      (r.location_type as string | null) ?? null,
        altitudeM:      r.altitude_m != null ? Number(r.altitude_m) : null,
        difficultyLevel,
        hazards,
        nearestMedicalKm: r.nearest_medical_km != null ? Number(r.nearest_medical_km) : null,
        satCommunicator: Boolean(r.sat_communicator_required),
        registrationRequired: Boolean(r.registration_required),
        realtime: alertSeverity != null || r.is_open != null ? {
          isOpen:        r.is_open as boolean | null,
          alertSeverity,
          alertMessage:  (r.alert_message as string | null) ?? null,
          currentCrowds: r.current_crowds != null ? Number(r.current_crowds) : null,
          activeAlerts:  (r.active_alerts as string[] | null) ?? null,
        } : null,
        riskScore,
        kuzmichAssessment:    synthesis.assessment ?? null,
        recommendations:      synthesis.recommendations ?? [],
        emergencyTip:         synthesis.emergencyTip ?? null,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
