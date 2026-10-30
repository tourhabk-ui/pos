/**
 * OpenAPI 3.1 для агентов — ступень 3 агентного контура (решение владельца
 * 12.10 «го, делай ступень 3»).
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * Есть агенты, которым недоступны ни MCP-клиент, ни A2A: GPT Actions у
 * пользовательских GPT, Copilot Studio, OpenAPI-наборы LangChain и подобных.
 * Они умеют ровно одно — прочитать описание OpenAPI и звать HTTP. Этот
 * документ описывает то, что у нас уже есть, а не заводит новых путей:
 * REST-биндинг A2A (через него зовётся любой из инструментов), публичные
 * читающие эндпоинты (каталог, туры и занятость, место, статус дня,
 * сейсмика, вулканы, погода), эндпоинт MCP и входы обнаружения.
 *
 * ── Правила ───────────────────────────────────────────────────────────────
 *
 * Форма ответов — из кода роутов (разбор 12.10), не из памяти: где роут
 * отвечает 200 с `degraded: true` вместо ошибки, где отдаёт константы
 * вместо колонок, где текст исключения уходит наружу — так и записано.
 * Перечень инструментов и их входные схемы берутся из реестра
 * (lib/mcp/public-tools): второй список разошёлся бы с первым. Сторож держит,
 * что каждый описанный путь существует в приложении и открыт Edge для
 * анонима, а документ проходит валидатор OpenAPI 3.1.
 *
 * Сторож: tests/unit/openapi-agents.test.ts.
 */

import manifest from '@/server.json';
import { OPENAPI_DESCRIPTION_ZH } from '@/lib/mcp/zh-layer';
import { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import {
  AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_JSONRPC_PATH, A2A_REST_PATH,
  A2A_PROTOCOL_VERSION, A2A_LEGACY_PROTOCOL_VERSION,
} from '@/lib/a2a/agent-card';
import { SERVER_CARD_PATH, AI_CATALOG_PATH, SERVER_CARD_MEDIA_TYPE, AI_CATALOG_MEDIA_TYPE, A2A_CARD_MEDIA_TYPE } from '@/lib/mcp/server-card';
import { PLACE_TYPE_PARAM } from '@/lib/routes/place-type-param';
import {
  REQUEST_NOTIFICATION_SCHEMA, NOTIFY_HOW_TO_VERIFY, NOTIFY_RESPONSE_RULES, NOTIFY_RESPONSE_RULES_EN, NOTIFY_RETRY_4XX,
} from '@/lib/mcp/request-notify-schema';

export const OPENAPI_PATH = '/openapi.json';
export const API_CATALOG_PATH = '/.well-known/api-catalog';
export const OPENAPI_VERSION = '3.1.0';
/** Зарегистрированный медиатип OpenAPI в JSON; по умолчанию отдаём application/json — его читают все. */
export const OPENAPI_MEDIA_TYPE = 'application/vnd.oai.openapi+json';
/** Linkset по RFC 9264 — форма каталога RFC 9727. */
export const LINKSET_MEDIA_TYPE = 'application/linkset+json';

type Json = Record<string, unknown>;

const JSON_CT = 'application/json';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function ref(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schema: Json): Json {
  return { description, content: { [JSON_CT]: { schema } } };
}

function nullable(type: string, extra: Json = {}): Json {
  return { type: [type, 'null'], ...extra };
}

function query(name: string, schema: Json, description: string, required = false): Json {
  return { name, in: 'query', required, description, schema };
}

const ERROR_ENVELOPE = ref('ErrorEnvelope');

/** Вызов инструмента DataPart: по схеме на каждый инструмент из реестра. */
function toolCallSchemas(): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const t of PUBLIC_MCP_TOOLS) {
    out[`ToolCall_${t.name}`] = {
      type: 'object',
      description: t.description,
      required: ['tool', 'arguments'],
      properties: {
        tool: { const: t.name },
        arguments: clone(t.inputSchema),
      },
    };
  }
  return out;
}

