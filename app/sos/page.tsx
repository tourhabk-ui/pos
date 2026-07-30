'use client';

import { useState, useEffect, useRef } from 'react';
import { MapPin, Phone, Loader2, CheckCircle, AlertTriangle, WifiOff, RotateCw } from 'lucide-react';
import { queueSOS, registerSOSSync } from '@/lib/offline/pending-queue';
import { SatelliteDictationCard } from '@/components/safety/SatelliteDictationCard';
import { MeshStatusWidget } from '@/components/mesh/MeshStatusWidget';
import { useMesh } from '@/hooks/use-mesh';
import LottiePlayer from '@/components/ui/LottiePlayer';
import { EMERGENCY_NUMBERS } from '@/lib/safety/emergency-numbers';

type SendStatus = 'idle' | 'locating' | 'sending' | 'sent' | 'queued' | 'error';

// Единый источник номеров — работает офлайн, без зависимостей (см. lib/safety/emergency-numbers.ts)
const SOS_CONTACTS = EMERGENCY_NUMBERS;

// ── Общий модуль семантики деградации GPS (public/safety/geo-degradation.js) ──
// Тот же модуль обслуживает /emergency. Единственный источник поведения при
// недоступной геолокации: /sos и /emergency больше не расходятся (#897).
type GeoErrorInfo = { code: number | string; reason: string; hint: string; retryable: boolean };

type LocatorState =
  | { phase: 'locating'; seconds: number }
  | { phase: 'found'; seconds: number; coords: { lat: number; lng: number; acc: number; timestamp: number | null } }
  | { phase: 'error'; seconds: number; error: GeoErrorInfo };

type LastKnown = {
  lat: number; lng: number; acc: number | null; t: number;
  minsAgo: number; ageLabel: string; distanceKm?: number; distanceLabel?: string;
};

interface VedarGeoAPI {
  LAST_POS_KEY: string;
  readLastKnown: (now?: number) => LastKnown | null;
  attachDistance: (last: LastKnown | null, curLat: number | null, curLng: number | null) => LastKnown | null;
  progressLabel: (seconds: number) => string;
  createLocator: (opts: { onState: (s: LocatorState) => void; onFix?: (p: GeolocationPosition) => void })
    => { start: () => void; retry: () => void; stop: () => void };
}

declare global {
  interface Window { VedarGeo?: VedarGeoAPI }
}

/**
 * Гарантирует, что общий модуль загружен, и отдаёт его API. Файл лежит в
 * CRITICAL_URLS precache, поэтому доступен и офлайн (через service worker).
 */
