'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Bot, CloudSun, Flame, MapPin } from 'lucide-react';

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
  safety_score: number;
}

interface WeatherData {
  temperature: number;
  description?: string;
}

interface BriefingData {
  safety: SafetyStatus | null;
  routes: RouteRec[];
  weather: WeatherData | null;
}

function severityBorderColor(s: number) {
  if (s >= 3) return 'var(--danger)';
  if (s === 2) return 'var(--warning)';
  return 'var(--border)';
}

function buildText(weather: WeatherData | null, safety: SafetyStatus | null): string {
  const parts: string[] = [];
  if (weather) {
    parts.push(`Сегодня в Петропавловске +${Math.round(weather.temperature)}°C.`);
  }
  if (safety?.hasAlert && safety.maxSeverity >= 2) {
    if (safety.topTitle) {
      parts.push(`Внимание: ${safety.topTitle}.`);
    } else {
      parts.push(`Активны ${safety.activeCount} предупреждений.`);
    }
  } else {
    parts.push('Условия благоприятные.');
  }
  if (parts.length > 0) {
    parts.push('Рекомендую:');
  }
  return parts.join(' ');
}

export function KuzmichBriefing() {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch('/api/public/safety-status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/weather?lat=53.0375&lng=158.6556').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/safety/routes?mode=safe_only&limit=3').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([safetyRes, weatherRes, routesRes]) => {
      if (cancelled) return;
      const safety: SafetyStatus | null = safetyRes?.success ? safetyRes.data : null;
      const weather: WeatherData | null = weatherRes?.success ? weatherRes.data : null;
      const routes: RouteRec[] = Array.isArray(routesRes?.data) ? routesRes.data.slice(0, 3) : [];
      setData({ safety, weather, routes });
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  if (!loading && !data) return null;

  const severity = data?.safety?.maxSeverity ?? 0;
  const borderColor = severityBorderColor(severity);
  const briefText = data ? buildText(data.weather, data.safety) : '';

  return (
    <section className="px-4 py-3 max-w-7xl mx-auto">
      <div
        className="rounded-xl p-4 md:p-5 transition-colors"
        style={{
          background: 'var(--bg-card)',
          border: `1px solid ${borderColor}`,
        }}
      >
        {loading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-3 rounded bg-[var(--bg-hover)] w-1/2" />
            <div className="h-3 rounded bg-[var(--bg-hover)] w-3/4" />
            <div className="h-3 rounded bg-[var(--bg-hover)] w-1/3" />
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            {/* Avatar + text */}
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--accent)' }}
              >
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--text-muted)] mb-1">
                  Кузьмич · обновлено {new Date().getHours().toString().padStart(2, '0')}:{new Date().getMinutes().toString().padStart(2, '0')}
                </p>

                {/* Severity indicator */}
                {severity >= 2 && (
                  <div className="flex items-center gap-1 mb-1">
                    <AlertTriangle
                      size={12}
                      style={{ color: severity >= 3 ? 'var(--danger)' : 'var(--warning)' }}
                    />
                    <span
                      className="text-[11px] font-semibold"
                      style={{ color: severity >= 3 ? 'var(--danger)' : 'var(--warning)' }}
                    >
                      {severity >= 3 ? 'Высокий уровень риска' : 'Повышенная осторожность'}
                    </span>
                  </div>
                )}

                <p className="text-sm text-[var(--text-secondary)] leading-snug mb-3">{briefText}</p>

                {/* Route pills */}
                <div className="flex flex-wrap gap-2">
                  {data!.routes.length > 0 ? (
                    data!.routes.map(r => (
                      <Link
                        key={r.id}
                        href={`/routes/${r.id}`}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--ocean)] hover:text-[var(--ocean)] transition-colors"
                        title={r.reason}
                      >
                        <MapPin size={10} className="flex-shrink-0" />
                        {r.title}
                      </Link>
                    ))
                  ) : (
                    <>
                      {[
                        { label: 'Авачинский',        href: '/routes?q=авачинский' },
                        { label: 'Мутновский',        href: '/routes?q=мутновский' },
                        { label: 'Халактырский пляж', href: '/routes?q=халактырский' },
                      ].map(r => (
                        <Link
                          key={r.href}
                          href={r.href}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--ocean)] hover:text-[var(--ocean)] transition-colors"
                        >
                          <MapPin size={10} className="flex-shrink-0" />
                          {r.label}
                        </Link>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Status chips + CTA */}
            <div className="flex sm:flex-col items-center sm:items-end gap-2 flex-shrink-0">
              <div className="flex items-center gap-3">
                {data!.weather && (
                  <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                    <CloudSun size={12} />
                    +{Math.round(data!.weather.temperature)}°
                  </span>
                )}
                <span
                  className="flex items-center gap-1 text-xs font-semibold"
                  style={{ color: severity >= 2 ? (severity >= 3 ? 'var(--danger)' : 'var(--warning)') : 'var(--success)' }}
                >
                  <Flame size={12} />
                  {severity >= 3 ? 'Опасно' : severity >= 2 ? 'Осторожно' : 'Норма'}
                </span>
              </div>
              <Link
                href="/ai-assistant"
                className="flex items-center gap-1 text-xs font-bold text-[var(--ocean)] hover:underline whitespace-nowrap"
              >
                Спросить Кузьмича <ArrowRight size={12} />
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
