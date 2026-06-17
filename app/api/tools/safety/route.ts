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
  z.object({ routeId: z.string().uuid() }),
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

  // ── Маршрут — агрегируем по всем точкам маршрута ─────────────────────────
  if ('routeId' in data) {
    try {
      const [routeRes, wpRes] = await Promise.all([
        query(
          `SELECT id, title, distance_km, elevation_gain_m, duration_hours,
                  difficulty, hazards, mchs_registration_required, mchs_phone
           FROM kamchatka_routes WHERE id = $1 LIMIT 1`,
          [data.routeId],
        ),
        query(
          `SELECT p.name, sp.hazard_types, sp.difficulty_level, sp.altitude_m,
                  sp.nearest_medical_km, sp.sat_communicator_required,
                  sp.registration_required,
                  rs.alert_severity, rs.alert_message
           FROM route_waypoints rw
           JOIN places p ON p.id = rw.place_id
           LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
           LEFT JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
           WHERE rw.route_id = $1
           ORDER BY rw.position`,
          [data.routeId],
        ),
      ]);

      if (!routeRes.rows.length) {
        return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
      }

      const r = routeRes.rows[0];
      const wps = wpRes.rows;

      // Агрегация опасностей по всем точкам маршрута
      const allHazards = new Set<string>();
      (Array.isArray(r.hazards) ? (r.hazards as string[]) : []).forEach(h => allHazards.add(h));
      wps.forEach(wp => {
        if (Array.isArray(wp.hazard_types)) (wp.hazard_types as string[]).forEach(h => allHazards.add(h));
      });
      const hazards = Array.from(allHazards);

      const maxAlertSeverity = wps.reduce((m: number | null, wp) => {
        const s = wp.alert_severity != null ? Number(wp.alert_severity) : null;
        if (s == null) return m;
        return m == null ? s : Math.max(m, s);
      }, null);

      const maxDifficulty = wps.reduce((m: number | null, wp) => {
        const d = wp.difficulty_level != null ? Number(wp.difficulty_level) : null;
        if (d == null) return m;
        return m == null ? d : Math.max(m, d);
      }, r.difficulty != null ? Number(r.difficulty) : null);

      const maxAltitude = wps.reduce((m: number | null, wp) => {
        const a = wp.altitude_m != null ? Number(wp.altitude_m) : null;
        if (a == null) return m;
        return m == null ? a : Math.max(m, a);
      }, null);

      const minMedical = wps.reduce((m: number | null, wp) => {
        const v = wp.nearest_medical_km != null ? Number(wp.nearest_medical_km) : null;
        if (v == null) return m;
        return m == null ? v : Math.min(m, v);
      }, null);

      const satRequired = wps.some(wp => wp.sat_communicator_required);
      const regRequired = Boolean(r.mchs_registration_required) || wps.some(wp => wp.registration_required);
      const alertWp = wps.find(wp => wp.alert_severity != null && Number(wp.alert_severity) > 0);

      const riskScore = computeRiskScore(hazards, maxAlertSeverity, maxDifficulty);

      const contextParts: string[] = [
        `МАРШРУТ: ${r.title as string}`,
      ];
      if (r.distance_km) contextParts.push(`ДИСТАНЦИЯ: ${r.distance_km} км`);
      if (r.elevation_gain_m) contextParts.push(`НАБОР ВЫСОТЫ: ${r.elevation_gain_m} м`);
      if (r.duration_hours) contextParts.push(`ДЛИТЕЛЬНОСТЬ: ${r.duration_hours} ч`);
      if (maxAltitude) contextParts.push(`МАКСИМАЛЬНАЯ ВЫСОТА: ${maxAltitude} м`);
      if (hazards.length) contextParts.push(`ОПАСНОСТИ: ${hazards.map(h => HAZARD_LABELS[h] ?? h).join(', ')}`);
      if (maxDifficulty != null) contextParts.push(`СЛОЖНОСТЬ: ${maxDifficulty}/5`);
      if (minMedical != null) contextParts.push(`БЛИЖАЙШАЯ МЕДПОМОЩЬ: ${minMedical} км`);
      if (satRequired) contextParts.push('Спутниковая связь: рекомендуется');
      if (regRequired) contextParts.push('Регистрация в МЧС: обязательна');
      if (r.mchs_phone) contextParts.push(`Телефон МЧС: ${r.mchs_phone}`);
      if (maxAlertSeverity != null && maxAlertSeverity > 0 && alertWp) {
        contextParts.push(`ТЕКУЩИЙ АЛЕРТ (уровень ${maxAlertSeverity}/4): ${(alertWp.alert_message as string | null) ?? 'повышенная осторожность'}`);
      }
      if (wps.length > 0) contextParts.push(`ТОЧЕК НА МАРШРУТЕ: ${wps.length}`);

      const messages = [
        {
          role: 'system' as const,
          content: 'Ты Кузьмич — опытный гид по Камчатке. Давай честные, конкретные оценки безопасности. Говори прямо о реальных рисках. Отвечай ТОЛЬКО валидным JSON без markdown-блоков.',
        },
        {
          role: 'user' as const,
          content: contextParts.join('\n') + `

Дай оценку безопасности маршрута строго по схеме JSON:
{
  "assessment": "2-3 предложения честной оценки безопасности для туриста",
  "recommendations": ["конкретная рекомендация", "максимум 5 штук"],
  "emergencyTip": "что делать при ЧС на этом маршруте (1 предложение)"
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
          placeId:          r.id as string,
          placeName:        r.title as string,
          placeType:        'route',
          altitudeM:        maxAltitude,
          difficultyLevel:  maxDifficulty,
          hazards,
          nearestMedicalKm: minMedical,
          satCommunicator:  satRequired,
          registrationRequired: regRequired,
          realtime: maxAlertSeverity != null && maxAlertSeverity > 0 ? {
            isOpen: null,
            alertSeverity: maxAlertSeverity,
            alertMessage: (alertWp?.alert_message as string | null) ?? null,
            currentCrowds: null,
            activeAlerts: null,
          } : null,
          riskScore,
          kuzmichAssessment: synthesis.assessment ?? null,
          recommendations:   synthesis.recommendations ?? [],
          emergencyTip:      synthesis.emergencyTip ?? null,
        },
      });
    } catch {
      return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
    }
  }

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
