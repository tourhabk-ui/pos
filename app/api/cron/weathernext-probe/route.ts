/**
 * GET /api/cron/weathernext-probe
 * Authorization: Bearer <CRON_SECRET>
 *
 * Отвечает на ОДИН вопрос: что говорит вероятностный ансамбль WeatherNext 2
 * там, где сейчас решает один детерминированный прогон Open-Meteo, — и где
 * два источника расходятся. Только чтение: ни модели, ни записи в БД, ни
 * публикации.
 *
 * ЧЕГО ЭТА ПРОБА НЕ ДЕЛАЕТ. Находка #1787 просила «сравнить точность с
 * текущим источником на наборе данных по Камчатке за последний месяц».
 * Точность так измерить НЕЛЬЗЯ, и делать вид, что можно, — то самое враньё
 * из §4.0: точность — это сверка прогноза с ТЕМ, ЧТО СЛУЧИЛОСЬ, а
 * наблюдений мы не собираем и архива своих прошлых прогнозов не храним.
 * Здесь меряется РАСХОЖДЕНИЕ двух источников на один и тот же день — этого
 * достаточно, чтобы увидеть дни, которые один прогон объявляет спокойными, а
 * большинство членов ансамбля — опасными. Кто из них прав, проба не знает и
 * не говорит.
 *
 * ИСХОДОВ ПО КАЖДОМУ ДНЮ ЧЕТЫРЕ, НЕ ДВА: сошлись на опасности, сошлись на
 * спокойствии, расходятся — и `unknown`, когда хотя бы один источник за этот
 * день не ответил. Третий исход не сливается с «спокойно».
 *
 * SSRF. Координаты не берутся из запроса: зоны зашиты в
 * lib/services/safety/zone-weather.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { ZONES, type ZoneKey } from '@/lib/services/safety/zone-weather';
import { fetchWeatherForecast } from '@/lib/planner/intelligence';
import { DANGEROUS_WMO_CODES, wmoHazardLabel } from '@/lib/weather/wmo-hazard';
import {
  fetchEnsembleOutlook, ensembleDayFor, hazardBreakdown,
  ENSEMBLE_MODEL, ENSEMBLE_ENDPOINT, HAZARD_THRESHOLDS,
  type EnsembleDay, type Consensus,
} from '@/lib/weather/ensemble';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HORIZON_DAYS = 5;
/** Доля членов, с которой ансамбль считается «видящим опасность» (как у Rescue). */
const DIVERGENCE_SHARE = 0.5;

export type DayVerdict =
  | 'agree_danger'      // оба источника: опасно
  | 'agree_calm'        // оба: спокойно
  | 'deterministic_only'// опасен только один прогон
  | 'ensemble_only'     // опасность видит большинство ансамбля, прогон спокоен
  | 'unknown';          // хотя бы один источник по этому дню молчит

/**
 * Вердикт по дню. `deterministicDangerous === null` и `share === null` — это
 * «не знаю», и оно НЕ становится «спокойно».
 */
export function classifyDivergence(
  deterministicDangerous: boolean | null,
  share: number | null,
): DayVerdict {
  if (deterministicDangerous === null || share === null) return 'unknown';
  const ensembleDangerous = share >= DIVERGENCE_SHARE;
  if (deterministicDangerous && ensembleDangerous) return 'agree_danger';
  if (!deterministicDangerous && !ensembleDangerous) return 'agree_calm';
  return deterministicDangerous ? 'deterministic_only' : 'ensemble_only';
}

interface DayRow {
  date: string;
  deterministic_code: number | null;
  deterministic_label: string | null;
  deterministic_dangerous: boolean | null;
  deterministic_wind_kmh: number | null;
  ensemble_members: number | null;
  ensemble_dangerous_members: number | null;
  ensemble_share: number | null;
  ensemble_consensus: Consensus | null;
  ensemble_hazards: string[] | null;
  verdict: DayVerdict;
}