function ensureGeoModule(): Promise<VedarGeoAPI | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.VedarGeo) return Promise.resolve(window.VedarGeo);
  return new Promise((resolve) => {
    const done = () => resolve(window.VedarGeo ?? null);
    const existing = document.querySelector<HTMLScriptElement>('script[data-vedar-geo]');
    if (existing) {
      existing.addEventListener('load', done);
      existing.addEventListener('error', () => resolve(null));
      if (window.VedarGeo) done();
      return;
    }
    const s = document.createElement('script');
    s.src = '/safety/geo-degradation.js';
    s.async = true;
    s.setAttribute('data-vedar-geo', '');
    s.onload = done;
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

export default function SosPage() {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [coordsText, setCoordsText] = useState('Определяем...');
  const [geoError, setGeoError] = useState<GeoErrorInfo | null>(null);
  const [lastKnown, setLastKnown] = useState<LastKnown | null>(null);
  const [sendStatus, setSendStatus] = useState<SendStatus>('idle');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const locatorRef = useRef<{ start: () => void; retry: () => void; stop: () => void } | null>(null);

  // VolcanoMesh: соседние устройства группы. Включается при появлении
  // координат. Если сеть есть у соседа, а не у нас — SOS уйдёт через него.
  const {
    status: meshStatus,
    peers: meshPeers,
    relayedCount: meshRelayedCount,
    sendSOS: meshSendSOS,
  } = useMesh(!!coords, coords);

  // Поиск координат через общий модуль — та же честная деградация, что на
  // /emergency: прогресс поиска, причина отказа (code 1/2/3), повтор и
  // последняя известная позиция ТОЛЬКО когда она реально есть (#897).
  useEffect(() => {
    let cancelled = false;
    void ensureGeoModule().then((api) => {
      if (cancelled) return;
      if (!api) {
        // Модуль не загрузился — честно говорим, что не ищем, а не «Определяем…».
        setGeoError({ code: 'unsupported', reason: 'GPS недоступен', hint: 'Позвони 112 напрямую', retryable: false });
        return;
      }
      // Последнюю позицию показываем только если она реально существует.
      setLastKnown(api.readLastKnown() ?? null);
      const locator = api.createLocator({
        onState: (s) => {
          if (cancelled) return;
          if (s.phase === 'locating') {
            setGeoError(null);
            setCoordsText(api.progressLabel(s.seconds));
          } else if (s.phase === 'found') {
            setGeoError(null);
            setCoords({ lat: s.coords.lat, lng: s.coords.lng });
            setCoordsText(`${s.coords.lat.toFixed(5)}°N, ${s.coords.lng.toFixed(5)}°E`);
            const fresh = api.readLastKnown();
            setLastKnown(fresh ? api.attachDistance(fresh, s.coords.lat, s.coords.lng) : null);
          } else if (s.phase === 'error') {
            setGeoError(s.error);
          }
        },
      });
      locatorRef.current = locator;
      locator.start();
    });
    return () => { cancelled = true; locatorRef.current?.stop(); };
  }, []);

  const retryGeo = () => {
    setGeoError(null);
    setCoordsText('Определяем...');
    locatorRef.current?.retry();
  };

  const handleSendSos = async () => {
    if (sendStatus === 'sending' || sendStatus === 'sent') return;
    setSendStatus('locating');

    let position: GeolocationPosition | null = null;
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 8000,
            maximumAge: 0,
          });
        });
        setCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
      } catch { /* координаты недоступны — отправляем без них */ }
    }

    setSendStatus('sending');

    const sosPayload = {
      lat: position?.coords.latitude ?? null,
      lng: position?.coords.longitude ?? null,
      accuracy: position?.coords.accuracy ?? null,
      tourist_name: name.trim() || null,
      tourist_phone: phone.trim() || null,
    };

    try {
      const res = await fetch('/api/safety/sos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sosPayload),
      });
      if (res.status === 429) { setSendStatus('error'); return; }
      setSendStatus('sent');
    } catch {
      // Прямой путь мёртв (офлайн/обрыв). Две страховки параллельно:
      // 1) меш — сосед с живой сетью ретранслирует немедленно;
      // 2) офлайн-очередь — отправка при появлении своей сети.
      // Меш НЕ зовём при успехе прямого пути — иначе каждый онлайн-SOS
      // приходил бы спасателям дважды (прямой + через соседа).
      try {
        meshSendSOS(sosPayload);
      } catch { /* меш не должен ломать офлайн-очередь */ }
      try {
        await queueSOS(sosPayload);
        const synced = await registerSOSSync();
        setSendStatus(synced ? 'queued' : 'error');
      } catch {
        setSendStatus('error');
      }
    }
  };

  const smsBody = coords
    ? `SOS! Мне нужна помощь. Мои координаты: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)} — vedarai.ru`
    : 'SOS! Мне нужна помощь — vedarai.ru';

  return (
    <div style={{
      minHeight: '100dvh',
      background: '#0a0a0a',
      color: 'white',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Шапка */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid rgba(239,68,68,0.3)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}>
        <div style={{ position: 'relative', width: '80px', height: '80px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <LottiePlayer src="/animations/sos-pulse.json" width={80} height={80} style={{ position: 'absolute', inset: 0 }} />
          <div style={{
            position: 'relative', zIndex: 1,
            width: '36px', height: '36px',
            borderRadius: '50%',
            background: 'var(--danger)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '11px', fontWeight: 800, letterSpacing: '0.05em',
          }}>
            SOS
          </div>
        </div>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>Экстренная помощь</h1>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', margin: 0 }}>
            Звонки и координаты — без интернета
          </p>
        </div>
      </div>

      <div style={{ flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

        {/* Координаты — честная деградация: прогресс, причина отказа, повтор */}
        <div style={{
          padding: '12px 16px',
          borderRadius: '12px',
          background: geoError
            ? 'color-mix(in srgb, var(--warning) 10%, transparent)'
            : 'color-mix(in srgb, var(--ocean) 10%, transparent)',
          border: geoError
            ? '1px solid color-mix(in srgb, var(--warning) 30%, transparent)'
            : '1px solid color-mix(in srgb, var(--ocean) 30%, transparent)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <MapPin size={18} style={{ color: geoError ? 'var(--warning)' : 'var(--ocean)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Ваши координаты
            </p>
            {geoError ? (
              <>
                <p style={{ fontSize: '14px', fontWeight: 700, margin: '2px 0 0', color: 'white' }}>
                  {geoError.reason}
                </p>
                <p style={{ fontSize: '11px', margin: '2px 0 0', color: 'rgba(255,255,255,0.5)', lineHeight: 1.4 }}>
                  {geoError.hint}
                </p>
              </>
            ) : (
              <p style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'monospace', margin: '2px 0 0', color: 'white' }}>
                {coordsText}
              </p>
            )}
          </div>
          {geoError && (
            <button
              onClick={retryGeo}
              aria-label="Повторить поиск координат"
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                minHeight: '44px',
                padding: '0 12px',
                borderRadius: '10px',
                border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
                background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                color: 'white',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              <RotateCw size={14} />
              Повторить
            </button>
          )}
        </div>

        {/* Последняя известная позиция — рендерится ТОЛЬКО когда она реально
            есть (readLastKnown вернул точку). Никакого обещания при её отсутствии. */}
        {lastKnown && (
          <div style={{
            padding: '10px 14px',
            borderRadius: '12px',
            background: 'color-mix(in srgb, var(--success) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)',
          }}>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Последний сигнал сети
            </p>
            <p style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'monospace', margin: '2px 0 0', color: 'var(--success)' }}>
              {lastKnown.lat.toFixed(5)}, {lastKnown.lng.toFixed(5)}
            </p>
            <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', margin: '2px 0 0', lineHeight: 1.4 }}>
              {lastKnown.ageLabel}{lastKnown.distanceLabel ? ` · ~${lastKnown.distanceLabel} от тебя` : ''} — не текущее место, а где была связь
            </p>
          </div>
        )}

        {/* Меш-статус: сколько устройств группы рядом, ретрансляции SOS */}
        <MeshStatusWidget status={meshStatus} peers={meshPeers} relayedCount={meshRelayedCount} />

        {/* 4 шага — прямо на экране, человек в панике не уйдёт читать */}
        <div style={{
          padding: '14px 16px',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' }}>
            Что делать
          </p>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { n: 1, text: 'Нажми кнопку «Отправить координаты» ниже', color: 'var(--danger)' },
              { n: 2, text: 'Позвони 112 — назови координаты с экрана', color: 'var(--danger)' },
              { n: 3, text: 'Нет голоса — отправь SMS (кнопка «Без интернета»)', color: 'var(--warning)' },
              { n: 4, text: 'Не уходи с места — спасатели ищут от точки последней связи', color: 'var(--warning)' },
            ].map(({ n, text, color }) => (
              <li key={n} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <span style={{
                  flexShrink: 0, width: '20px', height: '20px',
                  borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '10px', fontWeight: 800, background: `color-mix(in srgb, ${color} 20%, transparent)`,
                  color,
                }}>{n}</span>
                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', lineHeight: 1.5, paddingTop: '2px' }}>{text}</span>
              </li>
            ))}
          </ol>
          <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', margin: '12px 0 0', lineHeight: 1.5 }}>
            Приложение не заменяет спутниковый трекер. SMS и SOS уйдут только при наличии сотового сигнала.
          </p>
        </div>

        {/* Данные + кнопка отправки */}
        <div style={{
          padding: '14px 16px',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div>
              <label style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '4px' }}>
                Ваше имя
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Имя"
                disabled={sendStatus === 'sending' || sendStatus === 'sent'}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.05)',
                  color: 'white',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '4px' }}>
                Телефон
              </label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="+7..."
                disabled={sendStatus === 'sending' || sendStatus === 'sent'}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.05)',
                  color: 'white',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
            </div>
          </div>

          {/* Кнопка отправки координат */}
          <button
            onClick={handleSendSos}
            disabled={sendStatus === 'sending' || sendStatus === 'locating' || sendStatus === 'sent' || sendStatus === 'queued'}
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: '10px',
              border: 'none',
              background: sendStatus === 'sent' ? 'var(--success)'
                : sendStatus === 'queued' ? 'var(--ocean)'
                : sendStatus === 'error' ? 'var(--warning)'
                : sendStatus === 'sending' || sendStatus === 'locating' ? 'color-mix(in srgb, var(--danger) 50%, transparent)'
                : 'var(--danger)',
              color: 'white',
              fontWeight: 700,
              fontSize: '14px',
              cursor: sendStatus === 'sending' || sendStatus === 'locating' || sendStatus === 'sent' || sendStatus === 'queued' ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              transition: 'all 0.15s',
            }}
          >
            {(sendStatus === 'locating' || sendStatus === 'sending') && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />}
            {sendStatus === 'sent' && <CheckCircle size={16} />}
            {sendStatus === 'queued' && <WifiOff size={16} />}
            {sendStatus === 'error' && <AlertTriangle size={16} />}
            {sendStatus === 'idle' && 'Отправить координаты в Telegram'}
            {sendStatus === 'locating' && 'Определяю координаты...'}
            {sendStatus === 'sending' && 'Отправляю...'}
            {sendStatus === 'sent' && 'Координаты отправлены'}
            {sendStatus === 'queued' && 'Сохранено — отправим при появлении сети'}
            {sendStatus === 'error' && 'Ошибка — позвоните 112 напрямую'}
          </button>

          {/* SMS с координатами (без интернета).
              112 официально принимает SMS во всех сетях РФ — раньше здесь
              стоял плейсхолдер +79000000000, сигнал бедствия уходил в никуда. */}
          {coords && (
            <a
              href={`sms:112?body=${encodeURIComponent(smsBody)}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                width: '100%',
                marginTop: '8px',
                padding: '10px',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.05)',
                color: 'white',
                fontWeight: 600,
                fontSize: '13px',
                textDecoration: 'none',
              }}
            >
              SMS с координатами (без интернета)
            </a>
          )}
        </div>

        {/* Экстренные номера */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>
            Экстренные номера
          </p>
          {SOS_CONTACTS.map((c) => (
            <a
              key={c.phone}
              href={`tel:${c.phone.replace(/\s/g, '')}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: c.primary ? '14px' : '12px',
                borderRadius: '12px',
                background: c.primary ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'rgba(255,255,255,0.04)',
                border: c.primary ? '1px solid color-mix(in srgb, var(--danger) 30%, transparent)' : '1px solid rgba(255,255,255,0.08)',
                textDecoration: 'none',
                color: 'white',
              }}
            >
              <div style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: c.primary ? 'color-mix(in srgb, var(--danger) 20%, transparent)' : 'rgba(255,255,255,0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Phone size={16} color={c.primary ? 'var(--danger)' : 'rgba(255,255,255,0.5)'} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: c.primary ? '14px' : '13px', fontWeight: 600, marginBottom: '1px' }}>
                  {c.name}
                </div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {c.type}
                </div>
              </div>
              <div style={{
                fontSize: c.primary ? '18px' : '14px',
                fontWeight: 700,
                fontFamily: 'monospace',
                flexShrink: 0,
                color: c.primary ? 'var(--danger)' : 'white',
              }}>
                {c.phone}
              </div>
            </a>
          ))}
        </div>

        {/* Инструкции выживания — офлайн, всегда доступны */}
        <a
          href="/safety/offline"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '14px 16px',
            borderRadius: '12px',
            background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--warning) 25%, transparent)',
            textDecoration: 'none',
            color: 'white',
          }}
        >
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            background: 'color-mix(in srgb, var(--warning) 15%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <AlertTriangle size={18} color="var(--warning)" />
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '2px' }}>
              Что делать если... (офлайн)
            </div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)' }}>
              Медведь · Травма · Потерялся · Переохлаждение · Вулкан
            </div>
          </div>
        </a>


        {/* Карточка диктовки через спутниковый телефон */}
        <SatelliteDictationCard
          coords={coords}
          touristPhone={phone}
        />

        {/* Хаб безопасности — погода, вулканы, сейсмика, AI спасатель */}
        <a
          href="/hub/safety"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '12px 16px',
            borderRadius: '12px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'rgba(255,255,255,0.7)',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '13px',
          }}
        >
          Вулканы · Погода · AI Спасатель
        </a>


        {/* Регистрация маршрута */}
        <a
          href="/register"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '12px 16px',
            borderRadius: '12px',
            background: 'color-mix(in srgb, var(--ocean) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--ocean) 30%, transparent)',
            color: 'white',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '13px',
          }}
        >
          Зарегистрировать маршрут перед выходом
        </a>

        {/* Памятка */}
        <div style={{
          padding: '12px 16px',
          borderRadius: '12px',
          background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--warning) 20%, transparent)',
        }}>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', margin: 0, lineHeight: 1.6 }}>
            <AlertTriangle size={12} className="inline mr-1" />Если нет связи: оставайтесь на месте · свисток 3 сигнала · сохраняйте тепло
          </p>
        </div>
      </div>

      <style>{`
        @keyframes sos-pulse {
          0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 60%, transparent); }
          70% { box-shadow: 0 0 0 12px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
