/**
 * Пустых catch не становится больше (аудит 15.10, P4-03, п. 1.12).
 *
 * CLAUDE.md §4.0: «пустой `catch` превращает поломку в „данных нет“. Ловить
 * можно, молчать нельзя». Правило было, механизма — только для одной формы:
 * `silent-catch` ловит catch, возвращающий пустышку, похожую на успех. Две
 * другие формы — catch без единого оператора и `.catch(() => {})` — не
 * держал никто, и цена видна по именам: отказ всего AI-конвейера лида —
 * единственного пути коммерции до сезона — выглядел как «лид создан», а
 * веб-чат Кузьмича молча съезжал со ступени на ступень до одиночного вызова.
 *
 * Сторож не чинит долг скопом — решение 10.08 («единовременная чистка
 * вслепую опаснее проблемы, снимать по одной») уважается. Он замораживает
 * карту «файл → число пустых catch»: новый файл с пустым catch и рост числа в
 * известном — красные; снял один — число в записи обязано уменьшиться, снял
 * все — запись удаляется (самоустаревание, как KNOWN_JSX_LITERAL_GUARDS в
 * guards-judge-behavior). Расти карта не может.
 *
 * Что считается пустым — `lib/quality/empty-catch.ts`: тело catch без
 * операторов (комментарий не оператор) и обработчик `.catch` с пустым телом.
 * `.catch(() => null)` не считается намеренно — там часто честное «значения
 * нет»; почему — в шапке распознавателя.
 *
 * Как снимать запись: в catch — `logSwallowedFailure(scope, источник, err)`
 * (`lib/observability/swallowed.ts`), либо честная пометка сбоя в ответе,
 * либо проброс. Пустые catch приёмников оплаты (`app/api/payments/**`, зона
 * §7) сняты отдельно, решением W2-3 того же аудита: только лог, ответ и порядок
 * записи прежние — сторож `payment-receivers-name-failures`.
 *
 * Вторая половина файла — вызов: при падении квалификатора лида отказ назван
 * в логе со своей областью. Регулярка по исходнику здесь только запрещает
 * (CLAUDE.md §4, «Сторож судит поведение»), поведение судится вызовом.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { findEmptyCatches } from '@/lib/quality/empty-catch';

const ROOT = process.cwd();

/**
 * ЗАМОРОЖЕННЫЙ ДОЛГ на 15.10.2026 (после снятия AI-конвейера лида и четырёх
 * ступеней веб-чата): файл → число пустых catch обеих форм. Не разрешение, а
 * перепись известного. Только сокращается; новая запись или рост — красные.
 */
