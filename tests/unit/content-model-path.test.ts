/**
 * Контент пишет сильнейшая доступная модель, а не самая быстрая.
 *
 * Наблюдение владельца 25.07.2026: «наша LLM не дотягивает, работает на старых
 * моделях». Проверка подтвердила и уточнила причину — она была не в API и даже
 * не только в устаревших id.
 *
 * `callAIFast` — это ГОНКА трёх провайдеров: побеждает ответивший ПЕРВЫМ. Для
 * JSON и голосования так и надо. Но им же генерировались дайджест, пост в
 * AI-канал и ВСЕ описания мест и туров (Editor). Двое из трёх участников гонки
 * были прибиты к снапшотам начала 2025 (gemini-2.0-flash-001,
 * deepseek-chat-v3-0324), и маленькая быстрая модель выигрывала почти всегда.
 * То есть систему просили выбрать скорость — она и выбирала, а читали люди.
 *
 * Отдельный вывод про id: «поменять на последние» — недостаточное решение,
 * через полгода они снова устареют. В репо уже есть pickBestModel, который
 * берёт сильнейшую модель из /v1/models провайдера (CLAUDE.md §8: не
 * хардкодить id). До сих пор он был подключён РОВНО к одной ветке — решателю
 * эволюции. Теперь и к контенту.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PROVIDERS = read('lib/ai/providers.ts');
const DIGEST = read('lib/agents/scout-digest.ts');
const EDITOR = read('lib/agents/editor.ts');

/** Тело функции по имени — чтобы проверять код, а не пояснения над ним. */
function bodyOf(src: string, name: string): string {
  const re = new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`);
  return src.match(re)?.[0] ?? '';
}

describe('качественный путь существует и не гоняется на скорость', () => {
  const body = bodyOf(PROVIDERS, 'callAIQuality');

  it('callAIQuality найдена', () => {
    expect(body).not.toBe('');
  });

  it('модель не захардкожена — спрашивается у провайдера', () => {
    expect(body).toMatch(/resolveContentModel\('deepseek'\)/);
    expect(body).toMatch(/resolveContentModel\('qwen'\)/);
    // Ни одного литерального id модели в теле: именно это устаревало.
    expect(body).not.toMatch(/model:\s*'[a-z0-9][\w.\/-]*'/i);
  });

  it('провайдеры идут по очереди, а не в гонке', () => {
    // Гонка — признак выбора «кто быстрее». Здесь её быть не должно.
    expect(body).not.toMatch(/raceProviders|Promise\.race/);
  });

  it('в конце — общий waterfall, чтобы отказ не был молчаливым', () => {
    expect(body).toMatch(/return callAIWaterfall\(messages\)/);
  });
});

describe('резолвер модели общий, но кэш раздельный по назначению', () => {
  it('есть отдельный резолвер для контента', () => {
    expect(PROVIDERS).toMatch(/export async function resolveContentModel/);
  });

  it('решатель и контент не делят кэш', () => {
    // Иначе override одного назначения молча применился бы к другому.
    expect(PROVIDERS).toMatch(/PURPOSE_MODEL_CACHE/);
    expect(PROVIDERS).toMatch(/`\$\{purpose\}:\$\{provider\}`/);
  });

  it('оба назначения переопределяются через env', () => {
    for (const v of ['EVO_DECISION_MODEL', 'EVO_DECISION_QWEN_MODEL', 'CONTENT_MODEL', 'CONTENT_QWEN_MODEL']) {
      expect(PROVIDERS, `нет override ${v}`).toContain(v);
    }
  });
});

describe('генераторы контента подключены к качественному пути', () => {
  it('дайджест и пост в AI-канал генерируются через callAIQuality', () => {
    expect(DIGEST).toMatch(/digest = await callAIQuality\(/);
    expect(DIGEST).toMatch(/aiDigest = await callAIQuality\(/);
  });

  it('описания Editor — тоже', () => {
    expect(EDITOR).toMatch(/callAIQualityOrNull\(/);
    // Быстрая ветка из Editor ушла совсем.
    expect(EDITOR).not.toMatch(/callAIFast/);
  });

  it('фактчек остаётся на быстрой ветке — там скорость уместна', () => {
    // unsupportedClaims возвращает JSON: структурная задача, не текст для людей.
    expect(DIGEST).toMatch(/const raw = await callAIFast\(/);
  });
});
