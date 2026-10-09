/**
 * lib/analytics/metrika.ts — Яндекс.Метрика: один источник номера счётчика,
 * опций инициализации и правил, где счётчик не грузится.
 *
 * ── Откуда номер ──────────────────────────────────────────────────────────
 *
 * Счётчик 113581440 — вставка владельца 09.10 (сниппет с Вебвизором,
 * картой кликов, электронной коммерцией через `dataLayer`, `ssr:true`).
 * Номер — константа, а не переменная окружения: он публичен по определению
 * (стоит в HTML каждой страницы), а константа в коде — факт с
 * производителем (§10.09). До этого номер жил в двух местах с разными
 * умолчаниями: загрузчик брал `NEXT_PUBLIC_YANDEX_METRIKA_ID ?? '103522218'`,
 * а цели воронки (`lead-tracking`) — только переменную без умолчания, то
 * есть при незаданной переменной просмотры считались, а цели — нет, и
 * заметить расхождение было нечем.
 *
 * ── Что здесь решается ────────────────────────────────────────────────────
 *
 *  - грузить или нет — решает согласие (`lib/legal/third-party-registry`,
 *    категория `analytics`) и путь (`shouldTrackPath`): кабинеты партнёров
 *    и экраны с персональными данными или безопасностью счётчик не видят;
 *  - Вебвизор пишет действия на странице, но не содержимое полей с ПД:
 *    `muteWebvisorFields` ставит класс `ym-disable-keys` на телефоны, почту,
 *    имена и свободный текст — поля, которые Метрика по этому классу не
 *    записывает. Настройка «Запись полей» в кабинете счётчика — вторая
 *    линия, её код проверить не может;
 *  - переход внутри приложения (App Router) не перезагружает страницу —
 *    просмотр отправляется руками (`metrikaHit`), иначе Метрика видела бы
 *    один просмотр на весь визит.
 *
 * Файл без пула и без сервера: его читают клиентские компоненты.
 */

declare global {
  interface Window {
    ym?: (id: number, method: string, ...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/** Номер счётчика — вставка владельца 09.10. */
export const METRIKA_ID = 113581440;

export const METRIKA_TAG_URL = 'https://mc.yandex.ru/metrika/tag.js';

/**
 * Опции инициализации — ровно те, что в сниппете владельца. `referrer` и
 * `url` добавляются в самом скрипте: это значения времени выполнения.
 */
export const METRIKA_INIT_OPTIONS = {
  ssr: true,
  webvisor: true,
  clickmap: true,
  ecommerce: 'dataLayer',
  accurateTrackBounce: true,
  trackLinks: true,
} as const;

/**
 * Где счётчик не грузится, и почему. Сравнение по префиксу пути с границей
 * сегмента: `/hub` закрывает `/hub/operator`, но не `/hubris`.
 */
export const METRIKA_EXCLUDED_PREFIXES: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: '/hub', reason: 'кабинеты партнёров и администратора: экраны с ПД туристов, не маркетинговая поверхность' },
  { prefix: '/auth', reason: 'вход: пароли и контакты' },
  { prefix: '/register', reason: 'регистрация: контакты человека' },
  { prefix: '/profile', reason: 'профиль человека' },
  { prefix: '/booking-success', reason: 'страница брони с данными туриста' },
  { prefix: '/watch', reason: 'контроль выхода: положение людей на маршруте' },
  { prefix: '/checkin-ok', reason: 'отметка «мы в порядке» — слой безопасности' },
  { prefix: '/sos', reason: 'SOS: работает офлайн, сторонний скрипт там не нужен' },
  { prefix: '/emergency', reason: 'экстренные номера: офлайн-контур' },
  { prefix: '/offline', reason: 'страница «связи нет»: грузить нечего' },
  { prefix: '/field-check', reason: 'полевая проверка маршрутов: офлайн-контур' },
];

export function shouldTrackPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return !METRIKA_EXCLUDED_PREFIXES.some(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Инлайн-скрипт загрузчика — текст сниппета Метрики с опциями выше.
 * `dataLayer` заводится до `init`: электронная коммерция читает его сразу.
 */
export function metrikaInitScript(): string {
  const opts = JSON.stringify(METRIKA_INIT_OPTIONS).slice(1, -1);
  return (
    `window.dataLayer=window.dataLayer||[];` +
    `(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};` +
    `m[i].l=1*new Date();` +
    `for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}` +
    `k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})` +
    `(window,document,"script","${METRIKA_TAG_URL}","ym");` +
    `ym(${METRIKA_ID},"init",{${opts},referrer:document.referrer,url:location.href});`
  );
}

/** Просмотр страницы при переходе внутри приложения. Нет `ym` — нет и хита. */
export function metrikaHit(url: string, referer: string | null): void {
  if (typeof window === 'undefined' || typeof window.ym !== 'function') return;
  window.ym(METRIKA_ID, 'hit', url, {
    referer: referer ?? undefined,
    title: typeof document !== 'undefined' ? document.title : undefined,
  });
}

/** Цель (reachGoal) — воронка лидов и подобное. */
export function metrikaGoal(name: string, params?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || typeof window.ym !== 'function') return;
  window.ym(METRIKA_ID, 'reachGoal', name, params);
}

/** Класс, по которому Вебвизор не записывает содержимое поля. */
export const WEBVISOR_SILENT_CLASS = 'ym-disable-keys';

/**
 * Поля, содержимое которых в запись не попадает: телефон, почта, пароль,
 * имя (по автозаполнению и по имени поля) и любой свободный текст.
 */
export const WEBVISOR_SILENT_FIELDS = [
  'input[type="tel"]',
  'input[type="email"]',
  'input[type="password"]',
  'input[autocomplete*="tel"]',
  'input[autocomplete*="email"]',
  'input[autocomplete*="name"]',
  'input[name*="phone" i]',
  'input[name*="email" i]',
  'input[name*="name" i]',
  'input[name*="passport" i]',
  'textarea',
].join(', ');

/** Поставить класс тишины на все поля с ПД внутри `root` (и на сам `root`). */
export function muteWebvisorFields(root: ParentNode): number {
  let touched = 0;
  const mark = (el: Element) => {
    if (!el.classList.contains(WEBVISOR_SILENT_CLASS)) {
      el.classList.add(WEBVISOR_SILENT_CLASS);
      touched++;
    }
  };
  if (root instanceof Element && root.matches(WEBVISOR_SILENT_FIELDS)) mark(root);
  root.querySelectorAll(WEBVISOR_SILENT_FIELDS).forEach(mark);
  return touched;
}
