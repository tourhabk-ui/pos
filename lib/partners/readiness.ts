/**
 * Готовность партнёра принимать заявки (план готовности 23.11, этап 3c).
 *
 * Один модуль на все кабинеты: оператор, гид, жильё, снаряжение, перевозчик,
 * прокат автомобилей. До этого дня чек-лист был только у оператора
 * (`FirstStepsPanel` на главной кабинета) и судил по своим признакам: пункт
 * «Добавить даты проведения» не закрывался никогда, а канала уведомлений в
 * нём не было вовсе.
 *
 * Правило модуля: пункт закрыт, когда закрыта настоящая дверь, а не когда
 * так удобно нарисовать.
 *   - канал — то же чтение, что у двери «поставить на витрину»
 *     (lib/partners/reach, lib/partners/storefront-gate);
 *   - карточка на витрине — то же условие, что у читателей витрины
 *     (publicPartnerSql, для гида — publicGuideWhere);
 *   - содержимое — те же шлюзы, что у каталогов (publicTourSql,
 *     publicAccommodationSql, publicGearSql, живая строка прайса).
 *
 * Четыре состояния пункта, не два (§4.0):
 *   done    — выполнено;
 *   todo    — шаг за партнёром;
 *   waiting — шаг не за партнёром: администратор или решение владельца;
 *   unknown — проверить не удалось. Не равно ни «выполнено», ни «не выполнено».
 *
 * Здесь только правило и слова. База — lib/partners/readiness-store.ts.
 */
import { REQUEST_RECEIVING_CATEGORIES } from '@/lib/partners/categories';

export type ReadinessCategory = (typeof REQUEST_RECEIVING_CATEGORIES)[number];

export function isReadinessCategory(v: unknown): v is ReadinessCategory {
  return typeof v === 'string' && (REQUEST_RECEIVING_CATEGORIES as readonly string[]).includes(v);
}

export type ItemState = 'done' | 'todo' | 'waiting' | 'unknown';
export type ItemKey = 'profile' | 'channel' | 'content' | 'storefront' | 'offer';

export interface ReadinessItem {
  key: ItemKey;
  title: string;
  state: ItemState;
  /** Что сейчас и что делать — одной-двумя фразами. */
  detail: string;
  /** Куда идти, если шаг за партнёром. */
  href?: string;
  /** Без этого пункта заявки не приходят. */
  required: boolean;
}

export type ReadinessVerdict = 'ready' | 'not_ready' | 'unknown';

export interface PartnerReadiness {
  category: ReadinessCategory;
  verdict: ReadinessVerdict;
  headline: string;
  /**
   * Карточка уже на витрине, а канала нет: туристы оставляют заявки, и до
   * партнёра они не доходят. Экран обязан показать это как тревогу, а не как
   * один из невыполненных шагов.
   */
  urgent: boolean;
  items: ReadinessItem[];
}

/** Карточка партнёра: что записано в `partners`. */
export interface CardFacts {
  profileStatus: string;
  onboardingCompleted: boolean;
  /** Проходит условие витрины своей роли (опубликована и не тестовая). */
  onStorefront: boolean;
  isTest: boolean;
}

/** Содержимое: туры, объекты, строки прайса. */
export interface ContentFacts {
  /** Всего заведено (без удалённых). */
  total: number;
  /** Видно туристу сейчас. */
  live: number;
  /** Ждёт проверки администратором. */
  pending: number;
}

export interface ReadinessFacts {
  category: ReadinessCategory;
  /** Владелец кабинета или менеджер команды оператора. */
  viewer: 'owner' | 'manager';
  /** null — не прочитано. */
  card: CardFacts | null;
  channel: 'connected' | 'not_connected' | 'unknown';
  /** null — не прочитано. */
  content: ContentFacts | null;
  /** Прокат: может ли партнёр сам править прайс (участник пилота). */
  canEditRental: boolean;
}

const NOT_CHECKED = 'Не удалось проверить — обновите страницу позже.';

// ─── Профиль ──────────────────────────────────────────────────────────────────

/**
 * Профиль и проверка. Пункт есть только там, где у роли есть дверь:
 *   - оператор: отправка заявки из настройки кабинета (none → pending);
 *   - гид: «Отправить на проверку» в профиле (none/rejected → pending);
 *   - жильё и снаряжение: настройка кабинета (onboarding_completed).
 * У перевозчика и проката такой двери нет — пункта тоже нет.
 */
