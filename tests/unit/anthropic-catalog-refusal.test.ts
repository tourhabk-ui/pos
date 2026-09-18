/**
 * Каталог Anthropic: «пусто» и «не смогли спросить» — разные ответы.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * Отчёт судьи эволюции 18.09 (#1428) о ступени Anthropic говорил: «каталог
 * моделей пуст, а флагман (z-ai/glm-5.3) — не модель Anthropic; просить
 * нечего». Читается как факт о ключе: моделей у него нет. Факта о ключе там
 * не было вовсе — `getAnthropicModelIds` отвечал пустым списком на ТРИ
 * разных события (ключа нет, HTTP-отказ, запрос не дошёл) и не писал в лог
 * ни слова.
 *
 * Цена подмены выросла в день, когда владелец пополнил счёт Anthropic:
 * следующий отчёт сказал бы то же «каталог пуст», и вывод «деньги не
 * помогли» был бы сделан по замеру, которого не было (§4.0).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * У каталога есть проба с третьим исходом; снисходительный геттер построен
 * на ней и НЕ молчит о причине; ступень решателя печатает, отказал каталог
 * или ответил пустым списком, — разными строками.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

describe('проба каталога: три исхода, не один', () => {
  it('probeAnthropicModels объявлена и различает отказ от пустого списка', () => {
    expect(SRC).toMatch(/export async function probeAnthropicModels\(\)/);
    const fn = SRC.slice(SRC.indexOf('export async function probeAnthropicModels'));
    // Ключа нет, HTTP-отказ и сетевой отказ — три РАЗНЫЕ ветки с причиной.
    expect(fn).toMatch(/detail: 'ключ не задан'/);
    expect(fn).toMatch(/http_status: res\.status, detail: \(await res\.text\(\)\)/);
    expect(fn).toMatch(/err instanceof Error \? err\.message : 'запрос не удался'/);
  });

  it('снисходительный геттер построен на пробе и пишет причину в лог', () => {
    const fn = SRC.slice(
      SRC.indexOf('export async function getAnthropicModelIds'),
      SRC.indexOf('export async function probeAnthropicModels'),
    );
    expect(fn).toMatch(/await probeAnthropicModels\(\)/);
    // §4.0: ловить можно, молчать нельзя.
    expect(fn).toMatch(/console\.error\(`\[anthropic-models\] каталог не ответил/);
    // Прежние немые возвраты не вернулись.
    expect(fn).not.toMatch(/catch \{ return \[\] \}|if \(!res\.ok\) return \[\]/);
  });
});

describe('ступень решателя называет, что именно случилось', () => {
  const STEP = SRC.slice(SRC.indexOf('// 0b) Флагман НАПРЯМУЮ через Anthropic API'));

  it('отказ каталога и пустой список — разные строки отчёта', () => {
    expect(STEP).toMatch(/каталог не ответил \(\$\{antProbe\.http_status \?\? 'сеть'\}\)/);
    expect(STEP).toMatch(/каталог ответил пустым списком/);
    // Прежняя единственная формулировка ушла: она врала об одном из двух.
    expect(STEP).not.toMatch(/каталог моделей пуст/);
  });

  it('id для Anthropic по-прежнему не берётся из чужого слага', () => {
    // Урок 15.09: с флагманом z-ai снятие префикса давало модель чужого
    // поставщика, и запрос был бессмысленным независимо от ключа.
    expect(STEP).toMatch(/pickBestFlagship\(antIds\) \?\? anthropicModelFromSlug\(flagshipModel\)/);
    expect(STEP).toMatch(/просить нечего/);
  });
});

describe('живое поведение пробы', () => {
  const KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; });
  afterEach(() => {
    if (KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = KEY;
    vi.unstubAllGlobals();
  });

  it('HTTP-отказ отдаётся статусом и телом, а не пустым списком', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"error","error":{"message":"credit balance is too low"}}', { status: 400 })));
    const { probeAnthropicModels } = await import('@/lib/ai/providers');
    const r = await probeAnthropicModels();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.http_status).toBe(400);
      expect(r.detail).toContain('credit balance is too low');
    }
  });

  it('пустой список каталога — это ok, а не отказ', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })));
    const { probeAnthropicModels } = await import('@/lib/ai/providers');
    const r = await probeAnthropicModels();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ids).toEqual([]);
  });
});
