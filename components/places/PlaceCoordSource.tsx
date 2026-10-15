import { CircleAlert } from 'lucide-react';
import type { CoordSource } from '@/lib/places/coord-source';

/**
 * Откуда координата места — словами рядом с GPX и путём к месту (15.10, §0).
 *
 * Карточка вела к точке кнопкой «Проложить путь» и файлом GPX одинаково для
 * координаты, снятой на месте, и угаданной геокодером по названию: в базе они
 * лежали неотличимо (lib/places/coord-source.ts). Человек, который идёт по
 * файлу, должен знать, чему он верит.
 *
 * Снятая на месте и взятая из справочника — без строки: это обычный случай, и
 * подпись под каждой карточкой перестала бы читаться.
 */
const LINES: Partial<Record<CoordSource, { text: string; warn: boolean }>> = {
  geocoded: {
    text: 'Координата угадана по названию, а не снята на месте: у цели сверяйтесь с картой и указателями.',
    warn: true,
  },
  placeholder: {
    text: 'Вместо координаты у места стоит заглушка: по этой точке не идите, уточните место у МЧС или оператора.',
    warn: true,
  },
  unknown: {
    text: 'Откуда координата — у нас не записано: снята ли она на месте, неизвестно.',
    warn: false,
  },
};

export default function PlaceCoordSource({ source }: { source: CoordSource | undefined }) {
  const line = source ? LINES[source] : undefined;
  if (!line) return null;
  return (
    <p className={`flex items-start gap-2 py-1 text-xs leading-snug ${line.warn ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]'}`}>
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      {line.text}
    </p>
  );
}
