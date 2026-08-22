/**
 * Решения по блоку D переписи («Агенты и AI»), 22.08.2026.
 *
 * Перепись `docs/EXPORT_CENSUS.md` нашла 96 механизмов, которых не зовёт
 * никто. По блоку D решение принято поимённо: семь подключены, четырнадцать
 * удалены, два оставлены с записанной причиной.
 *
 * Сторож держит именно РЕШЕНИЯ, а не код: удалённое не должно вернуться
 * молча, подключённое — снова отвязаться. Оба вида отката выглядят как
 * тишина, а тишину здесь уже принимали за порядок.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
/** Код без комментариев: имя в пояснении — не вызов (на этом сторожа уже спотыкались). */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

describe('блок D · удалено', () => {
  it('agent-toolkits не возвращается: он обслуживал Совет, удалённый в апреле', () => {
    expect(exists('lib/agents/tools/agent-toolkits.ts')).toBe(false);
  });

  it('клиент Managed Agents не возвращается: это была заглушка при выключенном флаге', () => {
    expect(exists('lib/agents/managed/client.ts')).toBe(false);
  });

  it('универсального SQL-инструмента у агента нет', () => {
    // Произвольный SELECT в чате означает, что подсказка собеседника может
    // вычитать leads.phone и уехать в зарубежную модель. Инструменты — только
    // типизированные, в наборе своей роли.
    const src = code('lib/agents/sdk/sdk-runner.ts');
    expect(src).not.toMatch(/\bmakeQueryTool\b/);
    expect(src).not.toMatch(/\bmakeReadMemoryTool\b/);
  });

  it('двойник тормоза точности не возвращается', () => {
    // Живой — isModelGuessLocated в precision.ts.
    expect(code('lib/agents/evo/failure-taxonomy.ts')).not.toMatch(/\bisModelFault\b/);
    expect(code('lib/agents/evo/precision.ts')).toMatch(/\bisModelGuessLocated\b/);
  });

  it('мёртвые звенья провайдеров не возвращаются', () => {
    const src = code('lib/ai/providers.ts');
    // Прямой Xiaomi отключён 04.07; путь возврата — через OpenRouter.
    expect(src).not.toMatch(/\bcallMiMo\b/);
    // Gemini зовётся напрямую через Google API.
    expect(src).not.toMatch(/export async function callGemini\s*\(/);
    expect(src).toMatch(/export async function callGeminiDirect\s*\(/);
    // Тривиальный алиас водопада.
    expect(src).not.toMatch(/\bcallAIWaterfallDirect\b/);
  });

  it('страж ПД сторожит существующие двери', () => {
    // Раньше в списке стоял callGemini — функция, которой не звал никто.
    const src = read('lib/agents/compliance/pii-flow-scanner.ts');
    expect(src).toContain("'callGeminiDirect'");
    expect(src).toContain("'callGeminiTranscribe'");
    expect(src).not.toContain("'callMiMo'");
  });

  it('одиночный теггинг и пилот Molmo не возвращаются', () => {
    expect(code('lib/ai/image-tagger.ts')).not.toMatch(/\btagTourImage\b/);
    expect(code('lib/ai/provider-config.ts')).not.toMatch(/Molmo/i);
  });
});

describe('блок D · подключено', () => {
  it('порядок разрядов кронов берётся из реестра, а не пишется заново', () => {
    const src = code('app/api/admin/agents/liveness/route.ts');
    expect(src).toMatch(/\bentriesByTier\b/);
    expect(src).not.toMatch(/TIER_ORDER\.map/);
  });

  it('отказ по правам называет доступные намерения', () => {
    expect(code('app/api/agents/operator/route.ts')).toMatch(/\ballowedIntentsForRole\b/);
  });

  it('заявленные предложения эволюции сверяются с записанными', () => {
    const src = code('lib/agents/evo/evolver-analysis.ts');
    expect(src).toMatch(/\bsmokeTestMemoryWrites\b/);
    // Род записей обязателен: без него отметка «последний запуск» сама
    // становится тем найденным рядом, ради которого проверка заведена.
    // `[^;]*`, а не `[^)]*`: в аргументах есть свои скобки — new Date(startedAt).
    expect(src).toMatch(/smokeTestMemoryWrites\([^;]*'proposal'/);
  });

  it('преполётная проверка провайдеров имеет вход', () => {
    expect(exists('app/api/admin/health/ai-providers/route.ts')).toBe(true);
    expect(code('app/api/admin/health/ai-providers/route.ts')).toMatch(/\bpreflightProviders\b/);
    // Проба тратит квоту провайдеров — на дашборде она по кнопке, не при загрузке.
    const dash = code('app/hub/admin/health/_HealthDashboardClient.tsx');
    expect(dash).toMatch(/ai-providers/);
    expect(dash).toMatch(/onClick=\{runPreflight\}/);
  });

  it('всплеск регистраций операторов сторожит Watchdog', () => {
    const src = code('lib/agents/watchdog.ts');
    expect(src).toMatch(/\bdetectRegistrationSpike\b/);
    expect(src).toMatch(/checkOperatorRegistrationSpike/);
  });

  it('у всплеска три исхода: нет истории — не «спокойно»', () => {
    expect(code('lib/agents/agencies/operator-agency.ts')).toMatch(/verdict: 'unknown'/);
  });

  it('оценки опасности по зонам доходят до Спасателя', () => {
    const src = code('lib/agents/evo/rescue-agent.ts');
    expect(src).toMatch(/\bgetZoneAssessment\b/);
    expect(src).toMatch(/\bgetFullDangerSummary\b/);
  });

  it('тип оценки зоны не обещает колонок, которых запрос не выбирает', () => {
    const src = read('lib/agents/agencies/danger-analyst-agency.ts');
    expect(src).toMatch(/export type ZoneRisk = Pick</);
    expect(src).toMatch(/Promise<ZoneRisk \| null>/);
  });
});

describe('блок D · оставлено с причиной', () => {
  it('прогрев модели остаётся, и причина отключения записана рядом с кодом', () => {
    const doc = read('lib/ai/embeddings.ts');
    expect(doc).toMatch(/export async function warmModel/);
    expect(doc).toMatch(/ВЫЗОВА НЕТ НАМЕРЕННО/);
    expect(doc).toMatch(/musl|Alpine|sharp/);
    // И сам закомментированный вызов остаётся на месте — он часть объяснения.
    expect(read('instrumentation.ts')).toMatch(/warmModel/);
  });

  it('расшифровка интересов остаётся как вторая половина шифрования', () => {
    const doc = read('lib/ai/interest-extractor.ts');
    expect(doc).toMatch(/export function decryptInterests/);
    expect(doc).toMatch(/ВЫЗОВА НЕТ НАМЕРЕННО/);
  });
});
