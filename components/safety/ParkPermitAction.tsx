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
 * ── Вид: разбор 19.09, вторая редакция ────────────────────────────────────
 *
 * Первая редакция красила главную кнопку сплошным `--success` — и это была
 * ошибка ровно того рода, от которой предостерегает §1 языка: цвет нёс НЕ
 * состояние, а название сервиса. Зелёный на Ведаре значит «эко/норма», а не
 * «жми сюда»; к тому же в соседнем блоке МЧС уже стоит яркая кнопка, и два
 * кричащих действия рядом отменяют друг друга — на экран полагается один
 * главный акцент.
 *
 * Теперь зелёный остался там, где он осмыслен, — у иконки и заливки кнопки
 * в 12% (тот же приём, что у телефона МЧС с `--danger` этажом выше), а сама
 * иерархия держится размером и порядком, а не яркостью.
 *
 * Четыре запасных способа уехали в `<details>`: в поле со смартфона стена
 * из адресов и часов работы — это не полнота, а шум. Нативный `<details>`
 * выбран намеренно: он работает без JS и без сети (§8) и доступен с
 * клавиатуры (§10).
 *
 * Блок непрозрачный: это действие, а не контекст (§5). Стекла нет.
 */

import { Leaf, ExternalLink, Ticket, Check } from 'lucide-react';
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

/** Общая геометрия кнопок: 44px — это палец в перчатке и требование §10. */
const BTN =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2.5 ' +
  'text-sm font-semibold transition-all duration-200 hover:shadow-sm';

export default function ParkPermitAction({
  title,
  parkName,
  parkApprovalUrl,
  variant = 'full',
}: Props) {
  // Оба магазина, когда адрес известен. iPhone без подтверждённого адреса —
  // не ссылка наугад, а строка «ищите по названию» ниже (§4.0).
  const stores: Array<{ label: string; href: string }> = [
    { label: 'Android', href: GREEN_BUTTON.androidUrl },
    ...(GREEN_BUTTON.iosUrl ? [{ label: 'iPhone', href: GREEN_BUTTON.iosUrl }] : []),
  ];
  // Зона свободного посещения — не «нет данных», а названный факт парка.
  // Молчать о ней нельзя: турист иначе пойдёт оформлять ненужное разрешение.
  if (isFreeVisitArea(title)) {
    return (
      <p className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden />
        <span>
          <span className="font-semibold text-[var(--text-primary)]">
            Разрешение парка не требуется
          </span>{' '}
          — это зона свободного посещения ({PARK_PERMIT_SOURCE.authority},{' '}
          {PARK_PERMIT_SOURCE.asOf}).
        </span>
      </p>
    );
  }

  if (variant === 'compact') {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-3">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--success)]">
          <Leaf className="h-3.5 w-3.5" aria-hidden />
          {GREEN_BUTTON.name}:
        </span>
        {stores.map((st) => (
          <a
            key={st.label}
            href={st.href}
            target="_blank"
            rel="noopener noreferrer"
            title={`${GREEN_BUTTON.what} — ${st.label}`}
            className="inline-flex min-h-[44px] items-center py-1 text-sm font-semibold text-[var(--success)] hover:underline"
          >
            {st.label}
          </a>
        ))}
      </span>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
        <Ticket className="h-5 w-5 shrink-0 text-[var(--success)]" aria-hidden />
        <div>
          <p className="font-semibold text-[var(--text-primary)]">
            Разрешение на посещение парка
          </p>
          {parkName && (
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{parkName}</p>
          )}
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          {stores.map((st) => (
            <a
              key={st.label}
              href={st.href}
              target="_blank"
              rel="noopener noreferrer"
              className={`${BTN} border border-[var(--success)] text-[var(--success)]`}
              style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
            >
              <Leaf className="h-4 w-4" aria-hidden />
              {GREEN_BUTTON.name} · {st.label}
            </a>
          ))}

          {parkApprovalUrl && (
            <a
              href={parkApprovalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${BTN} border border-[var(--border)] bg-[var(--bg-hover)] font-medium text-[var(--text-primary)]`}
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Согласование маршрута
            </a>
          )}
        </div>

        {/* Одна строка вместо абзаца: что это за кнопка и куда она ведёт.
            Нет адреса под iPhone — сказано прямо, а не ссылкой наугад. */}
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          Приложение парка: разрешение, маршруты, правила
          {GREEN_BUTTON.iosUrl ? '.' : '. Ссылка ведёт в Google Play; для iPhone ищите по названию в App Store.'}
        </p>

        {/* Разрешение парка ≠ регистрация в МЧС. Строка короткая намеренно:
            длинное объяснение в поле не читают, а различие знать надо. */}
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--text-primary)]">
            Это не то же, что регистрация в МЧС:
          </span>{' '}
          парку — право находиться на территории, спасателям — сведения о группе. Нужны оба.
        </p>

        <details className="group border-t border-[var(--border)] pt-3">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center text-xs font-semibold text-[var(--ocean)] transition-opacity duration-200 hover:opacity-80">
            Другие способы получить разрешение
          </summary>
          <ul className="mt-2 space-y-2">
            {PARK_PERMIT_CHANNELS.filter((c) => c.key !== 'green_button').map((channel) => (
              <li key={channel.key} className="text-xs leading-relaxed text-[var(--text-secondary)]">
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
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Источник: {PARK_PERMIT_SOURCE.authority}, {PARK_PERMIT_SOURCE.asOf}
          </p>
        </details>
      </div>
    </div>
  );
}
