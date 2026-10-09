/**
 * scripts/research/platforms.config.ts
 *
 * Конфигурация платформ для marketplace audit.
 * Каждая платформа — оператор fishingkam изнутри.
 */

export interface PlatformConfig {
  id: string;
  name: string;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'broken' | 'skip';
  loginUrl: string;
  dashboardUrl?: string;
  addTourUrl?: string;
  credentials: {
    emailField?: string;
    passwordField?: string;
    email: string;
    password: string;
  };
  notes?: string;
}

/**
 * Логин и пароль кабинета площадки — только из окружения:
 * RESEARCH_<ID>_EMAIL и RESEARCH_<ID>_PASSWORD (ID заглавными, «-» → «_»).
 *
 * До 09.10 они лежали здесь открытым текстом, а репозиторий публичный: шесть
 * паролей и восемь почт видел любой с 17.05 (коммит 425e4c19c). Пустые значения —
 * «войти не можем»: аудит такую площадку пропускает (marketplace-audit.ts).
 * Сторож: tests/unit/no-plaintext-credentials.test.ts.
 */
function credentialsFromEnv(id: string): { email: string; password: string } {
  const key = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    email: process.env[`RESEARCH_${key}_EMAIL`] ?? '',
    password: process.env[`RESEARCH_${key}_PASSWORD`] ?? '',
  };
}

export const PLATFORMS: PlatformConfig[] = [
  // ── БЛОК 1 — российские туры (главный приоритет) ──────────────────────────────

  {
    id: 'tripster',
    name: 'Tripster',
    priority: 'high',
    status: 'active',
    loginUrl: 'https://experience.tripster.ru/accounts/login/',
    dashboardUrl: 'https://experience.tripster.ru/guide/dashboard/',
    addTourUrl: 'https://experience.tripster.ru/guide/experiences/new/',
    credentials: credentialsFromEnv('tripster'),
    notes: 'Уже интегрирован (lib/channels/tripster.ts). Проверить поля тура.',
  },
  {
    id: 'sputnik8',
    name: 'Sputnik8',
    priority: 'high',
    status: 'active',
    loginUrl: 'https://www.sputnik8.com/ru/sign_in',
    dashboardUrl: 'https://www.sputnik8.com/ru/partner',
    credentials: credentialsFromEnv('sputnik8'),
    notes: 'Уже интегрирован в channel sync. Изучить структуру тура.',
  },
  {
    id: 'russpass',
    name: 'Russpass',
    priority: 'high',
    status: 'active',
    loginUrl: 'https://russpass.ru/partners',
    credentials: credentialsFromEnv('russpass'),
    notes: 'Гос. платформа, бесплатно. Пароль пустой — нужна регистрация.',
  },
  {
    id: 'tourister',
    name: 'Tourister',
    priority: 'medium',
    status: 'active',
    loginUrl: 'https://www.tourister.ru/login',
    credentials: credentialsFromEnv('tourister'),
    notes: 'Объявления туров. Проверить формат карточки.',
  },
  {
    id: 'zoon',
    name: 'Zoon',
    priority: 'medium',
    status: 'active',
    loginUrl: 'https://b.zoon.ru/login/',
    credentials: credentialsFromEnv('zoon'),
    notes: 'Услуги и отзывы.',
  },

  // ── БЛОК 2 — агрегаторы ───────────────────────────────────────────────────────

  {
    id: 'level_travel',
    name: 'LevelTravel',
    priority: 'medium',
    status: 'active',
    loginUrl: 'https://partners.level.travel/login',
    credentials: credentialsFromEnv('level_travel'),
    notes: 'Попадаешь в Яндекс.Путешествия. СМС не приходит — возможно нужна живая авторизация.',
  },
  {
    id: 'travelpayouts',
    name: 'Travelpayouts',
    priority: 'low',
    status: 'active',
    loginUrl: 'https://travelpayouts.com/login',
    credentials: credentialsFromEnv('travelpayouts'),
    notes: 'Партнёрская сеть (Sputnik8 + все).',
  },

  // ── БЛОК 3 — международные (низкий приоритет) ────────────────────────────────

  {
    id: 'fishingbooker',
    name: 'FishingBooker',
    priority: 'low',
    status: 'active',
    loginUrl: 'https://fishingbooker.com/guides/sign_in',
    credentials: credentialsFromEnv('fishingbooker'),
    notes: 'Международная рыбалка. Пароль неизвестен.',
  },

  // ── ПРОПУСТИТЬ (сайты не работают) ───────────────────────────────────────────

  {
    id: 'rybinka',
    name: 'Рыбинка',
    priority: 'low',
    status: 'broken',
    loginUrl: 'https://rybinka.ru',
    credentials: credentialsFromEnv('rybinka'),
    notes: 'Домен продаётся.',
  },
  {
    id: 'rybalka_ru',
    name: 'Рыбалка.ру',
    priority: 'low',
    status: 'broken',
    loginUrl: 'https://rybalka.ru',
    credentials: credentialsFromEnv('rybalka_ru'),
    notes: 'Сайт не действителен.',
  },
  {
    id: 'tinkoff_travel',
    name: 'Tinkoff Путешествия',
    priority: 'low',
    status: 'broken',
    loginUrl: 'https://travel.tinkoff.ru/partners',
    credentials: credentialsFromEnv('tinkoff_travel'),
    notes: 'Сайт не грузится даже c VPN.',
  },
];

export const ACTIVE_PLATFORMS = PLATFORMS.filter(p => p.status === 'active');
export const HIGH_PRIORITY = PLATFORMS.filter(p => p.priority === 'high' && p.status === 'active');
