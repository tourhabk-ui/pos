'use client';

import { useEffect, useState } from 'react';

interface Props {
  lat: number;
  lng: number;
}

interface WeatherData {
  temp: number;
  icon: string;
}

export default function MapWeatherChip({ lat, lng }: Props) {
  const [weather, setWeather] = useState<WeatherData | null>(null);

  useEffect(() => {
    fetch(`/api/weather?lat=${lat}&lng=${lng}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) {
          const w = d.data;
          setWeather({
            temp: Math.round(w.temperature ?? w.temp ?? 0),
            icon: w.icon ?? '',
          });
        }
      })
      .catch(() => {});
  }, [lat, lng]);

  if (!weather) return null;

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 rounded-full text-xs text-white font-medium pointer-events-none"
      style={{ background: 'rgba(0,0,0,0.60)' }}
    >
      {weather.icon && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://openweathermap.org/img/wn/${weather.icon}.png`}
          alt=""
          width={20}
          height={20}
          className="opacity-90"
        />
      )}
      <span>{weather.temp}°</span>
    </div>
  );
}
