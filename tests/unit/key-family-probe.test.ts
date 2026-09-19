// @vitest-environment node
/**
 * Пробы формы ключа: «отозван», «лежит не в своём секрете» и «живой, но не
 * там» — три разные беды с тремя разными починками (19.09).
 *
 * За два дня одна и та же 401 объяснялась трижды, и каждый раз неверно:
 * «ключ отозван» (прогон 4 нашёл длину 108 без `sk-or-`), «гео-блок Timeweb»
 * (раннер GitHub не в РФ, и там тот же отказ), «ключи поменяли местами»
 * (прогон 11 показал ключ Anthropic и в своём секрете — отвергнутый). Код
 * ответа один, починки разные, и различает их только вопрос поставщику.
 *
 * Сторож держит не наличие шагов, а их РАЗЛИЧАЮЩУЮ СИЛУ: три исхода у
 * перекрёстной проверки (§4.0 — «не смог» не равно «оба мертвы»), запрос без
 * единого токена, и ни одного символа ключа наружу. Шаг, печатающий только
 * «401», зеленеет ровно тогда, когда диагностика перестала различать.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const OR = read('.github/workflows/openrouter-models.yml');
const ANT = read('.github/workflows/anthropic-path-probe.yml');

describe('поставщик называется по началу ключа', () => {
  it('обе пробы различают три известные формы, а не только свою', () => {
    for (const wf of [OR, ANT]) {
      expect(wf).toMatch(/sk-or-\*\)/);
      expect(wf).toMatch(/sk-ant-\*\)/);
      expect(wf).toMatch(/sk-proj-\*\)/);
      // Неизвестная форма — отдельный исход, а не молчание.
      expect(wf).toMatch(/не похож ни на одну известную форму/);
    }
  });

  it('каждая проба говорит, когда ключ лежит не в своём секрете', () => {
    // В пробе OpenRouter чужой — Anthropic, в пробе Anthropic — OpenRouter.
    expect(OR).toMatch(/sk-ant-\*\)\s+FAMILY="ANTHROPIC \(sk-ant-\) — ключ лежит не в своём секрете"/);
    expect(ANT).toMatch(/sk-or-\*\)\s+FAMILY="OPENROUTER \(sk-or-\) — ключ лежит не в своём секрете"/);
  });

  it('наружу — длина, форма и флаг пробелов, ни символа ключа', () => {
    for (const wf of [OR, ANT]) {
      expect(wf).toMatch(/wc -c/);
      expect(wf).toMatch(/пробелы внутри=/);
    }
    // Значение ключа не печатается ни echo, ни через тело ответа целиком.
    expect(OR).not.toMatch(/echo[^\n]*\$OPENROUTER_API_KEY/);
    expect(OR).not.toMatch(/echo[^\n]*\$\{OPENROUTER_API_KEY\}/);
    expect(ANT).not.toMatch(/echo[^\n]*\$ANTHROPIC_API_KEY/);
    expect(ANT).not.toMatch(/echo[^\n]*\$\{ANTHROPIC_API_KEY\}/);
  });
});

describe('перекрёстный вопрос: живой ключ или мёртвый', () => {
  it('ключ формы Anthropic из чужого секрета спрашивается у Anthropic', () => {
    // Подстрочный поиск по тексту workflow, а не проверка URL: регулярка тут
    // читалась бы как неанкоренная проверка хоста (и CodeQL её так и прочёл).
    expect(OR).toContain('api.anthropic.com/v1/models');
    expect(OR).toContain('anthropic-version: 2023-06-01');
  });

  it('вопрос не стоит токенов — это каталог, а не генерация', () => {
    // /v1/messages списал бы деньги и мог бы упереться в баланс, то есть
    // ответил бы не про ключ. Каталог отвечает ровно про авторизацию.
    expect(OR).not.toContain('api.anthropic.com/v1/messages');
  });

  it('три исхода, и «не смог» не выдаётся за «оба мертвы»', () => {
    expect(OR).toMatch(/200\)[\s\S]{0,400}?ЖИВОЙ ключ Anthropic лежит в секрете OPENROUTER_API_KEY/);
    expect(OR).toMatch(/000\)[\s\S]{0,200}?НЕ ЗНАЮ/);
    expect(OR).toMatch(/живого ключа Anthropic нет ни в одном секрете, нужен новый/);
  });

  it('две починки названы РАЗНЫМИ словами — иначе различать было бы незачем', () => {
    expect(OR).toMatch(/переложить его в ANTHROPIC_API_KEY/);
    expect(OR).toMatch(/Новый ключ Anthropic выпускать НЕ нужно/);
    // Обратный исход требует обратного действия, и это сказано вслух.
    expect(OR).toMatch(/нужен новый/);
  });
});
