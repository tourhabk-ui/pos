// Конфигурация приложения Kamchatour Hub

// Публичный бренд-канон. Все siteName/OG/UI используют его.
// KamchatourHub — только техническое/юридическое имя, TourHab — legacy, публично не используется.
export const SITE_NAME = 'Ведар';

/**
 * Публичный базовый URL платформы для ссылок, уходящих наружу
 * (письма, Telegram, PDF). На Timeweb NEXT_PUBLIC_APP_URL указывает на
 * технический twc1.net-домен — тогда берём NEXT_PUBLIC_SITE_URL или канон.
 * Не использовать захардкоженные домены в исходящих ссылках.
 */
export function getPublicBaseUrl(): string {
  return (
    (process.env.NEXT_PUBLIC_APP_URL?.includes('twc1.net')
      ? (process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru')
      : process.env.NEXT_PUBLIC_APP_URL) ?? 'https://vedarai.ru'
  );
}

export const config = {
  // Основные настройки
  app: {
    name: 'Kamchatour Hub',
    version: '1.0.0',
    description: 'Современная туристическая платформа для Камчатского края',
    url: (process.env.NEXT_PUBLIC_APP_URL?.includes('twc1.net') ? (process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru') : process.env.NEXT_PUBLIC_APP_URL) || 'https://vedarai.ru',
    environment: process.env.NODE_ENV || 'development',
    debug: process.env.NODE_ENV === 'development',
  },

  // Настройки базы данных
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/kamchatour',
    ssl: process.env.DATABASE_SSL === 'true',
    maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || '20'),
    connectionTimeout: parseInt(process.env.DATABASE_CONNECTION_TIMEOUT || '2000'),
    idleTimeout: parseInt(process.env.DATABASE_IDLE_TIMEOUT || '30000'),
  },

  // Настройки AI
  ai: {
    timeweb: {
      timeout: 30000,
      maxTokens: parseInt(process.env.AI_MAX_TOKENS || '800'),
      knowledgeBase: {
        enabled: !!process.env.TIMEWEB_AI_KB_ID,
        id: process.env.TIMEWEB_AI_KB_ID || '',
        updateEndpoint: 'https://api.timeweb.cloud/api/v1/cloud-ai/knowledge-bases',
        maxDocuments: 300,
        chunkSize: 1000,
      },
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseUrl: 'https://api.deepseek.com/v1',
      // Синхронный конфиг не может спросить /v1/models. deepseek-chat умер
      // 26.07.2026 вместе с линейкой v3 — дефолт из списка поддерживаемых,
      // override через DEEPSEEK_MODEL (как у резолвера в providers).
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4000'),
      temperature: 0.7,
      timeout: 30000,
    },
    minimax: {
      apiKey: process.env.MINIMAX_API_KEY || '',
      baseUrl: 'https://api.minimax.chat/v1',
      model: 'abab6.5s-chat',
      maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4000'),
      temperature: 0.7,
      timeout: 30000,
    },
    xai: {
      apiKey: process.env.XAI_API_KEY || '',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4',
      maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4000'),
      temperature: 0.7,
      timeout: 30000,
    },
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY || '',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta-llama/llama-3.1-70b-instruct',
      maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4000'),
      temperature: 0.7,
      timeout: 30000,
    },
    dailyBudget: parseFloat(process.env.AI_DAILY_BUDGET_USD || '10.0'),
  },

  // Настройки аутентификации
  auth: {
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
    passwordMinLength: 8,
    maxLoginAttempts: 5,
    lockoutDuration: 15 * 60 * 1000, // 15 минут
  },

  // Настройки файлов
  files: {
    maxSize: parseInt(process.env.FILE_MAX_SIZE || '10485760'), // 10MB
    allowedTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
      'text/plain',
    ],
    uploadPath: process.env.FILE_UPLOAD_PATH || '/uploads',
    cdnUrl: process.env.CDN_URL || '',
  },

  // Настройки карт
  maps: {
    yandex: {
      apiKey: process.env.YANDEX_MAPS_API_KEY || '',
      baseUrl: 'https://api-maps.yandex.ru/2.1',
    },
    openstreetmap: {
      baseUrl: 'https://nominatim.openstreetmap.org',
      userAgent: 'Kamchatour Hub/1.0',
    },
  },

  // Настройки погоды
  weather: {
    openMeteo: {
      baseUrl: 'https://api.open-meteo.com/v1',
      timeout: 10000,
    },
    openWeatherMap: {
      apiKey: process.env.OPENWEATHERMAP_API_KEY || '',
      baseUrl: 'https://api.openweathermap.org/data/2.5',
      timeout: 10000,
    },
    weatherApi: {
      apiKey: process.env.WEATHERAPI_KEY || '',
      baseUrl: 'https://api.weatherapi.com/v1',
      timeout: 10000,
    },
    yandex: {
      apiKey: process.env.YANDEX_WEATHER_API_KEY || '',
      baseUrl: 'https://api.weather.yandex.ru/v2',
      timeout: 10000,
    },
    cacheTimeout: 30 * 60 * 1000, // 30 минут
    defaultProvider: 'yandex', // 'openMeteo' | 'openWeatherMap' | 'weatherApi' | 'yandex' - Используем Yandex для максимальной точности на Камчатке
  },

  // Настройки платежей
  payments: {
    yandex: {
      shopId: process.env.YANDEX_PAYMENT_SHOP_ID || '',
      secretKey: process.env.YANDEX_PAYMENT_SECRET_KEY || '',
      baseUrl: 'https://api.yookassa.ru/v3',
    },
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY || '',
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    },
  },

  // Настройки уведомлений
  notifications: {
    email: {
      smtp: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
        },
      },
      from: process.env.EMAIL_FROM || 'noreply@tourhab.ru',
    },
    sms: {
      smsRu: {
        apiId: process.env.SMS_RU_API_KEY || '',
        baseUrl: 'https://sms.ru/sms/send',
      },
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
    },
  },

  // Настройки кэширования
  cache: {
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      password: process.env.REDIS_PASSWORD || '',
      db: parseInt(process.env.REDIS_DB || '0'),
    },
    defaultTTL: 3600, // 1 час
    maxTTL: 86400, // 24 часа
  },

  // Настройки мониторинга
  monitoring: {
    prometheus: {
      enabled: process.env.PROMETHEUS_ENABLED === 'true',
      port: parseInt(process.env.PROMETHEUS_PORT || '9090'),
    },
  },

  // Настройки безопасности
  security: {
    cors: {
      origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
      credentials: true,
    },
    rateLimit: {
      windowMs: 15 * 60 * 1000, // 15 минут
      max: 100, // максимум 100 запросов с одного IP
    },
    helmet: {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://api.deepseek.com"],
        },
      },
    },
  },

  // Настройки разработки
  development: {
    hotReload: process.env.NODE_ENV === 'development',
    mockData: process.env.MOCK_DATA === 'true',
    verboseLogging: process.env.VERBOSE_LOGGING === 'true',
  },

  // Настройки продакшена
  production: {
    compression: true,
    minify: true,
    sourceMaps: false,
    analytics: {
      googleAnalytics: process.env.GOOGLE_ANALYTICS_ID || '',
      yandexMetrika: process.env.YANDEX_METRIKA_ID || '',
    },
  },
};

