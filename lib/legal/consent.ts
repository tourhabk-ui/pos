/**
 * Согласие посетителя на аналитику и рекламные скрипты.
 *
 * ── Третий исход есть и здесь (§4.0) ──────────────────────────────────────
 *
 * Состояний ТРИ, и они не сводятся к двум:
 *   `granted`  — человек согласился;
 *   `denied`   — человек отказался;
 *   `unknown`  — ещё не спрашивали, или ответ не читается (приватное окно,
 *                очищенное хранилище, отключённые site data).
 *
 * `unknown` — НЕ «согласился». Именно этой подменой живёт большинство
 * баннеров: не ответил — считаем, что можно. Здесь неизвестность приравнена
 * к отказу, потому что цена ошибки несимметрична: не загруженная аналитика
 * чинится следующим визитом, ушедшие данные не отзываются.
 *
 * Хранение — `localStorage`, то есть у самого посетителя. Согласие на
 * аналитику не стоит того, чтобы заводить ради него серверную запись с новым
 * идентификатором: это увеличило бы объём ПД ради учёта согласия на ПД.
 * Любой доступ обёрнут: в приватном окне обращение бросает, и падение здесь
 * не должно ронять страницу.
 */

export type ConsentState = 'granted' | 'denied' | 'unknown';

export interface ConsentChoice {
  analytics: boolean;
  advertising: boolean;
}

/**
 * Ключ хранилища. Экспортирован не ради удобства: браузерная проба на проде
 * (`test/e2e/consent-gate.spec.ts`) сажает согласие в localStorage ДО
 * навигации, и ключ у неё обязан быть тот же самый. Разойдись они — проба
 * зеленела бы на «согласия нет», не проверив ветку согласия вовсе.
 */
export const CONSENT_STORAGE_KEY = 'vedar.consent.v1';

const KEY = CONSENT_STORAGE_KEY;

interface StoredConsent {
  analytics: boolean;
  advertising: boolean;
  /** Когда согласились — доказательство «когда», а не только «да». */
  at: string;
  /** Версия текста, на который согласились: текст изменится — спросим снова. */
  v: number;
}

/** Версия формулировки. Меняется вместе с составом получателей данных. */
export const CONSENT_VERSION = 1;

/**
 * Подписи двух кнопок баннера. Экспортированы по той же причине, что ключ:
 * браузерная проба на проде находит баннер по кнопке отказа и берёт подпись
 * отсюда. 09.11 карточку сменила полоса с другим текстом пояснения, а проба
 * искала баннер по прежнему тексту: первый её тест покраснел (#3205), второй —
 * «баннер не показан снова» — молча перестал что-либо проверять.
 */
export const CONSENT_BUTTONS = { accept: 'Разрешить', decline: 'Только необходимое' } as const;

/**
 * Тот же баннер на китайских страницах `/zh` (аудит 09.11, п. 6; слово
 * владельца 16.11 «карт-бланш»). До этого китайский посетитель читал
 * русскую полосу и не мог понять, на что соглашается, — согласие, которого
 * человек не понял, согласием не является.
 *
 * Смысл тот же, что у русской строки: аналитика и сервисы партнёров, часть
 * передаёт данные за пределы России, без согласия не грузятся. Политика
 * конфиденциальности есть только по-русски, и ссылка говорит об этом прямо.
 */
export const CONSENT_BANNER_ZH = {
  text: '网站分析与合作方服务，其中部分会将数据传输到俄罗斯境外。未经您同意，这些服务不会加载。',
  more: '详情（俄文）',
  accept: '允许',
  decline: '仅限必要',
} as const;

/** Китайская ли это страница — баннер говорит на её языке. */
export function isZhPath(pathname: string | null | undefined): boolean {
  return pathname === '/zh' || (pathname ?? '').startsWith('/zh/');
}

export function readConsent(): { state: ConsentState; choice: ConsentChoice } {
  const denied: ConsentChoice = { analytics: false, advertising: false };
  try {
    if (typeof window === 'undefined') return { state: 'unknown', choice: denied };
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { state: 'unknown', choice: denied };
    const parsed = JSON.parse(raw) as Partial<StoredConsent>;
    // Состав получателей изменился — прежнее согласие было на другой текст.
    if (parsed.v !== CONSENT_VERSION) return { state: 'unknown', choice: denied };
    const choice: ConsentChoice = {
      analytics: parsed.analytics === true,
      advertising: parsed.advertising === true,
    };
    return {
      state: choice.analytics || choice.advertising ? 'granted' : 'denied',
      choice,
    };
  } catch {
    // Приватное окно, очищенные site data, запрет хранилища. Это «не знаю»,
    // и по правилу выше оно равно отказу — но молчать о нём нельзя.
    console.error('[consent] хранилище недоступно — считаем, что согласия нет');
    return { state: 'unknown', choice: denied };
  }
}

export function writeConsent(choice: ConsentChoice): void {
  try {
    if (typeof window === 'undefined') return;
    const value: StoredConsent = { ...choice, at: new Date().toISOString(), v: CONSENT_VERSION };
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Записать не удалось — значит на следующей странице спросим снова.
    // Это неудобно, но честно: несохранённое согласие не считается данным.
    console.error('[consent] выбор не сохранён — спросим снова');
  }
}
