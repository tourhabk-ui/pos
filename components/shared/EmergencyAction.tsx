'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Siren } from 'lucide-react';

/**
 * SOS — единственная реализация на всю платформу.
 *
 * Повод: кнопка жила в трёх местах тремя разными кусками разметки — в
 * `BottomNav` (для /map и /ai-assistant), в инлайновом таб-баре главной и
 * отдельной плавающей кнопкой там же. У копий уже разъехалось поведение в
 * офлайне: одна уводила на /emergency, другая открывала инлайн-панель. Пока
 * копий три, четвёртый экран однажды получит кнопку без офлайн-ветки — и
 * узнаем мы об этом от человека, который не смог позвать помощь.
 *
 * Поэтому: одна кнопка, одно поведение, один сторож
 * (`tests/unit/sos-always-reachable.test.ts`).
 *
 * ОФЛАЙН. Обычная навигация на /sos офлайн падает: страница подтягивается
 * RSC-запросом, которого нет. Два честных запасных пути, оба сохранены:
 *   - `onOfflineFallback` — вызвать инлайн-панель прямо на текущем экране.
 *     Самый надёжный: навигации не происходит вовсе. Так делает главная.
 *   - без него — уход на `/emergency`: страница с нулевыми зависимостями,
 *     лежит в precache service worker'а.
 */

type Variant = 'header' | 'tab';

interface Props {
  /** `header` — пилюля в шапке (по умолчанию), `tab` — пункт нижней навигации. */
  variant?: Variant;
  /**
   * Что делать в офлайне вместо навигации. Если не задано — уходим на
   * `/emergency`. Задавайте там, где на экране есть своя инлайн-панель.
   */
  onOfflineFallback?: () => void;
}

export function EmergencyAction({ variant = 'header', onOfflineFallback }: Props) {
  const router = useRouter();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        e.preventDefault();
        if (onOfflineFallback) onOfflineFallback();
        else router.push('/emergency');
      }
    },
    [router, onOfflineFallback],
  );

  // Тач-цель не меньше 44px в обоих начертаниях: кнопку ищут пальцем, не глядя,
  // в перчатке и на морозе.
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '44px',
    minHeight: '44px',
    color: 'var(--danger)',
    textDecoration: 'none',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  };

  const style: React.CSSProperties =
    variant === 'header'
      ? {
          ...base,
          gap: '6px',
          padding: '0 12px',
          borderRadius: '999px',
          fontSize: '11px',
          border: '1px solid color-mix(in srgb, var(--danger) 45%, transparent)',
          background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
        }
      : {
          ...base,
          flexDirection: 'column',
          gap: '4px',
          fontSize: '8px',
        };

  return (
    <Link
      href="/sos"
      aria-label="SOS — экстренная помощь"
      onClick={handleClick}
      data-emergency-action
      style={style}
    >
      <Siren size={variant === 'header' ? 15 : 18} strokeWidth={2.2} aria-hidden />
      <span>SOS</span>
    </Link>
  );
}

export default EmergencyAction;
