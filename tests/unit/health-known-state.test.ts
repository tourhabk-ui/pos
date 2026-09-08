/**
 * tests/unit/health-known-state.test.ts
 *
 * Принятое положение дел молчит в Telegram, но не исчезает.
 *
 * ── Что случилось (08.09) ──────────────────────────────────────────────────
 *
 * Владелец: «уже в е смен ли а он все равно это пишет», следом — «мы поменяли
 * площадку вернули в гит хаб а qwen не используем». То есть на оба
 * предупреждения health-крона он ОТВЕТИЛ ДЕЛОМ: работу, которой нужен
 * OpenRouter, увёл на раннер GitHub, а Qwen перестал использовать. А крон
 * продолжал писать «OpenRouter недоступен с прода» и «Qwen недоступен» каждые
 * полчаса.
 *
 * Предупреждение о положении, которое измерено, объяснено и принято, — не
 * сигнал, а шум. И шум опаснее молчания: рядом в той же сводке стоят SOS без
 * ответа и просроченные платежи, и человек, приученный пролистывать, пролистает
 * их тоже.
 *
 * ── Где здесь граница ──────────────────────────────────────────────────────
 *
 * `known` — это не «замяли» и не «всё хорошо». Это четвёртый исход рядом с
 * тремя из §4.0: измерено, плохо, и решение принято человеком. Он обязан
 * оставаться видимым (`known_states` в теле ответа) и обязан слетать, как
 * только меняется ПРИЧИНА: гео-блок 403 принят, а 401, кончившиеся кредиты,
 * битая форма ключа и «сеть не дошла» — новость, и они будят.
 *
 * Широкий предикат («ключ на месте, что-то не работает») был бы выключенной
 * сигнализацией, а не убранным шумом, — сторож держит именно узость.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAcceptedOpenRouterGeoBlock } from '@/lib/ai/providers';

const HEALTH = readFileSync(join(process.cwd(), 'app/api/cron/health/route.ts'), 'utf-8');
const PROVIDERS = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

/** Целый ключ: форма измерена и претензий к ней нет. */
const GOOD_SHAPE = { key_len: 73, key_prefix_ok: true, key_had_outer_space: false, key_has_inner_space: false };

describe('принятым считается только гео-блок при целом ключе', () => {
  it('403 с целым ключом — принято', () => {
    expect(isAcceptedOpenRouterGeoBlock({
      key_source: 'OPENROUTER_API_KEY', http_status: 403, key_shape: GOOD_SHAPE,
    })).toBe(true);
  });

  it('401 — ключ отвергнут, это новость', () => {
    expect(isAcceptedOpenRouterGeoBlock({
      key_source: 'OPENROUTER_API_KEY', http_status: 401, key_shape: GOOD_SHAPE,
    })).toBe(false);
  });

  it('402 (кончились кредиты) — новость', () => {
    expect(isAcceptedOpenRouterGeoBlock({
      key_source: 'OPENROUTER_API_KEY', http_status: 402, key_shape: GOOD_SHAPE,
    })).toBe(false);
  });

  it('сеть не дошла — новость, а не принятое', () => {
    expect(isAcceptedOpenRouterGeoBlock({
      key_source: 'OPENROUTER_API_KEY', http_status: null, key_shape: GOOD_SHAPE,
    })).toBe(false);
  });

  it('ключа нет вовсе — не гео-блок', () => {
    expect(isAcceptedOpenRouterGeoBlock({
      key_source: null, http_status: 403, key_shape: GOOD_SHAPE,
    })).toBe(false);
  });

  it('форма ключа испорчена — 403 объясняется не регионом', () => {
    expect(isAcceptedOpenRouterGeoBlock({
      key_source: 'OPENROUTER_API_KEY',
      http_status: 403,
      key_shape: { ...GOOD_SHAPE, key_prefix_ok: false },
    })).toBe(false);
  });

  it('форму не измерили — «не знаю» не принимается за принятое (§4.0)', () => {
    expect(isAcceptedOpenRouterGeoBlock({
      key_source: 'OPENROUTER_API_KEY', http_status: 403, key_shape: null,
    })).toBe(false);
  });

  it('диагностика не собралась вовсе — тем более не принято', () => {
    expect(isAcceptedOpenRouterGeoBlock(null)).toBe(false);
  });
});

describe('known не уходит в Telegram, но остаётся в ответе', () => {
  it('алерт собирается только из crit и warn', () => {
    expect(HEALTH).toMatch(/if \(crits\.length > 0 \|\| warns\.length > 0\)/);
    // Прежнее условие отправляло всё подряд: с ним `known` уехал бы в Telegram
    // ровно так же, как warn, и правка не изменила бы ничего.
    expect(HEALTH).not.toMatch(/if \(issues\.length > 0\) \{\s*\n\s*const crits/);
  });

  it('принятые положения видны в теле ответа отдельным списком', () => {
    expect(HEALTH).toMatch(/known_states: known\.map/);
  });

  it('на общий вердикт ok влияет по-прежнему только crit', () => {
    expect(HEALTH).toMatch(/ok: crits\.length === 0/);
  });
});

describe('Qwen: снят с текстовых путей, а не заглушен в алерте', () => {
  it('водопад инструментов Кузьмича начинается с DeepSeek', () => {
    // Ступени идут ПОСЛЕДОВАТЕЛЬНО. Пока первым стоял отвергнутый ключ, каждое
    // сообщение человека в поле ждало заведомого отказа перед живым ответом.
    const body = PROVIDERS.slice(
      PROVIDERS.indexOf('export async function callToolsWaterfall'),
      PROVIDERS.indexOf('export async function callAIWithModel'),
    );
    expect(body).toMatch(/callDeepSeekWithTools\(messages, tools\)/);
    expect(body).not.toMatch(/callQwenWithTools\(messages, tools\)/);
  });

  it('первая фаза scout-innovator больше не ходит в Qwen', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agents/scout-innovator.ts'), 'utf-8');
    expect(src).not.toMatch(/callQwen\(/);
  });

  it('предупреждение называет то, что реально сломано: зрение', () => {
    // Не «Qwen недоступен» — провайдер, которым не пользуются, недоступным быть
    // не может. Зрение (qwen-vl) на том же ключе осталось, замены ему с прода
    // нет, и молчать об этом было бы враньём в другую сторону.
    expect(HEALTH).toMatch(/Зрение Кузьмича не работает/);
    expect(HEALTH).not.toMatch(/text: `Qwen недоступен/);
  });
});
