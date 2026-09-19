'use client';

/**
 * components/places/PlaceFacts.tsx — факты места таблицей, а не пузырями.
 *
 * ── Что было до 14.09 ─────────────────────────────────────────────────────
 *
 * `PlaceCharacteristics` рисовал каждый факт отдельным чипом: иконка, подпись
 * разрядкой, значение и рамка в пиксель вокруг. На телефоне два факта
 * занимали три строки экрана, а вместе с чипами опасностей — половину
 * первого разворота. Владелец про карточку целиком: «это не UX», «всё равно
 * кринж».
 *
 * Причина не в цвете и не в тёмной теме (сверено снимками обеих): всё на
 * карточке было КОРОБКОЙ. Раздел, внутри карточка «Безопасность», внутри неё
 * чип в рамке — три уровня вложенности там, где язык Ведара прямо запрещает
 * карточку в карточке (vedar-design §3).
 *
 * Здесь тот же набор данных — строками «ключ — значение» с волосяными
 * разделителями. Рамок нет вовсе: таблица фактов держится сеткой и
 * типографикой, как ей и положено.
 *
 * ── Что осталось за пределами ─────────────────────────────────────────────
 *
 * Высота, до медпомощи и вместимость раньше рисовались ТРИЖДЫ: в герое, в
 * характеристиках и в блоке безопасности. Теперь единственное место — эта
 * таблица; герой берёт из неё три первых факта, `PlaceSafety` не повторяет
 * ни одного (там осталось только то, что про опасность, а не про место).
 *
 * ── Незнание: уточнение 19.09 (направление D, срез 2) ─────────────────────
 *
 * Правило «не знаем — это отсутствие строки, а не прочерк» остаётся в силе для
 * фактов, чьё отсутствие ничего не обещает: нет высоты — человек просто не
 * узнал высоту.
 *
 * Но у двух фактов отсутствие ЧИТАЕТСЯ КАК ХОРОШАЯ НОВОСТЬ, и молчание тут
 * работает как ложь в пользу места:
 *
 *   • «Сложность» — пустая строка означает для читающего «ничего сложного»;
 *   • «До медпомощи» — пустая означает «видимо, недалеко».
 *
 * Оба нужны, чтобы решить, идти ли и с кем. Поэтому у них третий исход назван
 * СЛОВАМИ — «у нас не записано», — а не выражен пропуском. Это не отмена §4.0,
 * а его исполнение: прочерк по-прежнему запрещён (он читается как ноль),
 * запрещено и молчание там, где оно успокаивает.
 */

import { HAZARD_LABELS, LOCATION_TYPE_LABELS, DIFFICULTY_LABELS } from './types';
import type { PlaceSafety } from './types';

interface Props {
  locationType: string | null;
  zone: string | null;
  safety: PlaceSafety;
  terrainType?: string | null;
}

const ZONE_LABELS: Record<string, string> = {
  avachinsky:    'Авачинский',
  mutnovsky:     'Мутновский',
  klyuchevsky:   'Ключевская группа',
  nalychevo:     'Налычево',
  kronotsky:     'Кроноцкий',
  southern:      'Южная Камчатка',
  central:       'Центральная',
  northern:      'Северная',
  petropavlovsk: 'Петропавловск',
  commander:     'Командорские о-ва',
};

/** Сложность — единственное место, где значение красится: это состояние. */
const DIFFICULTY_TONE: Record<number, string> = {
  1: 'text-[var(--success)]',
  2: 'text-[var(--success)]',
  3: 'text-[var(--warning)]',
  4: 'text-[var(--accent)]',
  5: 'text-[var(--danger)]',
};

interface Fact { label: string; value: string; tone?: string }

/**
 * Тон незнания: приглушённый, но НЕ самый тусклый.
 *
 * `--text-muted` на карточке служит плейсхолдерам, и «не записано» в нём
 * читалось бы как декорация. Здесь это факт о наших данных, который человек
 * должен прочесть, поэтому берётся `--text-secondary` — тише значения, но не
 * шёпотом. Цветом тревоги (`--warning`) незнание тоже не красится: мы не знаем
 * — это не то же самое, что «опасно».
 *
 * Только цвет, без веса: `font-normal` рядом с `font-semibold` в разметке
 * разрешается порядком правил в собранном CSS, а не порядком слов в атрибуте —
 * то есть исход зависел бы от сборки, а не от кода.
 */
const UNKNOWN_TONE = 'text-[var(--text-secondary)]';

export default function PlaceFacts({ locationType, zone, safety, terrainType }: Props) {
  const facts: Fact[] = [];

  facts.push({
    label: 'Тип',
    value: LOCATION_TYPE_LABELS[locationType ?? 'other'] ?? 'Место',
  });

  if (zone) facts.push({ label: 'Район', value: ZONE_LABELS[zone] ?? zone });
  if (terrainType) facts.push({ label: 'Рельеф', value: terrainType });

  if (safety.altitudeM != null) {
    facts.push({ label: 'Высота', value: `${safety.altitudeM.toLocaleString('ru-RU')} м` });
  }

  if (safety.difficultyLevel != null) {
    const d = safety.difficultyLevel;
    facts.push({
      label: 'Сложность',
      value: DIFFICULTY_LABELS[d] ?? String(d),
      tone: DIFFICULTY_TONE[d],
    });
  } else {
    // Пустая «Сложность» читается как «ничего сложного» — см. шапку.
    facts.push({ label: 'Сложность', value: 'у нас не записана', tone: UNKNOWN_TONE });
  }

  if (safety.capacityPerDay != null) {
    facts.push({ label: 'Лимит посещения', value: `${safety.capacityPerDay} человек в сутки` });
  }

  if (safety.nearestMedicalKm != null) {
    facts.push({ label: 'До медпомощи', value: `${safety.nearestMedicalKm} км` });
  } else {
    // Пустая «До медпомощи» читается как «видимо, недалеко» — см. шапку.
    facts.push({ label: 'До медпомощи', value: 'у нас не записано', tone: UNKNOWN_TONE });
  }

  const hazards = safety.hazardTypes
    .map((h) => HAZARD_LABELS[h]?.label ?? h)
    .filter(Boolean);

  if (facts.length === 0 && hazards.length === 0) return null;

  return (
    <dl className="divide-y divide-[var(--border)]">
      {facts.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-sm text-[var(--text-secondary)]">{f.label}</dt>
          <dd className={`text-sm font-semibold text-right ${f.tone ?? 'text-[var(--text-primary)]'}`}>
            {f.value}
          </dd>
        </div>
      ))}

      {/* Опасности — та же строка таблицы, а не россыпь пузырей. Перечисление
          читается быстрее набора плашек и не растёт в высоту экспоненциально:
          у места с шестью опасностями плашки занимали три строки. */}
      {hazards.length > 0 && (
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-sm text-[var(--text-secondary)] shrink-0">Опасности</dt>
          <dd className="text-sm font-semibold text-right text-[var(--warning)]">
            {hazards.join(' · ')}
          </dd>
        </div>
      )}
    </dl>
  );
}
