/**
 * lib/planner/zone-graph.ts — ЧЕМ И СКОЛЬКО ЕХАТЬ МЕЖДУ ЗОНАМИ.
 *
 * Вынесено из `engine.ts` 27.09, чтобы правило «хватает ли дней на поездку в
 * дальнюю зону» (`zone-leg.ts`) могло спросить граф, не втягивая за собой весь
 * движок. Сам граф не изменился ни одним числом.
 *
 * Цены переезда здесь нет (слово владельца 14.11 «5 -1»): до 14.11 у рёбер
 * стояло `costPerPerson` — 5 000–15 000 ₽ на человека, зашитые в код без
 * источника. Цену переезда называет перевозчик.
 */
import type { ZoneId, TransportType } from '@/lib/planner/constants';

export interface ZoneEdge {
  distanceKm: number;
  travelHours: number | null;   // null = no road, helicopter only
  transports: TransportType[];
  needsTravelDay: boolean;
}

/**
 * Южная зона (#3394 п.3) — по образцу Северной: вертолётный день из Авачинской
 * зоны туда и обратно (тур «Курильское озеро (вертолёт)» — 5 часов), а
 * многодневные туры на внедорожнике везут и ночуют сами. Расстояния южной зоны —
 * по прямой между точками зон (`ZONE_COORDS`), дорогой они длиннее.
 */
export const ZONE_GRAPH: Record<ZoneId, Partial<Record<ZoneId, ZoneEdge>>> = {
  avachinsky: {
    western:  { distanceKm: 300, travelHours: 7,    transports: ['jeep'],       needsTravelDay: true },
    eastern:  { distanceKm: 250, travelHours: 5,    transports: ['jeep', 'helicopter'], needsTravelDay: true },
    northern: { distanceKm: 400, travelHours: null,  transports: ['helicopter'], needsTravelDay: false },
    southern: { distanceKm: 200, travelHours: null,  transports: ['helicopter', 'jeep'], needsTravelDay: false },
  },
  western: {
    avachinsky: { distanceKm: 300, travelHours: 7,   transports: ['jeep'],       needsTravelDay: true },
    eastern:    { distanceKm: 500, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
    northern:   { distanceKm: 600, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
    southern:   { distanceKm: 120, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
  },
  eastern: {
    avachinsky: { distanceKm: 250, travelHours: 5,   transports: ['jeep', 'helicopter'], needsTravelDay: true },
    western:    { distanceKm: 500, travelHours: null, transports: ['helicopter'],         needsTravelDay: true },
    northern:   { distanceKm: 200, travelHours: null, transports: ['helicopter'],         needsTravelDay: false },
    southern:   { distanceKm: 430, travelHours: null, transports: ['helicopter'],         needsTravelDay: true },
  },
  northern: {
    avachinsky: { distanceKm: 400, travelHours: null, transports: ['helicopter'], needsTravelDay: false },
    eastern:    { distanceKm: 200, travelHours: null, transports: ['helicopter'], needsTravelDay: false },
    western:    { distanceKm: 600, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
    southern:   { distanceKm: 400, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
  },
  southern: {
    avachinsky: { distanceKm: 200, travelHours: null, transports: ['helicopter', 'jeep'], needsTravelDay: false },
    western:    { distanceKm: 120, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
    eastern:    { distanceKm: 430, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
    northern:   { distanceKm: 400, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
  },
};

