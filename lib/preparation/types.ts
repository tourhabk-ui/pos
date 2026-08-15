/**
 * Доменная модель «Подготовки к походу» (план FCN, этап 4).
 *
 * Подготовка — не список покупок, а семь независимых потребностей выхода
 * (модель систем NPS / Leave No Trace): маршрут и доступ, условия и время,
 * навигация и питание телефона, вода и еда, одежда и укрытие,
 * безопасность и группа, логистика. Снаряжение — одна из них, не все.
 */

export type PrepDomain =
  | 'route'            // маршрут и доступ
  | 'conditions'       // условия и время
  | 'navigation'       // навигация и питание телефона
  | 'water_food'       // вода и питание
  | 'clothing_shelter' // одежда и укрытие
  | 'safety_group'     // безопасность, связь и группа
  | 'logistics';       // логистика и ответственность

export const PREP_DOMAINS: PrepDomain[] = [
  'route', 'conditions', 'navigation', 'water_food',
  'clothing_shelter', 'safety_group', 'logistics',
];

export const PREP_DOMAIN_LABELS: Record<PrepDomain, string> = {
  route: 'Маршрут и доступ',
  conditions: 'Условия и время',
  navigation: 'Навигация и телефон',
  water_food: 'Вода и питание',
  clothing_shelter: 'Одежда и укрытие',
  safety_group: 'Группа и связь',
  logistics: 'Логистика',
};

export type PrepImportance = 'required' | 'check' | 'recommended';

export type PrepState =
  | 'ready'          // сделано / подтверждено фактом
  | 'needs_action'   // требует решения до выхода
  | 'planned'        // человек отметил «сделаю»
  | 'not_applicable' // осознанно не про этот выход
  | 'unknown'        // продукт не знает факта
  | 'stale';         // было готово, но данные устарели

/**
 * Откуда взялась обязательность. «Обязательно по мнению AI» не существует:
 * makeItem не пропускает required с источником ai_suggestion.
 */
export type PrepSourceType =
  | 'route_passport'
  | 'field_pack'
  | 'official_rule'
  | 'condition_snapshot'
  | 'user_input'
  | 'ai_suggestion';

export type PrepActionKind =
  | 'open_field_pack'     // к сохранению полевого пакета
  | 'open_registration'   // онлайн-форма МЧС
  | 'open_equipment'      // чек-лист снаряжения
  | 'open_conditions'     // пересмотреть условия
  | 'manual_confirm';     // человек подтверждает сам

export interface PrepItem {
  code: string;
  domain: PrepDomain;
  importance: PrepImportance;
  state: PrepState;
  /** Почему это в плане — словами, не «так надо». */
  reason: string;
  source: { type: PrepSourceType; reference?: string; observedAt?: string };
  action?: { kind: PrepActionKind; label: string; href?: string };
  /** Короткий заголовок карточки. */
  title: string;
  /** Оценка времени/контекста для карточки («5 минут · телефон»). */
  meta?: string;
}

/** Ответы четырёх вопросов. Всё опционально: не анкета, а уточнение. */
export interface PrepAnswers {
  duration?: 'under_4h' | 'day' | 'overnight' | 'multi_day';
  party?: 'solo' | 'group' | 'guided';
  experience?: 'first_time' | 'some' | 'confident';
  ownership?: 'own_all' | 'partial_rent' | 'need_advice';
}

export interface PrepDomainSummary {
  domain: PrepDomain;
  label: string;
  /** Домен подготовлен: нет required/check в состоянии needs_action/unknown/stale. */
  prepared: boolean;
  items: PrepItem[];
}

export interface PreparationPlan {
  routeId: string;
  routeVersion: number;
  answers: PrepAnswers;
  /** Состояния, выставленные человеком (code → state). */
  userStates: Record<string, PrepState>;
  updatedAt: number;
}
