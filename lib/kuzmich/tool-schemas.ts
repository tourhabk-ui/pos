/**
 * lib/kuzmich/tool-schemas.ts
 *
 * Единый реестр инструментов Кузьмича — то немногое из идеи "MCP-слоя",
 * что применимо на нашем масштабе (без нового MCP-сервера/фреймворка).
 * До этого файла: JSON-схема аргументов существовала только для API модели
 * (KUZMICH_TOOLS в core.ts), а реальный парсинг в tool-loop.ts делал
 * `JSON.parse(...) as Record<string, string>` без проверки — битые или
 * неожиданные аргументы уходили прямо в executeTool.
 *
 * Реестр — одна точка правды: имя инструмента → { definition (JSON-схема
 * для API модели), schema (zod, для рантайм-валидации). KUZMICH_TOOLS
 * генерируется из реестра, а не дублируется руками.
 *
 * Решение по лишним полям: необъявленные в схеме поля молча отбрасываются
 * (стандартное поведение z.object() без .passthrough()) — ни один executor
 * их не читает, ошибкой это не считаем.
 */

import { z } from 'zod';
import type { ToolDefinition } from '@/lib/ai/providers';

/**
 * Строковое поле: допускает нестроковый JSON (число/bool → String(...)),
 * триммит и ОБРЕЗАЕТ (не отвергает) до максимума — превышение длины не
 * должно ломать вызов, который раньше "работал" без всякого лимита.
 * Пустая после trim строка остаётся невалидной (обязательное поле не может
 * быть пустым — на это и раньше нельзя было опереться).
 */
function looseString(max: number) {
  return z.preprocess(
    (v) => {
      if (v === undefined || v === null) return v;
      const s = typeof v === 'string' ? v : String(v);
      return s.trim().slice(0, max);
    },
    z.string().min(1),
  );
}

// ── search_kamchatka ──────────────────────────────────────────────────────
const searchKamchatkaSchema = z.object({
  query: looseString(300),
});

// ── get_tours ─────────────────────────────────────────────────────────────
const getToursSchema = z.object({
  activity_type: looseString(100).optional(),
});

// ── get_tour_details ──────────────────────────────────────────────────────
// Полная карточка одного тура: описание, программа, точка сбора/логистика,
// что входит/не входит, что взять. Общий список (get_tours) их не отдаёт —
// иначе промпт раздувается. Ищем по названию/ключевому слову.
const getTourDetailsSchema = z.object({
  name: looseString(200).optional(),
  query: looseString(200).optional(),
}).refine(v => !!(v.name || v.query), { message: 'нужно указать name (название или ключевое слово тура)' });

// ── get_guardian_context ──────────────────────────────────────────────────
// executeTool исторически принимает `place` ИЛИ `name` (args.place ?? args.name) —
// сохраняем эту терпимость, а не только объявленный в JSON-схеме `place`.
const getGuardianContextSchema = z.object({
  place: looseString(200).optional(),
  name: looseString(200).optional(),
}).refine(v => !!(v.place || v.name), { message: 'нужно указать place (название места)' });

// ── get_place_info ────────────────────────────────────────────────────────
const getPlaceInfoSchema = z.object({
  name: looseString(200),
});

// ── get_weather ───────────────────────────────────────────────────────────
const getWeatherSchema = z.object({});

const safetyStatusSchema = z.object({});

// ── make_trip_plan ──────────────────────────────────────────────────────────
// План поездки по дням («Мой план 2.0», A-2). Оба поля необязательны:
// без days — неделя, без interests — классика первой поездки.
const makeTripPlanSchema = z.object({
  days: looseString(4).optional(),
  interests: looseString(300).optional(),
});

// ── get_tour_availability ───────────────────────────────────────────────────
// Свободные даты и места тура (Эволюция 3.0, п.4). Даты/числа приходят
// строками (как все args) — executor валидирует и клампит сам.
const getTourAvailabilitySchema = z.object({
  tour: looseString(200),
  date_from: looseString(20).optional(),
  days: looseString(10).optional(),
});

// ── search_taaft ──────────────────────────────────────────────────────────
// executeTool принимает `task` ИЛИ `query` (args.task ?? args.query).
const searchTaaftSchema = z.object({
  task: looseString(300).optional(),
  query: looseString(300).optional(),
}).refine(v => !!(v.task || v.query), { message: 'нужно указать task (что нужно сделать)' });

// ── search_accommodations ───────────────────────────────────────────────────
// Все фильтры необязательны — без них отдаём топ по рейтингу. price_max
// приходит строкой (как и прочие args), executor коэрсит через Number().
const searchAccommodationsSchema = z.object({
  zone: looseString(100).optional(),
  type: looseString(50).optional(),
  price_max: looseString(20).optional(),
});

// ── search_gear ─────────────────────────────────────────────────────────────
// Прокат снаряжения. Все фильтры необязательны — без них топ по рейтингу.
const searchGearSchema = z.object({
  query: looseString(100).optional(),
  category: looseString(50).optional(),
  price_max: looseString(20).optional(),
});