/**
 * Итог проверки конфигурации: два уровня, а не «валидно / невалидно».
 *
 * Одним списком нельзя: отсутствующий ключ карт и подпись токенов известным
 * всему миру значением — беды разного порядка. Сваленные в кучу, они либо
 * приучают пролистывать список, либо валят запуск из-за мелочи.
 */
export interface ConfigCheck {
  /** С этим работать нельзя: подпись сессий и доступ к данным. */
  fatal: string[];
  /** Работать можно, но часть возможностей не поднимется. */
  warnings: string[];
}

/**
 * Проверка конфигурации платформы.
 *
 * До 22.08.2026 функция была написана и не вызывалась ниоткуда: прод с
 * `JWT_SECRET`, равным строке-заглушке, поднялся бы молча — а это значит, что
 * любой желающий подписывает токен любого пользователя. Зовётся при старте
 * (`instrumentation.ts`).
 */
export function validateConfig(): ConfigCheck {
  const fatal: string[] = [];
  const warnings: string[] = [];

  if (!config.database.url) {
    fatal.push('DATABASE_URL не задан — платформа не видит своих данных');
  }

  if (!config.auth.jwtSecret) {
    fatal.push('JWT_SECRET не задан — подписывать сессии нечем');
  } else if (config.auth.jwtSecret === 'your-secret-key') {
    fatal.push('JWT_SECRET равен строке-заглушке из примера — токен подделает кто угодно');
  } else if (config.auth.jwtSecret.length < 32) {
    fatal.push(`JWT_SECRET короче 32 символов (${config.auth.jwtSecret.length}) — подбор реален`);
  }

  if (config.app.environment === 'production' && !config.maps.yandex.apiKey) {
    warnings.push('YANDEX_MAPS_API_KEY не задан — карты Яндекса в проде не поднимутся');
  }

  return { fatal, warnings };
}

// getClientConfig убрана 22.08.2026 (перепись): не звалась.
//
// Она собирала «конфигурацию без секретов» для браузера, а клиентские
// компоненты берут NEXT_PUBLIC_* из process.env напрямую — 33 места. Одна
// дверь для того, что видно браузеру, была бы лучше, но заводится она сразу
// для всех, иначе получается два способа и оба неполные.
