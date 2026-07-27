/**
 * Последний прибитый id модели снят — но НЕ там, где ответа ждёт человек.
 *
 * К 26.07.2026 решатель эволюции и генератор контента уже брали сильнейшую
 * модель из /v1/models провайдера (CLAUDE.md §8: не хардкодить id). Одиночный
 * `callQwen` оставался на `QWEN_MODEL || 'qwen-plus'` — среднем тире. На нём
 * висит первая фаза scout-innovator, которая рождает предложения эволюции:
 * слабее модель — беднее задачи, которые потом попадают в Issues.
 *
 * Обратная сторона так же важна: `callQwenWithTools` — живой цикл инструментов
 * Кузьмича, где турист ждёт ответа в поле. Туда резолв НЕ подключён намеренно
 * (сетевой round-trip на холодном кэше + более медленная модель). Тест сторожит
 * обе стороны решения, чтобы «усилить везде» не заехало в путь ожидания.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PROVIDERS = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

/** Тело функции по имени — проверяем код, а не пояснения над ним. */
function bodyOf(name: string): string {
  const re = new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`);
  return PROVIDERS.match(re)?.[0] ?? '';
}

describe('callQwen берёт сильнейшую доступную модель', () => {
  const body = bodyOf('callQwen');

  it('функция найдена', () => {
    expect(body).not.toBe('');
  });

  it('модель резолвится, а не берётся из конфига', () => {
    expect(body).toContain("resolveChatModel('qwen')");
  });

  it('в теле нет литерального id модели', () => {
    expect(body).not.toMatch(/model:\s*'[a-z0-9][\w.\/-]*'/i);
  });
});

describe('живой tools-цикл Кузьмича остаётся на быстром пути', () => {
  const body = bodyOf('callQwenWithTools');

  it('функция найдена', () => {
    expect(body).not.toBe('');
  });

  it('резолв туда НЕ подключён — там ждёт человек', () => {
    expect(body).not.toContain('resolveChatModel');
    expect(body).not.toContain('resolveContentModel');
    expect(body).toContain('getQwenConfig()');
  });
});

describe('резолвер чата: свой кэш и прежний override', () => {
  it('resolveChatModel экспортирован', () => {
    expect(PROVIDERS).toMatch(/export async function resolveChatModel/);
  });

  it('назначение chat отделено от decision/content', () => {
    const body = bodyOf('resolveChatModel');
    expect(body).toContain("'chat'");
  });

  it('override остался прежним — QWEN_MODEL', () => {
    const body = bodyOf('resolveChatModel');
    expect(body).toContain('QWEN_MODEL');
  });

  it('purpose входит в ключ кэша — пути не делят резолв', () => {
    expect(PROVIDERS).toMatch(/`\$\{purpose\}:\$\{provider\}`/);
  });
});
