/**
 * Как быстро толчок доходит до ленты — чистая часть переписи
 * `GET /api/cron/seismic-latency-census`.
 *
 * ── Повод (01.10) ─────────────────────────────────────────────────────────
 *
 * Толчок M5.0 30.09 18:36 UTC (EQKam, 169 км от Петропавловска) владелец
 * увидел на Ведаре около 23:30 и спросил, почему его нет. Ответить было
 * нечем: в `external_alerts.created_at` лежит время ОЧАГА, а не записи, и
 * «пришло через пять минут» от «пришло через пять часов» по ленте
 * неотличимо. Время записи есть в журнале решений безопасности (миграция
 * 925): событие `published` пишется в момент вставки строки.
 *
 * Норма, против которой меряется задержка, записана в самом воркфлоу приёма:
 * «цунами от 185 км ≈ 15 мин».
 */
import { distanceKm } from '@/lib/services/safety/seismic-zones';

/** Норма доставки: волна цунами от 185 км идёт около 15 минут. */
export const SEISMIC_DELIVERY_NORM_MIN = 15;

export type SeismicSource = 'eqkam' | 'kbgsras' | 'usgs' | 'emsd' | 'other';

/** Источник записи — по её внешнему id, который пишет каждый приём. */
export function seismicSourceOf(externalId: string | null): SeismicSource {
  if (!externalId) return 'other';
  if (externalId.startsWith('t.me/eqkam/')) return 'eqkam';
  if (externalId.startsWith('t.me/kbgsras/')) return 'kbgsras';
  if (externalId.startsWith('usgs/')) return 'usgs';
  if (externalId.startsWith('www.emsd.ru/eq/')) return 'emsd';
  return 'other';
}

export interface QuakeRow {
  id: string;
  externalId: string | null;
  magnitude: number | null;
  lat: number | null;
  lng: number | null;
  /** Время толчка, как его записал приём (у EQKam до 01.10 — время поста). */
  eventAt: string;
  /** Когда строка легла в базу — событие `published` журнала; null — журнала нет. */
  ingestedAt: string | null;
}

export interface QuakeLatency extends QuakeRow {
  source: SeismicSource;
  /** Минут от толчка до записи; null — время записи неизвестно (не ноль). */
  latencyMin: number | null;
  /** Задержка больше нормы; null — судить не по чему. */
  late: boolean | null;
}

export function quakeLatency(row: QuakeRow): QuakeLatency {
  const source = seismicSourceOf(row.externalId);
  const at = Date.parse(row.eventAt);
  const ingested = row.ingestedAt ? Date.parse(row.ingestedAt) : NaN;
  const latencyMin = Number.isNaN(at) || Number.isNaN(ingested)
    ? null
    : Math.round((ingested - at) / 60_000);
  return {
    ...row,
    source,
    latencyMin,
    late: latencyMin === null ? null : latencyMin > SEISMIC_DELIVERY_NORM_MIN,
  };
}

export interface SourceLatencySummary {
  source: SeismicSource;
  quakes: number;
  /** Со временем записи — только по ним считается задержка. */
  measured: number;
  medianMin: number | null;
  maxMin: number | null;
  late: number;
}

export function summarizeBySource(items: QuakeLatency[]): SourceLatencySummary[] {
  const by = new Map<SeismicSource, QuakeLatency[]>();
  for (const it of items) by.set(it.source, [...(by.get(it.source) ?? []), it]);
  return [...by.entries()].map(([source, list]) => {
    const lat = list.map((x) => x.latencyMin).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const mid = lat.length === 0
      ? null
      : lat.length % 2 === 1 ? lat[(lat.length - 1) / 2] : Math.round((lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2);
    return {
      source,
      quakes: list.length,
      measured: lat.length,
      medianMin: mid,
      maxMin: lat.length > 0 ? lat[lat.length - 1] : null,
      late: list.filter((x) => x.late === true).length,
    };
  }).sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Окно, в котором две записи разных источников подозреваются одним толчком.
 * Шире окна сверки приёма (±30 с): задача переписи — найти то, что сверка
 * ПРОПУСТИЛА. Бюллетень EQKam шёл временем поста, минут через шесть после
 * очага (01.10), — такие пары и должны здесь всплыть.
 */
export const SUSPECT_WINDOW_MIN = 15;
export const SUSPECT_KM = 60;

export interface SuspectedDuplicate {
  a: { id: string; source: SeismicSource; magnitude: number | null; eventAt: string };
  b: { id: string; source: SeismicSource; magnitude: number | null; eventAt: string };
  minutesApart: number;
  kmApart: number;
}

/** Пары записей разных источников, похожие на один толчок, записанный дважды. */
export function suspectedDuplicates(items: QuakeLatency[]): SuspectedDuplicate[] {
  const out: SuspectedDuplicate[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.source === b.source) continue;
      if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) continue;
      const minutes = Math.abs(Date.parse(a.eventAt) - Date.parse(b.eventAt)) / 60_000;
      if (Number.isNaN(minutes) || minutes > SUSPECT_WINDOW_MIN) continue;
      const km = distanceKm(a.lat, a.lng, b.lat, b.lng);
      if (km > SUSPECT_KM) continue;
      out.push({
        a: { id: a.id, source: a.source, magnitude: a.magnitude, eventAt: a.eventAt },
        b: { id: b.id, source: b.source, magnitude: b.magnitude, eventAt: b.eventAt },
        minutesApart: Math.round(minutes * 10) / 10,
        kmApart: Math.round(km),
      });
    }
  }
  return out;
}
