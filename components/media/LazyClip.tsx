'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, WifiOff } from 'lucide-react';
import { clipHint, clipPolicy, type ClipVerdict } from '@/lib/media/clip-policy';

/**
 * Короткий клип «красота и движ»: ленивый показ.
 *
 * - Пока клип далеко от экрана, ничего не качается: в разметке только
 *   кадр-обложка (poster), `preload="none"` и ни одного `src`. Файл
 *   подключается, когда клип подошёл ближе 300 px к видимой области.
 * - Играет сам, без звука и в цикле, только пока виден хотя бы наполовину, и
 *   останавливается, как только ушёл: невидимое видео не жжёт батарею.
 * - Автоигра уступает человеку и сети (lib/media/clip-policy): меньше движения,
 *   экономия трафика, медленная сеть, офлайн — тогда обложка и кнопка. Нажатое
 *   рукой играет всегда, где есть сеть.
 * - Нет IntersectionObserver (старый браузер) — не гадаем: обложка и кнопка.
 *
 * Звука нет намеренно: клип — петля настроения, а не ролик; полный ролик с
 * управлением и звуком живёт отдельным плеером.
 */
export interface LazyClipProps {
  url: string;
  poster: string;
  /** Что на клипе, словами — для скринридера; видимой подписи не требует. */
  label: string;
  className?: string;
}

interface Net { saveData?: boolean; effectiveType?: string }

function readVerdict(): ClipVerdict {
  const nav = navigator as Navigator & { connection?: Net };
  return clipPolicy({
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    saveData: nav.connection?.saveData === true,
    effectiveType: nav.connection?.effectiveType,
    online: navigator.onLine !== false,
  });
}

export function LazyClip({ url, poster, label, className }: LazyClipProps) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [verdict, setVerdict] = useState<ClipVerdict | null>(null);
  const [hasObserver, setHasObserver] = useState(true);

  useEffect(() => {
    setVerdict(readVerdict());
    const onNet = () => setVerdict(readVerdict());
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);
    return () => {
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
    };
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setHasObserver(false);
      return;
    }
    const nearObs = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) setNear(true); },
      { rootMargin: '300px' },
    );
    const seenObs = new IntersectionObserver(
      (es) => setVisible(es.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5)),
      { threshold: [0, 0.5, 1] },
    );
    nearObs.observe(el);
    seenObs.observe(el);
    return () => { nearObs.disconnect(); seenObs.disconnect(); };
  }, []);

  const auto = verdict?.autoplay === true && hasObserver;
  const wantsFile = tapped || (auto && near);
  const wantsPlay = tapped ? true : auto && visible;

  useEffect(() => {
    const v = video.current;
    if (!v || !wantsFile) return;
    if (wantsPlay) {
      void v.play().catch(() => setPlaying(false));
    } else {
      v.pause();
    }
  }, [wantsFile, wantsPlay]);

  const onTap = useCallback(() => {
    const v = video.current;
    if (!tapped) { setTapped(true); return; }
    if (!v) return;
    if (v.paused) void v.play().catch(() => setPlaying(false)); else v.pause();
  }, [tapped]);

  const offline = verdict?.reason === 'offline';
  const hint = verdict && !verdict.autoplay && !tapped ? clipHint(verdict.reason) : null;
  const showButton = !playing && !offline;

  return (
    <div ref={box} className={`relative overflow-hidden rounded-lg bg-[var(--bg-hover)] ${className ?? ''}`}>
      <video
        ref={video}
        poster={poster}
        muted
        loop
        playsInline
        preload="none"
        aria-label={label}
        className="block w-full h-full object-cover"
        src={wantsFile && !offline ? url : undefined}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {showButton && (
        <button
          type="button"
          onClick={onTap}
          aria-label={`Воспроизвести: ${label}`}
          className="absolute inset-0 flex items-center justify-center bg-black/20 transition-all duration-200 hover:bg-black/30"
        >
          <span className="flex items-center justify-center w-11 h-11 rounded-full backdrop-blur-md bg-black/40 border border-white/15">
            <Play className="w-5 h-5 text-white" aria-hidden />
          </span>
        </button>
      )}
      {offline && (
        <div className="absolute inset-x-0 bottom-0 px-2 py-1 text-[11px] text-white backdrop-blur-md bg-black/40 flex items-center gap-1">
          <WifiOff className="w-3 h-3" aria-hidden /> {hint ?? clipHint('offline')}
        </div>
      )}
      {!offline && hint && showButton && (
        <div className="absolute inset-x-0 bottom-0 px-2 py-1 text-[11px] text-white backdrop-blur-md bg-black/40">{hint}</div>
      )}
    </div>
  );
}