export function buildOpenApiDocument(base: string): Json {
  const b = base.replace(/\/$/, '');
  const toolNames = PUBLIC_MCP_TOOLS.map((t) => t.name);
  const toolCalls = toolCallSchemas();

  const schemas: Record<string, Json> = {
    // Тело уведомления об изменении заявки (notify_url, 29.10) — та же схема,
    // что держит сторож тела (lib/mcp/request-notify-schema).
    RequestNotification: clone(REQUEST_NOTIFICATION_SCHEMA) as Json,
    ErrorEnvelope: {
      type: 'object',
      required: ['success', 'error'],
      properties: { success: { const: false }, error: { type: 'string', description: 'Текст для человека, по-русски' } },
    },

    // ── Каталог маршрутов, мест и туров ────────────────────────────────
    CatalogItem: {
      type: 'object',
      description: 'Запись каталога. У kind=place поле id — places.ark_id, его принимает GET /api/places/{id}. geometry — метаданные из payload, не трек для навигации.',
      required: ['id', 'kind', 'title', 'description', 'hazards', 'hasRealImage'],
      properties: {
        id: { type: 'string' },
        slug: nullable('string', { description: 'Ключ дедупликации, не адрес страницы' }),
        urlSlug: nullable('string'),
        kind: { type: 'string', enum: ['place', 'route', 'tour'] },
        category: nullable('string'),
        locationType: nullable('string'),
        activityType: nullable('string'),
        title: { type: 'string' },
        description: { type: 'string' },
        imageUrl: { type: 'string', description: 'Относительный путь; ключа нет, если картинки нет' },
        lat: nullable('number'),
        lng: nullable('number'),
        sourceUrl: nullable('string'),
        sourceName: nullable('string'),
        priceFrom: nullable('number'),
        season: nullable('string'),
        difficulty: nullable('string'),
        durationDays: nullable('number'),
        bestMonths: nullable('array', { items: { type: 'integer' } }),
        geometry: nullable('object', { properties: { type: { type: 'string' }, coordinates: { type: 'array', items: { type: 'array', items: { type: 'number' } } } } }),
        volcanoStatus: nullable('string'),
        hasRealImage: { type: 'boolean' },
        hazards: { type: 'array', items: { type: 'string', enum: ['volcano_activity', 'bears_active', 'high_difficulty', 'permit_required', 'weather_risk'] } },
        isOpen: nullable('boolean', { description: 'false — место закрыто администратором. true — значение по умолчанию у всех мест («никто не закрыл»), не проверка, что место открыто' }),
        lineGrade: nullable('string', { enum: ['surveyed', 'sketch', 'unknown', 'points_only', 'none', null], description: 'Только у kind=route: откуда линия' }),
        onRoute: nullable('boolean', { description: 'Только у kind=place' }),
        zone: nullable('string', { description: 'Зона записи в базе: avachinsky, western, eastern, northern или метка района вне них; null — не записана' }),
      },
    },
    CatalogResponse: {
      type: 'object',
      required: ['success', 'data', 'meta'],
      properties: {
        success: { const: true },
        data: { type: 'array', items: ref('CatalogItem') },
        meta: {
          type: 'object',
          required: ['total', 'page', 'limit', 'pages'],
          properties: { total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, pages: { type: 'integer' } },
        },
      },
    },

    // ── Туры ───────────────────────────────────────────────────────────
    TourListItem: {
      type: 'object',
      description: 'Тур оператора на витрине. Числа из numeric-колонок приходят числами после parseFloat; id — строка (bigint).',
      required: ['id', 'name', 'description', 'price', 'currency', 'images', 'isActive'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        shortDescription: { type: 'string' },
        category: { type: 'string', description: 'activity_type оператора' },
        difficulty: { type: 'string' },
        duration: { type: 'number' },
        price: { type: 'number' },
        currency: { type: 'string' },
        season: { type: 'array', items: { type: 'string', format: 'date' }, description: 'От нуля до двух дат: начало и конец сезона' },
        coordinates: { type: 'array', items: { type: 'number' }, description: '[lat, lng] или []' },
        requirements: { type: 'array', items: { type: 'string' } },
        included: { type: 'array', items: { type: 'string' } },
        notIncluded: { type: 'array', items: { type: 'string' } },
        maxGroupSize: { type: 'integer' },
        minGroupSize: { type: 'integer' },
        rating: nullable('number'),
        reviewCount: { type: 'integer' },
        isActive: { type: 'boolean' },
        images: { type: 'array', items: { type: 'string' }, description: 'Относительные пути; не пуст — есть запасная обложка' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        sourceUrl: { type: 'null' },
        sourceName: nullable('string', { description: 'Имя оператора' }),
        source: { const: 'tour' },
      },
    },
    ToursResponse: {
      type: 'object',
      description: 'Ошибок 4xx/5xx у списка нет: любой сбой отвечает 200 с пустым списком и degraded: true.',
      required: ['success', 'data'],
      properties: {
        success: { const: true },
        data: {
          type: 'object',
          required: ['tours', 'pagination'],
          properties: {
            tours: { type: 'array', items: ref('TourListItem') },
            pagination: {
              type: 'object',
              required: ['total', 'limit', 'offset', 'hasMore'],
              properties: { total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' }, hasMore: { type: 'boolean' } },
            },
          },
        },
        degraded: { const: true, description: 'Есть только при сбое: данных нет, это не «туров нет»' },
      },
    },
    TourDetail: {
      type: 'object',
      description: 'Карточка тура. Поля category, duration, season, coordinates, requirements, maxGroupSize и minGroupSize здесь константы (колонок нет): adventure, 0, [], [], [], 20, 1. Программа, что взять и правила безопасности — через инструмент get_tour_details (A2A/MCP) или fetch(tour:<id>).',
      required: ['id', 'name', 'description', 'price', 'currency', 'images'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        shortDescription: { type: 'string' },
        category: { const: 'adventure' },
        difficulty: { type: 'string' },
        duration: { const: 0 },
        price: { type: 'number' },
        currency: { type: 'string' },
        season: { type: 'array', maxItems: 0 },
        coordinates: { type: 'array', maxItems: 0 },
        requirements: { type: 'array', maxItems: 0 },
        included: { type: 'array', items: { type: 'string' } },
        notIncluded: { type: 'array', items: { type: 'string' } },
        maxGroupSize: { const: 20 },
        minGroupSize: { const: 1 },
        rating: nullable('number'),
        reviewCount: { type: 'integer' },
        isActive: { type: 'boolean' },
        images: { type: 'array', items: { type: 'string' } },
        slug: nullable('string'),
        locationName: nullable('string'),
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        routeId: nullable('string'),
        route: nullable('object', {
          properties: { id: { type: 'string' }, title: { type: 'string' }, category: nullable('string'), lat: nullable('number'), lng: nullable('number'), sourceUrl: nullable('string') },
        }),
        operator: nullable('object', { properties: { id: { type: 'string' }, name: { type: 'string' }, rating: nullable('number') } }),
      },
    },
    TourDetailResponse: {
      type: 'object',
      required: ['success', 'data'],
      properties: { success: { const: true }, data: ref('TourDetail') },
    },
    TourSlotsResponse: {
      type: 'object',
      description: 'Только даты со свободными местами, от сегодня и не дальше года, до 400 строк. Пустой массив у существующего тура — свободных дат нет.',
      required: ['success', 'slots'],
      properties: {
        success: { const: true },
        slots: {
          type: 'array',
          items: {
            type: 'object',
            required: ['date', 'available_slots', 'booked_slots', 'free_slots'],
            properties: {
              date: { type: 'string', format: 'date' },
              available_slots: { type: 'integer' },
              booked_slots: { type: 'integer' },
              free_slots: { type: 'integer' },
            },
          },
        },
      },
    },

    // ── Место ──────────────────────────────────────────────────────────
    PlaceDetailResponse: {
      type: 'object',
      required: ['success', 'data'],
      properties: {
        success: { const: true },
        data: {
          type: 'object',
          description: 'Карточка места. Полный состав полей шире перечисленного: безопасность (safety), статус вулкана, реалтайм, маршруты через место, туры к нему, отзывы, соседи.',
          required: ['id', 'name', 'lat', 'lng'],
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'places.ark_id' },
            name: { type: 'string' },
            description: nullable('string'),
            descriptionSource: nullable('string'),
            essence: nullable('string'),
            category: nullable('string'),
            locationType: nullable('string'),
            lat: { type: 'number' },
            lng: { type: 'number' },
            zone: nullable('string'),
            district: nullable('string'),
            photoUrl: nullable('string'),
            images: { type: 'array', items: { type: 'string' } },
            photoCount: { type: 'integer' },
            bestSeason: nullable('string'),
            accessInfo: nullable('string'),
            safety: nullable('object', {
              additionalProperties: true,
              description: 'source — type_template | manual | unknown | null: значения шаблона фактом не считаются',
              properties: {
                source: nullable('string', { enum: ['type_template', 'manual', 'unknown', null] }),
                hazardTypes: { type: 'array', items: { type: 'string' } },
                nearestMedicalKm: nullable('number'),
                registrationRequired: nullable('boolean'),
                satCommunicatorRequired: nullable('boolean'),
              },
            }),
            volcanoStatus: nullable('object', { additionalProperties: true }),
            realtime: nullable('object', { additionalProperties: true }),
            routes: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, slug: nullable('string'), title: { type: 'string' }, linkKind: nullable('string') } } },
            tours: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, title: { type: 'string' }, basePrice: nullable('number'), operatorName: nullable('string') } } },
            reviews: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { rating: { type: 'number' }, comment: nullable('string'), authorName: { type: 'string' }, createdAt: { type: 'string' } } } },
            nearby: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, name: { type: 'string' }, distanceKm: { type: 'number' } } } },
          },
        },
      },
    },

    // ── Безопасность и погода ──────────────────────────────────────────
    SafetyStatusResponse: {
      type: 'object',
      description: 'Всегда 200. При недоступном источнике — data.unavailable: true и нули; клиент обязан проверять unavailable, а не читать нули как «тихо».',
      required: ['success', 'data'],
      properties: {
        success: { const: true },
        data: {
          oneOf: [
            {
              type: 'object',
              required: ['hasAlert', 'maxSeverity', 'activeCount', 'source'],
              properties: {
                hasAlert: { type: 'boolean' },
                maxSeverity: { type: 'number' },
                activeCount: { type: 'integer' },
                topTitle: nullable('string'),
                topType: nullable('string'),
                dataUpdatedAt: nullable('string'),
                source: { type: 'string' },
                feedCount: nullable('integer'),
                feedTitles: nullable('array', { items: { type: 'string' } }),
                feedBasis: nullable('array', { items: nullable('object', { properties: { title: { type: 'string' }, url: nullable('string'), recognized: { type: 'boolean' } } }) }),
              },
            },
            {
              type: 'object',
              required: ['unavailable', 'hasAlert', 'maxSeverity', 'activeCount', 'source'],
              properties: {
                unavailable: { const: true },
                hasAlert: { const: false },
                maxSeverity: { const: 0 },
                activeCount: { const: 0 },
                topTitle: { type: 'null' },
                topType: { type: 'null' },
                dataUpdatedAt: { type: 'null' },
                source: { type: 'string' },
              },
            },
          ],
        },
      },
    },
    SeismicResponse: {
      type: 'object',
      description: 'Без параметра hours — лента КБГС РАН или USGS (до 15 событий за 48 ч); с hours — толчки из external_alerts за окно, до 500.',
      required: ['events'],
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'magnitude', 'time'],
            properties: {
              id: { type: 'string' },
              magnitude: { type: 'number' },
              place: { type: 'string' },
              time: { type: 'integer', description: 'Unix-время в миллисекундах' },
              depth: nullable('number'),
              lat: nullable('number'),
              lng: nullable('number'),
            },
          },
        },
        source: { type: 'string', enum: ['kbgsras', 'usgs', 'external_alerts'] },
        hours: { type: 'integer' },
        updatedAt: { type: 'string' },
        checkedAt: nullable('string'),
        fromCache: { type: 'boolean' },
      },
    },
    SeismicError: {
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'string' }, events: { type: 'array', maxItems: 0 }, source: { type: 'string' } },
    },
    VolcanicResponse: {
      type: 'object',
      description: 'До 20 событий за 7 суток. Сбой основного запроса тоже отвечает 200: events пуст, checked_at null и есть поле error.',
      required: ['events', 'statuses'],
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title', 'severity', 'created_at', 'active'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: nullable('string'),
              severity: { type: 'integer' },
              affected_zones: { type: 'array', items: { type: 'string' } },
              created_at: { type: 'string', format: 'date-time' },
              expires_at: nullable('string'),
              source_url: nullable('string'),
              active: { type: 'boolean' },
            },
          },
        },
        checked_at: nullable('string'),
        statuses: {
          type: 'object',
          properties: {
            elevated: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'color'],
                properties: {
                  name: { type: 'string' },
                  color: { type: 'string', enum: ['yellow', 'orange', 'red'] },
                  summary: nullable('string'),
                  ash_height_m: nullable('number'),
                  observed_at: nullable('string'),
                  source_url: nullable('string'),
                },
              },
            },
            total: nullable('integer'),
            green: nullable('integer'),
            updated_at: nullable('string'),
          },
        },
        error: { type: 'string', description: 'Только при сбое' },
      },
    },
    SafetyWeather: {
      type: 'object',
      description: 'Погода экрана безопасности для Петропавловска-Камчатского, готовыми русскими строками.',
      required: ['place', 'today', 'stale'],
      properties: {
        place: { type: 'string' },
        now: nullable('object', {
          properties: { label: { type: 'string', enum: ['ночь', 'утро', 'день', 'вечер'] }, temp: nullable('number'), precip: { type: 'string' }, wind: { type: 'string' } },
        }),
        today: { type: 'object', properties: { temp: nullable('number'), precip: { type: 'string' }, wind: { type: 'string' }, sky: nullable('string') } },
        checked_at: nullable('string'),
        stale: { type: 'boolean' },
      },
    },
    WeatherResponse: {
      type: 'object',
      required: ['success', 'data'],
      properties: {
        success: { const: true },
        data: {
          type: 'object',
          description: 'Сводка по провайдеру. Ветер — км/ч; давление зависит от провайдера: Open-Meteo даёт гПа, остальные — мм рт. ст. Поля windGust, dewPoint, sunrise, sunset, moonPhase, hourlyForecast, alerts есть не у всех провайдеров.',
          additionalProperties: true,
          required: ['location', 'temperature', 'condition', 'forecast', 'safetyLevel', 'lastUpdated'],
          properties: {
            location: { type: 'string' },
            temperature: { type: 'number' },
            feelsLike: { type: 'number' },
            condition: { type: 'string' },
            conditionText: { type: 'string' },
            humidity: nullable('number'),
            windSpeed: { type: 'number', description: 'км/ч' },
            windDirection: { type: 'number' },
            pressure: { type: 'number' },
            visibility: nullable('number'),
            uvIndex: { type: 'number' },
            cloudCover: { type: 'number' },
            forecast: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  date: { type: 'string' },
                  temperature: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } },
                  condition: { type: 'string' },
                  conditionText: { type: 'string' },
                  precipitation: { type: 'number' },
                  precipitationProbability: { type: 'number' },
                  windSpeed: { type: 'number' },
                  humidity: nullable('number'),
                },
              },
            },
            lastUpdated: { type: 'string' },
            safetyLevel: { type: 'string', enum: ['excellent', 'good', 'moderate', 'difficult', 'dangerous'] },
            recommendations: { type: 'array', items: { type: 'string' } },
            clothingAdvice: { type: 'array', items: { type: 'string' } },
            tourAdvice: { type: 'string' },
            comfortIndex: { type: 'number', minimum: 0, maximum: 100 },
          },
        },
      },
    },

    // ── A2A ────────────────────────────────────────────────────────────
    A2ATextPart: {
      type: 'object',
      required: ['text'],
      properties: { kind: { const: 'text' }, text: { type: 'string', maxLength: 8000 } },
    },
    A2AToolCallPart: {
      type: 'object',
      description: 'Точный вызов инструмента: data.tool и data.arguments по схеме инструмента (те же схемы, что tools/list у MCP). Если такая часть есть, текстовые части не читаются.',
      required: ['data'],
      properties: { kind: { const: 'data' }, data: ref('ToolCallData') },
    },
    ToolCallData: {
      description: 'Один из публичных инструментов с его аргументами. Записывающие (create_lead, create_booking_request, create_stay_request, request_charter, create_car_rental_request) — заявки, которые подтверждает человек; им нужен consent: true.',
      oneOf: toolNames.map((n) => ref(`ToolCall_${n}`)),
    },
    ...toolCalls,
    A2ASendMessageRequest: {
      type: 'object',
      required: ['message'],
      properties: {
        message: {
          type: 'object',
          required: ['parts'],
          properties: {
            messageId: { type: 'string', maxLength: 128 },
            contextId: { type: 'string', maxLength: 128, description: 'Контекст разговора: последние 10 реплик держатся час в памяти процесса' },
            taskId: { type: 'string', maxLength: 128, description: 'Только незавершённая задача; все задачи здесь завершаются в ответе, так что поле практически не нужно' },
            role: { type: 'string', description: 'Не читается' },
            parts: {
              type: 'array',
              minItems: 1,
              maxItems: 16,
              items: { oneOf: [ref('A2ATextPart'), ref('A2AToolCallPart')] },
            },
          },
        },
        configuration: { type: 'object', properties: { historyLength: { type: 'integer' } } },
      },
    },
    A2APart: {
      oneOf: [
        { type: 'object', required: ['text'], properties: { kind: { const: 'text' }, text: { type: 'string' } } },
        { type: 'object', required: ['data'], properties: { kind: { const: 'data' }, data: { type: 'object', additionalProperties: true } } },
      ],
    },
    A2AMessage: {
      type: 'object',
      required: ['messageId', 'role', 'parts'],
      properties: {
        kind: { const: 'message', description: 'Только в форме 0.3' },
        messageId: { type: 'string' },
        role: { type: 'string', enum: ['ROLE_AGENT', 'agent'] },
        parts: { type: 'array', items: ref('A2APart') },
        contextId: { type: 'string' },
        taskId: { type: 'string' },
      },
    },
    A2ATask: {
      type: 'object',
      description: 'Задача завершается в ответе: состояния только completed (успех; есть артефакт), rejected (отказ по входу или лимит) и failed (наш сбой). Первая часть — текст; у вызова инструмента вторая, DataPart, — { tool, continue_url?, result? }. В history только ответ агента.',
      required: ['id', 'contextId', 'status', 'artifacts', 'history'],
      properties: {
        kind: { const: 'task', description: 'Только в форме 0.3' },
        id: { type: 'string' },
        contextId: { type: 'string' },
        status: {
          type: 'object',
          required: ['state'],
          properties: {
            state: { type: 'string', enum: ['TASK_STATE_COMPLETED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED', 'completed', 'rejected', 'failed'] },
            timestamp: { type: 'string' },
            message: ref('A2AMessage'),
          },
        },
        artifacts: {
          type: 'array',
          items: { type: 'object', properties: { artifactId: { type: 'string' }, name: { type: 'string' }, parts: { type: 'array', items: ref('A2APart') } } },
        },
        history: { type: 'array', items: ref('A2AMessage') },
        metadata: { type: 'object', additionalProperties: true },
      },
    },
    A2ASendMessageResponse: {
      description: 'С заголовком A2A-Version: 1.0 — { task }; без заголовка или с 0.3 — Task как есть, с kind и строчными состояниями.',
      oneOf: [
        { type: 'object', required: ['task'], properties: { task: ref('A2ATask') } },
        ref('A2ATask'),
      ],
    },
    A2AError: {
      type: 'object',
      description: 'google.rpc.Status с ErrorInfo. HTTP-код повторён в error.code.',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'status', 'message'],
          properties: {
            code: { type: 'integer' },
            status: { type: 'string', enum: ['NOT_FOUND', 'FAILED_PRECONDITION', 'INVALID_ARGUMENT', 'INTERNAL'] },
            message: { type: 'string' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  '@type': { const: 'type.googleapis.com/google.rpc.ErrorInfo' },
                  reason: {
                    type: 'string',
                    enum: ['TASK_NOT_FOUND', 'METHOD_NOT_FOUND', 'TASK_NOT_CANCELABLE', 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'UNSUPPORTED_OPERATION',
                      'CONTENT_TYPE_NOT_SUPPORTED', 'VERSION_NOT_SUPPORTED', 'PARSE_ERROR', 'INVALID_REQUEST', 'INVALID_PARAMS', 'INTERNAL', 'INVALID_AGENT_RESPONSE'],
                  },
                  domain: { const: 'a2a-protocol.org' },
                  metadata: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },

    // ── MCP ────────────────────────────────────────────────────────────
    JsonRpcRequest: {
      type: 'object',
      required: ['jsonrpc', 'method'],
      properties: {
        jsonrpc: { const: '2.0' },
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }], description: 'Без id — уведомление: ответ 202 без тела' },
        method: { type: 'string', enum: ['initialize', 'tools/list', 'tools/call', 'ping'] },
        params: { type: 'object', additionalProperties: true },
      },
    },
    JsonRpcResponse: {
      type: 'object',
      required: ['jsonrpc', 'id'],
      properties: {
        jsonrpc: { const: '2.0' },
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
        result: { type: 'object', additionalProperties: true, description: 'tools/call: { content: [{ type: "text", text }], structuredContent?, isError? }' },
        error: { type: 'object', properties: { code: { type: 'integer' }, message: { type: 'string' }, data: {} } },
      },
    },
    McpServerInfo: {
      type: 'object',
      required: ['name', 'version', 'tools'],
      properties: {
        name: { const: MCP_SERVER_INFO.name },
        title: { type: 'string' },
        version: { const: MCP_SERVER_INFO.version },
        description: { type: 'string' },
        tools: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['name', 'description', 'inputSchema'], properties: { name: { type: 'string', enum: toolNames } } } },
      },
    },
    McpServerCard: {
      type: 'object',
      required: ['$schema', 'name', 'version', 'description', 'remotes'],
      properties: {
        $schema: { type: 'string' },
        name: { const: manifest.name },
        version: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        websiteUrl: { type: 'string' },
        remotes: { type: 'array', items: { type: 'object', properties: { type: { const: 'streamable-http' }, url: { type: 'string' }, supportedProtocolVersions: { type: 'array', items: { type: 'string', enum: [...SUPPORTED_PROTOCOL_VERSIONS] } } } } },
      },
    },
    AgentCard: { type: 'object', additionalProperties: true, required: ['name', 'description', 'skills'], properties: { name: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' }, skills: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
    AiCatalog: { type: 'object', required: ['specVersion', 'entries'], properties: { specVersion: { type: 'string' }, entries: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['identifier', 'type', 'url'] } } } },
    ApiCatalog: {
      type: 'object',
      description: 'Linkset по RFC 9264: link context objects с anchor и отношениями service-desc, service-doc, service-meta (RFC 8631).',
      required: ['linkset'],
      properties: { linkset: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['anchor'], properties: { anchor: { type: 'string' } } } } },
    },
  };

  const a2aVersionHeader: Json = {
    name: 'A2A-Version',
    in: 'header',
    required: false,
    description: 'Версия протокола. Без заголовка ответ кодируется по 0.3 (kind, строчные роли и состояния); 1.0 — обёртка { task } и состояния TASK_STATE_*.',
    schema: { type: 'string', enum: [A2A_PROTOCOL_VERSION, A2A_LEGACY_PROTOCOL_VERSION, '0.2'] },
  };

  const a2aErrors = {
    '400': jsonResponse('Неверный запрос: INVALID_PARAMS, CONTENT_TYPE_NOT_SUPPORTED, VERSION_NOT_SUPPORTED, PARSE_ERROR; тело больше 64 КиБ — INVALID_REQUEST', ref('A2AError')),
    '404': jsonResponse('Задача или путь не найдены', ref('A2AError')),
    '500': jsonResponse('Наш сбой, общий текст', ref('A2AError')),
  };

  const paths: Record<string, Json> = {
    [`${A2A_REST_PATH}/message:send`]: {
      post: {
        tags: ['a2a'],
        operationId: 'a2aSendMessage',
        summary: 'Вопрос Кузьмичу текстом или точный вызов инструмента (A2A REST)',
        description: 'Свободный текст (TextPart) — отвечает Кузьмич с теми же инструментами, что у MCP; точный вызов — DataPart { tool, arguments } по схемам инструментов. Задача завершается в ответе. Лимиты по адресу: текст 10 в минуту; инструменты чтения 30 в минуту, заявки 5 в час (общие с MCP). Превышение — Task со state rejected, HTTP 200.',
        parameters: [a2aVersionHeader],
        requestBody: { required: true, content: { [JSON_CT]: { schema: ref('A2ASendMessageRequest') } } },
        responses: {
          '200': { description: 'Задача', content: { 'application/a2a+json': { schema: ref('A2ASendMessageResponse') } } },
          ...a2aErrors,
        },
      },
    },
    [`${A2A_REST_PATH}/tasks/{id}`]: {
      get: {
        tags: ['a2a'],
        operationId: 'a2aGetTask',
        summary: 'Задача по id (час в памяти процесса)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'historyLength', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
          a2aVersionHeader,
        ],
        responses: {
          '200': { description: 'Задача', content: { 'application/a2a+json': { schema: ref('A2ASendMessageResponse') } } },
          '400': a2aErrors['400'],
          '404': a2aErrors['404'],
        },
      },
    },
    [`${A2A_REST_PATH}/tasks/{id}:cancel`]: {
      post: {
        tags: ['a2a'],
        operationId: 'a2aCancelTask',
        summary: 'Отмена задачи — всегда отказ',
        description: 'Все задачи здесь завершаются в ответе на message:send, отменять нечего: 400 TASK_NOT_CANCELABLE у существующей, 404 у неизвестной. Путь описан, чтобы клиент не ждал 200.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, a2aVersionHeader],
        responses: { '400': a2aErrors['400'], '404': a2aErrors['404'] },
      },
    },
    [A2A_REST_PATH]: {
      get: {
        tags: ['a2a', 'discovery'],
        operationId: 'a2aCardRest',
        summary: 'Визитка агента 1.0 (та же, что /.well-known/agent-card.json)',
        responses: { '200': jsonResponse('Agent Card', ref('AgentCard')) },
      },
    },
    [A2A_JSONRPC_PATH]: {
      post: {
        tags: ['a2a'],
        operationId: 'a2aJsonRpc',
        summary: 'A2A по JSON-RPC 2.0 (SendMessage / message/send, GetTask / tasks/get, CancelTask / tasks/cancel)',
        description: 'Тот же агент, что REST; имена методов обеих версий, форма ответа — по заголовку A2A-Version. Пакеты принимаются; тело до 64 КиБ (413).',
        parameters: [a2aVersionHeader],
        requestBody: { required: true, content: { [JSON_CT]: { schema: { type: 'object', additionalProperties: true, required: ['jsonrpc', 'method'] } } } },
        responses: {
          '200': jsonResponse('Ответ JSON-RPC: result или error', { type: 'object', additionalProperties: true }),
          '202': { description: 'Уведомление без id — ответа нет' },
          '400': jsonResponse('Невалидный JSON или неподдерживаемая версия', { type: 'object', additionalProperties: true }),
          '413': { description: 'Тело больше 64 КиБ' },
        },
      },
    },

    '/api/mcp': {
      post: {
        tags: ['mcp'],
        operationId: 'mcpJsonRpc',
        summary: 'MCP-сервер: JSON-RPC 2.0 по Streamable HTTP (initialize, tools/list, tools/call, ping; в 2026-07-28 — server/discover, tools/list, tools/call)',
        description: `Анонимно, без сессий. Версии протокола: ${[...SUPPORTED_PROTOCOL_VERSIONS].join(', ')} (заголовок MCP-Protocol-Version проверяется, если есть). Ревизия 2026-07-28 — без initialize: версия и clientCapabilities в params._meta каждого запроса, заголовки MCP-Protocol-Version, Mcp-Method и Mcp-Name (у tools/call) сверяются с телом (-32020), чужая версия — -32022 с data.supported, неизвестный метод — HTTP 404 и -32601, пакетов нет. Лимиты по адресу на вызов инструмента: чтение 30 в минуту, заявки 5 в час. Пакет — до 20 сообщений, тело — до 64 КиБ. Отказ инструмента — result с isError: true и HTTP 200; неизвестный инструмент — error -32602 с data.available.`,
        requestBody: { required: true, content: { [JSON_CT]: { schema: { oneOf: [ref('JsonRpcRequest'), { type: 'array', items: ref('JsonRpcRequest'), maxItems: 20 }] } } } },
        responses: {
          '200': jsonResponse('Ответ JSON-RPC (или массив для пакета)', { oneOf: [ref('JsonRpcResponse'), { type: 'array', items: ref('JsonRpcResponse') }] }),
          '202': { description: 'Уведомление или пакет из одних уведомлений' },
          '400': jsonResponse('Невалидный JSON, пустой пакет, неподдерживаемая версия; в 2026-07-28 — заголовки не совпали с телом, нет обязательных полей _meta', ref('JsonRpcResponse')),
          '404': jsonResponse('Ревизия 2026-07-28: метода нет на сервере (-32601)', ref('JsonRpcResponse')),
          '413': { description: 'Тело больше 64 КиБ' },
        },
      },
      get: {
        tags: ['mcp', 'discovery'],
        operationId: 'mcpInfo',
        summary: 'Сведения о сервере и список инструментов со схемами',
        description: 'С Accept: text/event-stream — 405 (потока событий нет, только POST).',
        responses: { '200': jsonResponse('Сервер и инструменты', ref('McpServerInfo')), '405': { description: 'Запрошен поток событий' } },
      },
    },
    [SERVER_CARD_PATH]: {
      get: {
        tags: ['mcp', 'discovery'],
        operationId: 'mcpServerCard',
        summary: 'Карточка сервера (расширение MCP Server Card)',
        responses: { '200': { description: 'Карточка', content: { [SERVER_CARD_MEDIA_TYPE]: { schema: ref('McpServerCard') } } }, '304': { description: 'Не изменилась (If-None-Match)' } },
      },
    },

    '/api/routes': {
      get: {
        tags: ['catalog'],
        operationId: 'listCatalog',
        summary: 'Каталог мест, маршрутов и туров с поиском и фильтрами',
        description: 'Поиск q — подстрока по названию и описанию. Фильтр по радиусу работает только при трёх параметрах near_lat, near_lng, radius_km сразу. Неизвестные параметры отбрасываются.',
        parameters: [
          query('q', { type: 'string', maxLength: 200 }, 'Слова запроса'),
          query('kind', { type: 'string', enum: ['place', 'route', 'tour'] }, 'Род записи'),
          query('category', { type: 'string', maxLength: 60 }, 'Точное равенство'),
          query('location_type', { type: 'string', maxLength: 60 }, 'Тип места'),
          query('activity_type', { type: 'string', maxLength: 60 }, 'Тип активности'),
          query('page', { type: 'integer', minimum: 1, default: 1 }, 'Страница'),
          query('limit', { type: 'integer', minimum: 1, maximum: 2000, default: 24 }, 'Размер страницы'),
          query('hasCoords', { type: 'string', enum: ['true', 'false'] }, 'Только с координатами (действует только true)'),
          query('sort', { type: 'string', enum: ['title', 'recent', 'price_asc', 'price_desc', 'recommended', 'navigable'], default: 'title' }, 'Порядок'),
          query('difficulty', { type: 'string', enum: ['easy', 'medium', 'hard'] }, 'Сложность'),
          query('price_min', { type: 'number', minimum: 0 }, 'Цена от'),
          query('price_max', { type: 'number', minimum: 0 }, 'Цена до'),
          query('near_lat', { type: 'number', minimum: -90, maximum: 90 }, 'Центр радиуса'),
          query('near_lng', { type: 'number', minimum: -180, maximum: 180 }, 'Центр радиуса'),
          query('radius_km', { type: 'number', minimum: 1, maximum: 1000 }, 'Радиус'),
          query('has_waypoints', { type: 'string', enum: ['true'] }, 'Только маршруты с двумя и более путевыми точками'),
          query(
            'place_type',
            // Правило входа — то же, чем проверяет сервер (lib/routes/place-type-param).
            { type: 'string', maxLength: 200, pattern: PLACE_TYPE_PARAM.source, examples: ['volcano', 'hot_spring,thermal', 'bay,cape,beach'] },
            'Только маршруты, чей путь проходит через место этого вида (location_type, до 8 через запятую, например volcano; hot_spring,thermal; bay,cape,beach); места «рядом с маршрутом» не считаются. Отбирает только маршруты: с kind=place выдача пуста',
          ),
          query('brief', { type: 'string', enum: ['1'] }, 'Описание первой строкой до 200 знаков'),
        ],
        responses: {
          '200': jsonResponse('Страница каталога', ref('CatalogResponse')),
          '400': jsonResponse('Неверные параметры запроса', ERROR_ENVELOPE),
          '503': jsonResponse('Каталог не прочитался', ERROR_ENVELOPE),
        },
      },
    },

    '/api/tours': {
      get: {
        tags: ['tours'],
        operationId: 'listTours',
        summary: 'Туры операторов на витрине',
        description: 'Живая занятость по датам — GET /api/tours/{id}/slots или инструмент get_tour_availability. Заявка на тур — инструмент create_booking_request (A2A/MCP), подтверждает оператор.',
        parameters: [
          query('category', { type: 'string' }, 'Тип активности (русские значения; английские алиасы fishing, volcanoes, bears и подобные принимаются)'),
          query('search', { type: 'string' }, 'Подстрока по названию и описанию'),
          query('limit', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Не больше 50'),
          query('offset', { type: 'integer', minimum: 0, default: 0 }, 'Смещение'),
        ],
        responses: { '200': jsonResponse('Список; при сбое — пустой список с degraded: true', ref('ToursResponse')) },
      },
    },
    '/api/tours/{id}': {
      get: {
        tags: ['tours'],
        operationId: 'getTour',
        summary: 'Карточка тура',
        parameters: [{ name: 'id', in: 'path', required: true, description: 'Числовой id тура (operator_tours.id)', schema: { type: 'string', pattern: '^\\d+$' } }],
        responses: {
          '200': jsonResponse('Тур', ref('TourDetailResponse')),
          '404': jsonResponse('Тура нет или он не на витрине', ERROR_ENVELOPE),
          '500': jsonResponse('Сбой', ERROR_ENVELOPE),
        },
      },
    },
    '/api/tours/{id}/slots': {
      get: {
        tags: ['tours'],
        operationId: 'getTourSlots',
        summary: 'Свободные даты тура с местами (реальная занятость)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d+$' } }],
        responses: {
          '200': jsonResponse('Даты', ref('TourSlotsResponse')),
          '400': jsonResponse('Некорректный id', ERROR_ENVELOPE),
          '404': jsonResponse('Тура нет или он не на витрине', ERROR_ENVELOPE),
          '500': jsonResponse('Сбой', ERROR_ENVELOPE),
        },
      },
    },

    '/api/places/{id}': {
      get: {
        tags: ['places'],
        operationId: 'getPlace',
        summary: 'Карточка места: факты, безопасность как свойство места, маршруты через него, туры к нему',
        parameters: [{ name: 'id', in: 'path', required: true, description: 'places.ark_id (UUID) — он же id у kind=place в каталоге', schema: { type: 'string', minLength: 10 } }],
        responses: {
          '200': jsonResponse('Место', ref('PlaceDetailResponse')),
          '400': jsonResponse('Некорректный id', ERROR_ENVELOPE),
          '404': jsonResponse('Места нет', ERROR_ENVELOPE),
          '500': jsonResponse('Сбой', ERROR_ENVELOPE),
        },
      },
    },

    '/api/public/safety-status': {
      get: {
        tags: ['safety'],
        operationId: 'safetyStatus',
        summary: 'Статус дня: есть ли тревога и какой силы',
        responses: { '200': jsonResponse('Статус или «данные недоступны»', ref('SafetyStatusResponse')) },
      },
    },
    '/api/safety/seismic': {
      get: {
        tags: ['safety'],
        operationId: 'seismic',
        summary: 'Толчки: лента КБГС РАН / USGS или окно по часам',
        parameters: [
          query('hours', { type: 'integer', minimum: 1, maximum: 72 }, 'Окно в часах из external_alerts; без параметра — лента источника'),
          query('fresh', { type: 'string', enum: ['1'] }, 'Обойти кэш (не чаще раза в 20 с на процесс)'),
        ],
        responses: {
          '200': jsonResponse('События', ref('SeismicResponse')),
          '400': jsonResponse('hours вне 1..72', ref('SeismicError')),
          '502': jsonResponse('Источник недоступен', ref('SeismicError')),
        },
      },
    },
    '/api/safety/volcanic': {
      get: {
        tags: ['safety'],
        operationId: 'volcanic',
        summary: 'Вулканы: события за 7 суток и повышенные статусы',
        responses: { '200': jsonResponse('События и статусы; при сбое — пусто с полем error', ref('VolcanicResponse')) },
      },
    },
    '/api/safety/weather': {
      get: {
        tags: ['safety', 'weather'],
        operationId: 'safetyWeather',
        summary: 'Погода экрана безопасности (Петропавловск-Камчатский)',
        responses: { '200': jsonResponse('Сводка строками', ref('SafetyWeather')), '502': jsonResponse('Прогноз не получен', { type: 'object', required: ['error'], properties: { error: { type: 'string' } } }) },
      },
    },
    '/api/weather': {
      get: {
        tags: ['weather'],
        operationId: 'weather',
        summary: 'Погода и прогноз по координатам',
        parameters: [
          query('lat', { type: 'number' }, 'Широта', true),
          query('lng', { type: 'number' }, 'Долгота', true),
          query('location', { type: 'string' }, 'Подпись места в ответе'),
          query('provider', { type: 'string', enum: ['yandex', 'openMeteo', 'openWeatherMap', 'weatherApi'], default: 'yandex' }, 'Предпочтительный провайдер; при отказе идут остальные'),
        ],
        responses: {
          '200': jsonResponse('Погода', ref('WeatherResponse')),
          '400': jsonResponse('Нет координат или они не числа', ERROR_ENVELOPE),
          '503': jsonResponse('Ни один провайдер не ответил', { type: 'object', required: ['success', 'unavailable', 'error'], properties: { success: { const: false }, unavailable: { const: true }, error: { type: 'string' } } }),
          '500': jsonResponse('Сбой', { type: 'object', required: ['success', 'error'], properties: { success: { const: false }, error: { type: 'string' }, message: { type: 'string' } } }),
        },
      },
    },

    '/.well-known/mcp.json': { get: { tags: ['discovery'], operationId: 'mcpManifest', summary: 'Манифест MCP: эндпоинт, каталоги, варианты подключения, A2A, инструменты', responses: { '200': jsonResponse('Манифест', { type: 'object', additionalProperties: true }) } } },
    [AGENT_CARD_PATH]: { get: { tags: ['discovery'], operationId: 'agentCard', summary: 'Визитка A2A 1.0', responses: { '200': jsonResponse('Agent Card', ref('AgentCard')) } } },
    [LEGACY_AGENT_CARD_PATH]: { get: { tags: ['discovery'], operationId: 'agentCardLegacy', summary: 'Визитка A2A 0.3', responses: { '200': jsonResponse('Agent Card 0.3', ref('AgentCard')) } } },
    [AI_CATALOG_PATH]: { get: { tags: ['discovery'], operationId: 'aiCatalog', summary: 'AI Catalog домена', responses: { '200': { description: 'Каталог', content: { [AI_CATALOG_MEDIA_TYPE]: { schema: ref('AiCatalog') } } } } } },
    [API_CATALOG_PATH]: { get: { tags: ['discovery'], operationId: 'apiCatalog', summary: 'Каталог API по RFC 9727 (linkset)', responses: { '200': { description: 'Linkset', content: { [LINKSET_MEDIA_TYPE]: { schema: ref('ApiCatalog') } } } } } },
    [OPENAPI_PATH]: { get: { tags: ['discovery'], operationId: 'openapi', summary: 'Этот документ', responses: { '200': { description: 'OpenAPI 3.1', content: { [JSON_CT]: { schema: { type: 'object', additionalProperties: true } }, [OPENAPI_MEDIA_TYPE]: { schema: { type: 'object', additionalProperties: true } } } } } } },
    '/llms.txt': { get: { tags: ['discovery'], operationId: 'llmsTxt', summary: 'Описание платформы для моделей и агентов', responses: { '200': { description: 'Текст', content: { 'text/plain': { schema: { type: 'string' } } } } } } },
  };

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: manifest.title,
      version: manifest.version,
      summary: manifest.description,
      description:
        'Публичный API информационного портала «Ведар Камчатка». Ведар не турагентство и не туроператор. Для программ, которым недоступны MCP и A2A-клиенты. '
        + 'Всё без авторизации. Запись — только заявки через инструменты create_lead, create_booking_request, '
        + 'create_stay_request, request_charter, create_car_rental_request (A2A DataPart или MCP tools/call), их подтверждает человек; '
        + 'мгновенной брони и оплаты нет. Данные на русском. Экстренный вызов на Камчатке — 112. '
        + 'Public API of Vedar Kamchatka, a Kamchatka travel information portal and AI guide, not a travel agency and not a tour operator. For clients without MCP or A2A: read endpoints, A2A REST binding, MCP endpoint. '
        + 'Requests are human-confirmed; no instant booking or payment.'
        + ' ' + OPENAPI_DESCRIPTION_ZH,
      termsOfService: `${b}/legal/terms`,
      contact: { name: 'Ведар', url: `${b}/contact` },
    },
    externalDocs: { description: 'llms.txt — описание для моделей; /mcp — страница сервера', url: `${b}/llms.txt` },
    servers: [{ url: b }],
    tags: [
      { name: 'a2a', description: 'Agent2Agent 1.0 (и 0.3): текст Кузьмичу или точный вызов инструмента' },
      { name: 'mcp', description: 'Model Context Protocol по Streamable HTTP' },
      { name: 'catalog', description: 'Места, маршруты и туры одним каталогом' },
      { name: 'tours', description: 'Туры операторов и их реальная занятость' },
      { name: 'places', description: 'Карточка места' },
      { name: 'safety', description: 'Статус дня, сейсмика, вулканы' },
      { name: 'weather', description: 'Погода' },
      { name: 'discovery', description: 'Манифесты, визитки и каталоги' },
    ],
    paths,
    // Уведомление агенту об изменении заявки (29.10): адрес — notify_url в
    // аргументах пишущего инструмента, тело — RequestNotification, подпись —
    // Standard Webhooks. Сервер шлёт POST сам; это не путь, который зовёт клиент.
    webhooks: {
      requestUpdated: {
        post: {
          operationId: 'requestUpdated',
          summary: 'Заявка изменилась / Request changed',
          description:
            'Приходит на notify_url, переданный при создании заявки (create_lead, create_booking_request, request_charter, create_car_rental_request), '
            + 'когда меняются состояние, дата, предложенная оператором дата, тур или число человек. Сверка идёт по расписанию примерно раз в 30 минут, срок не гарантирован. '
            + NOTIFY_HOW_TO_VERIFY + ' '
            + NOTIFY_RESPONSE_RULES + ' '
            + 'Sent to the notify_url given when the request was created, when its state, date, offered date, tour or group size changes; signed per Standard Webhooks '
            + '(webhook-id, webhook-timestamp, webhook-signature v1 = base64 HMAC-SHA256 of "id.timestamp.body", key = base64 after whsec_). '
            + 'Reject timestamps older than 5 minutes, drop repeated webhook-id, prefer the later observed_at. '
            + NOTIFY_RESPONSE_RULES_EN,
          parameters: [
            { name: 'webhook-id', in: 'header', required: true, schema: { type: 'string', pattern: '^evt_[0-9a-f]{32}$' }, description: 'Один и тот же у повторов одного уведомления / same for retries of one delivery' },
            { name: 'webhook-timestamp', in: 'header', required: true, schema: { type: 'string', pattern: '^[0-9]+$' }, description: 'Секунды Unix в момент попытки / Unix seconds of the attempt' },
            { name: 'webhook-signature', in: 'header', required: true, schema: { type: 'string', pattern: '^v1,' }, description: 'v1,<base64 HMAC-SHA256>' },
          ],
          requestBody: { required: true, content: { [JSON_CT]: { schema: ref('RequestNotification') } } },
          responses: {
            '200': { description: 'Принято / accepted (any 2xx)' },
            '410': { description: 'Подписку отключить / disable the subscription' },
            // Любой другой 4xx отключает так же, с первого ответа (outcomeOfStatus);
            // повторяются только перечисленные — их слово в описании ответа.
            '4XX': { description: `Подписка отключается с первого ответа, кроме ${NOTIFY_RETRY_4XX.join('/')} — их повторяют / disables the subscription on the first reply, except ${NOTIFY_RETRY_4XX.join('/')}, which are retried` },
          },
        },
      },
    },
    components: { schemas },
  };
}

