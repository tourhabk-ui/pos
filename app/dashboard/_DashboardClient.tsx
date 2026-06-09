'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Map, Flame, Wifi, Navigation, AlertTriangle, CheckCircle, ArrowRight, X, Clock, Gauge, Bot } from 'lucide-react';

interface StatusChip { icon: React.ReactNode; label: string; value: string; ok: boolean }
interface KuzmichWarning { text: string; dismissed: boolean }

const ROUTE = {
  title: 'Мутновский вулкан → Дачные источники',
  totalKm: 14.2,
  checkpointsDone: 2,
  checkpointsTotal: 3,
  remainingKm: 7.2,
  waypoints: [
    { time: '08:00', label: 'Старт' },
    { time: '11:30', label: 'Кратер' },
    { time: '14:00', label: 'Источники' },
  ],
  currentWaypoint: 1,
};

const TOOLS = [
  { icon: Map,           label: 'Карта офлайн',      sub: 'Скачано · 400 МБ', ok: true,  href: '/map'             },
  { icon: Flame,         label: 'Статус вулканов',   sub: '',                 ok: null,  href: '/safety'          },
  { icon: Wifi,          label: 'Зоны связи',        sub: '30 покрытий',      ok: null,  href: '/map'             },
  { icon: AlertTriangle, label: 'МЧС регистрация',   sub: 'Не оформлено',     ok: false, href: '/tools/safety'    },
];

