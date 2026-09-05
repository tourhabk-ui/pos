'use client';

/**
 * components/field/FieldCoords.tsx — координаты в приборном ряду.
 *
 * Владелец 05.09: «хочу видеть координаты». Две строки, обе — показания, не
 * действия (§2 CLAUDE.md: прибор непрозрачный, как компас и кнопки масштаба):
 *
 *   «Я»      — координаты фикса GPS. Нет фикса — так и написано, число не
 *              подставляется ниоткуда (§4.0: незнание не заполняется).
 *   «Центр»  — координаты центра карты, но ТОЛЬКО когда человек сдвинул
 *              карту от себя дальше CENTER_APART_M: пока центр — это он сам,
 *              вторая строка повторяла бы первую и только отвлекала. Это
 *              способ снять координату места без GPS: подвести перекрестье
 *              и прочитать.
 *
 * Тап по строке копирует её в буфер: координаты в поле нужны, чтобы их
 * передать — спасателям, товарищу, чужому навигатору. Кнопка формата
 * переключает DD ↔ DMS для обеих строк сразу; выбор помнится в
 * localStorage, потому что тот, кто диктует МЧС, диктует в одном формате
 * всегда. Форматы — lib/geo/format-coords, одни на экран и на буфер.
 */

import { useCallback, useEffect, useState } from 'react';
import { Crosshair, LocateFixed } from 'lucide-react';
import { distanceM, formatCoords, type CoordFormat, type LatLng } from '@/lib/geo/format-coords';

/** Дальше этого центр карты считается «другим местом», а не «я». */
export const CENTER_APART_M = 30;
const FORMAT_KEY = 'vedar:coord-format';

export interface FieldCoordsProps {
  /** Фикс GPS; null — фикса нет. */
  fix: LatLng | null;
  /** Центр карты; null — карта ещё не поднялась. */
  center: LatLng | null;
}

/** Показывать ли строку центра: карта поднята и сдвинута от человека (или фикса нет). */
export function centerRowVisible(fix: LatLng | null, center: LatLng | null): boolean {
  if (!center) return false;
  if (!fix) return true;
  return distanceM(fix, center) > CENTER_APART_M;
}

function readFormat(): CoordFormat {
  try {
    return window.localStorage.getItem(FORMAT_KEY) === 'dms' ? 'dms' : 'dd';
  } catch {
    return 'dd';
  }
}

export function FieldCoords({ fix, center }: FieldCoordsProps) {
  const [format, setFormat] = useState<CoordFormat>('dd');
  const [copied, setCopied] = useState<'fix' | 'center' | null>(null);
  useEffect(() => { setFormat(readFormat()); }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const toggleFormat = useCallback(() => {
    setFormat((f) => {
      const next: CoordFormat = f === 'dd' ? 'dms' : 'dd';
      try { window.localStorage.setItem(FORMAT_KEY, next); } catch { /* приватный режим — формат не запомнится, и только */ }
      return next;
    });
  }, []);

  const copy = useCallback(async (which: 'fix' | 'center', p: LatLng) => {
    try {
      await navigator.clipboard?.writeText(formatCoords(p, format));
      setCopied(which);
    } catch {
      // Буфер недоступен (старый браузер, запрет) — число остаётся на
      // экране, его можно продиктовать; молча делать вид, что скопировали, нельзя.
      setCopied(null);
    }
  }, [format]);

  const showCenter = centerRowVisible(fix, center);
  const box = {
    borderRadius: 12,
    background: 'var(--bg-card)', color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  } as const;
  const row = (which: 'fix' | 'center', Icon: typeof LocateFixed, label: string, p: LatLng | null) => (
    <button type="button" key={which}
      onClick={() => { if (p) void copy(which, p); }}
      disabled={!p}
      aria-label={p ? `${label}: ${formatCoords(p, format)} — скопировать` : `${label}: нет фикса`}
      className="flex items-center gap-2 px-3 text-left"
      style={{ minHeight: 44, width: '100%', background: 'transparent', color: 'inherit' }}>
      <Icon className="w-4 h-4 shrink-0" style={{ color: p ? 'var(--ocean)' : 'var(--text-muted)' }} />
      <span className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {copied === which ? 'Скопировано' : label}
        </span>
        <span className="text-xs tabular-nums" style={{ color: p ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          {p ? formatCoords(p, format) : 'нет фикса'}
        </span>
      </span>
    </button>
  );
  return (
    <div style={{ ...box, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {row('fix', LocateFixed, 'Я', fix)}
      {showCenter && center && row('center', Crosshair, 'Центр карты', center)}
      <button type="button" onClick={toggleFormat}
        aria-label={format === 'dd' ? 'Показать в градусах, минутах и секундах' : 'Показать в десятичных градусах'}
        className="text-[10px] font-semibold uppercase tracking-wider px-3"
        style={{ minHeight: 32, borderTop: '1px solid var(--border)', color: 'var(--ocean)', background: 'transparent' }}>
        {format === 'dd' ? 'Град · мин · сек' : 'Десятичные'}
      </button>
    </div>
  );
}
