/**
 * Статус места полями в ответах MCP и A2A (ревью MCP 08.11).
 *
 * «ЗЕЛЁНЫЙ» в скобках у названия приходилось вынимать регуляркой из русского
 * текста, а «закрыто» и «цвета нет» вовсе не имели машинного вида. Поля —
 * `placeStatusFields` (lib/safety/place-day-status), то же правило, что у
 * карточки места; здесь только их описание для outputSchema и тип записи
 * о месте тура в итоге заявки.
 */
import type { TourPlaceStatus } from '@/lib/safety/tour-place-status';
import type { VerdictReasonCode, VerdictStatus } from '@/lib/routes/go-verdict';

/** Поля статуса — одни у get_guardian_context и у места тура в заявке. */
export const PLACE_STATUS_PROPERTIES = {
  level: {
    type: 'string',
    enum: ['closed', 'red', 'yellow', 'green', 'unknown'],
    description: 'Status for going out today: closed; red, yellow, green — regional-report colour (green is no safety guarantee); unknown — no colour, not «safe»',
  },
  color: {
    type: ['string', 'null'],
    enum: ['red', 'yellow', 'green', null],
    description: 'Colour, also when closed; null — none',
  },
  closed: { type: 'boolean', description: 'Marked closed' },
  stale: { type: 'boolean', description: 'Over 3 hours old: colour hidden' },
  outside_sources: { type: 'boolean', description: 'Outside regional reports (Northern Kurils): never green; «no warnings» cannot be said' },
  reason: {
    type: ['string', 'null'],
    enum: ['park_season', null],
    description: 'park_season — yellow: park trails closed off-season, no independent hiking; the operator confirms park approval. null — not recorded',
  },
  status_updated_at: { type: ['string', 'null'], description: 'Computed at, ISO 8601 UTC; null — not recorded' },
} as const;

const PLACE_STATUS_REQUIRED = ['level', 'color', 'closed', 'stale', 'outside_sources', 'reason', 'status_updated_at'] as const;

/** Место в ответе get_guardian_context. */
export interface GuardianPlaceStatus {
  id: string | null;
  name: string;
  location_type: string | null;
  /** low — неточное совпадение с запросом: может быть другое место. */
  match: 'high' | 'low';
  level: TourPlaceStatus['level'];
  color: TourPlaceStatus['color'];
  closed: boolean;
  stale: boolean;
  outside_sources: boolean;
  reason: TourPlaceStatus['reason'];
  status_updated_at: string | null;
  alerts: string[];
}

/**
 * Маршрут каталога в ответе get_guardian_context (#3302): места с таким
 * названием нет, а маршрут есть — у него оценка на сегодня по правилу его
 * карточки (lib/routes/go-verdict), а не статус места.
 */
export interface GuardianRouteStatus {
  /** id карточки маршрута — тот же, что в её адресе. */
  id: string;
  title: string;
  /** Адрес карточки маршрута на Ведаре. */
  url: string;
  today: VerdictStatus;
  code: VerdictReasonCode;
  reason: string;
  /** Что прочитать не удалось из того, что способно скрыть запрет. */
  unknown: string[];
  /** Действующие предупреждения по маршруту; null — прочитать не удалось. */
  alerts: string[] | null;
  park_name: string | null;
  /**
   * high — маршрут назван запросом; low — название только похоже (другое
   * число или падеж): это может быть другой маршрут, уточните название.
   */
  match: 'high' | 'low';
}

export interface GuardianStructured {
  found: boolean;
  places: GuardianPlaceStatus[];
  routes: GuardianRouteStatus[];
}

/**
 * Коды причины — исчерпывающе: новый код в go-verdict не соберётся, пока не
 * внесён сюда, и схема не отстанет от правила молча.
 */
const VERDICT_CODES: Record<VerdictReasonCode, true> = {
  alert_ban: true, point_closed: true, park_closed_hazard: true, volcano_red: true, weather_severe: true,
  signals_unknown: true, park_closed: true,
  volcano_orange: true, alert_warning: true, out_of_season: true, clear: true,
};

