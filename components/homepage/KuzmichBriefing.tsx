'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Bot, CloudSun, Compass, Flame, HelpCircle } from 'lucide-react';
import { briefingStatus, briefingUpdatedAt, type BriefingSafety } from '@/lib/home/briefing';
import { HOME_CONTAINER } from '@/lib/home/desktop-layout';

/**
 * Утренняя сводка Кузьмича на десктопной главной: погода, обстановка, туры.
 *
 * Аудит 24.09 (#37) — три заявления без источника рядом с продажей:
 *   - «обновлено 12:45» бралось из new Date() в момент рендера, то есть
 *     называло время открытия страницы, а не данных. Теперь — время из
 *     dataUpdatedAt ответа safety-status; его нет — строки «обновлено» нет;
 *   - «Норма» зелёным рисовалась и при safety = null (источник недоступен).
 *     Теперь у статуса три исхода (lib/home/briefing): норма — только при
 *     живых данных со временем, иначе «Обстановка неизвестна» словами (§4.0);
 *   - при пустом ответе рекомендаций подставлялся захардкоженный список мест
 *     (Авачинский, Мутновский, Халактырский) — выдача без источника. Убран.
 * Рекомендует Кузьмич теперь ТУРЫ сезона, а не места: их передаёт страница
 * из той же витрины, что сетка туров (fetchPlates — правило сезона каталога,
 * туры с кончившимся сезоном отсеяны на стороне страницы). Своего подбора у
 * Кузьмича нет (§4, «Подбор тура — 3 движка + Кузьмич»). Нет туров — нет и
 * строки «Рекомендую».
 */

interface WeatherData {
  temperature: number;
  description?: string;
}

interface BriefingData {
  safety: BriefingSafety | null;
  weather: WeatherData | null;
}

export interface BriefingTour {
  id: string;
  title: string;
}

function severityBorderColor(s: number) {
  if (s >= 3) return 'var(--danger)';
  if (s === 2) return 'var(--warning)';
  return 'var(--border)';
}

function fmtTemp(t: number): string {
  const r = Math.round(t);
  return r > 0 ? `+${r}` : String(r);
}

function buildText(weather: WeatherData | null, safety: BriefingSafety | null, hasTours: boolean): string {
  const parts: string[] = [];
  if (weather) {
    parts.push(`Сегодня в Петропавловске ${fmtTemp(weather.temperature)}°C.`);
  }
  const status = briefingStatus(safety);
  if (safety && (status === 'danger' || status === 'caution')) {
    if (safety.topTitle) {
      parts.push(`Внимание: ${safety.topTitle}.`);
    } else {
      parts.push(`Активны ${safety.activeCount} предупреждений.`);
    }
  } else if (safety) {
    // «Благоприятные» говорим только когда данные ЕСТЬ и в них тихо.
    // Без данных (источник недоступен) молчим: «мы не знаем» — не «спокойно».
    if (status === 'calm') parts.push('Условия благоприятные.');
  }
  if (hasTours) parts.push('Туры сезона:');
  return parts.join(' ');
}

export function KuzmichBriefing({ tours }: { tours: readonly BriefingTour[] }) {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fail = (what: string) => (err: unknown) => {
      // Отказ не глушится (§4.0): блок покажет «неизвестно», а причина — в консоли.
      console.warn(`[home] KuzmichBriefing: отказ загрузки (${what}):`, err instanceof Error ? err.message : err);
      return null;
    };

    Promise.all([
      fetch('/api/public/safety-status').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).catch(fail('safety-status')),
      fetch('/api/weather?lat=53.0375&lng=158.6556').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).catch(fail('погода')),
    ]).then(([safetyRes, weatherRes]) => {
      if (cancelled) return;
      // unavailable — источник недоступен: данных нет, safety = null,
      // и текст не притворяется, что условия известны.
      const safety: BriefingSafety | null =
        safetyRes?.success && safetyRes.data?.unavailable !== true ? safetyRes.data : null;
      const weather: WeatherData | null = weatherRes?.success ? weatherRes.data : null;
      setData({ safety, weather });
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  if (!loading && !data) return null;

  const safety = data?.safety ?? null;
  const status = briefingStatus(safety);
  const severity = safety?.maxSeverity ?? 0;
  const borderColor = severityBorderColor(status === 'unknown' ? 0 : severity);
  const briefText = data ? buildText(data.weather, safety, tours.length > 0) : '';
  const updatedAt = briefingUpdatedAt(safety);

  const statusView = {
    danger:  { label: 'Опасно',                 color: 'var(--danger)',         Icon: Flame },
    caution: { label: 'Осторожно',              color: 'var(--warning)',        Icon: Flame },
    calm:    { label: 'Норма',                  color: 'var(--success)',        Icon: Flame },
    unknown: { label: 'Обстановка неизвестна',  color: 'var(--text-secondary)', Icon: HelpCircle },
  }[status];

  return (
    <section className={`${HOME_CONTAINER} pb-3`}>
      <div
        className="rounded-lg p-4 md:p-5 transition-colors"
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
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-1">
                  Кузьмич{updatedAt ? ` · данные на ${updatedAt}` : ''}
                </p>

                {/* Severity indicator */}
                {status !== 'unknown' && severity >= 2 && (
                  <div className="flex items-center gap-1 mb-1">
                    <AlertTriangle
                      size={12}
                      style={{ color: severity >= 3 ? 'var(--danger)' : 'var(--warning)' }}
                    />
                    <span
                      className="text-xs font-semibold"
                      style={{ color: severity >= 3 ? 'var(--danger)' : 'var(--warning)' }}
                    >
                      {severity >= 3 ? 'Высокий уровень риска' : 'Повышенная осторожность'}
                    </span>
                  </div>
                )}

                {briefText && <p className="text-sm text-[var(--text-secondary)] leading-snug mb-3">{briefText}</p>}

                {/* Туры сезона — из витрины страницы; своих «запасных» нет */}
                {tours.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {tours.map(t => (
                      <Link
                        key={t.id}
                        href={`/marketplace/tours/${t.id}`}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--ocean)] hover:text-[var(--ocean)] transition-colors"
                      >
                        <Compass size={12} className="flex-shrink-0" />
                        {t.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Status chips + CTA */}
            <div className="flex sm:flex-col items-center sm:items-end gap-2 flex-shrink-0">
              <div className="flex items-center gap-3">
                {data!.weather && (
                  <span className="flex items-center gap-1 text-xs text-[var(--text-secondary)] lining-nums">
                    <CloudSun size={12} />
                    {fmtTemp(data!.weather.temperature)}°
                  </span>
                )}
                <span
                  className="flex items-center gap-1 text-xs font-semibold"
                  style={{ color: statusView.color }}
                >
                  <statusView.Icon size={12} />
                  {statusView.label}
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
