'use client';

/**
 * components/safety/ParkPermitAction.tsx
 *
 * «Зелёная кнопка» и остальные способы получить разрешение на посещение
 * природного парка — одним блоком, из одного источника
 * (lib/safety/park-permit.ts).
 *
 * ── Почему это ОТДЕЛЬНЫЙ блок, а не строка в блоке МЧС ────────────────────
 *
 * Регистрация в МЧС и разрешение парка — две разные обязанности перед двумя
 * разными ведомствами. Турист, сделавший только первое, на кордоне узнаёт об
 * этом от инспектора. Поставить их рядом можно и нужно; слить в одно слово
 * «регистрация» — значит сказать неправду ради компактности.
 *
 * ── Вид ───────────────────────────────────────────────────────────────────
 *
 * Непрозрачный блок на `--bg-card`: это действие, а не контекст (контракт
 * §2). Зелёный `--success` — у иконки и главной кнопки, потому что сервис
 * так и называется, а не ради украшения. Стекла здесь нет.
 */

import { Leaf, ExternalLink, Ticket } from 'lucide-react';
import {
  PARK_PERMIT_CHANNELS,
  PARK_PERMIT_SOURCE,
  GREEN_BUTTON,
  isFreeVisitArea,
} from '@/lib/safety/park-permit';

interface Props {
  /** Название маршрута или места — только чтобы узнать зону свободного посещения. */
  title?: string | null;
  /** Парк, если он известен из данных. Не угадывается. */
  parkName?: string | null;
  /** Ссылка на согласование КОНКРЕТНОГО маршрута, если она есть в БД. */
  parkApprovalUrl?: string | null;
  /** `compact` — одна строка со ссылкой (карточка места); `full` — блок (карточка маршрута). */
  variant?: 'full' | 'compact';
}

export default function ParkPermitAction({
  title,
  parkName,
  parkApprovalUrl,
  variant = 'full',
}: Props) {
  // Зона свободного посещения — не «нет данных», а названный факт парка.
  // Молчать о ней нельзя: турист иначе пойдёт оформлять ненужное разрешение.
  if (isFreeVisitArea(title)) {
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        <span className="font-medium text-[var(--text-primary)]">Разрешение парка не требуется:</span>{' '}
        это зона свободного посещения ({PARK_PERMIT_SOURCE.authority}, {PARK_PERMIT_SOURCE.asOf}).
      </p>
    );
  }

  if (variant === 'compact') {
    return (
      <a
        href={GREEN_BUTTON.androidUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={GREEN_BUTTON.what}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--success)] hover:underline"
      >
        <Leaf className="h-3.5 w-3.5" aria-hidden />
        {GREEN_BUTTON.name}
      </a>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
        <Ticket className="w-5 h-5 flex-shrink-0 text-[var(--success)]" aria-hidden />
        <div>
          <p className="font-semibold text-[var(--text-primary)]">Разрешение на посещение парка</p>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            {parkName ? `${parkName}. ` : ''}Это не то же, что регистрация в МЧС: парку — право
            находиться на территории, спасателям — сведения о группе. Нужны оба.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <a
            href={GREEN_BUTTON.androidUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-all hover:shadow-sm"
            style={{ background: 'var(--success)' }}
          >
            <Leaf className="w-4 h-4" aria-hidden />
            {GREEN_BUTTON.name}
          </a>

          {parkApprovalUrl && (
            <a
              href={parkApprovalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all hover:shadow-sm bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border)]"
            >
              <ExternalLink className="w-4 h-4" aria-hidden />
              Согласование маршрута
            </a>
          )}
        </div>

        {/* «Зелёная кнопка» — приложение, и под iOS адрес у нас не подтверждён.
            Сказать об этом честнее, чем дать ссылку наугад. */}
        <p className="text-xs text-[var(--text-secondary)]">
          {GREEN_BUTTON.what}. Ссылка ведёт в Google Play
          {GREEN_BUTTON.iosUrl ? '' : '; для iPhone ищите приложение по названию в App Store'}.
        </p>

        <div className="pt-3 mt-1 border-t border-[var(--border)]">
          <p className="text-xs font-semibold text-[var(--text-primary)] mb-2">Другие способы</p>
          <ul className="space-y-1.5">
            {PARK_PERMIT_CHANNELS.filter((c) => c.key !== 'green_button').map((channel) => (
              <li key={channel.key} className="text-xs text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">{channel.title}:</span>{' '}
                {channel.href ? (
                  <a
                    href={channel.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--ocean)] hover:underline"
                  >
                    {channel.detail}
                  </a>
                ) : (
                  channel.detail
                )}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-[var(--text-muted)]">
          Источник: {PARK_PERMIT_SOURCE.authority}, {PARK_PERMIT_SOURCE.asOf}
        </p>
      </div>
    </div>
  );
}
