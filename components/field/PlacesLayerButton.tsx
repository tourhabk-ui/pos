'use client';

/**
 * Тумблер слоя «все места платформы» на полевой карте.
 *
 * Скрин владельца 13.09: экран «На маршруте» показывал ВЫБРАННЫЙ маршрут и
 * поверх него весь реестр мест района — «получается всё в одной карте и очень
 * сложно ориентироваться». Карта поля отвечает на вопрос «куда мне сейчас
 * шагать», а не «что вообще есть на Камчатке»; выбор «куда» делается раньше,
 * на плане, и у него свой поиск.
 *
 * Поэтому по умолчанию слой ВЫКЛЮЧЕН (решение владельца 13.09: «только
 * маршрут»), а этот тумблер возвращает контекст, когда он нужен, и запоминает
 * выбор между запусками.
 *
 * Кнопка одна на оба режима экрана (приборный и «Карта») — не копия, а тот же
 * элемент с тем же состоянием, по образцу FieldActionBar. Две кнопки одного
 * действия расходятся поведением, это уже случалось (#887).
 *
 * Непрозрачная намеренно: это орган управления, а не слой контекста (§2
 * CLAUDE.md — «стекло для контекста, непрозрачность для действия»).
 */

import { Layers } from 'lucide-react';

export interface PlacesLayerButtonProps {
  /** Слой сейчас включён. */
  on: boolean;
  onToggle: () => void;
  /** Тёмный вариант — поверх карты в режиме «Карта», где нет светлой подложки. */
  overMap?: boolean;
}

export function PlacesLayerButton({ on, onToggle, overMap = false }: PlacesLayerButtonProps) {
  const label = on ? 'Скрыть все места на карте' : 'Показать все места на карте';
  const base = overMap
    ? { background: 'rgba(13,17,23,0.85)', color: '#fff', border: '1px solid #30363d' }
    : { background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' };
  const active = { background: 'var(--ocean)', color: '#fff', border: '1px solid var(--ocean)' };

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className="w-11 h-11 rounded-lg flex items-center justify-center transition-all duration-200"
      style={on ? active : base}
    >
      <Layers className="w-5 h-5" />
    </button>
  );
}