interface ZoneRow {
  zone: ZoneKey;
  zone_name: string;
  lat: number;
  lng: number;
  /** null — источник не ответил вовсе (не «прогноза нет»). */
  deterministic_days: number | null;
  ensemble_members: number | null;
  ensemble_unavailable: string[] | null;
  days: DayRow[];
}

function ensembleRow(day: EnsembleDay | null): Pick<DayRow,
  'ensemble_members' | 'ensemble_dangerous_members' | 'ensemble_share'
  | 'ensemble_consensus' | 'ensemble_hazards'> {
  if (!day || day.membersDangerous === null || day.share === null) {
    return {
      ensemble_members: day?.membersCounted ?? null,
      ensemble_dangerous_members: null,
      ensemble_share: null,
      ensemble_consensus: day?.consensus ?? null,
      ensemble_hazards: null,
    };
  }
  return {
    ensemble_members: day.membersCounted,
    ensemble_dangerous_members: day.membersDangerous,
    ensemble_share: Math.round(day.share * 100) / 100,
    ensemble_consensus: day.consensus,
    ensemble_hazards: hazardBreakdown(day),
  };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const zones: ZoneRow[] = [];

  for (const key of Object.keys(ZONES) as ZoneKey[]) {
    const zone = ZONES[key];
    // Последовательно по зонам: обе пробы делят один исходящий адрес и один
    // бесплатный лимит Open-Meteo.
    const forecast = await fetchWeatherForecast(zone.lat, zone.lon, HORIZON_DAYS);
    const outlook = await fetchEnsembleOutlook(zone.lat, zone.lon, HORIZON_DAYS);

    // Даты берём из ансамбля, если он ответил, иначе из прогона: набор дней
    // не выдумывается ни из чего.
    const dates = outlook
      ? outlook.days.map((d) => d.date)
      : forecast.map((d) => d.date);

    const days: DayRow[] = dates.map((date) => {
      const det = forecast.find((d) => d.date === date) ?? null;
      const ens = ensembleDayFor(outlook, date);
      const detDangerous = det ? DANGEROUS_WMO_CODES.has(det.weatherCode) : null;
      const ensParts = ensembleRow(ens);
      return {
        date,
        deterministic_code: det?.weatherCode ?? null,
        deterministic_label: det ? wmoHazardLabel(det.weatherCode) : null,
        deterministic_dangerous: detDangerous,
        deterministic_wind_kmh: det ? Math.round(det.windKmh) : null,
        ...ensParts,
        verdict: classifyDivergence(detDangerous, ensParts.ensemble_share),
      };
    });

    zones.push({
      zone: key,
      zone_name: zone.name,
      lat: zone.lat,
      lng: zone.lon,
      deterministic_days: forecast.length > 0 ? forecast.length : null,
      ensemble_members: outlook?.members ?? null,
      ensemble_unavailable: outlook?.unavailable ?? null,
      days,
    });
  }

  const allDays = zones.flatMap((z) => z.days);
  const byVerdict: Record<DayVerdict, number> = {
    agree_danger: 0, agree_calm: 0, deterministic_only: 0, ensemble_only: 0, unknown: 0,
  };
  for (const d of allDays) byVerdict[d.verdict] += 1;

  const ensembleAnswered = zones.filter((z) => z.ensemble_members !== null).length;
  const verdict = ensembleAnswered === 0
    ? 'ensemble_unreachable'
    : ensembleAnswered < zones.length ? 'partial' : 'both_sources_answered';

  return NextResponse.json({
    ok: true,
    probe: 'weathernext_probe_v1',
    place: 'prod',
    verdict,
    measures: 'расхождение двух источников на один день; точность НЕ меряется — наблюдений нет',
    ensemble: { endpoint: ENSEMBLE_ENDPOINT, model: ENSEMBLE_MODEL },
    thresholds: HAZARD_THRESHOLDS,
    horizon_days: HORIZON_DAYS,
    divergence_share: DIVERGENCE_SHARE,
    days_total: allDays.length,
    by_verdict: byVerdict,
    zones,
    checked_at: new Date().toISOString(),
  });
}