const KNOWN_EMPTY_CATCHES: Record<string, number> = {
  'app/_home/_HomeV8Client.tsx': 3,
  'app/accommodations/_AccommodationsClient.tsx': 1,
  'app/ai-assistant/_AIAssistantClient.tsx': 1,
  'app/api/admin/ai-analytics/route.ts': 1,
  'app/api/admin/channels/test/route.ts': 1,
  'app/api/admin/content/partners/[id]/upload/route.ts': 2,
  'app/api/admin/content/reviews/[id]/moderate/route.ts': 1,
  'app/api/admin/content/reviews/route.ts': 1,
  'app/api/admin/diagnostics/storage/route.ts': 2,
  'app/api/admin/execute-all/route.ts': 1,
  'app/api/admin/import/route-passports/route.ts': 2,
  'app/api/admin/operators/[id]/account/route.ts': 1,
  'app/api/admin/operators/create/route.ts': 1,
  'app/api/admin/photos/upload/route.ts': 1,
  'app/api/admin/telegram/route.ts': 2,
  'app/api/agents/rescue-briefing/route.ts': 1,
  'app/api/ai/chat-stream/route.ts': 2,
  'app/api/ai/chat/route.ts': 1,
  'app/api/ai/deepseek/route.ts': 1,
  'app/api/ai/judge-rag/route.ts': 1,
  'app/api/analytics/dwell/route.ts': 1,
  'app/api/auth/max/start/route.ts': 1,
  'app/api/auth/register-operator/route.ts': 5,
  'app/api/auth/register/route.ts': 1,
  'app/api/auth/switch-role/route.ts': 1,
  'app/api/bookings/[id]/cancel/route.ts': 1,
  'app/api/bookings/[id]/route.ts': 1,
  'app/api/bots/reposter/bulk/route.ts': 1,
  'app/api/collections/[slug]/route.ts': 1,
  'app/api/cron/digest/route.ts': 3,
  'app/api/cron/evo-findings/route.ts': 1,
  'app/api/cron/evo-report/route.ts': 4,
  'app/api/cron/evo/route.ts': 1,
  'app/api/cron/health/route.ts': 5,
  'app/api/cron/import-route-passports/route.ts': 2,
  'app/api/cron/kb-gap/route.ts': 3,
  'app/api/cron/legacy-tours-cleanup/route.ts': 2,
  'app/api/cron/legislation-sync/route.ts': 1,
  'app/api/cron/model-catalog/route.ts': 1,
  'app/api/cron/partner-cleanup/route.ts': 2,
  'app/api/cron/payment-test-setup/route.ts': 2,
  'app/api/cron/payouts/route.ts': 1,
  'app/api/cron/scout/route.ts': 1,
  'app/api/cron/smart-notify/route.ts': 2,
  'app/api/cron/ssr-sentinel/route.ts': 1,
  'app/api/cron/tour-reminder/route.ts': 2,
  'app/api/cron/trip-reminders/route.ts': 1,
  'app/api/cron/voice-probe/route.ts': 1,
  'app/api/hub/operator/bookings/[id]/route.ts': 4,
  'app/api/leads/route.ts': 1,
  'app/api/max/kuzmich/route.ts': 6,
  'app/api/mcp/route.ts': 1,
  'app/api/mesh/sos-relay/route.ts': 1,
  'app/api/meta/webhook/route.ts': 1,
  'app/api/octo/bookings/[uuid]/cancel/route.ts': 1,
  'app/api/octo/bookings/[uuid]/status/route.ts': 1,
  'app/api/p/[code]/event/route.ts': 1,
  'app/api/partners/register/route.ts': 2,
  'app/api/planner/chat/route.ts': 1,
  'app/api/planner/recommend/route.ts': 3,
  'app/api/preparation/share/route.ts': 1,
  'app/api/public/now/route.ts': 1,
  'app/api/reviews/tour/[tourId]/route.ts': 1,
  'app/api/roles/route.ts': 1,
  'app/api/safety/reports/route.ts': 1,
  'app/api/safety/wishes/route.ts': 1,
  'app/api/telegram/admin/route.ts': 3,
  'app/api/telegram/kuzmich/route.ts': 6,
  'app/api/telegram/setup-webhook/route.ts': 1,
  'app/api/telegram/webhook/route.ts': 4,
  'app/api/tools/[slug]/route.ts': 1,
  'app/api/tours/route.ts': 1,
  'app/api/trips/[id]/route.ts': 1,
  'app/api/trips/share/[token]/route.ts': 3,
  'app/api/whatsapp/kuzmich/route.ts': 1,
  'app/api/widget/chat/route.ts': 1,
  'app/api/widget/lead.js/route.ts': 1,
  'app/api/widget/partner/[partnerId]/route.ts': 1,
  'app/auth/login/_MaxLoginButton.tsx': 1,
  'app/booking-success/[id]/_BookingSuccessClient.tsx': 2,
  'app/catalog/tours/[id]/_TourDetailClient.tsx': 2,
  'app/checkin-ok/CheckinOkClient.tsx': 1,
  'app/field-check/_FieldCheckClient.tsx': 4,
  'app/hub/admin/ai-prompts/_AIPromptsClient.tsx': 1,
  'app/hub/admin/ai-usage/page.tsx': 1,
  'app/hub/admin/artem/_ArtemWorkspaceClient.tsx': 1,
  'app/hub/admin/brain/_IntelligenceClient.tsx': 2,
  'app/hub/admin/content/accommodation-reviews/page.tsx': 2,
  'app/hub/admin/content/partners/page.tsx': 1,
  'app/hub/admin/content/reviews/page.tsx': 2,
  'app/hub/admin/email/_EmailAdminClient.tsx': 1,
  'app/hub/admin/health/_HealthTabs.tsx': 1,
  'app/hub/admin/leads/_LeadsClient.tsx': 2,
  'app/hub/admin/operators/_OperatorsClient.tsx': 4,
  'app/hub/admin/places/_PlacesCleanupClient.tsx': 1,
  'app/hub/admin/pricing/_PricingClient.tsx': 1,
  'app/hub/admin/promo-codes/page.tsx': 2,
  'app/hub/admin/support/_AdminSupportClient.tsx': 2,
  'app/hub/admin/telegram/_TelegramAdminClient.tsx': 1,
  'app/hub/admin/traffic/_SelfVisitToggle.tsx': 1,
  'app/hub/admin/volcano/_AgentsClient.tsx': 3,
  'app/hub/admin/volcano/_VolcanoTabs.tsx': 1,
  'app/hub/guide/_GuideDashboardClient.tsx': 2,
  'app/hub/operator/_OperatorDashboardClient.tsx': 1,
  'app/hub/operator/integrations/_IntegrationsPageClient.tsx': 1,
  'app/hub/operator/leads/_LeadsClient.tsx': 1,
  'app/hub/operator/onboarding/_OnboardingClient.tsx': 1,
  'app/hub/operator/tours/[id]/_EditTourClient.tsx': 1,
  'app/hub/operator/tours/_ToursManagementClient.tsx': 1,
  'app/hub/safety/_SafetyHubClient.tsx': 1,
  'app/hub/tourist/_TouristDashboardClient.tsx': 1,
  'app/hub/tourist/cart/checkout/_CheckoutClient.tsx': 1,
  'app/hub/tourist/messages/_MessagesClient.tsx': 2,
  'app/hub/tourist/support/_SupportClient.tsx': 1,
  'app/kuzmich/_KuzmichClient.tsx': 3,
  'app/map/_MapPageClient.tsx': 2,
  'app/oauth/partner/authorize/_ConsentClient.tsx': 1,
  'app/p/[code]/_SelectionClient.tsx': 1,
  'app/places/[id]/_PlaceDetailClient.tsx': 1,
  'app/places/[id]/opengraph-image.tsx': 1,
  'app/planner/_PlannerClient.tsx': 2,
  'app/planning/_PlanningClient.tsx': 35,
  'app/register/page.tsx': 2,
  'app/return/ReturnClient.tsx': 1,
  'app/routes/[id]/_RouteDetailClient.tsx': 5,
  'app/routes/[id]/page.tsx': 1,
  'app/routes/[id]/prepare/_PrepareClient.tsx': 2,
  'app/routes/_RoutesPageClient.tsx': 1,
  'app/safety/_SafetyClient.tsx': 3,
  'app/sos/page.tsx': 3,
  'app/team/join/[token]/_JoinClient.tsx': 1,
  'app/tools/equipment/_EquipmentClient.tsx': 2,
  'app/tools/safety/_SafetyClient.tsx': 1,
  'app/trip/[token]/_OfflineSave.tsx': 1,
  'app/trip/[token]/_TripShareClient.tsx': 1,
  'app/watch/WatchClient.tsx': 3,
  'lib/agents/agencies/rescue-agency.ts': 2,
  'lib/agents/editor.ts': 2,
  'lib/agents/eval/editor-judge.ts': 3,
  'lib/agents/evo/content-sanitizer.ts': 1,
  'lib/agents/evo/growth-agent.ts': 4,
  'lib/agents/evo/intel-bridge.ts': 1,
  'lib/agents/evo/model-watcher.ts': 1,
  'lib/agents/evo/schema-model.ts': 2,
  'lib/agents/execution/initiative-executor.ts': 1,
  'lib/agents/kvert-sync.ts': 1,
  'lib/agents/memory/agent-memory.ts': 1,
  'lib/agents/observation-logger.ts': 1,
  'lib/agents/platform-agent.ts': 4,
  'lib/agents/repo-scanner.ts': 1,
  'lib/agents/safeguards/approval-required.ts': 1,
  'lib/agents/scout-ai-features.ts': 1,
  'lib/agents/scout-digest.ts': 2,
  'lib/agents/scout-innovator.ts': 1,
  'lib/agents/sdk/sdk-runner.ts': 1,
  'lib/agents/tools/board-executor-tools.ts': 1,
  'lib/agents/watchdog.ts': 1,
  'lib/ai/fetchAsMarkdown.ts': 1,
  'lib/ai/image-tagger.ts': 1,
  'lib/ai/interest-extractor.ts': 1,
  'lib/ai/json-salvage.ts': 1,
  'lib/ai/providers.ts': 8,
  'lib/ai/query-expansion.ts': 1,
  'lib/ai/route-knowledge.ts': 1,
  'lib/ai/tourist-demand-aggregator.ts': 1,
  'lib/ai/tts.ts': 1,
  'lib/ai/user-memory.ts': 3,
  'lib/ai/verbalized-sampling.ts': 1,
  'lib/auth/jwt.ts': 1,
  'lib/auth/password-reset.ts': 1,
  'lib/auth/tourist-helpers.ts': 1,
  'lib/client-errors/report.ts': 3,
  'lib/db-pool.ts': 1,
  'lib/db/schema-facts.ts': 1,
  'lib/eco/ledger.ts': 1,
  'lib/events/emit.ts': 1,
  'lib/field/track-import.ts': 1,
  'lib/funnel/beacon.ts': 2,
  'lib/kuzmich/core.ts': 9,
  'lib/kuzmich/engagement.ts': 2,
  'lib/kuzmich/tool-loop.ts': 1,
  'lib/kuzmich/trip-plan-tool.ts': 1,
  'lib/mcp/dev-tools/server.ts': 1,
  'lib/mcp/read-body.ts': 1,
  'lib/mcp/write-guard.ts': 1,
  'lib/mesh/volcano-mesh.ts': 5,
  'lib/notifications/booking-notifications.ts': 4,
  'lib/notifications/cover-image.ts': 2,
  'lib/notifications/manual-channel-post.ts': 6,
  'lib/notifications/operator-booking.ts': 1,
  'lib/notifications/post-validation.ts': 2,
  'lib/notifications/telegram-channel.ts': 15,
  'lib/notifications/telegram-upload.ts': 1,
  'lib/notifications/telegram.ts': 1,
  'lib/notifications/tour-channel-post.ts': 2,
  'lib/octo/auth.ts': 1,
  'lib/octo/service.ts': 3,
  'lib/octo/webhooks.ts': 1,
  'lib/offline/field-pack.ts': 1,
  'lib/offline/route-map-save.ts': 1,
  'lib/offline/trip-save.ts': 1,
  'lib/offline/useOfflineRegion.ts': 1,
  'lib/on-route/wp-progress.ts': 2,
  'lib/operators/team.ts': 2,
  'lib/partners/channel-link.ts': 1,
  'lib/places/place-detail.ts': 1,
  'lib/planner/compose.ts': 1,
  'lib/planner/engine.ts': 1,
  'lib/preparation/storage.ts': 1,
  'lib/referral/agent-link.ts': 2,
  'lib/referral/link.ts': 2,
  'lib/routes/catalog-return.ts': 2,
  'lib/routes/geometry-audit.ts': 3,
  'lib/routes/route-detail.ts': 1,
  'lib/search/tour-recommend.ts': 2,
  'lib/security/route-inventory.ts': 1,
  'lib/security/timing-safe.ts': 2,
  'lib/seo/indexnow.ts': 4,
  'lib/seo/page-snapshot.ts': 2,
  'lib/services/ingest/osm-traces-scout.ts': 1,
  'lib/services/ingest/visitkamchatka-importer.ts': 3,
  'lib/services/intelligence-monitor.service.ts': 5,
  'lib/services/operators/operator-tour-scraper.ts': 1,
  'lib/services/routes/route-description-cache.ts': 1,
  'lib/services/safety/max-channel.ts': 1,
  'lib/services/tours/tours-visitkamchatka.ts': 1,
  'lib/share.ts': 1,
  'lib/telegram/admin-notify.ts': 2,
  'lib/telegram/booking-notify.ts': 3,
  'lib/telegram/group-monitor.ts': 4,
  'lib/telegram/welcome.ts': 2,
  'lib/wishlist/client.ts': 2,
};

