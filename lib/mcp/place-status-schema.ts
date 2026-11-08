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

/** Поля статуса — одни у get_guardian_context и у места тура в заявке. */
export const PLACE_STATUS_PROPERTIES = {
  level: {
    type: 'string',
    enum: ['closed', 'red', 'yellow', 'green', 'unknown'],
    description: 'Статус места для выхода на сегодня. closed — место отмечено закрытым; red, yellow, green — цвет пересчёта сводок края (green — не гарантия безопасности, предупреждения могут быть); unknown — цвета нет: пересчёт устарел или не было, место вне сводок края. unknown не значит «безопасно»',
  },
  color: {
    type: ['string', 'null'],
    enum: ['red', 'yellow', 'green', null],
    description: 'Цвет пересчёта, и у закрытого места тоже; null — цвета нет',
  },
  closed: { type: 'boolean', description: 'Место отмечено закрытым' },
  stale: { type: 'boolean', description: 'Пересчёт старше 3 часов: цвет уже может быть не про сегодня и не показывается' },
  outside_sources: { type: 'boolean', description: 'Место вне сводок края (Северные Курилы): зелёного там не бывает, «предупреждений нет» сказать нельзя' },
  status_updated_at: { type: ['string', 'null'], description: 'Когда статус пересчитан, ISO 8601 UTC; null — не записано' },
} as const;

const PLACE_STATUS_REQUIRED = ['level', 'color', 'closed', 'stale', 'outside_sources', 'status_updated_at'] as const;

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
  status_updated_at: string | null;
  alerts: string[];
}

export interface GuardianStructured {
  found: boolean;
  places: GuardianPlaceStatus[];
}

export const GUARDIAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'Место нашлось в справочнике Ведара. false — статуса места нет, и это не значит, что там безопасно' },
    places: {
      type: 'array',
      description: 'Совпавшие места, до трёх. Полный ответ — в тексте: опасности, коды вулкана, маршруты, тревоги из сводок',
      items: {
        type: 'object',
        properties: {
          id: { type: ['string', 'null'] },
          name: { type: 'string' },
          location_type: { type: ['string', 'null'] },
          match: { type: 'string', enum: ['high', 'low'], description: 'low — неточное совпадение с запросом: это может быть другое место, уточните у человека' },
          ...PLACE_STATUS_PROPERTIES,
          alerts: { type: 'array', items: { type: 'string' }, description: 'Действующие предупреждения по месту' },
        },
        required: ['id', 'name', 'location_type', 'match', ...PLACE_STATUS_REQUIRED, 'alerts'],
      },
    },
  },
  required: ['found', 'places'],
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
  description: 'Главное место тура и его статус на сегодня — у заявок на тур. Статус не останавливает заявку: состоится ли выезд на дату тура, подтверждает оператор; закрытое или красное место назовите человеку',
  items: {
    type: 'object',
    properties: {
      tool: { type: 'string' },
      tour_id: { type: 'integer' },
      read: { type: 'string', enum: ['ok', 'no_place', 'failed'], description: 'ok — статус прочитан; no_place — главное место у тура не записано; failed — прочитать не удалось (не «предупреждений нет»)' },
      place: {
        type: ['object', 'null'],
        properties: {
          place_id: { type: 'string' },
          place: { type: 'string', description: 'Название места' },
          ...PLACE_STATUS_PROPERTIES,
        },
        required: ['place_id', 'place', ...PLACE_STATUS_REQUIRED],
      },
    },
    required: ['tool', 'tour_id', 'read', 'place'],
  },
} as const;
