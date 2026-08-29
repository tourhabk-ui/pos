'use client';

/**
 * Сканер QR-эстафеты SOS — кнопка «помочь другому» на экране /sos.
 *
 * Зачем свой сканер, если камера телефона и так читает QR: в панике в поле
 * инструкция «выйди из приложения, открой камеру, наведи, нажми баннер»
 * стоит человеку минут. И главное — штатная камера ведёт в браузер, где
 * наша PWA может быть не установлена, а значит офлайн страница эстафеты
 * не откроется. Из приложения путь короче и надёжнее.
 *
 * Декодер выбирается по наличию, а не по угадыванию платформы:
 * 1. BarcodeDetector — нативный, быстрый (Chrome/Android);
 * 2. jsQR из /safety/jsqr.js — precache SW, работает офлайн (весь iOS/WebKit);
 * 3. ни того ни другого — говорим честно и отправляем к штатной камере,
 *    а не крутим бесполезное окно (§4.0: «не смог» ≠ «нет сигнала»).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, X, MapPin, AlertTriangle } from 'lucide-react';
import { classifyScannedCode, type ScannedCode } from '@/lib/mesh/qr-relay';

type JsQrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: string },
) => { data: string } | null;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

declare global {
  interface Window {
    jsQR?: JsQrFn | { default: JsQrFn };
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

/** Грузит вендоренный jsQR один раз. null — файла нет в кэше и сети (честный исход). */
function ensureJsQr(): Promise<JsQrFn | null> {
  const pick = (): JsQrFn | null => {
    const g = window.jsQR;
    if (!g) return null;
    return typeof g === 'function' ? g : g.default ?? null;
  };
  if (pick()) return Promise.resolve(pick());
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-jsqr]');
    const done = () => resolve(pick());
    if (existing) {
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener('error', () => resolve(null), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = '/safety/jsqr.js';
    s.async = true;
    s.dataset.jsqr = '1';
    s.onload = done;
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

type ScanPhase =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'scanning' }
  | { phase: 'no_camera'; reason: string }
  | { phase: 'no_decoder' }
  | { phase: 'found'; code: ScannedCode };

export function SosQrScanner() {
  const router = useRouter();
  const [state, setState] = useState<ScanPhase>({ phase: 'idle' });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);

  const stopCamera = () => {
    stoppedRef.current = true;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => stopCamera, []);

  const close = () => {
    stopCamera();
    setState({ phase: 'idle' });
  };

  const start = async () => {
    stoppedRef.current = false;
    setState({ phase: 'starting' });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      setState({
        phase: 'no_camera',
        reason: name === 'NotAllowedError'
          ? 'Доступ к камере запрещён. Разрешите его в настройках браузера — или отсканируйте код штатной камерой телефона.'
          : 'Камера недоступна. Отсканируйте код штатной камерой телефона: она откроет ссылку сама.',
      });
      return;
    }
    streamRef.current = stream;

    const video = videoRef.current;
    if (!video) { stopCamera(); return; }
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    try { await video.play(); } catch { /* автоплей отклонён — кадр всё равно придёт */ }

    // Нативный детектор, если есть; иначе вендоренный jsQR (офлайн).
    let detect: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => Promise<string | null>;
    if (typeof window.BarcodeDetector === 'function') {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      detect = async (canvas) => {
        const found = await detector.detect(canvas).catch(() => []);
        return found[0]?.rawValue ?? null;
      };
    } else {
      const jsQR = await ensureJsQr();
      if (!jsQR) {
        stopCamera();
        setState({ phase: 'no_decoder' });
        return;
      }
      detect = async (canvas, ctx) => {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        return res?.data ?? null;
      };
    }

    setState({ phase: 'scanning' });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) { stopCamera(); setState({ phase: 'no_decoder' }); return; }

    const tick = async () => {
      if (stoppedRef.current) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        // Ограничиваем сторону: полный кадр 1080p декодируется заметно дольше,
        // а QR читается и с уменьшенного.
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const text = await detect(canvas, ctx).catch(() => null);
        if (text && !stoppedRef.current) {
          const code = classifyScannedCode(text, window.location.origin);
          if (code.kind === 'sos_relay') {
            stopCamera();
            // Единый путь доставки — та же страница /sos/relay, что и при
            // сканировании штатной камерой. Своя логика доставки здесь не
            // заводится: две копии разойдутся поведением.
            router.push(code.url.replace(window.location.origin, ''));
            return;
          }
          // geo: и мусор — показываем и НЕ выдаём за сигнал бедствия.
          stopCamera();
          setState({ phase: 'found', code });
          return;
        }
      }
      rafRef.current = requestAnimationFrame(() => { void tick(); });
    };
    void tick();
  };

  const active = state.phase !== 'idle';

  return (
    <>
      <button
        type="button"
        onClick={() => { void start(); }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          width: '100%', padding: '12px', borderRadius: '12px',
          background: 'transparent', border: '1px solid rgba(255,255,255,0.25)',
          color: 'rgba(255,255,255,0.85)', fontSize: '14px', fontWeight: 600,
        }}
      >
        <Camera size={16} />
        Сканировать SOS другого туриста
      </button>

      {active && (
        <div
          role="dialog"
          aria-label="Сканирование QR-кода SOS"
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: '#000', display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px' }}>
            <span style={{ color: '#fff', fontSize: '15px', fontWeight: 700 }}>Наведите на QR-код</span>
            <button
              type="button"
              onClick={close}
              aria-label="Закрыть сканер"
              style={{ background: 'transparent', border: 'none', color: '#fff', padding: '4px' }}
            >
              <X size={22} />
            </button>
          </div>

          <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {state.phase === 'scanning' && (
              <div
                aria-hidden
                style={{
                  position: 'absolute', top: '50%', left: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 'min(70vw, 260px)', aspectRatio: '1',
                  border: '3px solid rgba(255,255,255,0.9)', borderRadius: '16px',
                }}
              />
            )}
          </div>

          <div style={{ padding: '16px', background: '#000' }}>
            {state.phase === 'starting' && (
              <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '13px', margin: 0 }}>Включаем камеру…</p>
            )}

            {state.phase === 'scanning' && (
              <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
                Держите код в рамке. Работает без интернета — сигнал сохранится
                на вашем телефоне и уйдёт, когда появится связь.
              </p>
            )}

            {state.phase === 'no_camera' && (
              <p style={{ color: 'var(--warning)', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
                {state.reason}
              </p>
            )}

            {state.phase === 'no_decoder' && (
              <p style={{ color: 'var(--warning)', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
                Этот браузер не умеет читать коды, а офлайн-декодер не загружен.
                Отсканируйте код штатной камерой телефона — она откроет ссылку сама.
              </p>
            )}

            {state.phase === 'found' && state.code.kind === 'geo' && (
              <div style={{ color: '#fff', fontSize: '13px', lineHeight: 1.6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                  <MapPin size={15} /> Код с координатами (не сигнал SOS)
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '15px', margin: '6px 0' }}>
                  {state.code.lat.toFixed(5)}, {state.code.lng.toFixed(5)}
                </div>
                <a
                  href={`geo:${state.code.lat},${state.code.lng}`}
                  style={{ color: 'var(--ocean)' }}
                >
                  Открыть в картах
                </a>
              </div>
            )}

            {state.phase === 'found' && state.code.kind === 'unknown' && (
              <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: '13px', lineHeight: 1.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--warning)' }}>
                  <AlertTriangle size={15} /> Это не код эстафеты SOS
                </div>
                <p style={{ margin: '6px 0 0', wordBreak: 'break-all', color: 'rgba(255,255,255,0.6)' }}>
                  {state.code.text.slice(0, 120)}
                </p>
              </div>
            )}

            {(state.phase === 'found' || state.phase === 'no_camera' || state.phase === 'no_decoder') && (
              <button
                type="button"
                onClick={() => { void start(); }}
                style={{
                  marginTop: '12px', width: '100%', padding: '10px',
                  borderRadius: '10px', border: '1px solid rgba(255,255,255,0.25)',
                  background: 'transparent', color: '#fff', fontSize: '13px', fontWeight: 600,
                }}
              >
                Сканировать ещё раз
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