/**
 * Файлы переписи: всё отслеживаемое в app/ и lib/ с расширением .ts/.tsx.
 *
 * Список берётся каталогами, а фильтр по расширению — здесь, в JS. Первая
 * редакция брала pathspec с двумя звёздочками и маской имени без магии
 * `:(glob)`, а git понимает его как «хотя бы один подкаталог»: мимо сторожа
 * шёл 21 файл прямо в app/ и lib/ — `lib/db-pool.ts`, `lib/auth.ts`,
 * `lib/config.ts`, `app/layout.tsx`… (ревью волны 2, аудит 15.10, P4-03).
 * Охват объявлен «по app/ и lib/», значит держать его надо весь (§10.09).
 * `-z` — чтобы путь с не-ASCII не пришёл в кавычках.
 */
function censusFiles(): string[] {
  return execSync('git ls-files -z -- app lib', { cwd: ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter((f) => /\.tsx?$/.test(f));
}

function census(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of censusFiles()) {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    if (!src.includes('catch')) continue;
    const hits = findEmptyCatches(src, f);
    if (hits.length > 0) out.set(f, hits.map((h) => `${f}:${h.line} (${h.form === 'block' ? 'catch без операторов' : '.catch с пустым телом'})`));
  }
  return out;
}

describe('распознаватель пустого catch', () => {
  it('catch без операторов — находка, комментарий оператором не считается', () => {
    expect(findEmptyCatches('try { x(); } catch {}')).toEqual([{ line: 1, form: 'block' }]);
    expect(findEmptyCatches('try {\n  x();\n} catch (e) {\n  // Тихая ошибка\n}')).toEqual([{ line: 3, form: 'block' }]);
    expect(findEmptyCatches('try { x(); } catch { /* fall through */ }')).toHaveLength(1);
  });

  it('обработчик .catch с пустым телом — находка в обеих записях функции', () => {
    expect(findEmptyCatches('p.catch(() => {});')).toEqual([{ line: 1, form: 'promise' }]);
    expect(findEmptyCatches('p.catch((_e) => { /* молча */ });')).toHaveLength(1);
    expect(findEmptyCatches('p.catch(function () {});')).toHaveLength(1);
  });

  it('названный отказ, проброс и честное «значения нет» — не находка', () => {
    expect(findEmptyCatches("try { x(); } catch (e) { logSwallowedFailure('s', 'x', e); }")).toEqual([]);
    expect(findEmptyCatches('try { x(); } catch (e) { throw e; }')).toEqual([]);
    expect(findEmptyCatches('p.catch((e) => console.error(e));')).toEqual([]);
    expect(findEmptyCatches('const b = await res.json().catch(() => null);')).toEqual([]);
  });

  it('слово catch в строке, шаблоне, регулярке и комментарии не считается', () => {
    const src = [
      "const a = 'try {} catch {}';",
      'const b = `p.catch(() => {})`;',
      'const c = /catch\\s*\\{\\s*\\}/;',
      '// try {} catch {}',
      '/* p.catch(() => {}) */',
    ].join('\n');
    expect(findEmptyCatches(src)).toEqual([]);
  });

  it('TSX разбирается как TSX', () => {
    const src = 'export function A() { const f = () => { try { g(); } catch {} }; return <button onClick={f}>ок</button>; }';
    expect(findEmptyCatches(src, 'a.tsx')).toHaveLength(1);
  });
});

describe('долг пустых catch не растёт', () => {
  const actual = census();

  it('перепись состоялась — ноль находок на ненулевом входе был бы отказом, а не успехом', () => {
    // §4.0: прогон, разобравший 0, обязан краснеть. Если распознаватель
    // сломается и перестанет видеть что-либо, этот тест покажет это первым.
    expect(actual.size).toBeGreaterThan(100);
  });

  it('охват — весь app/ и lib/, включая файлы прямо в корне каталога', () => {
    // Находка ревью 15.10: pathspec `**` без подкаталога пропускал корень.
    // Сверка с диском, а не с git: файл, лежащий прямо в app/ или lib/,
    // обязан попасть в перепись, иначе его новый пустой catch не краснит ничего.
    const files = new Set(censusFiles());
    const rootLevel = ['app', 'lib'].flatMap((dir) =>
      readdirSync(join(ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
        .map((e) => `${dir}/${e.name}`));
    expect(rootLevel.length).toBeGreaterThan(10);
    expect(rootLevel.filter((f) => !files.has(f))).toEqual([]);
    expect(files.has('app/api/leads/route.ts')).toBe(true);
  });

  it('новый файл с пустым catch не появился', () => {
    const newcomers = [...actual.entries()]
      .filter(([f]) => !(f in KNOWN_EMPTY_CATCHES))
      .flatMap(([, where]) => where);
    expect(
      newcomers,
      'Пустой catch: отказ пойман и не назван (CLAUDE.md §4.0). Назовите его — '
      + "logSwallowedFailure(scope, источник, err) из lib/observability/swallowed.ts, "
      + 'пометьте сбой в ответе или пробросьте выше.',
    ).toEqual([]);
  });

  it('в известном файле пустых catch не прибавилось', () => {
    const grown = [...actual.entries()]
      .filter(([f, where]) => f in KNOWN_EMPTY_CATCHES && where.length > KNOWN_EMPTY_CATCHES[f])
      .map(([f, where]) => `${f}: ${KNOWN_EMPTY_CATCHES[f]} → ${where.length}\n  ${where.join('\n  ')}`);
    expect(grown, 'долг вырос: новый пустой catch в файле из переписи').toEqual([]);
  });

  it('запись самоустаревает: снял пустой catch — уменьши число, снял все или удалил файл — удали запись', () => {
    const stale: string[] = [];
    for (const [f, known] of Object.entries(KNOWN_EMPTY_CATCHES)) {
      if (!existsSync(join(ROOT, f))) { stale.push(`${f}: файла нет — удалите запись`); continue; }
      const n = actual.get(f)?.length ?? 0;
      if (n < known) stale.push(`${f}: записано ${known}, осталось ${n} — ${n === 0 ? 'удалите запись' : 'уменьшите число'}`);
    }
    expect(stale).toEqual([]);
  });
});

describe('AI-конвейер лида называет свой отказ (POST /api/leads)', () => {
  /** `makeError` зовётся после сброса модулей: класс ошибки должен быть тем же, что видит роут. */
  async function postLeadWith(makeError: () => Promise<Error>) {
    vi.resetModules();
    const processError = await makeError();
    const logMock = vi.fn();
    vi.doMock('@/lib/observability/swallowed', () => ({ logSwallowedFailure: logMock }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
    vi.doMock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: vi.fn(async () => true) }));
    vi.doMock('@/lib/notifications/lead-notify', () => ({
      notifyPartnerNewLeadPersonally: vi.fn(async () => null),
      notifyOperatorNewLead: vi.fn(async () => undefined),
    }));
    vi.doMock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => ({ success: true })) } }));
    vi.doMock('@/lib/rate-limit', () => ({ createRateLimiter: () => ({ check: () => true }), getTrustedClientIp: () => '203.0.113.7' }));
    const processMock = vi.fn(async () => { throw processError; });
    vi.doMock('@/lib/services/operators/lead-processor.service', () => ({ leadProcessor: { process: processMock } }));
    vi.doMock('@/lib/leads/create', () => ({ createLead: vi.fn(async () => 'lead-42') }));
    vi.doMock('@/lib/analytics/self-visit', () => ({ isSelfVisit: () => false }));
    vi.doMock('@/lib/mcp/handoff', () => ({ attachMcpAttribution: vi.fn(async () => null), MCP_ATTRIBUTION: { cookieName: 'mcp_h' } }));
    vi.doMock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'ok' })) }));
    vi.doMock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

    const { POST } = await import('@/app/api/leads/route');
    const res = await POST(new NextRequest('https://vedarai.ru/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Анна', phone: '+79000000001', comment: 'хочу на вулкан', pd_consent: true }),
    }));
    // Туристу отказ разбора не мешает: ответ уходит раньше конвейера.
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(processMock).toHaveBeenCalledWith('lead-42'));
    return logMock;
  }

  it('квалификатор упал — отказ в логе со своей областью и номером заявки, не в тишине', async () => {
    const boom = Object.assign(new Error('модель не ответила'), { code: 'ETIMEDOUT' });
    const logMock = await postLeadWith(async () => boom);
    await vi.waitFor(() => expect(logMock).toHaveBeenCalledTimes(1));
    expect(logMock).toHaveBeenCalledWith('leads', expect.stringContaining('lead-42'), boom);
  });

  it('заявка на машину — решение не подбирать тур, а не отказ: лог не будится', async () => {
    const logMock = await postLeadWith(async () => {
      const { LeadIsVehicleOrderError } = await import('@/lib/leads/vehicle-order');
      return new LeadIsVehicleOrderError();
    });
    // Конвейер отработал (processMock позван), даём микрозадачам дойти до catch.
    await new Promise((r) => setTimeout(r, 0));
    expect(logMock).not.toHaveBeenCalled();
  });
});
