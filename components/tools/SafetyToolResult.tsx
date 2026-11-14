'use client';

/**
 * Результат «Анализатора безопасности» (/tools/safety) — из блоков карточек.
 *
 * Своей оценки у инструмента нет (слово владельца 14.11). Место показано теми
 * же блоками, что на его карточке: обстановка дня (`PlaceRealtimeStatus`),
 * опасности, совет Кузьмича из данных (`PlaceKuzmich`), «Что знать»
 * (`PlaceSafety`, с кнопкой 112). Маршрут — тем же блоком оценки дня, что на
 * его карточке (`RouteVerdict`). Две оценки одного дня на двух экранах человек
 * сверяет — и перестаёт верить обеим.
 *
 * Исходов у кнопки GPS четыре, и ни один не выдаётся за другой: место рядом,
 * ближайшее место далеко (оценки нет), человек вне края, мест в базе нет.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import PlaceRealtimeStatus from '@/components/places/PlaceRealtimeStatus';
import PlaceHazardsUnknown from '@/components/places/PlaceHazardsUnknown';
import VolcanoAccBadge from '@/components/places/VolcanoAccBadge';
import PlaceKuzmich from '@/components/places/PlaceKuzmich';
import PlaceSafety from '@/components/places/PlaceSafety';
import RouteVerdict, { type VerdictResponse } from '@/components/routes/RouteVerdict';
import { HazardBadgeStrip, HazardPhraseList } from '@/components/shared/HazardBadgeStrip';
import { EmergencyCallLine } from '@/components/safety/EmergencyCallLine';
import { advisoryForPlace } from '@/lib/kuzmich/place-advisory';
import { ownPermitOf, permitNotRequired } from '@/lib/places/own-permit';
import { placeTypeLabel } from '@/lib/places/type-label';
import { NEAREST_PLACE_MAX_KM } from '@/lib/places/nearest-limit';
import type {
  PlaceEco, PlaceRealtime, PlaceSafety as SafetyData, VolcanoAccStatus,
} from '@/components/places/types';

export interface ToolPlace {
  id: string;
  name: string;
  locationType: string | null;
  safety: SafetyData;
  realtime: PlaceRealtime | null;
  volcanoStatus: VolcanoAccStatus | null;
  eco: PlaceEco | null;
}

export interface ToolNearest {
  id: string;
  slug: string | null;
  name: string;
  locationType: string | null;
  distanceKm: number;
}

export type SafetyToolAnswer =
  /** `distanceKm` — только у ответа на GPS: сколько от человека до места. */
  | { kind: 'place'; distanceKm: number | null; place: ToolPlace }
  | { kind: 'far'; nearest: ToolNearest }
  | { kind: 'outside' }
  | { kind: 'none' }
  | {
    kind: 'route';
    route: { cardId: string; title: string; hazards: string[]; registrationRequired: boolean };
    verdict: VerdictResponse['verdict'];
    signals: VerdictResponse['signals'];
  };

/**
 * Пересчёта у места нет вовсе — блок обстановки скажет это своими словами
 * («Обстановку сейчас не знаем»), а не исчезнет: у инструмента это главный
 * ответ, и пустое место читалось бы как «всё спокойно».
 */
const NO_REALTIME: PlaceRealtime = {
  isOpen: null, currentCrowds: null, currentWeather: null, activeAlerts: null,
  alertSeverity: null, alertMessage: null, touristsToday: null, touristsHour: null,
  status: null, linkedVolcanoes: null, updatedAt: null,
};

const HAZARDS_UNKNOWN_ROUTE =
  'Опасности этого маршрута у нас не записаны — это не значит, что их нет. Спросите МЧС и оператора перед выходом.';

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--text-muted)] font-bold mb-1">{children}</p>
  );
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 min-h-[44px] text-sm font-medium text-[var(--ocean)] hover:text-[var(--accent)] transition-colors"
    >
      {children}
      <ArrowRight size={14} aria-hidden="true" />
    </Link>
  );
}

/** Сколько от человека до места — словами, без ложной точности. */
export function distanceWords(km: number): string {
  return km < 1 ? 'меньше километра от вас' : `в ${km} км от вас`;
}

