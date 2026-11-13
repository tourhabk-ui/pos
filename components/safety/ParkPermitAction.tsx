'use client';

/**
 * components/safety/ParkPermitAction.tsx
 *
 * «Зелёная кнопка» и остальные способы получить разрешение на посещение
 * природного парка — одним блоком, из одного источника
 * (lib/safety/park-permit.ts).
 *
 * ── Почему это ОТДЕЛЬНЫЙ блок, а не строка в блоке МЧС ────────────────────
 *
 * Регистрация в МЧС и разрешение парка — две разные обязанности перед двумя
 * разными ведомствами. Турист, сделавший только первое, на кордоне узнаёт об
 * этом от инспектора. Поставить их рядом можно и нужно; слить в одно слово
 * «регистрация» — значит сказать неправду ради компактности.
 *
 * ── Вид: разбор 19.09, вторая редакция ────────────────────────────────────
 *
 * Первая редакция красила главную кнопку сплошным `--success` — и это была
 * ошибка ровно того рода, от которой предостерегает §1 языка: цвет нёс НЕ
 * состояние, а название сервиса. Зелёный на Ведаре значит «эко/норма», а не
 * «жми сюда»; к тому же в соседнем блоке МЧС уже стоит яркая кнопка, и два
 * кричащих действия рядом отменяют друг друга — на экран полагается один
 * главный акцент.
 *
 * Теперь зелёный остался там, где он осмыслен, — у иконки и заливки кнопки
 * в 12% (тот же приём, что у телефона МЧС с `--danger` этажом выше), а сама
 * иерархия держится размером и порядком, а не яркостью.
 *
 * Четыре запасных способа уехали в `<details>`: в поле со смартфона стена
 * из адресов и часов работы — это не полнота, а шум. Нативный `<details>`
 * выбран намеренно: он работает без JS и без сети (§8) и доступен с
 * клавиатуры (§10).
 *
 * Блок непрозрачный: это действие, а не контекст (§5). Стекла нет.
 */

import { Leaf, ExternalLink, Ticket, Check } from 'lucide-react';
import {
  PARK_PERMIT_CHANNELS,
  PARK_PERMIT_SOURCE,
  GREEN_BUTTON,
  permitRuleFor,
  KRONOKI_REQUESTS,
  KRONOKI_ORDER_RU,
  FEDERAL_PERMIT_UNKNOWN_RU,
} from '@/lib/safety/park-permit';
import {
  permitCardWording,
  webHref,
  ambiguousTerritoryRu,
  TERRITORY_NOT_RECORDED_RU,
  CONDITIONS_NOT_RECORDED_RU,
  CONDITIONS_UNREAD_RU,
  RECORDED_UNKNOWN_RU,
  KGBU_IF_IN_PARK_RU,
  type RoutePermitCardCase,
} from '@/lib/parks/route-permit-card';

interface Props {
  /** Название маршрута или места — только чтобы узнать зону свободного посещения. */
  title?: string | null;
  /** Парк, если он известен из данных. Не угадывается. */
  parkName?: string | null;
  /** Ссылка на согласование КОНКРЕТНОГО маршрута, если она есть в БД. */
  parkApprovalUrl?: string | null;
  /** `compact` — одна строка со ссылкой (карточка места); `full` — блок (карточка маршрута). */
  variant?: 'full' | 'compact';
  /**
   * Случай территории маршрута с сервера (lib/parks/route-permit, то же правило,
   * что в ответе Кузьмича и MCP). По нему блок решает, утверждать ли «нужно
   * разрешение парка». Не передан — прежний вид (страница регистрации, старая
   * офлайн-копия карточки).
   */
  permit?: RoutePermitCardCase | null;
}

/** Почта из справочника — в `mailto:`, только если это похоже на адрес. */
function mailHref(email: string | null): string | null {
  return email && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email.trim()) ? `mailto:${email.trim()}` : null;
}

/** Общая геометрия кнопок: 44px — это палец в перчатке и требование §10. */
const BTN =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2.5 ' +
  'text-sm font-semibold transition-all duration-200 hover:shadow-sm';

