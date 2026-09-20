'use client';

/**
 * components/safety/MchsRegistrationBlock.tsx
 *
 * Регистрация туристской группы в МЧС на карточке маршрута.
 *
 * ── Почему блок перестал быть красным (20.09) ─────────────────────────────
 *
 * Он был карточкой в красной рамке в два пикселя, с красной шапкой, красной
 * кнопкой телефона и сплошной красной кнопкой заявки. Красный на Ведаре
 * зарезервирован под тревогу и SOS (§7 языка): когда им покрашена ещё и
 * подготовка к походу, цвет перестаёт означать опасность. На той же странице
 * живёт настоящая красная кнопка — SOS, — и она обязана быть единственной
 * красной вещью в поле зрения.
 *
 * Регистрация — это подготовка, а не происшествие. Поэтому блок спокойный:
 * `--warning` у иконки и разбавленная заливка у действия. Слово «обязательна»
 * при этом осталось, и срок стоит в шапке: строгость несёт текст и порядок,
 * а не яркость.
 *
 * Парой к нему идёт `ParkPermitAction` — разрешение парка. Два блока-близнеца
 * рядом: одна обязанность перед спасателями, вторая перед парком, и ни одна
 * не притворяется другой.
 *
 * ── Почему отдельный файл ─────────────────────────────────────────────────
 *
 * Разметка жила внутри `_RouteDetailClient.tsx` на 2600 строк, и трогать её
 * значило трогать всю карточку. Вынесено ради сторожа: вид проверяется
 * файлом (`tests/unit/mchs-block-design.test.ts`), а не глазами.
 *
 * Факты — только из `lib/safety/mchs-registration`: срок, каналы подачи,
 * состав данных, источник. Своих строк о ведомстве здесь нет.
 */

import Link from 'next/link';
import { ShieldAlert, Phone, FileText } from 'lucide-react';
import {
  MCHS_DEADLINE_SHORT,
  MCHS_CHANNELS,
  MCHS_REQUIRED_DATA,
  MCHS_SOURCE,
} from '@/lib/safety/mchs-registration';

interface Props {
  /** Телефон МЧС для консультации — только если он задан для маршрута в БД. */
  mchsPhone?: string | null;
  parkName?: string | null;
  parkSlug?: string | null;
  /** Открыть форму заявки (модалка живёт в карточке маршрута). */
  onOpenForm: () => void;
}

/** Та же геометрия, что у блока разрешения парка: 44px — палец в перчатке. */
const BTN =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2.5 ' +
  'text-sm font-semibold transition-all duration-200 hover:shadow-sm';

export default function MchsRegistrationBlock({
  mchsPhone,
  parkName,
  parkSlug,
  onOpenForm,
}: Props) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
        <ShieldAlert className="h-5 w-5 shrink-0 text-[var(--warning)]" aria-hidden />
        <div>
          <p className="font-semibold text-[var(--text-primary)]">
            Регистрация в МЧС обязательна
          </p>
          {/* Срок, а не «до выхода». Прежняя формулировка читалась как
              «накануне», и человек опаздывал на неделю: заявка подаётся за
              10 РАБОЧИХ дней до начала. Факт — из модуля, чтобы копия не
              разошлась с остальными. */}
          <p className="mt-0.5 text-xs font-medium text-[var(--warning)]">
            {MCHS_DEADLINE_SHORT}
          </p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onOpenForm}
            className={`${BTN} cursor-pointer border border-[var(--warning)] text-[var(--warning)]`}
            style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)' }}
          >
            <FileText className="h-4 w-4" aria-hidden />
            Заполнить заявку
          </button>

          {mchsPhone && (
            <a
              href={`tel:${mchsPhone.replace(/\D/g, '')}`}
              className={`${BTN} border border-[var(--border)] bg-[var(--bg-hover)] font-medium text-[var(--text-primary)]`}
            >
              <Phone className="h-4 w-4" aria-hidden />
              {mchsPhone}
            </a>
          )}
        </div>

        {parkName && (
          <p className="text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">Природный парк:</span>{' '}
            {parkSlug ? (
              <Link href={`/park/${parkSlug}`} className="text-[var(--ocean)] hover:underline">
                {parkName}
              </Link>
            ) : (
              parkName
            )}
          </p>
        )}

        {/* Три канала подачи и состав данных — под раскрытием. Раньше висели
            простынёй: девять строк мелкого текста под кнопкой. Свёрнуто не
            значит спрятано — если онлайн-форма недоступна, человек обязан
            найти почтовый и очный путь, поэтому они здесь, а не «где-то на
            сайте ведомства». `<details>` работает без JS и без сети (§8). */}
        <details className="border-t border-[var(--border)] pt-3">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center text-xs font-semibold text-[var(--ocean)] transition-opacity duration-200 hover:opacity-80">
            Как подать заявку и что указать
          </summary>

          <ul className="mt-2 space-y-2">
            {MCHS_CHANNELS.map((ch) => (
              <li key={ch.key} className="text-xs leading-relaxed text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">{ch.title}:</span>{' '}
                {ch.href ? (
                  <a
                    href={ch.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--ocean)] hover:underline"
                  >
                    {ch.detail}
                  </a>
                ) : (
                  ch.detail
                )}
              </li>
            ))}
          </ul>

          <p className="mb-1.5 mt-3 text-xs font-semibold text-[var(--text-primary)]">
            Что указать
          </p>
          <ul className="space-y-1">
            {MCHS_REQUIRED_DATA.map((item) => (
              <li key={item} className="text-xs leading-relaxed text-[var(--text-secondary)]">
                — {item}
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Источник: {MCHS_SOURCE.authority}, {MCHS_SOURCE.asOf}
          </p>
        </details>
      </div>
    </div>
  );
}