export default function DashboardClient() {
  const [weather, setWeather] = useState<{ temp: number; wind: number } | null>(null);
  const [warning, setWarning] = useState<KuzmichWarning>({
    text: 'Сегодня ветер усилится к 15:00. Рекомендую выйти с кратера до 14:30.',
    dismissed: false,
  });
  const [now] = useState(() => new Date());

  useEffect(() => {
    fetch('/api/weather?lat=53.0375&lng=158.6556')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.success && d.data) {
          setWeather({ temp: Math.round(d.data.temperature), wind: Math.round(d.data.windSpeed) });
        }
      }).catch(() => null);
  }, []);

  const tideTime = `${now.getHours().toString().padStart(2,'0')}:${((now.getMinutes() + 12) % 60).toString().padStart(2,'0')}`;

  const STATUS: StatusChip[] = [
    { icon: <span className="text-yellow-400">☀</span>, label: '', value: weather ? `+${weather.temp}° ясно` : '—', ok: true },
    { icon: <Flame size={12} />,       label: 'Вулканы:', value: 'норма',   ok: true  },
    { icon: <Clock size={12} />,       label: 'Прилив:',  value: tideTime,  ok: true  },
    { icon: <Gauge size={12} />,       label: 'Связь:',   value: '3G',      ok: true  },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col pb-6" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-safe pt-4 pb-3"
        style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">←</Link>
          <div>
            <span className="font-bold text-[var(--text-primary)] tracking-widest text-sm">VEDAR</span>
            <span className="ml-2 text-[10px] text-[var(--text-muted)]">КАМЧАТКА AI</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} />
          <span className="text-[10px] text-[var(--text-muted)]">Связь: 3G</span>
          <Link href="/safety/sos"
            className="ml-2 px-3 py-1 rounded text-xs font-bold text-[var(--text-primary)]"
            style={{ background: 'var(--danger)' }}>SOS</Link>
        </div>
      </div>

      {/* Status chips */}
      <div className="flex gap-2 px-4 py-3 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {STATUS.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium flex-shrink-0"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: s.ok ? 'var(--text-secondary)' : 'var(--danger)' }}>
            {s.icon}
            {s.label && <span className="text-[var(--text-muted)]">{s.label}</span>}
            <span>{s.value}</span>
          </div>
        ))}
      </div>

      <div className="px-4 space-y-3">
        {/* Today's route card */}
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[9px] font-bold tracking-[0.3em] px-2 py-0.5 rounded"
              style={{ background: 'var(--success)', color: 'var(--bg-primary)' }}>ВАШ МАРШРУТ СЕГОДНЯ</span>
          </div>
          <p className="font-bold text-[var(--text-primary)] text-base mb-4 leading-tight">{ROUTE.title}</p>

          {/* Timeline */}
          <div className="flex items-center gap-0 mb-3">
            {ROUTE.waypoints.map((wp, i) => (
              <React.Fragment key={i}>
                <div className="flex flex-col items-center flex-shrink-0">
                  <div className="w-3 h-3 rounded-full border-2 flex items-center justify-center"
                    style={{
                      borderColor: i <= ROUTE.currentWaypoint ? 'var(--success)' : 'var(--border)',
                      background: i < ROUTE.currentWaypoint ? 'var(--success)' : i === ROUTE.currentWaypoint ? 'var(--accent)' : 'var(--bg-card)',
                    }} />
                  <span className="text-[9px] mt-1 font-mono" style={{ color: i <= ROUTE.currentWaypoint ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                    {wp.time}
                  </span>
                  <span className="text-[9px]" style={{ color: i <= ROUTE.currentWaypoint ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                    {wp.label}
                  </span>
                </div>
                {i < ROUTE.waypoints.length - 1 && (
                  <div className="flex-1 h-px mx-1 mb-6"
                    style={{ background: i < ROUTE.currentWaypoint ? 'var(--success)' : 'var(--border)' }} />
                )}
              </React.Fragment>
            ))}
          </div>

          <p className="text-[11px] mb-3 text-[var(--text-muted)]">
            {ROUTE.checkpointsDone}/{ROUTE.checkpointsTotal} чекпоинта · {ROUTE.remainingKm} км осталось
          </p>

          <Link href="/on-route"
            className="flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-bold transition-all hover:opacity-90"
            style={{ background: 'color-mix(in srgb, var(--success) 12%, var(--bg-card))', border: '1px solid var(--success)', color: 'var(--success)' }}>
            Открыть навигацию <ArrowRight size={16} />
          </Link>
        </div>

        {/* Kuzmich warning */}
        {!warning.dismissed && (
          <div className="rounded-xl p-4 relative" style={{ background: 'var(--bg-card)', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' }}>
            <button onClick={() => setWarning(w => ({ ...w, dismissed: true }))}
              className="absolute top-3 right-3 text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
              <X size={14} />
            </button>
            <div className="flex gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--bg-hover)' }}><Bot size={20} strokeWidth={1.5} style={{ color: 'var(--accent)' }} /></div>
              <div>
                <p className="text-[10px] font-bold tracking-[0.2em] mb-1 text-[var(--accent)]">КУЗЬМИЧ AI</p>
                <p className="text-sm leading-snug text-[var(--text-secondary)]">{warning.text}</p>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => setWarning(w => ({ ...w, dismissed: true }))}
                    className="px-4 py-1.5 rounded-lg text-xs font-bold"
                    style={{ background: 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)', color: 'var(--accent)' }}>
                    Понял
                  </button>
                  <Link href="/safety"
                    className="px-4 py-1.5 rounded-lg text-xs font-bold"
                    style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                    Подробнее
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tool grid */}
        <div className="grid grid-cols-2 gap-2">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <Link key={t.label} href={t.href}
                className="flex items-center gap-3 p-3 rounded-xl transition-all hover:brightness-110"
                style={{ background: 'var(--bg-card)', border: `1px solid ${t.ok === false ? 'var(--danger)' : 'var(--border)'}` }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: t.ok === false ? 'color-mix(in srgb, var(--danger) 12%, var(--bg-card))' : t.ok === true ? 'color-mix(in srgb, var(--success) 12%, var(--bg-card))' : 'var(--bg-hover)' }}>
                  <Icon size={16} style={{ color: t.ok === false ? 'var(--danger)' : t.ok === true ? 'var(--success)' : 'var(--text-muted)' }} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-[var(--text-primary)] leading-tight">{t.label}</p>
                  {t.sub && <p className="text-[10px]" style={{ color: t.ok === false ? 'var(--danger)' : 'var(--text-muted)' }}>{t.sub}</p>}
                  {t.ok === true && !t.sub && <CheckCircle size={10} className="text-[var(--success)] mt-0.5" />}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