function profileItem(f: ReadinessFacts): ReadinessItem | null {
  const { category, card } = f;
  if (category === 'transfer' || category === 'cars') return null;
  const base = { key: 'profile' as const, required: true };

  if (category === 'stay' || category === 'gear') {
    const title = 'Настройка кабинета';
    if (!card) return { ...base, title, state: 'unknown', detail: NOT_CHECKED };
    if (card.onboardingCompleted) return { ...base, title, state: 'done', detail: 'Настройка пройдена.' };
    return {
      ...base, title, state: 'todo',
      detail: 'Пройдите настройку кабинета: название, описание, контакты.',
      href: category === 'stay' ? '/hub/stay/onboarding' : '/hub/gear/onboarding',
    };
  }

  const title = 'Профиль и заявка на проверку';
  if (!card) return { ...base, title, state: 'unknown', detail: NOT_CHECKED };
  const manager = f.viewer === 'manager';
  switch (card.profileStatus) {
    case 'pending':
      return { ...base, title, state: 'done', detail: 'Заявка отправлена. Профиль проверяет администратор.' };
    case 'approved':
      return { ...base, title, state: 'done', detail: 'Профиль проверен и одобрен.' };
    case 'none':
      if (category === 'guide') {
        return {
          ...base, title, state: 'todo',
          detail: 'Заполните профиль и нажмите «Отправить на проверку».',
          href: '/hub/guide/profile',
        };
      }
      return {
        ...base, title, state: 'todo',
        detail: manager
          ? 'Заявку на проверку отправляет владелец кабинета.'
          : 'Заполните профиль компании и отправьте заявку на проверку.',
        href: manager ? undefined : '/hub/operator/onboarding',
      };
    case 'rejected':
      if (category === 'guide') {
        return {
          ...base, title, state: 'todo',
          detail: 'Профиль отклонён. Причина указана в профиле — исправьте и отправьте снова.',
          href: '/hub/guide/profile',
        };
      }
      // У оператора двери повторной отправки нет: обещать её нельзя.
      return {
        ...base, title, state: 'waiting',
        detail: 'Заявка отклонена администратором. Отправить её повторно из кабинета нельзя — свяжитесь с администратором платформы.',
      };
    default:
      return { ...base, title, state: 'unknown', detail: 'Статус заявки неизвестен.' };
  }
}

// ─── Канал ────────────────────────────────────────────────────────────────────

function channelItem(f: ReadinessFacts): ReadinessItem {
  const base = { key: 'channel' as const, title: 'MAX или Telegram для заявок', required: true };
  if (f.channel === 'unknown') return { ...base, state: 'unknown', detail: NOT_CHECKED };
  if (f.channel === 'connected') {
    return { ...base, state: 'done', detail: 'Подключён. Новые заявки приходят в чат.' };
  }
  return {
    ...base, state: 'todo',
    detail: f.viewer === 'manager'
      ? 'Не подключён ни MAX, ни Telegram — заявки до компании не дойдут. Подключает владелец кабинета.'
      : 'Не подключён ни MAX, ни Telegram — заявки до вас не дойдут. Нажмите «Подключить MAX» или «Подключить Telegram» вверху кабинета.',
  };
}

// ─── Содержимое ───────────────────────────────────────────────────────────────

const CONTENT_TITLE: Record<ReadinessCategory, string> = {
  operator: 'Туры',
  guide: 'Свои туры',
  stay: 'Объекты жилья',
  gear: 'Снаряжение',
  transfer: 'Прайс',
  cars: 'Прайс проката',
};

function counts(c: ContentFacts, noun: string): string {
  const parts = [`${noun}: ${c.total}`, `на сайте: ${c.live}`];
  if (c.pending > 0) parts.push(`на проверке: ${c.pending}`);
  return `${parts.join(', ')}.`;
}

function contentItem(f: ReadinessFacts): ReadinessItem {
  const { category, content } = f;
  const title = CONTENT_TITLE[category];
  // Гид попадает в реестр и без своих туров: пункт ему не обязателен.
  const required = category !== 'guide';
  const base = { key: 'content' as const, title, required };
  if (!content) return { ...base, state: 'unknown', detail: NOT_CHECKED };

  switch (category) {
    case 'operator':
      if (content.total > 0) return { ...base, state: 'done', detail: counts(content, 'Туров в кабинете') };
      return { ...base, state: 'todo', detail: 'Заведите первый тур.', href: '/hub/operator/tours/new' };
    case 'guide':
      if (content.total > 0) return { ...base, state: 'done', detail: counts(content, 'Своих туров') };
      return {
        ...base, state: 'todo',
        detail: 'Своих туров нет. Это не обязательно: в реестр гидов профиль выходит и без них.',
        href: '/hub/guide/own',
      };
    case 'stay':
      if (content.total > 0) return { ...base, state: 'done', detail: counts(content, 'Объектов') };
      return { ...base, state: 'todo', detail: 'Заведите объект жилья.', href: '/hub/stay/accommodations/new' };
    case 'gear':
      if (content.total > 0) return { ...base, state: 'done', detail: counts(content, 'Позиций') };
      return { ...base, state: 'todo', detail: 'Заведите снаряжение для проката.', href: '/hub/gear/inventory' };
    case 'transfer':
      if (content.live > 0) return { ...base, state: 'done', detail: `Строк прайса на сайте: ${content.live}.` };
      if (content.pending > 0) {
        return { ...base, state: 'waiting', detail: `Прайс отправлен на проверку администратору, строк: ${content.pending}.` };
      }
      return {
        ...base, state: 'todo',
        detail: 'Заведите прайс: раздел «Прайс» в кабинете. Строка выходит на сайт после проверки администратором.',
        href: '/hub/carrier',
      };
    case 'cars':
      if (content.live > 0) return { ...base, state: 'done', detail: `Строк прайса на сайте: ${content.live}.` };
      if (f.canEditRental) {
        return { ...base, state: 'todo', detail: 'Заведите прайс проката.', href: '/hub/carrier/rental' };
      }
      // Писать прайс из кабинета могут только участники пилота проката.
      return {
        ...base, state: 'waiting',
        detail: 'Прайс проката на сайт сейчас заводит администратор платформы — передайте ему цены и условия.',
      };
  }
}