/** Каталог API по RFC 9727: linkset с тремя контекстами — публичный API, MCP, A2A. */
export function buildApiCatalog(base: string): Json {
  const b = base.replace(/\/$/, '');
  return {
    linkset: [
      {
        anchor: `${b}/api/`,
        'service-desc': [{ href: `${b}${OPENAPI_PATH}`, type: OPENAPI_MEDIA_TYPE }],
        'service-doc': [
          { href: `${b}/mcp`, type: 'text/html' },
          { href: `${b}/llms.txt`, type: 'text/plain' },
        ],
        'service-meta': [{ href: `${b}/legal/terms`, type: 'text/html' }],
      },
      {
        anchor: `${b}/api/mcp`,
        'service-desc': [
          { href: `${b}${SERVER_CARD_PATH}`, type: SERVER_CARD_MEDIA_TYPE },
          { href: `${b}/.well-known/mcp.json`, type: JSON_CT },
        ],
        'service-doc': [{ href: `${b}/mcp`, type: 'text/html' }],
      },
      {
        anchor: `${b}${A2A_JSONRPC_PATH}`,
        'service-desc': [
          { href: `${b}${AGENT_CARD_PATH}`, type: A2A_CARD_MEDIA_TYPE },
          { href: `${b}${LEGACY_AGENT_CARD_PATH}`, type: A2A_CARD_MEDIA_TYPE },
          { href: `${b}${AI_CATALOG_PATH}`, type: AI_CATALOG_MEDIA_TYPE },
        ],
        'service-doc': [{ href: `${b}/llms.txt`, type: 'text/plain' }],
      },
    ],
  };
}