function PlaceResult({ place, distanceKm }: { place: ToolPlace; distanceKm: number | null }) {
  const realtime = place.realtime ?? NO_REALTIME;
  return (
    <>
      <header>
        <Eyebrow>{placeTypeLabel(place.locationType) ?? 'Место'}</Eyebrow>
        <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">{place.name}</h2>
        {distanceKm != null && (
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Ближайшее к вам место в нашей базе — {distanceWords(distanceKm)}. Оценка ниже относится к этому
            месту, а не к точке, где вы стоите.
          </p>
        )}
        <CardLink href={`/places/${place.id}`}>Открыть карточку места</CardLink>
      </header>

      <PlaceRealtimeStatus
        realtime={realtime}
        isVolcano={place.locationType === 'volcano'}
        volcanoColor={place.volcanoStatus?.colorCode ?? null}
      />

      {(place.safety.hazardTypes.length > 0 || place.safety.registrationRequired) && (
        <HazardPhraseList hazards={place.safety.hazardTypes} mchsRequired={place.safety.registrationRequired} />
      )}
      <PlaceHazardsUnknown hazards={place.safety.hazardTypes} source={place.safety.source} />

      {place.volcanoStatus && <VolcanoAccBadge status={place.volcanoStatus} />}

      <PlaceKuzmich
        placeId={place.id}
        placeName={place.name}
        kuzmichReview={null}
        advisory={advisoryForPlace(place)}
      />

      <section>
        <h3 className="font-playfair text-xl font-bold text-[var(--text-primary)] mb-3">Что знать</h3>
        <PlaceSafety
          safety={place.safety}
          placeId={place.id}
          ownPermit={ownPermitOf(place.eco)}
          permitFree={permitNotRequired(place.eco)}
        />
      </section>
    </>
  );
}

function RouteResult({ answer }: { answer: Extract<SafetyToolAnswer, { kind: 'route' }> }) {
  const { route } = answer;
  const hasHazards = route.hazards.length > 0;
  return (
    <>
      <header>
        <Eyebrow>Маршрут</Eyebrow>
        <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">{route.title}</h2>
        <CardLink href={`/routes/${route.cardId}`}>Открыть карточку маршрута</CardLink>
      </header>

      {/* Та же оценка дня, что на карточке маршрута; данные уже пришли — второго запроса нет. */}
      <RouteVerdict routeId="" data={{ verdict: answer.verdict, signals: answer.signals }} />

      {(hasHazards || route.registrationRequired) && (
        <HazardBadgeStrip hazards={route.hazards} mchsRequired={route.registrationRequired} />
      )}
      {!hasHazards && <p className="text-sm text-[var(--text-muted)]">{HAZARDS_UNKNOWN_ROUTE}</p>}

      <EmergencyCallLine />
    </>
  );
}

function FarResult({ nearest }: { nearest: ToolNearest }) {
  return (
    <>
      <header>
        <Eyebrow>Рядом с вами</Eyebrow>
        <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">
          Что там, где вы стоите, мы не знаем
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          В пределах {NEAREST_PLACE_MAX_KM} км от вас мест в нашей базе нет. Ближайшее — {nearest.name},{' '}
          {distanceWords(nearest.distanceKm)}: его оценка к вашей точке не относится, поэтому мы её здесь не
          показываем.
        </p>
        <div className="flex flex-wrap gap-x-6">
          <CardLink href={`/places/${nearest.slug ?? nearest.id}`}>Открыть карточку: {nearest.name}</CardLink>
          <CardLink href="/safety">Обстановка в крае</CardLink>
        </div>
      </header>
      <EmergencyCallLine />
    </>
  );
}

function PlainResult({ title, text }: { title: string; text: string }) {
  return (
    <>
      <header>
        <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">{title}</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{text}</p>
        <CardLink href="/safety">Обстановка в крае</CardLink>
      </header>
      <EmergencyCallLine />
    </>
  );
}

export function SafetyToolResult({ answer, onReset }: { answer: SafetyToolAnswer; onReset: () => void }) {
  return (
    <div className="space-y-5">
      {answer.kind === 'place' && <PlaceResult place={answer.place} distanceKm={answer.distanceKm} />}
      {answer.kind === 'route' && <RouteResult answer={answer} />}
      {answer.kind === 'far' && <FarResult nearest={answer.nearest} />}
      {answer.kind === 'outside' && (
        <PlainResult
          title="Вы вне Камчатского края"
          text="У Ведара данные только о Камчатке: оценить точку, где вы стоите, нам не по чему."
        />
      )}
      {answer.kind === 'none' && (
        <PlainResult
          title="Мест рядом не нашлось"
          text="В нашей базе нет мест с координатами — оценить точку, где вы стоите, нам не по чему."
        />
      )}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={onReset}
          className="min-h-[44px] text-sm text-[var(--accent)] hover:underline"
        >
          Новый запрос
        </button>
      </div>
    </div>
  );
}
