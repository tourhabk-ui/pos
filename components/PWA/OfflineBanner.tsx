'use client';

/**
 * OfflineBanner — тонкая полоса вверху экрана, когда пропала сеть. Фидбэк с
 * Халактырского пляжа: в поле важно понимать, что приложение работает из кэша
 * и часть данных не обновляется (а не «висит»).
 *
 * ── Правка 08.09: полоса обещала то, чего не знала ─────────────────────────
 *
 * Прежний текст кончался словами «СОС и карта работают», а шапка уверяла, что
 * компонент «ничего не выдумывает». Между тем он не знает ни того, скачан ли
 * пакет карты, ни того, поднялся ли Service Worker, — а без SW не работает ни
 * офлайн-карта, ни очередь СОС, и полевой экран рядом говорит об этом прямо
 * («карта не сохранится, очередь SOS без связи не сработает»).
 *
 * Замер того же дня: на экране «На маршруте» без сети полоса обещала «карта
 * работает», а под ней стояло «Карта не загрузилась». Два утверждения об
 * одном, в один момент, на одном экране.
 *
 * Теперь полоса говорит ровно о том, что видит: сети нет, данные могут
 * устареть. Когда офлайн-контур ТОЧНО не поднялся (`failed`/`unsupported`),
 * она называет и это — не обещанием наоборот, а предупреждением.
 */

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { useSwRegistration } from '@/lib/offline/sw-status';

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const sw = useSwRegistration();

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  // Офлайн-контур точно не поднялся — это важнее общего «данные устареют»:
  // без него не работает ни сохранённая карта, ни очередь СОС.
  const brokenOffline = sw.state === 'failed' || sw.state === 'unsupported';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'sticky',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: 'calc(4px + env(safe-area-inset-top)) 12px 4px',
        background: 'var(--warning)',
        color: '#1A1714',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1.3,
      }}
    >
      <WifiOff size={14} strokeWidth={2} aria-hidden />
      {brokenOffline
        ? 'Офлайн. Офлайн-режим не поднялся — сохранённая карта и очередь СОС могут не сработать.'
        : 'Офлайн — данные могут устареть.'}
    </div>
  );
}

export default OfflineBanner;
