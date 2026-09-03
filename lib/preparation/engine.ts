/**
 * Движок подготовки: детерминированные правила v1 (план FCN, этап 4).
 *
 * Правила — код, а не мнение модели. AI может объяснять и предлагать
 * (source ai_suggestion), но не может назначать обязательность: required
 * возникает только из проверяемого источника — правила маршрута (МЧС,
 * парк), факта манифеста полевого пакета либо базовой функции выбранного
 * человеком сценария (ночёвка → укрытие). Это тот же принцип, что у
 * compliance-гардов: не «правило в промпте», а детерминированный код.
 */

import type { RoutePassport } from '@/lib/routes/passport';
import type { PackAssetState } from '@/lib/offline/field-pack';
import { fieldPackReadiness } from '@/lib/offline/field-pack';
import { MCHS_ONLINE_FORM_URL } from '@/lib/safety/mchs-registration';
import {
  PREP_DOMAINS, PREP_DOMAIN_LABELS,
  type PrepAnswers, type PrepDomainSummary, type PrepItem, type PrepState,
} from './types';

/** Версия правил: меняешь состав/условия — поднимай. */
export const PREP_RULES_VERSION = 1;

/**
 * Единственная дверь для создания item. Здесь живёт страж:
 * «обязательно по мнению AI» не существует — required с источником
 * ai_suggestion понижается до recommended, а не проходит молча.
 */
export function makeItem(item: PrepItem): PrepItem {
  if (item.importance === 'required' && item.source.type === 'ai_suggestion') {
    return { ...item, importance: 'recommended' };
  }
  return item;
}

export interface PrepEngineInput {
  passport: RoutePassport | null;
  /**
   * Маршрут, к которому готовятся. Нужен ссылке на полевой пакет: без него
   * она открывала полевой режим с ПОСЛЕДНИМ активным маршрутом, и человек,
   * готовясь к одному, сохранял пакет другого. `null` — маршрут неизвестен,
   * ссылка остаётся прежней (это законно, а не повод выдумать id).
   */
  routeId?: string | null;
  /** Состояния полевого пакета (verifyFieldPack) или null — пакета нет. */
  packStates: PackAssetState[] | null;
  answers: PrepAnswers;
  /** Возраст снимка условий в мс; null — снимка нет. */
  conditionsAgeMs: number | null;
  /** Состояния, выставленные человеком (переживают перезагрузку). */
  userStates: Record<string, PrepState>;
}

/** Применить пользовательское состояние поверх вычисленного. */
function withUser(item: PrepItem, userStates: Record<string, PrepState>): PrepItem {
  const u = userStates[item.code];
  if (!u) return item;
  // Факты движка человек не перекрывает: состояние пакета приходит из
  // манифеста, и «готово» кликом его не делает готовым.
  if (item.source.type === 'field_pack') return item;
  return { ...item, state: u };
}

