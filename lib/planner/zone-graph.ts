/**
 * lib/planner/zone-graph.ts — ЧЕМ И СКОЛЬКО ЕХАТЬ МЕЖДУ ЗОНАМИ.
 *
 * Вынесено из `engine.ts` 27.09, чтобы правило «хватает ли дней на поездку в
 * дальнюю зону» (`zone-leg.ts`) могло спросить граф, не втягивая за собой весь
 * движок. Сам граф не изменился ни одним числом.
 */
import type { ZoneId, TransportType } from '@/lib/planner/constants';

export interface ZoneEdge {
  distanceKm: number;
  travelHours: number | null;   // null = no road, helicopter only
  transports: TransportType[];
  costPerPerson: [number, number];  // [economy, comfort]
  needsTravelDay: boolean;
}

export const ZONE_GRAPH: Record<ZoneId, Partial<Record<ZoneId, ZoneEdge>>> = {
  avachinsky: {
    western:  { distanceKm: 300, travelHours: 7,    transports: ['jeep'],       costPerPerson: [5000, 8000],   needsTravelDay: true },
    eastern:  { distanceKm: 250, travelHours: 5,    transports: ['jeep', 'helicopter'], costPerPerson: [5000, 15000], needsTravelDay: true },
    northern: { distanceKm: 400, travelHours: null,  transports: ['helicopter'], costPerPerson: [0, 0],         needsTravelDay: false },
  },
  western: {
    avachinsky: { distanceKm: 300, travelHours: 7,   transports: ['jeep'],       costPerPerson: [5000, 8000],   needsTravelDay: true },
    eastern:    { distanceKm: 500, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0],         needsTravelDay: true },
    northern:   { distanceKm: 600, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0],         needsTravelDay: true },
  },
  eastern: {
    avachinsky: { distanceKm: 250, travelHours: 5,   transports: ['jeep', 'helicopter'], costPerPerson: [5000, 15000], needsTravelDay: true },
    western:    { distanceKm: 500, travelHours: null, transports: ['helicopter'],         costPerPerson: [0, 0],        needsTravelDay: true },
    northern:   { distanceKm: 200, travelHours: null, transports: ['helicopter'],         costPerPerson: [0, 0],        needsTravelDay: false },
  },
  northern: {
    avachinsky: { distanceKm: 400, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0], needsTravelDay: false },
    eastern:    { distanceKm: 200, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0], needsTravelDay: false },
    western:    { distanceKm: 600, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0], needsTravelDay: true },
  },
};

