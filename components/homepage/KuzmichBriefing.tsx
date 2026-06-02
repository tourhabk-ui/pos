'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, MapPin, Thermometer, Wind } from 'lucide-react';

interface SafetyStatus {
  hasAlert: boolean;
  maxSeverity: number;
  activeCount: number;
  topTitle: string | null;
  topType: string | null;
}

interface RouteRec {
  id: number;
  title: string;
  reason: string;
  status: string;
  safety_score: number;
}

interface WeatherData {
  temperature: number;
  conditionText: string;
  windSpeed: number;
}

interface BriefingData {
  safety: SafetyStatus;
  weather: WeatherData | null;
  routes: RouteRec[];
}

// Petropavlovsk-Kamchatsky coords
const PK_LAT = 53.0375;
const PK_LNG = 158.6556;

function buildText(safety: SafetyStatus, weather: WeatherData | null): string {
  const temp = weather ? `${weather.temperature > 0 ? '+' : ''}${weather.temperature}°C` : null;
  const wind = weather && weather.windSpeed > 10 ? `, ветер ${weather.windSpeed} м/с` : '';
  const weatherPart = temp ? `Сегодня ${temp}${wind}` : 'Сегодня';

  if (safety.maxSeverity >= 3) {
    const what = safety.topTitle ?? 'Объявлена опасность';
    return `${weatherPart}. Предупреждение: ${what}. Будьте внимательны при планировании выхода.`;
  }
  if (safety.maxSeverity === 2) {
    const what = safety.topTitle ?? 'Есть предупреждения';
    return `${weatherPart}. ${what}. Рекомендую проверить маршрут перед выходом.`;
  }
  if (weather) {
    const cond = weather.conditionText?.toLowerCase() ?? '';
    return `${weatherPart}, ${cond}. Условия подходящие — вот что сейчас открыто:`;
  }
  return 'Сейчас на Камчатке тихо. Хороший момент для похода:';
}

function SeverityIcon({ severity }: { severity: number }) {
  if (severity >= 2) return <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: severity >= 3 ? 'var(--danger)' : 'var(--warning)' }} />;
  return <Thermometer className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />;
}

function borderColor(severity: number) {
  if (severity >= 3) return 'var(--danger)';
  if (severity >= 2) return 'var(--warning)';
  return 'var(--border)';
}

export function KuzmichBriefing() {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [safetyRes, weatherRes, routesRes] = await Promise.all([
          fetch('/api/public/safety-status', { cache: 'no-store' }),
          fetch(`/api/weather?lat=${PK_LAT}&lng=${PK_LNG}`, { cache: 'no-store' }),
          fetch('/api/safety/routes?mode=safe_only&limit=3', { cache: 'no-store' }),
        ]);

        const [safetyJson, weatherJson, routesJson] = await Promise.all([
          safetyRes.ok ? safetyRes.json() : null,
          weatherRes.ok ? weatherRes.json() : null,
          routesRes.ok ? routesRes.json() : null,
        ]);

        if (cancelled) return;

        const safety: SafetyStatus = safetyJson?.data ?? {
          hasAlert: false, maxSeverity: 0, activeCount: 0, topTitle: null, topType: null,
        };

        const wd = weatherJson?.data;
        const weather: WeatherData | null = wd
          ? { temperature: wd.temperature, conditionText: wd.conditionText, windSpeed: wd.windSpeed ?? 0 }
          : null;

        const routes: RouteRec[] = (routesJson?.data ?? []).slice(0, 3);

        setData({ safety, weather, routes });
      } catch {
        // network error — hide silently
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  if (!loading && !data) return null;

  const severity = data?.safety.maxSeverity ?? 0;
  const bc = borderColor(severity);

  return (
    <section className="max-w-6xl mx-auto px-4 md:px-8 py-5">
      <div
        className="rounded-lg px-5 py-4"
        style={{
          background: 'var(--bg-card)',
          border: `1px solid ${bc}`,
          borderLeft: `4px solid ${bc}`,
        }}
      >
        {loading ? (
          <div className="space-y-2.5">
            <div className="ds-skeleton h-3 w-32 rounded" />
            <div className="ds-skeleton h-4 w-3/4 rounded" />
            <div className="flex gap-2 pt-1">
              <div className="ds-skeleton h-8 w-28 rounded-full" />
              <div className="ds-skeleton h-8 w-28 rounded-full" />
              <div className="ds-skeleton h-8 w-28 rounded-full" />
            </div>
          </div>
        ) : data ? (
          <div className="flex flex-col gap-3">
            {/* Header row */}
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold flex-shrink-0"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                К
              </span>
              <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                Кузьмич
              </span>
              {data.weather && (
                <span className="text-xs flex items-center gap-1 ml-auto" style={{ color: 'var(--text-muted)' }}>
                  <Wind className="w-3 h-3" />
                  {data.weather.windSpeed} м/с
                </span>
              )}
            </div>

            {/* Briefing text */}
            <div className="flex items-start gap-2">
              <SeverityIcon severity={severity} />
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                {buildText(data.safety, data.weather)}
              </p>
            </div>

            {/* Route chips */}
            {data.routes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {data.routes.map((r) => (
                  <Link
                    key={r.id}
                    href={`/routes/${r.id}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full transition-colors hover:opacity-80"
                    style={{
                      background: 'color-mix(in srgb, var(--ocean) 10%, var(--bg-primary))',
                      color: 'var(--ocean)',
                      border: '1px solid color-mix(in srgb, var(--ocean) 25%, transparent)',
                    }}
                    title={r.reason}
                  >
                    <MapPin className="w-3 h-3 flex-shrink-0" />
                    {r.title}
                  </Link>
                ))}
                <Link
                  href="/ai-assistant"
                  className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-full transition-colors hover:opacity-80 ml-auto"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Спросить Кузьмича
                  <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            )}

            {data.routes.length === 0 && (
              <Link
                href="/ai-assistant"
                className="inline-flex items-center gap-1 text-xs font-medium self-start"
                style={{ color: 'var(--ocean)' }}
              >
                Спросить Кузьмича про условия
                <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