// ── search_transfers ────────────────────────────────────────────────────────
// Места в поездках перевозчиков (витрина схемы 926, 02.09). Все фильтры
// необязательны: без них — ближайшие две недели, от одного места.
const searchTransfersSchema = z.object({
  from: looseString(10).optional(),
  to: looseString(10).optional(),
  seats: looseString(3).optional(),
  place: looseString(100).optional(),
});

interface ToolSpec {
  definition: ToolDefinition;
  schema: z.ZodTypeAny;
}

export const TOOL_REGISTRY: Record<string, ToolSpec> = {
  search_kamchatka: {
    definition: {
      type: 'function',
      function: {
        name: 'search_kamchatka',
        description: 'Поиск актуальной информации о Камчатке: цены, адреса, телефоны, расписание, отзывы. Используй ВСЕГДА когда не знаешь точных цифр или деталей.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Поисковый запрос' } }, required: ['query'] },
      },
    },
    schema: searchKamchatkaSchema,
  },
  get_tours: {
    definition: {
      type: 'function',
      function: {
        name: 'get_tours',
        description: 'Получить активные туры из платформы TourHab с ценами и датами. Используй когда турист спрашивает о конкретных турах или программах.',
        parameters: { type: 'object', properties: { activity_type: { type: 'string', description: 'Фильтр по типу: рыбалка, вулканы, медведи, гейзеры, трекинг и т.д.' } }, required: [] },
      },
    },
    schema: getToursSchema,
  },
  get_tour_details: {
    definition: {
      type: 'function',
      function: {
        name: 'get_tour_details',
        description: 'Полные детали КОНКРЕТНОГО тура: описание, программа, точка сбора и логистика (старт/забор), что входит и не входит, что взять с собой. Используй ВСЕГДА, когда турист спрашивает про конкретный тур — что там по программе, откуда стартуют, где сбор, что взять. Не выдумывай эти детали сам — бери отсюда.',
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'Название тура или ключевое слово (например «сплав», «Быстрая», «рыбалка»)' } }, required: ['name'] },
      },
    },
    schema: getTourDetailsSchema,
  },
  get_guardian_context: {
    definition: {
      type: 'function',
      function: {
        name: 'get_guardian_context',
        description: 'Получить полный контекст места как Хранитель: статус (открыто/закрыто), реалтайм алерты КБГС РАН, опасности, загрузка, традиционные знания о месте. Используй ВСЕГДА когда спрашивают о конкретном месте, вулкане, озере, маршруте, источнике Камчатки.',
        parameters: { type: 'object', properties: { place: { type: 'string', description: 'Название места или объекта' } }, required: ['place'] },
      },
    },
    schema: getGuardianContextSchema,
  },
  get_place_info: {
    definition: {
      type: 'function',
      function: {
        name: 'get_place_info',
        description: 'Найти базовую информацию о месте из базы данных (используй get_guardian_context для полного контекста с безопасностью и алертами).',
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'Название объекта' } }, required: ['name'] },
      },
    },
    schema: getPlaceInfoSchema,
  },
  get_weather: {
    definition: {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Получить текущую погоду в Петропавловске-Камчатском.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    schema: getWeatherSchema,
  },
  search_accommodations: {
    definition: {
      type: 'function',
      function: {
        name: 'search_accommodations',
        description: 'Найти жильё на Камчатке (гостиницы, базы, глэмпинг, дома) из платформы TourHab с ценами и адресами. Используй когда турист спрашивает где остановиться, переночевать, снять жильё.',
        parameters: {
          type: 'object',
          properties: {
            zone: { type: 'string', description: 'Зона расположения (например: Петропавловск-Камчатский, Налычево, Паратунка)' },
            type: { type: 'string', description: 'Тип жилья: hotel, hostel, guesthouse, glamping, apartment, cottage' },
            price_max: { type: 'string', description: 'Максимальная цена за ночь в рублях' },
          },
          required: [],
        },
      },
    },
    schema: searchAccommodationsSchema,
  },
  search_transfers: {
    definition: {
      type: 'function',
      function: {
        name: 'search_transfers',
        description: 'Найти свободные места в поездках перевозчиков Камчатки (джипы, вахтовки, микроавтобусы) из витрины TourHab: дата, направление, остаток мест, цена места. Используй когда турист спрашивает как доехать, есть ли трансфер, заброска, попутный джип к вулкану или источникам. Место занимается только после подтверждения перевозчика.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Начало окна дат, ГГГГ-ММ-ДД (по умолчанию сегодня)' },
            to: { type: 'string', description: 'Конец окна дат, ГГГГ-ММ-ДД (по умолчанию +14 дней, не больше 60)' },
            seats: { type: 'string', description: 'Сколько мест нужно (по умолчанию 1)' },
            place: { type: 'string', description: 'Куда или откуда: слово из направления, например «Горелый», «Толбачик», «аэропорт»' },
          },
          required: [],
        },
      },
    },
    schema: searchTransfersSchema,
  },
  search_gear: {
    definition: {
      type: 'function',
      function: {
        name: 'search_gear',
        description: 'Найти прокат туристического снаряжения на Камчатке из платформы TourHab с ценами за сутки. Используй когда турист спрашивает где арендовать/взять напрокат снаряжение: палатку, спальник, треккинговые палки, рюкзак, кошки, газовую горелку и т.д.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Что ищут: например "палатка", "спальник", "треккинговые палки", бренд' },
            category: { type: 'string', description: 'Категория снаряжения (если известна)' },
            price_max: { type: 'string', description: 'Максимальная цена за сутки в рублях' },
          },
          required: [],
        },
      },
    },
    schema: searchGearSchema,
  },
  // Обстановка по КРАЮ целиком — то, чего нет ни у кого, кроме нас: сейсмика и
  // вулканы КБГС РАН, сведённые в один ответ. Внешний агент спрашивает это
  // первым («безопасно ли сейчас на Камчатке»), а по конкретному месту дальше
  // идёт в get_guardian_context.
  safety_status: {
    definition: {
      type: 'function',
      function: {
        name: 'safety_status',
        description: 'Текущая обстановка по Камчатскому краю целиком: активные предупреждения, их количество и тяжесть, свежесть данных (источник — КБГС РАН). Используй, когда спрашивают, безопасно ли сейчас ехать или что происходит в крае. Для конкретного места используй get_guardian_context.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    schema: safetyStatusSchema,
  },
  make_trip_plan: {
    definition: {
      type: 'function',
      function: {
        name: 'make_trip_plan',
        description: 'Собрать план поездки по Камчатке по дням: зоны, активности, честные цены, предупреждения сезона. Используй, когда туриста интересует «что посмотреть за N дней», «составь маршрут/план поездки», «как спланировать неделю на Камчатке». Ответ содержит ссылку на страницу готового плана с бронью туров.',
        parameters: {
          type: 'object',
          properties: {
            days: { type: 'string', description: 'Сколько дней поездка (число, 3–21). Не сказано — 7.' },
            interests: { type: 'string', description: 'Интересы туриста своими словами: «вулканы и медведи», «рыбалка», «море и термальные»' },
          },
          required: [],
        },
      },
    },
    schema: makeTripPlanSchema,
  },
  get_tour_availability: {
    definition: {
      type: 'function',
      function: {
        name: 'get_tour_availability',
        description: 'Свободные даты и места КОНКРЕТНОГО тура из реальной занятости броней. Используй всегда, когда турист спрашивает «когда есть места», «свободно ли на дату», «на какие даты можно» — не называй даты и места по памяти, только отсюда.',
        parameters: {
          type: 'object',
          properties: {
            tour: { type: 'string', description: 'Название тура, ключевое слово или числовой ID' },
            date_from: { type: 'string', description: 'С какой даты смотреть, YYYY-MM-DD. Не сказано — с сегодня.' },
            days: { type: 'string', description: 'Окно в днях (1–31). Не сказано — 14.' },
          },
          required: ['tour'],
        },
      },
    },
    schema: getTourAvailabilitySchema,
  },
  search_taaft: {
    definition: {
      type: 'function',
      function: {
        name: 'search_taaft',
        description: 'Найти внешний AI-инструмент или онлайн-сервис для специфической задачи: определить растение или животное по фото, транскрибировать аудио, обработать GPX-трек, перевести текст, создать аудиогид, проверить лавинную обстановку. Используй когда нужен специализированный инструмент за пределами TourHab.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Что нужно сделать (на русском): например "определить растение на фото", "транскрибировать аудиозапись", "анализировать GPX-трек"' },
          },
          required: ['task'],
        },
      },
    },
    schema: searchTaaftSchema,
  },
};

/** Сгенерировано из реестра — JSON-схема для API модели, не дублируется руками. */
export const KUZMICH_TOOLS: ToolDefinition[] = Object.values(TOOL_REGISTRY).map(t => t.definition);

export type ToolValidation =
  | { ok: true; args: Record<string, string> }
  | { ok: false; error: string };

/**
 * Валидирует сырые аргументы tool_call перед исполнением (Roitman: защитный
 * слой на границе модель→executor). Неизвестное имя инструмента НЕ считаем
 * ошибкой валидации — пропускаем как ok:true без изменений, чтобы executeTool
 * сам отдал своё существующее сообщение "Неизвестный инструмент." (поведение
 * этого случая не меняем).
 */
export function validateToolArgs(name: string, rawArgs: Record<string, string>): ToolValidation {
  const spec = TOOL_REGISTRY[name];
  if (!spec) return { ok: true, args: rawArgs };

  const parsed = spec.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const message = parsed.error.issues.map(i => i.message).join('; ') || 'некорректные аргументы';
    return { ok: false, error: `Аргументы для ${name} не прошли проверку: ${message}. Повтори вызов с корректными аргументами.` };
  }
  return { ok: true, args: parsed.data as Record<string, string> };
}