export default function ParkPermitAction({
  title,
  parkName,
  parkApprovalUrl,
  variant = 'full',
  permit = null,
}: Props) {
  // Оба магазина, когда адрес известен. iPhone без подтверждённого адреса —
  // не ссылка наугад, а строка «ищите по названию» ниже (§4.0).
  const stores: Array<{ label: string; href: string }> = [
    { label: 'Android', href: GREEN_BUTTON.androidUrl },
    ...(GREEN_BUTTON.iosUrl ? [{ label: 'iPhone', href: GREEN_BUTTON.iosUrl }] : []),
  ];
  // Зона свободного посещения — не «нет данных», а названный факт парка.
  // Молчать о ней нельзя: турист иначе пойдёт оформлять ненужное разрешение.
  // Территория вне парка со своим режимом без разрешения (Вачкажец, 14.10):
  // «Зелёная кнопка» звала бы оформлять то, чего ведомство не выдаёт.
  // Какое правило относится к маршруту — permitRuleFor: тот же порядок
  // проверок читает ответ Кузьмича и MCP (lib/parks/route-permit, #3302).
  const rule = permitRuleFor({ title, parkName });
  if (rule.kind === 'no_permit') {
    const noPermit = rule.territory;
    return (
      <p className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden />
        <span>
          <span className="font-semibold text-[var(--text-primary)]">
            Разрешение на посещение не требуется
          </span>{' '}
          — {noPermit.name}: {noPermit.basis} (
          <a href={noPermit.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--ocean)]">
            {noPermit.authority}, {noPermit.asOf}
          </a>
          ).
        </span>
      </p>
    );
  }

  // Кроноцкий и Корякский заповедники, Южно-Камчатский заказник — заявка в
  // Кроноцкий заповедник, а не «Зелёная кнопка» краевого КГБУ (14.10).
  if (rule.kind === 'kronoki') {
    const kronoki = rule.territory;
    if (variant === 'compact') {
      return (
        <a
          href={KRONOKI_REQUESTS.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center gap-1.5 py-1 text-sm font-semibold text-[var(--success)] hover:underline"
        >
          <Ticket className="h-3.5 w-3.5" aria-hidden />
          Заявка в Кроноцкий заповедник
        </a>
      );
    }
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <Ticket className="h-5 w-5 shrink-0 text-[var(--success)]" aria-hidden />
          <div>
            <p className="font-semibold text-[var(--text-primary)]">Разрешение на посещение</p>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{kronoki.name}</p>
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{KRONOKI_ORDER_RU}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <a
              href={KRONOKI_REQUESTS.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`${BTN} border border-[var(--success)] text-[var(--success)]`}
              style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Страница заявок
            </a>
            <a
              href={`mailto:${KRONOKI_REQUESTS.email}`}
              className={`${BTN} border border-[var(--border)] text-[var(--text-primary)]`}
            >
              {KRONOKI_REQUESTS.email}
            </a>
          </div>
          {/* Ссылки «Согласование маршрута» здесь нет намеренно: адреса в
              `park_approval_url` писались для сети краевых парков, а у этих
              территорий другое ведомство — заявку принимает заповедник. */}
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              Это не то же, что регистрация в МЧС:
            </span>{' '}
            заповеднику — право находиться на территории, спасателям — сведения о группе. Нужны оба.
          </p>
        </div>
      </div>
    );
  }

  if (rule.kind === 'free_visit') {
    return (
      <p className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden />
        <span>
          <span className="font-semibold text-[var(--text-primary)]">
            Разрешение парка не требуется
          </span>{' '}
          — это зона свободного посещения ({PARK_PERMIT_SOURCE.authority},{' '}
          {PARK_PERMIT_SOURCE.asOf}).
        </span>
      </p>
    );
  }

  if (variant === 'compact') {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-3">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--success)]">
          <Leaf className="h-3.5 w-3.5" aria-hidden />
          {GREEN_BUTTON.name}:
        </span>
        {stores.map((st) => (
          <a
            key={st.label}
            href={st.href}
            target="_blank"
            rel="noopener noreferrer"
            title={`${GREEN_BUTTON.what} — ${st.label}`}
            className="inline-flex min-h-[44px] items-center py-1 text-sm font-semibold text-[var(--success)] hover:underline"
          >
            {st.label}
          </a>
        ))}
      </span>
    );
  }

  // Парк ушёл в федеральное ведение (14.10, миграция 1245): способы ниже
  // принадлежат краевому КГБУ, и действуют ли они теперь — не объявлено.
  const federal = rule.federal;

  // Что блок утверждает (#3302, перепись 13.11): «нужно разрешение парка» —
  // только там, где это подтверждает справочник или ссылка согласования. Иначе
  // карточка звала за разрешением КГБУ на маршруты без парка и к чужому ведомству.
  // Ссылка согласования — только веб-адрес: пустая строка и чужая схема ссылкой не считаются.
  const approvalHref = webHref(parkApprovalUrl);
  const wording = permitCardWording(permit, { hasApprovalUrl: approvalHref !== null });

  // У территории своя запись в справочнике — её каналы, без «Зелёной кнопки».
  if (wording === 'recorded' && permit?.kind === 'recorded') {
    const park = permit.park;
    const links: Array<{ label: string; href: string }> = [];
    const page = webHref(park.permitUrl);
    if (page) links.push({ label: 'Страница условий', href: page });
    const online = webHref(park.onlineUrl);
    if (online) links.push({ label: 'Онлайн-заявка', href: online });
    const gosuslugi = webHref(park.gosuslugiUrl);
    if (gosuslugi) links.push({ label: 'Госуслуги41', href: gosuslugi });
    const mail = mailHref(park.email);
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <Ticket className="h-5 w-5 shrink-0 text-[var(--success)]" aria-hidden />
          <div>
            <p className="font-semibold text-[var(--text-primary)]">Разрешение на посещение</p>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{park.displayName}</p>
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{RECORDED_UNKNOWN_RU}</p>
          {(links.length > 0 || mail) && (
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${BTN} border border-[var(--border)] text-[var(--text-primary)]`}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  {l.label}
                </a>
              ))}
              {mail && park.email && (
                <a href={mail} className={`${BTN} border border-[var(--border)] text-[var(--text-primary)]`}>
                  {park.email.trim()}
                </a>
              )}
            </div>
          )}
          {park.officeAddress && (
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--text-primary)]">Офис:</span> {park.officeAddress}
              {park.officeHours ? ` (${park.officeHours})` : ''}
            </p>
          )}
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              Это не то же, что регистрация в МЧС:
            </span>{' '}
            территории — право находиться на ней, спасателям — сведения о группе.
          </p>
        </div>
      </div>
    );
  }

  // К названию территории подходят несколько записей — чьи условия, не определить.
  if (wording === 'ambiguous' && permit?.kind === 'ambiguous') {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <Ticket className="h-5 w-5 shrink-0 text-[var(--success)]" aria-hidden />
          <div>
            <p className="font-semibold text-[var(--text-primary)]">Разрешение на посещение</p>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{permit.territory}</p>
          </div>
        </div>
        <p className="px-5 py-4 text-sm leading-relaxed text-[var(--text-secondary)]">
          {ambiguousTerritoryRu(permit.names)}
        </p>
      </div>
    );
  }

  // Парк маршрута записью не подтверждён: способы КГБУ названы с условием.
  const conditional = wording === 'conditional';
  const namedTerritory = conditional && permit && (permit.kind === 'unrecorded' || permit.kind === 'unread')
    ? permit.territory
    : null;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
        <Ticket className="h-5 w-5 shrink-0 text-[var(--success)]" aria-hidden />
        <div>
          <p className="font-semibold text-[var(--text-primary)]">
            {conditional ? 'Разрешение парка' : 'Разрешение на посещение парка'}
          </p>
          {conditional ? (
            // Названная территория стоит строкой ниже, вместе с тем, что о ней не записано.
            !namedTerritory && (
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{TERRITORY_NOT_RECORDED_RU}</p>
            )
          ) : (
            parkName && <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{parkName}</p>
          )}
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        {conditional && namedTerritory && (
          <p className="border-l-2 border-[var(--warning)] pl-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">{namedTerritory}.</span>{' '}
            {permit?.kind === 'unread' ? CONDITIONS_UNREAD_RU : CONDITIONS_NOT_RECORDED_RU}
          </p>
        )}
        {conditional && (
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{KGBU_IF_IN_PARK_RU}</p>
        )}
        {federal && (
          <p className="border-l-2 border-[var(--warning)] pl-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              С {federal.since} {federal.name} — часть национального парка {federal.nationalPark} в
              ведении Минприроды России
            </span>{' '}
            (
            <a href={federal.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--ocean)]">
              {federal.source}
            </a>
            ). {FEDERAL_PERMIT_UNKNOWN_RU}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          {stores.map((st) => (
            <a
              key={st.label}
              href={st.href}
              target="_blank"
              rel="noopener noreferrer"
              className={`${BTN} border border-[var(--success)] text-[var(--success)]`}
              style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
            >
              <Leaf className="h-4 w-4" aria-hidden />
              {GREEN_BUTTON.name} · {st.label}
            </a>
          ))}

          {approvalHref && (
            <a
              href={approvalHref}
              target="_blank"
              rel="noopener noreferrer"
              className={`${BTN} border border-[var(--border)] bg-[var(--bg-hover)] font-medium text-[var(--text-primary)]`}
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Согласование маршрута
            </a>
          )}
        </div>

        {/* Одна строка вместо абзаца: что это за кнопка и куда она ведёт.
            Нет адреса под iPhone — сказано прямо, а не ссылкой наугад. */}
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          Приложение парка: разрешение, маршруты, правила
          {GREEN_BUTTON.iosUrl ? '.' : '. Ссылка ведёт в Google Play; для iPhone ищите по названию в App Store.'}
        </p>

        {/* Разрешение парка ≠ регистрация в МЧС. Строка короткая намеренно:
            длинное объяснение в поле не читают, а различие знать надо. */}
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--text-primary)]">
            Это не то же, что регистрация в МЧС:
          </span>{' '}
          парку — право находиться на территории, спасателям — сведения о группе.{' '}
          {conditional ? 'В парке нужны оба.' : 'Нужны оба.'}
        </p>

        <details className="group border-t border-[var(--border)] pt-3">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center text-xs font-semibold text-[var(--ocean)] transition-opacity duration-200 hover:opacity-80">
            Другие способы получить разрешение
          </summary>
          <ul className="mt-2 space-y-2">
            {PARK_PERMIT_CHANNELS.filter((c) => c.key !== 'green_button').map((channel) => (
              <li key={channel.key} className="text-xs leading-relaxed text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">{channel.title}:</span>{' '}
                {channel.href ? (
                  <a
                    href={channel.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--ocean)] hover:underline"
                  >
                    {channel.detail}
                  </a>
                ) : (
                  channel.detail
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Источник: {PARK_PERMIT_SOURCE.authority}, {PARK_PERMIT_SOURCE.asOf}
          </p>
        </details>
      </div>
    </div>
  );
}
