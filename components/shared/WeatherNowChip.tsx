'use client';

import { useEffect, useState } from 'react';
import { CloudSun } from 'lucide-react';
import { parseWeatherNow, type WeatherNow } from '@/lib/weather/now-temperature';

/**
 * Значок «температура сейчас» — прогнозом и названный прогнозом (15.10, §0).
 *
 * Число — модель погоды для координат (Open-Meteo, при ключе — Яндекс), а не
 * замер на месте: в горах и у воды разница бывает в разы больше, чем кажется
 * по одной цифре. Поэтому рядом слово «прогноз» и полная подпись в title.
 */
export default function WeatherNowChip({ lat, lng, whose, glass = false }: {
  lat: number;
  lng: number;
  /** Чьи координаты: «места», «вашего положения». */
  whose: string;
  /** Поверх карты — стеклом (§2), иначе плиткой карточки. */
  glass?: boolean;
}) {
  const [now, setNow] = useState<WeatherNow | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/weather?lat=${lat}&lng=${lng}`)
      .then((r) => r.json())
      .then((d: unknown) => { if (alive) setNow(parseWeatherNow(d)); })
      // Нет ответа — нет значка: число без источника не рисуем, а отказ
      // роута уже пишется в его лог.
      .catch(() => { if (alive) setNow(null); });
    return () => { alive = false; };
  }, [lat, lng]);

  if (!now) return null;
  const title = `Температура сейчас по прогнозу погоды для координат ${whose}, а не замер на месте`;
  return glass ? (
    <div title={title} className="flex items-center gap-1 px-2.5 py-1.5 rounded-full"
      style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.15)' }}>
      <CloudSun className="w-3.5 h-3.5 text-white/80" aria-hidden />
      <span className="text-xs font-bold text-white">{now.temp}°</span>
      <span className="text-[10px] text-white/70">прогноз</span>
    </div>
  ) : (
    <div title={title} className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-hover)]">
      <CloudSun className="w-4 h-4 text-[var(--ocean)]" aria-hidden />
      <span className="text-sm font-semibold text-[var(--text-primary)]">{now.temp}°</span>
      <span className="text-[11px] text-[var(--text-muted)]">прогноз</span>
    </div>
  );
}
