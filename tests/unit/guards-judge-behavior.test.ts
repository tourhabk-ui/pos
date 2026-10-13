/**
 * Сторож на сторожей: правило проверяется поведением, не литералом исходника
 * (решение владельца 13.10, карт-бланш: «сторожа по регулярке на исходник»).
 *
 * 13.10 три сторожа за день упёрлись в правку, которая правило не нарушала:
 * подпись видео на карточке тура, строка оператора на витрине, срез шапки
 * миграции по слову BEGIN. Все три сравнивали ЛИТЕРАЛ разметки —
 * `toMatch(/<OperatorNameLink name=\{tour\.operator_name\}…/)`. Такой сторож
 * ловит рефакторинг, а не дефект: краснеет, когда код переписан верно, и
 * зеленеет, когда компонент на месте, но не рендерится.
 *
 * Правило (CLAUDE.md §4, «Сторож судит поведение, не текст»): экран,
 * компонент, подпись, ссылка — рендером с данными; правило в функции —
 * вызовом; регулярка по исходнику — только для запретов («этого быть не
 * должно»). Этот тест держит ДОЛГ: замороженный список тестов, которые ещё
 * сравнивают JSX-литералы, с числом вхождений в каждом. Новый такой тест —
 * красный. Переписал старый на рендер — список обязан уменьшиться: запись
 * самоустаревает, как KNOWN_UNPRODUCED в alert-types-produced. Расти список
 * не может.
 *
 * Что считается литералом разметки: положительное `toMatch(/<Компонент…/)`
 * или `toContain('<Компонент…')` — поиск JSX-тега с заглавной буквы.
 * `.not.toMatch(/<…/)` — запрет, он разрешён и не считается. Теги в нижнем
 * регистре (`<a href`, `<BottomNav` в серверной странице, которую jsdom не
 * рендерит) под правило не попадают: серверный каркас страницы — тот случай,
 * где рендера нет и текст — единственная улика.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'tests/unit');
const SELF = 'guards-judge-behavior.test.ts';

/** Положительное сравнение с JSX-тегом; `.not.` перед ним — запрет, не считается. */
const JSX_LITERAL = /(?<!\.not)\.(?:toMatch|toContain)\(\s*(?:\/|['"`])<[A-Z]/g;

/**
 * Долг на 13.10: файл → число литералов. Только сокращается. Снизил число —
 * уменьши запись; убрал все — удали запись; новый файл в этом списке
 * появиться не может.
 */
const KNOWN_JSX_LITERAL_GUARDS: Record<string, number> = {
  'accommodations-list-ssr.test.tsx': 1,
  'agent-pack-a.test.ts': 1,
  'auto-confirm-bookings.test.ts': 1,
  'avito-feed.test.ts': 5,
  'bear-zones-field.test.ts': 1,
  'booking-success-page.test.tsx': 1,
  'brand-mark-single.test.ts': 2,
  'carrier-screens.test.ts': 4,
  'catalog-categories-linked.test.ts': 1,
  'catalog-linking.test.ts': 1,
  'catalog-storefront.test.tsx': 2,
  'crm-clients-screens.test.ts': 4,
  'crm-direct-payments.test.ts': 1,
  'feed-price-unit.test.ts': 1,
  'field-base-map.test.ts': 3,
  'field-cockpit.test.ts': 2,
  'field-instruments.test.ts': 1,
  'field-mode-no-commerce.test.ts': 1,
  'field-nav-hard.test.ts': 1,
  'field-screen-no-overlap.test.ts': 1,
  'field-sheet-collapsed.test.ts': 3,
  'field-top-compact.test.ts': 1,
  'funnel-window.test.ts': 1,
  'guide-pack-a.test.ts': 1,
  'guide-pack-b.test.ts': 1,
  'hazard-wording-single-source.test.ts': 1,
  'header-actions-reachable.test.ts': 1,
  'header-over-photo.test.tsx': 1,
  'home-alerts-visible.test.ts': 2,
  'home-bottomnav-both-trees.test.ts': 2,
  'home-desk-brief.test.ts': 5,
  'home-quick-tools.test.ts': 3,
  'home-stay-plate.test.ts': 3,
  'home-transfer-button.test.ts': 2,
  'home-transfer-plate.test.ts': 1,
  'kutha-photos.test.ts': 2,
  'legal-disclosure.test.ts': 1,
  'map-threat-summary.test.ts': 1,
  'marine-mammals.test.ts': 1,
  'mcp-landing.test.ts': 1,
  'mobile-two-taps.test.ts': 3,
  'no-external-navigators.test.ts': 2,
  'operator-clients-crm.test.ts': 1,
  'operator-name-links.test.tsx': 2,
  'operator-org-ref.test.ts': 1,
  'operator-review-reply.test.ts': 1,
  'operator-small-fixes.test.ts': 1,
  'page-h1-and-meta.test.ts': 2,
  'park-permit.test.ts': 4,
  'partner-channel-banner.test.ts': 1,
  'partner-mcp-auth.test.ts': 1,
  'partner-short-address.test.ts': 1,
  'password-reset.test.ts': 2,
  'photo-lightbox.test.tsx': 1,
  'place-access-text.test.ts': 1,
  'place-add-photo-link.test.ts': 1,
  'place-card-speaks-human.test.ts': 1,
  'place-own-route-wired.test.ts': 1,
  'place-user-photos-reachable.test.ts': 1,
  'plans-programmatic-seo.test.ts': 3,
  'point-card-and-calculated-on-map.test.ts': 2,
  'prepare-page.test.ts': 1,
  'push-diagnosis-and-optin.test.ts': 2,
  'push-key-runtime.test.ts': 1,
  'push-safety-offer.test.ts': 2,
  'pwa-install-tracking.test.ts': 1,
  'recovery-states.test.ts': 2,
  'route-pick-by-line.test.ts': 1,
  'route-relief-chart.test.ts': 1,
  'route-verdict-surface.test.ts': 2,
  'safety-manual-refresh.test.ts': 2,
  'search-finds-tours.test.ts': 1,
  'seat-requests.test.ts': 1,
  'self-visits-separated.test.ts': 1,
  'seo-audit-2909-structure.test.ts': 1,
  'seo-live-counts.test.ts': 1,
  'share-and-referral.test.ts': 3,
  'sign-out-reachable.test.ts': 1,
  'sos-always-reachable.test.ts': 3,
  'sos-rescue-chat.test.ts': 2,
  'stay-request.test.ts': 5,
  'stay-review-reply.test.ts': 2,
  'tour-card-shell.test.ts': 1,
  'tour-review-form.test.ts': 1,
  'tourist-cabinet-sweep.test.ts': 1,
  'tourist-walkthrough-ux.test.ts': 2,
  'trail-observation.test.ts': 2,
  'transfer-charter.test.ts': 2,
  'trip-offline-save.test.ts': 1,
  'vedar-map-place-click.test.ts': 2,
  'vedar-zoom-readout.test.ts': 1,
  'volcano-pulse.test.ts': 2,
  'weather-page.test.tsx': 1,
  'wishlist-contract.test.ts': 1,
  'yandex-metrika.test.ts': 2,
};

function countLiterals(file: string): number {
  return (readFileSync(join(DIR, file), 'utf-8').match(JSX_LITERAL) ?? []).length;
}

describe('сторож судит поведение, не текст (13.10)', () => {
  const files = readdirSync(DIR).filter((f) => /\.test\.tsx?$/.test(f) && f !== SELF).sort();
  const actual = new Map<string, number>();
  for (const f of files) {
    const n = countLiterals(f);
    if (n > 0) actual.set(f, n);
  }

  it('новый сторож не сравнивает разметку по литералу — проверяет рендером', () => {
    const newcomers = [...actual.entries()]
      .filter(([f]) => !(f in KNOWN_JSX_LITERAL_GUARDS))
      .map(([f, n]) => `${f}: ${n}`);
    expect(newcomers, 'новый тест ищет JSX-тег в исходнике: рендерите компонент с данными и проверяйте текст, href, aria (CLAUDE.md §4 «Сторож судит поведение»)').toEqual([]);
  });

  it('долг не растёт: в известном тесте литералов не больше, чем записано', () => {
    const grown = [...actual.entries()]
      .filter(([f, n]) => f in KNOWN_JSX_LITERAL_GUARDS && n > KNOWN_JSX_LITERAL_GUARDS[f])
      .map(([f, n]) => `${f}: ${KNOWN_JSX_LITERAL_GUARDS[f]} → ${n}`);
    expect(grown, 'в тесте прибавилось сравнений с JSX-литералом').toEqual([]);
  });

  it('запись самоустаревает: литералов стало меньше — реестр обязан это признать', () => {
    const stale: string[] = [];
    for (const [f, known] of Object.entries(KNOWN_JSX_LITERAL_GUARDS)) {
      if (!existsSync(join(DIR, f))) { stale.push(`${f}: файла нет — удалите запись`); continue; }
      const n = actual.get(f) ?? 0;
      if (n < known) stale.push(`${f}: записано ${known}, осталось ${n} — ${n === 0 ? 'удалите запись' : 'уменьшите число'}`);
    }
    expect(stale).toEqual([]);
  });

  it('запрет регулярке разрешён: .not.toMatch(/<…/) литералом не считается', () => {
    expect("expect(src).not.toMatch(/<Link href/)".match(JSX_LITERAL)).toBeNull();
    expect("expect(src).toMatch(/<Link href/)".match(JSX_LITERAL)).toHaveLength(1);
    expect("expect(src).toContain('<OperatorNameLink')".match(JSX_LITERAL)).toHaveLength(1);
    expect("expect(src).toContain('<a href=\"#tours\"')".match(JSX_LITERAL)).toBeNull();
  });
});