export function buildPreparationItems(input: PrepEngineInput): PrepItem[] {
  const { passport, packStates, answers, conditionsAgeMs, routeId = null } = input;
  const items: PrepItem[] = [];
  const overnight = answers.duration === 'overnight' || answers.duration === 'multi_day';

  // ── 1. Маршрут и доступ ──────────────────────────────────────────────────
  if (passport) {
    items.push(makeItem({
      code: 'route_data',
      domain: 'route',
      importance: 'check',
      state: passport.grade === 'surveyed' ? 'ready' : 'needs_action',
      title: passport.grade === 'surveyed' ? 'Маршрут с проверенным треком' : 'Линия маршрута — ориентир',
      reason: passport.grade === 'surveyed'
        ? `Снятый трек (источник: ${passport.source ?? 'записан'}), редакция v${passport.version}`
        : 'Подтверждённой линии нет — путь придётся сверять с местностью',
      source: { type: 'route_passport', reference: `v${passport.version}` },
    }));
    if (passport.access.mchsRequired) {
      items.push(makeItem({
        code: 'mchs_registration',
        domain: 'route',
        importance: 'required',
        state: 'needs_action',
        title: 'Регистрация группы в МЧС',
        meta: '10 минут · онлайн-форма',
        reason: 'На этом маршруте регистрация обязательна — спасатели должны знать, где вас искать',
        source: { type: 'official_rule', reference: passport.access.mchsPhone ?? 'МЧС Камчатка' },
        action: { kind: 'open_registration', label: 'Зарегистрироваться', href: MCHS_ONLINE_FORM_URL },
      }));
    }
    if (passport.access.parkName) {
      items.push(makeItem({
        code: 'park_approval',
        domain: 'route',
        importance: 'check',
        state: 'unknown',
        title: `Согласование: ${passport.access.parkName}`,
        reason: 'Маршрут проходит по территории природного парка — проверьте правила посещения',
        source: { type: 'route_passport', reference: passport.access.parkApprovalUrl ?? undefined },
        ...(passport.access.parkApprovalUrl
          ? { action: { kind: 'manual_confirm' as const, label: 'Проверить', href: passport.access.parkApprovalUrl } }
          : {}),
      }));
    }
  }

  // ── 2. Условия и время ───────────────────────────────────────────────────
  items.push(makeItem({
    code: 'conditions_review',
    domain: 'conditions',
    importance: 'check',
    state: conditionsAgeMs === null
      ? 'needs_action'
      : conditionsAgeMs > 24 * 3_600_000 ? 'stale' : 'ready',
    title: 'Свежие условия по краю',
    meta: '2 минуты · при связи',
    reason: conditionsAgeMs === null
      ? 'Снимка условий нет — проверьте обстановку до выхода, пока есть связь'
      : 'Условия меняются: пересмотрите утром перед выходом',
    source: { type: 'condition_snapshot' },
    action: { kind: 'open_conditions', label: 'Проверить' },
  }));

  // ── 3. Навигация и питание телефона ──────────────────────────────────────
  {
    const readiness = packStates ? fieldPackReadiness(packStates) : null;
    items.push(makeItem({
      code: 'field_pack',
      domain: 'navigation',
      importance: 'required',
      state: readiness === 'ready' ? 'ready' : 'needs_action',
      title: 'Сохранить полевой пакет',
      meta: 'Карта и точки · 5 минут',
      reason: readiness === 'ready'
        ? 'Карта, линия и точки в телефоне — работают без связи'
        : readiness === 'partial'
          ? 'Пакет скачан не полностью — доберите при связи'
          : 'Работает без связи, вся карта под рукой — в поле сети не будет',
      source: { type: 'field_pack', reference: readiness ?? 'нет пакета' },
      action: {
        kind: 'open_field_pack',
        label: readiness === 'ready' ? 'Проверить' : 'Открыть',
        // Маршрут — в самой ссылке: полевой режим иначе поднимет последний
        // активный, и пакет сохранится не для того маршрута, к которому
        // человек готовится (см. routeId выше).
        href: routeId ? `/planning?mode=trail&route=${encodeURIComponent(routeId)}` : '/planning?mode=trail',
      },
    }));
    items.push(makeItem({
      code: 'power_bank',
      domain: 'navigation',
      importance: 'recommended',
      state: 'unknown',
      title: 'Запас питания телефона',
      reason: 'GPS и экран съедают заряд вдвое быстрее города; телефон — ваша карта',
      source: { type: 'official_rule', reference: 'NPS Ten Essentials' },
      action: { kind: 'manual_confirm', label: 'Готово' },
    }));
  }

  // ── 4. Вода и питание ────────────────────────────────────────────────────
  items.push(makeItem({
    code: 'water_plan',
    domain: 'water_food',
    importance: 'required',
    state: 'needs_action',
    title: overnight ? 'Вода и еда с запасом на ночёвку' : 'План по воде',
    reason: overnight
      ? 'Ночёвка требует запаса еды и воды сверх дневной нормы — плюс резерв на задержку'
      : 'Решите, где пополняете воду, или берите полный объём на выход',
    source: { type: 'official_rule', reference: 'NPS Ten Essentials' },
    action: { kind: 'manual_confirm', label: 'Решено' },
  }));

  // ── 5. Одежда и укрытие ──────────────────────────────────────────────────
  items.push(makeItem({
    code: 'clothing_layers',
    domain: 'clothing_shelter',
    importance: 'check',
    state: 'unknown',
    title: 'Слои одежды под погоду',
    reason: 'Погода на маршруте отличается от города: ветровой и утепляющий слой — минимум',
    source: { type: 'official_rule', reference: 'NPS Ten Essentials' },
    action: { kind: 'open_equipment', label: 'Чек-лист' },
  }));
  if (overnight) {
    items.push(makeItem({
      code: 'shelter',
      domain: 'clothing_shelter',
      importance: 'required',
      state: 'needs_action',
      title: 'Укрытие для ночёвки',
      reason: 'Вы выбрали выход с ночёвкой — укрытие перестаёт быть опцией',
      source: { type: 'user_input', reference: 'duration=overnight' },
      action: { kind: 'manual_confirm', label: 'Есть' },
    }));
  }

  // ── 6. Группа и связь ────────────────────────────────────────────────────
  items.push(makeItem({
    code: 'return_plan',
    domain: 'safety_group',
    importance: 'required',
    state: 'needs_action',
    title: 'Отправить брифинг контакту',
    meta: '2 минуты · группа',
    reason: 'Кто-то вне маршрута должен знать, куда вы идёте и когда ждать обратно — это первое, что спросят спасатели',
    source: { type: 'official_rule', reference: 'NPS: сообщите план похода' },
    // Ссылка, а не отправка за человека: контактных данных получателя мы
    // не собираем — турист отправляет её своим мессенджером (миграция 870).
    action: { kind: 'share_briefing', label: 'Создать ссылку' },
  }));
  if (answers.party === 'group' || answers.party === 'guided') {
    items.push(makeItem({
      code: 'group_roles',
      domain: 'safety_group',
      importance: 'recommended',
      state: 'unknown',
      title: 'Роли в группе распределены',
      reason: 'Кто ведёт, кто замыкает, у кого аптечка — решается до выхода, а не на осыпи',
      source: { type: 'official_rule', reference: 'Leave No Trace' },
      action: { kind: 'manual_confirm', label: 'Готово' },
    }));
  }

  // ── 7. Логистика ─────────────────────────────────────────────────────────
  items.push(makeItem({
    code: 'return_transport',
    domain: 'logistics',
    importance: 'check',
    state: 'needs_action',
    title: 'Подтвердить трансфер обратно',
    meta: 'логистика',
    reason: 'Гарантированный обратный выезд: договоритесь о времени и месте до выхода',
    source: { type: 'user_input' },
    action: { kind: 'manual_confirm', label: 'Подтверждён' },
  }));

  return items.map(i => withUser(i, input.userStates));
}

/** Сводка по доменам: домен подготовлен, когда в нём нет открытых required/check. */
export function summarizeDomains(items: PrepItem[]): PrepDomainSummary[] {
  return PREP_DOMAINS.map(domain => {
    const domainItems = items.filter(i => i.domain === domain);
    const open = domainItems.some(i =>
      i.importance !== 'recommended' &&
      (i.state === 'needs_action' || i.state === 'unknown' || i.state === 'stale'),
    );
    return {
      domain,
      label: PREP_DOMAIN_LABELS[domain],
      prepared: domainItems.length > 0 && !open,
      items: domainItems,
    };
  });
}

/**
 * «Нужно решить до выхода»: 2–4 самых важных открытых действия.
 * Порядок: required раньше check, внутри — порядок правил (он смысловой).
 */
export function nextActions(items: PrepItem[], limit = 4): PrepItem[] {
  const open = items.filter(i =>
    (i.state === 'needs_action' || i.state === 'stale') && i.importance !== 'recommended',
  );
  const rank = { required: 0, check: 1, recommended: 2 } as const;
  return [...open].sort((a, b) => rank[a.importance] - rank[b.importance]).slice(0, limit);
}
