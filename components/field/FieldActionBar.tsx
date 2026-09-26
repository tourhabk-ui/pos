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
  /**
   * Короткое имя для свёрнутого листа — одно слово (макет владельца 24.09:
   * «Карта / Место / Трек / Наблюдение»). Без подписей четыре одинаковых
   * квадрата читались как загадка; полное имя 07.09 съедало карту.
   */
  short?: string;
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
  /**
   * Свёрнутый лист «На маршруте» (владелец 07.09, третий раунд той же
   * жалобы — «занимает очень много места карты», после 60vh→45vh→32vh):
   * панель одна на оба состояния листа (форма 02.09), и подпись+счётчик под
   * каждой кнопкой стабильно добавляли ~35px высоты, которых карте не
   * доставалось. Кружок-кнопка НЕ меняет размер — 56px, «под палец в
   * перчатке», трогать нельзя ни в каком виде; уходит только текст под
   * ним, а имя действия остаётся доступным экранным читалкам aria-label'ом.
   */
  compact?: boolean;
}

export function FieldActionBar({ actions, error, compact }: FieldActionBarProps) {
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className={`flex overflow-x-auto ${compact ? 'gap-2' : 'gap-3 pb-1'}`}
        style={{ scrollbarWidth: 'none' }}>
        {actions.map(a => {
          const badge = a.badge !== null && a.badge !== undefined && a.badge > 0 && (
            <span
              className="absolute -top-1 -right-1 flex items-center justify-center rounded-full text-[11px] font-bold tabular-nums"
              style={{
                minWidth: 20, height: 20, padding: '0 5px',
                background: 'var(--danger)', color: '#FFFFFF',
              }}
            >
              {a.badge}
            </span>
          );
          const tile = {
            background: a.active ? 'var(--accent)' : 'var(--bg-card)',
            border: a.active ? 'none' : '1px solid var(--border)',
            color: a.active ? '#FFFFFF' : 'var(--text-primary)',
            opacity: a.busy ? 0.6 : 1,
          };
          // Свёрнутый лист (владелец 26.09: «место, трек, наблюдение меньше,
          // чтоб не закрывало свёрнутый километраж»): иконка и слово В ОДНУ
          // СТРОКУ внутри плитки высотой ровно TAP. Было — плитка TAP+8 и
          // подпись под ней, ~80 px; стало 56. Цель под перчатку не меньше
          // TAP ни в каком виде: экономия за счёт раскладки, не за счёт пальца.
          // Иконка в строке — 20 px, зазор 4 px: при 24 px и 6 px «Наблюдение»
          // резалось до «Наблюд…» на телефоне шириной 410 px (скрин 26.09).
          if (compact) {
            return (
              <button
                key={a.id}
                onClick={a.onPress}
                disabled={a.busy}
                aria-pressed={a.active ? true : undefined}
                aria-label={a.label}
                className="relative flex items-center justify-center gap-1 shrink-0 rounded-2xl px-1 [&_svg]:w-5 [&_svg]:h-5 [&_svg]:shrink-0"
                style={{ ...tile, flex: '1 1 0', minWidth: 0, height: TAP }}
              >
                {a.icon}
                <span className="text-[11.5px] font-semibold leading-none whitespace-nowrap overflow-hidden text-ellipsis">
                  {a.short ?? a.label}
                </span>
                {badge}
              </button>
            );
          }
          return (
          <button
            key={a.id}
            onClick={a.onPress}
            disabled={a.busy}
            aria-pressed={a.active ? true : undefined}
            className="flex flex-col items-center shrink-0 gap-1.5"
            // Развёрнутая панель делит ширину поровну (24.09, скрин владельца
            // «похож на помойку»): при четырёх действиях 4×84 px с зазорами
            // шире листа, и «Наблюдение» резалось краем экрана до «Наблк».
            // Кружок под палец (TAP) не меняется, делится только ширина под
            // подписью; прокрутка остаётся запасом, если действий станет пять.
            style={{ flex: '1 1 0', minWidth: 72, maxWidth: 96 }}
          >
            <span
              className="relative flex items-center justify-center rounded-2xl"
              style={{
                width: TAP + 8,
                height: TAP + 8,
                ...tile,
              }}
            >
              {a.icon}
              {badge}
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
          );
        })}
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
