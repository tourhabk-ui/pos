/**
 * Авто-выбор сильнейшего флагмана (Claude/GPT) БЕЗ привязки к id.
 * Критично: эвристика не должна откатывать мозг на модель СЛАБЕЕ пина —
 * поэтому проверяем разбор версий Claude (opus-5 > opus-4-5) и лестницу тиров.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pickBestFlagship, flagshipVersion } from '@/lib/ai/model-resolver';

describe('flagshipVersion — разбор версии Claude/GPT', () => {
  it('opus-5 = 5.0, opus-4-5 = 4.5 (не путать major-minor)', () => {
    expect(flagshipVersion('claude-opus-5')).toBe(5);
    expect(flagshipVersion('claude-opus-4-5')).toBe(4.5);
    expect(flagshipVersion('claude-sonnet-4-5')).toBe(4.5);
  });

  it('дата-снапшот в хвосте игнорируется', () => {
    expect(flagshipVersion('claude-opus-5-20260701')).toBe(5);
    expect(flagshipVersion('claude-opus-4-1-20250805')).toBe(4.1);
  });

  it('gpt-5 = 5.0', () => {
    expect(flagshipVersion('gpt-5')).toBe(5);
  });
});

describe('pickBestFlagship', () => {
  it('opus сильнее sonnet сильнее haiku', () => {
    const ids = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-5'];
    expect(pickBestFlagship(ids)).toBe('claude-opus-4-5');
  });

  it('при равном тире берёт старшую версию: opus-5 > opus-4-5', () => {
    expect(pickBestFlagship(['claude-opus-4-5', 'claude-opus-5'])).toBe('claude-opus-5');
    expect(pickBestFlagship(['claude-opus-4-5-20250929', 'claude-opus-5-20260701']))
      .toBe('claude-opus-5-20260701');
  });

  it('не откатывается на haiku/mini, когда есть opus', () => {
    const ids = ['claude-haiku-5', 'claude-opus-4-1', 'gpt-5-mini'];
    expect(pickBestFlagship(ids)).toBe('claude-opus-4-1');
  });

  it('фильтр семейства (каталог OpenRouter) — только anthropic/', () => {
    const ids = ['openai/gpt-5', 'anthropic/claude-opus-5', 'google/gemini-2-pro'];
    expect(pickBestFlagship(ids, 'anthropic/')).toBe('anthropic/claude-opus-5');
  });

  it('отсекает служебные (embed/vision/tts) и пустой список → null', () => {
    expect(pickBestFlagship(['claude-opus-5-vision', 'text-embedding-3'])).toBeNull();
    expect(pickBestFlagship([])).toBeNull();
  });

  it('детерминизм: при равенстве — лексикографически меньший', () => {
    const ids = ['claude-opus-5-b', 'claude-opus-5-a'];
    expect(pickBestFlagship(ids)).toBe('claude-opus-5-a');
  });
});

describe('структурно: флагман не прибит к id, идёт через резолвер', () => {
  const providers = readFileSync('lib/ai/providers.ts', 'utf8');

  it('решатель зовёт resolveFlagshipModel, а не хардкод-константу', () => {
    expect(providers).toMatch(/resolveFlagshipModel/);
    // в теле решателя используется резолвнутая модель, не старая константа
    expect(providers).not.toMatch(/EVO_FLAGSHIP_MODEL\b/);
  });

  it('пин остался только крайним фоллбэком', () => {
    expect(providers).toMatch(/EVO_FLAGSHIP_FALLBACK/);
    expect(providers).toMatch(/pickBestFlagship\(ids\)/);
  });

  it('админ-страница evo/models: pinned зависит от override, не хардкод true', () => {
    const route = readFileSync('app/api/admin/evo/models/route.ts', 'utf8');
    expect(route).toMatch(/pinned:\s*!!flagshipOverride/);
    expect(route).toMatch(/pickBestFlagship\(flagshipIds\)/);
  });
});

/**
 * Флагман выбирается среди ВСЕХ доступных, а не только Anthropic.
 *
 * До 19.08 `resolveFlagshipModel` спрашивал список моделей у Anthropic и
 * приклеивал префикс `anthropic/`. Комментарий над функцией обещал
 * «Claude/GPT», но модель другого поставщика не могла быть выбрана ПО
 * ПОСТРОЕНИЮ — ни за какую цену и ни при какой силе. Оценщик
 * `pickBestFlagship` при этом всегда был провайдеро-независим: он просто
 * никогда не видел чужих моделей.
 *
 * Заметно это стало, когда пришло письмо о скидке на модель OpenAI: подключать
 * её было бы некуда. Правильный ответ не в том, чтобы прибить нужный id
 * (§8 это прямо запрещает), а в том, чтобы каталог для выбора был полным.
 */