export const GUARDIAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'Place found in the Vedar directory. false — no status, which does not mean safe; a catalog route with that name, if any, is in routes' },
    places: {
      type: 'array',
      description: 'Matched places, up to three. Hazards, volcano codes, routes and alerts are in the text',
      items: {
        type: 'object',
        properties: {
          id: { type: ['string', 'null'] },
          name: { type: 'string' },
          location_type: { type: ['string', 'null'] },
          match: { type: 'string', enum: ['high', 'low'], description: 'low — inexact match, may be another place: ask the person' },
          ...PLACE_STATUS_PROPERTIES,
          alerts: { type: 'array', items: { type: 'string' }, description: 'Active warnings for the place' },
        },
        required: ['id', 'name', 'location_type', 'match', ...PLACE_STATUS_REQUIRED, 'alerts'],
      },
    },
    routes: {
      type: 'array',
      description: 'Catalog routes with that name when no place or only an inexact one matched; otherwise up to three similar names (match: low). Each has today\'s call as on its card. Empty when a place is found does not mean no routes: they are in the text',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Route card id' },
          title: { type: 'string' },
          url: { type: 'string', description: 'Route card URL on Vedar' },
          today: {
            type: 'string',
            enum: ['go', 'caution', 'no'],
            description: 'Today\'s call: go — no warnings, dangerous volcano codes or closed points found (not a safety guarantee); caution — a reason for care or too little data; no — do not go today. Not an official bulletin',
          },
          code: { type: 'string', enum: Object.keys(VERDICT_CODES), description: 'Reason code: alert_ban — ban in a report; point_closed — a route point closed; volcano_red, volcano_orange — KVERT code on the route; signals_unknown — could not read what may hide a ban; alert_warning — active warning; out_of_season; clear — nothing found' },
          reason: { type: 'string', description: 'Reason in one line' },
          unknown: { type: 'array', items: { type: 'string' }, description: 'What could not be read (warnings, volcanoes, closed points); non-empty rules out go' },
          alerts: { type: ['array', 'null'], items: { type: 'string' }, description: 'Active route warnings; null — could not read (not «no warnings»)' },
          park_name: { type: ['string', 'null'], description: 'Protected area of the route as recorded; its administration sets visit terms' },
          match: { type: 'string', enum: ['high', 'low'], description: 'high — named by the query; low — only similar, may be another route: ask the person' },
        },
        required: ['id', 'title', 'url', 'today', 'code', 'reason', 'unknown', 'alerts', 'park_name', 'match'],
      },
    },
  },
  required: ['found', 'places', 'routes'],
} as const;

/**
 * Место тура в итоге заявки. `read`: ok — статус прочитан (`place` есть);
 * no_place — главное место у тура не записано; failed — прочитать не удалось.
 */
export interface TourPlaceEntry {
  tool: string;
  tour_id: number;
  read: 'ok' | 'no_place' | 'failed';
  place: TourPlaceStatus | null;
}

export const TOUR_PLACE_ENTRY_SCHEMA = {
  type: 'array',
  description: 'Main place of the tour and its status today (tour requests). It does not stop the request; the operator confirms the trip. Tell the person about a closed or red place',
  items: {
    type: 'object',
    properties: {
      tool: { type: 'string' },
      tour_id: { type: 'integer' },
      read: { type: 'string', enum: ['ok', 'no_place', 'failed'], description: 'ok — read; no_place — tour has no main place; failed — could not read (not «no warnings»)' },
      place: {
        type: ['object', 'null'],
        properties: {
          place_id: { type: 'string' },
          place: { type: 'string', description: 'Place name' },
          ...PLACE_STATUS_PROPERTIES,
        },
        required: ['place_id', 'place', ...PLACE_STATUS_REQUIRED],
      },
    },
    required: ['tool', 'tour_id', 'read', 'place'],
  },
} as const;
