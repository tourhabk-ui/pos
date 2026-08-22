'use client';

/**
 * Полоса действий полевого экрана (владелец 22.08, по образцу MAPS.ME).
 *
 * Ряд круглых кнопок с подписями: одно касание — одно действие, ничего не
 * спрятано под меню. Это правильная форма для поля, и брать её у навигатора,
 * который люди уже держат в руках, честнее, чем изобретать свою.
 *
 * Три вещи, которых у образца нет и которые здесь обязательны:
 *
 *  1. Кнопка НЕ показывается, если действие сейчас невозможно: рекордер без
 *     геолокации, «поделиться» без Web Share. Серая неактивная кнопка врёт
 *     не меньше, чем работающая: человек в перчатке жмёт её и решает, что
 *     сломалось приложение.
 *  2. Идущая запись видна не значком, а ЧИСЛАМИ — точки и километры прямо
 *     на кнопке. «Пишется» без цифр неотличимо от «делает вид».
 *  3. Действие может сказать «не смог»: третий исход у каждой кнопки, и он
 *     выводится строкой рядом, а не глотается (§4.0).
 */

import type { ReactNode } from 'react';

/** Полевая цель под палец в перчатке — не меньше 56 px. */
const TAP = 56;

export interface FieldAction {
  id: string;
  label: string;
  icon: ReactNode;
  onPress: () => void;
  /** Действие сейчас идёт (запись трека). */
  active?: boolean;
  /** Строка под подписью: счётчик, состояние. */
  hint?: string | null;
  /** Значок-счётчик в углу, как у образца. */
  badge?: number | null;
  busy?: boolean;
}

export interface FieldActionBarProps {
  actions: FieldAction[];
  /** Отказ последнего действия — словами. */
  error?: string | null;
}

export function FieldActionBar({ actions, error }: FieldActionBarProps) {
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3 overflow-x-auto pb-1"
        style={{ scrollbarWidth: 'none' }}>
        {actions.map(a => (
          <button
            key={a.id}
            onClick={a.onPress}
            disabled={a.busy}
            aria-pressed={a.active ? true : undefined}
            className="flex flex-col items-center gap-1.5 shrink-0"
            style={{ width: 84 }}
          >
            <span
              className="relative flex items-center justify-center rounded-2xl"
              style={{
                width: TAP + 8,
                height: TAP + 8,
                background: a.active ? 'var(--accent)' : 'var(--bg-card)',
                border: a.active ? 'none' : '1px solid var(--border)',
                color: a.active ? '#FFFFFF' : 'var(--text-primary)',
                opacity: a.busy ? 0.6 : 1,
              }}
            >
              {a.icon}
              {a.badge !== null && a.badge !== undefined && a.badge > 0 && (
                <span
                  className="absolute -top-1 -right-1 flex items-center justify-center rounded-full text-[11px] font-bold tabular-nums"
                  style={{
                    minWidth: 20, height: 20, padding: '0 5px',
                    background: 'var(--danger)', color: '#FFFFFF',
                  }}
                >
                  {a.badge}
                </span>
              )}
            </span>
            <span className="text-[11.5px] leading-tight text-center"
              style={{ color: 'var(--text-secondary)' }}>
              {a.label}
            </span>
            {a.hint && (
              <span className="text-[11px] leading-tight text-center tabular-nums"
                style={{ color: a.active ? 'var(--accent)' : 'var(--text-muted)' }}>
                {a.hint}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Отказ говорится словами. Пустое место здесь честнее, чем кнопка,
          которая молча ничего не сделала. */}
      {error && (
        <p className="text-xs leading-snug" style={{ color: 'var(--warning)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
