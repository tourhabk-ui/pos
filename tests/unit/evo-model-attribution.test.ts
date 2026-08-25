/**
 * Кто думал — видно там, где читают.
 *
 * Владелец потребовал, чтобы аудит считала самая мощная модель. В коде она уже
 * стоит первой: callAIDecisionDetailed идёт флагман → OpenRouter-релей →
 * Anthropic напрямую → и только потом DeepSeek/Qwen. Но waterfall съезжает на
 * фоллбэк МОЛЧА, когда нет ключа или релея, и снаружи это неотличимо: скан
 * зелёный, находки есть.
 *
 * Атрибуция модели писалась в БД с EVO-4, но не доходила ни до тела тикета, ни
 * до ответа крона — то есть ровно туда, куда смотрит человек. «Аудит считает
 * флагман» оставалось верой. Тесты держат обратное: понижение видно без
 * похода в базу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildIssueBody, type GrowthFinding } from '@/lib/agents/evo/issue-reporter';
import { buildEvoAlert, isFlagshipDecision } from '@/lib/agents/evo/alert';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const REPORT_ROUTE = read('app/api/cron/evo-report/route.ts');
const GROWTH = read('lib/agents/evo/growth-agent.ts');

const base: GrowthFinding = {
  id: 'f-1',
  category: 'bug',
  severity: 'high',
  file_path: 'lib/x.ts',
  line_number: 10,
  title: 'Заголовок',
  description: 'Описание',
  suggestion: 'Предложение',
};

describe('модель в теле тикета', () => {
  it('флагман назван поимённо', () => {
    const body = buildIssueBody({ ...base, model: 'anthropic/claude-opus-5' });
    expect(body).toContain('anthropic/claude-opus-5');
  });

  it('фоллбэк тоже назван — понижение должно бросаться в глаза', () => {
    const body = buildIssueBody({ ...base, model: 'deepseek-chat' });
    expect(body).toContain('deepseek-chat');
  });

  it('детерминированная находка не выдаётся за работу модели', () => {
    const body = buildIssueBody({ ...base, model: 'deterministic' });
    expect(body).toContain('детерминированной проверкой');
    expect(body).not.toContain('моделью `deterministic`');
  });

  it('старые находки без атрибуции честно помечены, а не приписаны флагману', () => {
    const body = buildIssueBody({ ...base, model: null });
    expect(body).toContain('не записана');
  });
});

describe('модель доезжает до тикета и до ответа крона', () => {
  it('выборка находок тянет model из БД', () => {
    expect(REPORT_ROUTE).toContain('suggestion, status, model');
  });

  it('ответ скана называет модель прогона', () => {
    expect(GROWTH).toContain('decision_model');
    // §8 (эволюция AI-вызова на раннер GitHub, evo-review.yml): плановый скан
    // ('full') AI-ревью больше не зовёт сам — decisionModel в нём честно
    // остаётся null (объявлен, не подменяется угадыванием), а атрибуция
    // модели теперь приходит с находками через POST /api/cron/evo-findings.
    // Прод-фоллбэк (aiCodeReview, ручной триггер) атрибуцию по-прежнему
    // проставляет.
    expect(GROWTH).toContain("let decisionModel: string | null = null;");
    const findingsRoute = readFileSync(join(process.cwd(), 'app/api/cron/evo-findings/route.ts'), 'utf-8');
    expect(findingsRoute).toMatch(/model:\s*model\s*\?\?\s*null/);
  });
});

describe('телеграм-отчёт называет модель и кричит про понижение', () => {
  const scan = (decision_model: string | null) => ({
    issues: [], new_issues: 0, duration_ms: 1000,
    coverage: { source: 'github', files_listed: 900, files_reviewed: 20, mock_files_scanned: 20 },
    decision_model,
  });
  const quiet = { evolution: { processed: 0 }, rescue: { alerts: [] }, errors: [] as string[] };

  it('флагман назван в отчёте', () => {
    const text = buildEvoAlert({ scan: scan('anthropic/claude-opus-5'), ...quiet });
    // Тихий прогон на флагмане алерта не требует — шум владельцу не нужен.
    expect(text).toBeNull();
    const withNews = buildEvoAlert({
      scan: { ...scan('anthropic/claude-opus-5'), new_issues: 2 }, ...quiet,
    });
    expect(withNews).toContain('Модель аудита: anthropic/claude-opus-5');
  });

  it('съезд на фоллбэк сам по себе повод для отчёта', () => {
    // Даже когда прогон тихий: иначе понижение узнаётся только случайно.
    const text = buildEvoAlert({ scan: scan('deepseek-chat'), ...quiet });
    expect(text).not.toBeNull();
    expect(text).toContain('ФОЛЛБЭК');
    expect(text).toContain('deepseek-chat');
  });

  it('прямой путь в Anthropic — тоже флагман, а не понижение', () => {
    expect(isFlagshipDecision('anthropic:claude-opus-5')).toBe(true);
    expect(isFlagshipDecision('anthropic/claude-opus-5')).toBe(true);
    expect(isFlagshipDecision('deepseek-chat')).toBe(false);
    expect(isFlagshipDecision('qwen-max')).toBe(false);
    expect(isFlagshipDecision(null)).toBe(false);
  });

  it('решатель молчит — это тревога, а не тишина (контракт сменён 01.08)', () => {
    // Прежний тест утверждал «null = ревью не запускалось» — при
    // files_reviewed: 20 в этой же фикстуре. Это и было слепое пятно:
    // четыре прогона подряд с немым решателем выглядели зелёными.
    // Файлы ушли в ревью, модель не записана → не ответил ни один
    // провайдер, и «0 находок» ничего не значит.
    const text = buildEvoAlert({ scan: scan(null), ...quiet });
    expect(text).not.toBeNull();
    expect(text).toContain('РЕШАТЕЛЬ МОЛЧИТ');
  });

  it('а вот прогон, где ревью НЕ запускалось, тревоги не даёт', () => {
    const noReview = {
      ...scan(null),
      coverage: { source: 'github', files_listed: 900, files_reviewed: 0, mock_files_scanned: 20 },
    };
    expect(buildEvoAlert({ scan: noReview, ...quiet })).toBeNull();
  });
});

describe('немота решателя приходит с причиной (01.08)', () => {
  // Баланс DeepSeek оказался жив ($7.83, расход $20/30д), а прогоны молчали —
  // отказы глотались по ступеням waterfall без следа. Теперь причина едет
  // из callAIDecisionDetailed через скан в алерт.
  const quiet = { evolution: { processed: 0 }, rescue: { alerts: [] }, errors: [] as string[] };
  const scanErr = {
    issues: [], new_issues: 0, duration_ms: 1000,
    coverage: { source: 'github', files_listed: 900, files_reviewed: 20, mock_files_scanned: 20 },
    decision_model: null,
    decision_error: 'deepseek(deepseek-chat): HTTP 400 maximum context length exceeded',
  };

  it('алерт называет причину, а не только факт немоты', () => {
    const text = buildEvoAlert({ scan: scanErr, ...quiet });
    expect(text).toContain('РЕШАТЕЛЬ МОЛЧИТ');
    expect(text).toContain('maximum context length');
  });

  it('waterfall собирает причины по ступеням, а не глотает', () => {
    const providers = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');
    expect(providers, 'копилка причин пропала — немота снова станет слепой')
      .toMatch(/why\.push\(`deepseek\(\$\{model\}\): HTTP \$\{res\.status\}/);
    expect(providers).toMatch(/error: why\.join/);
  });

  it('нераспарсенный ответ сохраняет атрибуцию модели', () => {
    // Раньше parse-ошибка глоталась общим catch и терялась даже модель —
    // немота и кривой ответ выглядели одинаково.
    expect(GROWTH).toMatch(/не распарсился/);
    expect(GROWTH).toMatch(/model: decisionModel \?\? null,\s*\n\s*decisionError/);
  });
});

describe('провенанс решателя: штатный DeepSeek против настоящего съезда (пакет D)', () => {
  const quiet = { evolution: { processed: 0 }, rescue: { alerts: [] }, errors: [] as string[] };
  const scanWith = (provenance: string[] | null, extra: Record<string, unknown> = {}) => ({
    issues: [], new_issues: 0, duration_ms: 1000,
    coverage: { source: 'github', files_listed: 900, files_reviewed: 20, mock_files_scanned: 20 },
    decision_model: 'deepseek-chat',
    decision_provenance: provenance,
    ...extra,
  });

  it('релей не настроен → DeepSeek штатен: тихий прогон БЕЗ тревоги', () => {
    // Ровно ночной кейс 07-08.08: ключей флагмана нет, политика владельца
    // «дипсик либо опус» — DeepSeek тут не понижение, а штатный решатель.
    const text = buildEvoAlert({
      scan: scanWith(['flagship: пустой ответ или нет ключа/релея', 'anthropic: ключа нет']),
      ...quiet,
    });
    expect(text).toBeNull();
  });

  it('релей не настроен, но есть новости → строка информационная, не ФОЛЛБЭК', () => {
    const text = buildEvoAlert({
      scan: scanWith(['flagship: пустой ответ или нет ключа/релея', 'anthropic: ключа нет'], { new_issues: 2 }),
      ...quiet,
    });
    expect(text).toContain('штатный решатель');
    expect(text).not.toContain('ФОЛЛБЭК');
  });

  it('релей настроен, но флагман молчит → тревога С ПРИЧИНОЙ из провенанса', () => {
    const text = buildEvoAlert({
      scan: scanWith(['flagship: пустой ответ или нет ключа/релея', 'anthropic: HTTP 500 upstream error']),
      ...quiet,
    });
    expect(text).toContain('ФОЛЛБЭК');
    expect(text).toContain('HTTP 500');
    expect(text).not.toContain('Проверьте ключ и релей');
  });

  it('прогон без провенанса (до пакета D) — считается понижением, как раньше', () => {
    const text = buildEvoAlert({ scan: scanWith(null), ...quiet });
    expect(text).toContain('ФОЛЛБЭК');
  });
});

describe('EVO_FLAGSHIP_DEFERRED: отложенный флагман — решение, а не тревога', () => {
  const quiet = { evolution: { processed: 0 }, rescue: { alerts: [] }, errors: [] as string[] };
  const CREDIT_PROV = [
    'flagship: пустой ответ или нет ключа/релея',
    'anthropic: HTTP 400 {"type":"error","error":{"message":"Your credit balance is too low"}}',
  ];
  const scanDeferred = (extra: Record<string, unknown> = {}) => ({
    issues: [], new_issues: 0, duration_ms: 1000,
    coverage: { source: 'github', files_listed: 900, files_reviewed: 20, mock_files_scanned: 20 },
    decision_model: 'deepseek-chat',
    decision_provenance: CREDIT_PROV,
    ...extra,
  });

  it('с флагом тихий прогон не тревожит, хотя флагман настроен и молчит', () => {
    // Ровно решение владельца 08.08: баланс не пополняем до продакшена.
    expect(buildEvoAlert({ scan: scanDeferred(), ...quiet }, { flagshipDeferred: true })).toBeNull();
  });

  it('с флагом при новостях — информационная строка с причиной, не ФОЛЛБЭК', () => {
    const text = buildEvoAlert({ scan: scanDeferred({ new_issues: 1 }), ...quiet }, { flagshipDeferred: true });
    expect(text).toContain('флагман отложен владельцем');
    expect(text).toContain('credit balance');
    expect(text).not.toContain('ФОЛЛБЭК');
  });

  it('БЕЗ флага тот же прогон кричит — снятие флага возвращает тревогу', () => {
    const text = buildEvoAlert({ scan: scanDeferred(), ...quiet }, { flagshipDeferred: false });
    expect(text).toContain('ФОЛЛБЭК');
  });

  it('флаг не глушит немоту решателя — это другой класс тревоги', () => {
    const text = buildEvoAlert({
      scan: { ...scanDeferred(), decision_model: null, decision_error: 'все молчат' },
      ...quiet,
    }, { flagshipDeferred: true });
    expect(text).toContain('РЕШАТЕЛЬ МОЛЧИТ');
  });
});
