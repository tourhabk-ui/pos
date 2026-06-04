'use client';

import { useEffect, useState } from 'react';
import { CloudSun } from 'lucide-react';

interface Props {
  lat: number;
  lng: number;
}

export function MapWeatherChip({ lat, lng }: Props) {
  const [weather, setWeather] = useState<{ temp: number; icon: string } | null>(null);

  useEffect(() => {
    fetch(`/api/weather?lat=${lat}&lng=${lng}`)
      .then(r => r.json())
      .then((d: unknown) => {
        if (typeof d !== 'object' || d === null) return;
        const rec = d as Record<string, unknown>;
        if (typeof rec.temperature === 'number') {
          setWeather({
            temp: Math.round(rec.temperature as number),
            icon: typeof rec.iconUrl === 'string' ? rec.iconUrl : '',
          });
        }
      })
      .catch(() => {});
  }, [lat, lng]);

  if (!weather) return null;

  return (
    <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full"
      style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.15)' }}>
      {weather.icon
        ? <img src={weather.icon} alt="" className="w-4 h-4" />
        : <CloudSun className="w-3.5 h-3.5 text-white/80" />
      }
      <span className="text-xs font-bold text-white">{weather.temp}°</span>
    </div>
  );
}
