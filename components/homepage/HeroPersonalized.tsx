'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Wind, Thermometer, ArrowRight, Loader2 } from 'lucide-react';

interface WeatherSnip {
  temperature: number;
  windSpeed: number;
  conditionText: string;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

const TIPS = [
  'Сейчас отличная погода для Халактырского пляжа',
  'Мутновский открыт — рекомендуется выйти пораньше',
  'Идеальный сезон для похода к Авачинскому',
  'Курильское озеро: медведи активны утром',
  'Паратунка: термальные источники работают круглосуточно',
];

export function HeroPersonalized() {
  const [weather, setWeather] = useState<WeatherSnip | null>(null);
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);

  useEffect(() => {
    fetch('/api/weather?lat=53.0375&lng=158.6556')
      .then(r => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.success && d.data) {
          setWeather({
            temperature: Math.round(d.data.temperature),
            windSpeed: Math.round(d.data.windSpeed),
            conditionText: d.data.conditionText ?? '',
          });
        }
      })
      .catch(() => null);
  }, []);

  return (
    <div className="relative mx-4 mt-4 mb-0 rounded-2xl overflow-hidden h-[320px] md:h-[380px]">
      <Image
        src="/images/hero/IMG_20260316_133049.jpg"
        alt="Камчатка"
        fill
        className="object-cover"
        priority
      />
      {/* Dark gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/30 to-black/70" />

      <div className="absolute inset-0 flex flex-col justify-between p-6">
        {/* Weather chip */}
        <div className="self-end">
          {weather ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold text-white"
              style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)' }}>
              <Thermometer size={12} className="text-[var(--accent)]" />
              <span>+{weather.temperature}°</span>
              <Wind size={12} className="ml-1 text-white/70" />
              <span className="text-white/70">{weather.windSpeed} м/с</span>
            </div>
          ) : (
            <Loader2 size={16} className="text-white/50 animate-spin" />
          )}
        </div>

        {/* Greeting + tip + CTA */}
        <div>
          <p className="text-white/70 text-sm font-medium mb-1">{getGreeting()}</p>
          <h2 className="font-playfair text-3xl md:text-4xl text-white font-bold leading-tight mb-2">
            Камчатка ждёт
          </h2>
          <p className="text-white/80 text-sm mb-5 leading-snug max-w-xs">
            {tip}
          </p>
          <Link
            href="/routes"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white transition-all hover:scale-105 active:scale-95"
            style={{ background: 'var(--accent)' }}
          >
            Маршруты <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}
