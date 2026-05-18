'use client';

import { useEffect, useState } from 'react';
import { Wind, Droplets, Thermometer, Eye } from 'lucide-react';

interface WeatherData {
  temp: number;
  feels_like: number;
  condition: string;
  wind_speed: number;
  humidity: number;
  visibility: number;
  icon: string;
}

interface Props {
  lat: number;
  lng: number;
  placeName: string;
}

export default function PlaceWeather({ lat, lng, placeName }: Props) {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/weather?lat=${lat}&lng=${lng}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) {
          const w = d.data;
          setWeather({
            temp: Math.round(w.temperature ?? w.temp ?? 0),
            feels_like: Math.round(w.feels_like ?? w.temperature ?? 0),
            condition: w.description ?? w.condition ?? '',
            wind_speed: Math.round((w.wind_speed ?? 0) * 3.6), // m/s → km/h
            humidity: w.humidity ?? 0,
            visibility: Math.round((w.visibility ?? 10000) / 1000),
            icon: w.icon ?? '',
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [lat, lng]);

  if (loading) {
    return (
      <div className="ds-card p-4 animate-pulse">
        <div className="h-4 bg-[var(--bg-hover)] rounded w-1/3 mb-3" />
        <div className="h-8 bg-[var(--bg-hover)] rounded w-1/2" />
      </div>
    );
  }

  if (!weather) return null;

  return (
    <div className="ds-card p-4">
      <p className="ds-label mb-3">Погода сейчас — {placeName}</p>

      <div className="flex items-center gap-4">
        <div className="flex items-end gap-1">
          <span className="text-3xl font-bold text-[var(--text-primary)]">{weather.temp}°</span>
          <span className="text-sm text-[var(--text-secondary)] mb-1">ощущается {weather.feels_like}°</span>
        </div>
        {weather.icon && (
          <img
            src={`https://openweathermap.org/img/wn/${weather.icon}@2x.png`}
            alt={weather.condition}
            width={50}
            height={50}
            className="opacity-90"
          />
        )}
        <span className="text-sm text-[var(--text-secondary)] capitalize">{weather.condition}</span>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-3">
        <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          <Wind size={14} className="text-[var(--ocean)] shrink-0" />
          <span>{weather.wind_speed} км/ч</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          <Droplets size={14} className="text-[var(--ocean)] shrink-0" />
          <span>{weather.humidity}%</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          <Eye size={14} className="text-[var(--ocean)] shrink-0" />
          <span>{weather.visibility} км</span>
        </div>
      </div>
    </div>
  );
}
