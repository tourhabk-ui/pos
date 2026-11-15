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

export const ZONE_GRAPH: Record<ZoneId, Partial<Record<ZoneId, ZoneEdge>>> = {
  avachinsky: {
    western:  { distanceKm: 300, travelHours: 7,    transports: ['jeep'],       needsTravelDay: true },
    eastern:  { distanceKm: 250, travelHours: 5,    transports: ['jeep', 'helicopter'], needsTravelDay: true },
    northern: { distanceKm: 400, travelHours: null,  transports: ['helicopter'], needsTravelDay: false },
  },
  western: {
    avachinsky: { distanceKm: 300, travelHours: 7,   transports: ['jeep'],       needsTravelDay: true },
    eastern:    { distanceKm: 500, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
    northern:   { distanceKm: 600, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
  },
  eastern: {
    avachinsky: { distanceKm: 250, travelHours: 5,   transports: ['jeep', 'helicopter'], needsTravelDay: true },
    western:    { distanceKm: 500, travelHours: null, transports: ['helicopter'],         needsTravelDay: true },
    northern:   { distanceKm: 200, travelHours: null, transports: ['helicopter'],         needsTravelDay: false },
  },
  northern: {
    avachinsky: { distanceKm: 400, travelHours: null, transports: ['helicopter'], needsTravelDay: false },
    eastern:    { distanceKm: 200, travelHours: null, transports: ['helicopter'], needsTravelDay: false },
    western:    { distanceKm: 600, travelHours: null, transports: ['helicopter'], needsTravelDay: true },
  },
};