describe('каталог для выбора флагмана полон', () => {
  const SRC = readFileSync('lib/ai/providers.ts', 'utf-8');

  it('резолвер спрашивает каталог OpenRouter — там все поставщики', () => {
    const fn = SRC.slice(SRC.indexOf('export async function resolveFlagshipModel'));
    expect(fn.slice(0, 1400)).toMatch(/getOpenRouterModelIds\(\)/);
  });

  it('Anthropic остаётся запасным путём, а не единственным', () => {
    const fn = SRC.slice(SRC.indexOf('export async function resolveFlagshipModel'));
    const body = fn.slice(0, 1600);
    expect(body).toMatch(/getAnthropicModelIds\(\)/);
    // Порядок важен: путь вызова флагмана — OpenRouter, и выбирать надо из
    // того, что по этому пути достижимо.
    expect(body.indexOf('getOpenRouterModelIds')).toBeLessThan(body.indexOf('getAnthropicModelIds'));
  });

  it('второй префикс поставщика не приклеивается', () => {
    // Каталог OpenRouter уже несёт `openai/…`, `anthropic/…`. Ещё один
    // префикс дал бы `anthropic/openai/gpt-…` — модель, которой нет.
    const fn = SRC.slice(SRC.indexOf('export async function resolveFlagshipModel'));
    const routedBlock = fn.slice(0, fn.indexOf('getAnthropicModelIds'));
    expect(routedBlock).not.toMatch(/`anthropic\/\$\{pickedRouted\}`/);
  });

  it('внутри поставщика выбирается сильнейший — и это измеримо', () => {
    const catalog = [
      'anthropic/claude-opus-4-5', 'anthropic/claude-opus-5', 'anthropic/claude-haiku-4-5',
      'openai/gpt-5', 'openai/gpt-6', 'openai/gpt-6-mini',
    ];
    expect(pickBestFlagship(catalog, 'anthropic/')).toBe('anthropic/claude-opus-5');
    expect(pickBestFlagship(catalog, 'openai/')).toBe('openai/gpt-6');
  });

  it('МЕЖДУ поставщиками оценщик не судит — и это не недоделка', () => {
    // Лестница тиров калибрована под имена Anthropic: слово opus даёт высокий
    // тир, а простой gpt-N попадает в нейтральный и проигрывает даже более
    // старой версии. Починить «поровну» невозможно: сила модели ПО ИМЕНИ не
    // выводится, а `gpt-6` против `claude-5` — числа разных вендоров.
    //
    // Тест закрепляет ГРАНИЦУ: смешанный каталог без указания поставщика даёт
    // результат, на который полагаться нельзя. Поэтому резолвер всегда задаёт
    // семейство, а выбор поставщика — решение владельца.
    const mixed = ['anthropic/claude-opus-4-5', 'openai/gpt-6'];
    expect(pickBestFlagship(mixed)).toBe('anthropic/claude-opus-4-5');
  });

  it('поставщик задаётся переменной, а не правкой кода', () => {
    expect(SRC).toMatch(/EVO_DECISION_FLAGSHIP_VENDOR/);
    // По умолчанию — тот, на котором платформа работала до сих пор.
    expect(SRC).toMatch(/EVO_DECISION_FLAGSHIP_VENDOR \|\| 'anthropic'/);
  });

  it('прямая ступень Anthropic берёт имя из каталога Anthropic', () => {
    // Разные каталоги — разные имена; общего у них только поставщик.
    // resolveFlagshipModel при живом ключе OpenRouter выбирает id из ЕГО
    // каталога (слаги вида `anthropic/claude-opus-4.6`). Снятие префикса даёт
    // `claude-opus-4.6`, а api.anthropic.com знает `claude-opus-4-8`: запрос
    // отвечает 400 за доли секунды, и отчёт читается как «Anthropic молчит»
    // при живом ключе с оплаченным Opus.
    const leg = SRC.slice(SRC.indexOf('const antKey = getAnthropicKey()'), SRC.indexOf('// 1) DeepSeek'));
    expect(leg).toMatch(/getAnthropicModelIds\(\)/);
    expect(leg).toMatch(/pickBestFlagship\(antIds\)/);
    // Снятие префикса остаётся ТОЛЬКО как запасной путь на случай пустого
    // каталога — и о том, что он пуст, сказано вслух.
    expect(leg).toMatch(/каталог моделей пуст/);
  });

  it('имя модели названо в причине отказа', () => {
    // Без него «anthropic: HTTP 400» неотличимо от отказа по ключу — именно
    // на этом разбор находок простоял четверо суток (16-19.08).
    const leg = SRC.slice(SRC.indexOf('const antKey = getAnthropicKey()'), SRC.indexOf('// 1) DeepSeek'));
    expect(leg).toMatch(/anthropic\(\$\{antModel\}\): HTTP/);
    expect(leg).toMatch(/anthropic\(\$\{antModel\}\): пустой ответ/);
  });

  it('привязки к конкретному id нет', () => {
    // §8: подбор идёт оценкой, а не перечнем. Скидка на конкретную модель —
    // повод проверить каталог, а не прибить id в коде.
    const fn = SRC.slice(SRC.indexOf('export async function resolveFlagshipModel'), SRC.indexOf('export async function resolveFlagshipModel') + 1600);
    expect(fn).not.toMatch(/gpt-5\.6|gpt-5-6|provider.*only/i);
  });
});