// ─── Витрина ──────────────────────────────────────────────────────────────────

function storefrontItem(f: ReadinessFacts): ReadinessItem {
  const base = { key: 'storefront' as const, title: 'Карточка на витрине', required: true };
  const { card } = f;
  if (!card) return { ...base, state: 'unknown', detail: NOT_CHECKED };
  if (card.isTest) {
    return { ...base, state: 'waiting', detail: 'Это тестовый профиль: на витрину он не выходит и заявок туристов не получает.' };
  }
  if (card.onStorefront) return { ...base, state: 'done', detail: 'Карточка на витрине: туристы её видят.' };
  // Дверь администратора без канала карточку на витрину не ставит
  // (lib/partners/storefront-gate) — об этом сказано, только пока канала нет.
  return {
    ...base, state: 'waiting',
    detail: f.channel === 'connected'
      ? 'На витрину карточку ставит администратор платформы.'
      : 'На витрину карточку ставит администратор платформы. Без подключённого MAX или Telegram он этого сделать не может.',
  };
}

// ─── Оферта ───────────────────────────────────────────────────────────────────

/**
 * Отметки о принятии оферты в кабинете пока нет (этап 5 плана). Пункт
 * называет это прямо и ничего не требует: юридического текста здесь нет и
 * быть не должно — его даёт владелец.
 */
function offerItem(): ReadinessItem {
  return {
    key: 'offer', title: 'Оферта для партнёров', required: false, state: 'waiting',
    detail: 'Отметки о принятии оферты в кабинете пока нет — ждёт решения владельца платформы. От вас сейчас ничего не требуется.',
    href: '/legal/offer',
  };
}

// ─── Итог ─────────────────────────────────────────────────────────────────────

/** На витрине без канала: заявки оставляют, а партнёр о них не узнаёт. */
function isUrgent(items: ReadinessItem[]): boolean {
  const byKey = (k: ItemKey) => items.find(i => i.key === k);
  return byKey('storefront')?.state === 'done' && byKey('channel')?.state === 'todo';
}

function headlineOf(verdict: ReadinessVerdict, items: ReadinessItem[]): string {
  if (verdict === 'ready') return 'Готовы принимать заявки';
  if (isUrgent(items)) return 'Заявки до вас не доходят: не подключён ни MAX, ни Telegram';
  if (verdict === 'unknown') return 'Готовность проверить не удалось';
  const required = items.filter(i => i.required);
  const todo = required.filter(i => i.state === 'todo').length;
  if (todo > 0) return `До приёма заявок осталось шагов: ${todo}`;
  return 'Ваши шаги выполнены. Заявки пойдут, когда карточка выйдет на витрину';
}

/**
 * Готовность по фактам. «Готов принимать заявки» — только когда закрыты ВСЕ
 * обязательные пункты; «не смог проверить» обязательный пункт не закрывает.
 */
export function buildReadiness(facts: ReadinessFacts): PartnerReadiness {
  const items = [
    profileItem(facts),
    channelItem(facts),
    contentItem(facts),
    storefrontItem(facts),
    offerItem(),
  ].filter((i): i is ReadinessItem => i !== null);

  const required = items.filter(i => i.required);
  const verdict: ReadinessVerdict = required.some(i => i.state === 'todo' || i.state === 'waiting')
    ? 'not_ready'
    : required.some(i => i.state === 'unknown')
      ? 'unknown'
      : 'ready';

  return { category: facts.category, verdict, headline: headlineOf(verdict, items), urgent: isUrgent(items), items };
}
