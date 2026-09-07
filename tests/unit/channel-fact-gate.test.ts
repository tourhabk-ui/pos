/**
 * Фактчек — на ВСЕХ публикаторах новостных каналов, а не только на дайджесте.
 *
 * Инцидент 31.07: в публичный AI-канал ушёл пост intelligence-monitor с
 * перенесёнными числами («По данным Yandex YDB — ускоряет в 3 раза»,
 * «llama.cpp: прирост качества до 300%») и упоминанием TourHab. Гейты
 * unsourcedPercents/unsupportedClaims, построенные после инцидента 25.07,
 * жили только в scout-digest — конвейер intelligence-monitor →
 * postAINewsToChannel/postTravelNewsToChannel публиковал без проверки,
 * по 150-200-символьным огрызкам сниппетов, с внутренними action_items
 * («что сделать TourHab») в промпте публичного поста.
 *
 * Сторож держит: общий модуль, детерминированный гейт ловит кратности,
 * оба публикатора зовут гейт, внутренности не утекают в публичные посты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unsourcedPercents } from '@/lib/agents/fact-check';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/**
 * Промпт судьи — где бы он ни лежал.
 *
 * 18.08 он переехал из инлайна в константу `JUDGE_SYSTEM`: его читают два
 * места (сам судья и обёртка), а копия промпта — это два разных фактчека.
 * Сторож ищет ПРИНЦИПЫ в тексте промпта, и адрес текста его волновать не
 * должен: прежняя редакция цеплялась за `{ role: 'system', content: '...' }`
 * и покраснела на переносе, хотя ни один принцип не пострадал.
 */
function judgeSystemPrompt(src: string): string {
  const asConst = /JUDGE_SYSTEM\s*=\s*'([^']+)'/.exec(src)?.[1];
  if (asConst) return asConst;
  return /system',\s*content:\s*'([^']+)'/.exec(src)?.[1] ?? '';
}

describe('unsourcedPercents ловит и кратности, не только проценты', () => {
  it('«в 3 раза» без тройки в источнике — выдумка (кейс инцидента)', () => {
    expect(unsourcedPercents('YDB ускоряет обработку запросов в 3 раза', 'статья про кэширование запросов'))
      .toEqual(['в 3 раза']);
  });

  it('«300%» без числа в источнике — выдумка (кейс инцидента)', () => {
    expect(unsourcedPercents('прирост качества до 300%', 'speculative decoding ускоряет инференс'))
      .toEqual(['300%']);
  });

  it('число из источника — проходит (floor, а не семантика)', () => {
    expect(unsourcedPercents('ускорение в 3 раза', 'бенчмарк показал ускорение в 3 раза')).toEqual([]);
    expect(unsourcedPercents('на 40%', 'рост на 40 процентов... 40')).toEqual([]);
  });

  it('старый контракт дайджеста не сломан: пост без чисел чист', () => {
    expect(unsourcedPercents('Вышла новая модель, поддерживает инструменты', 'anything')).toEqual([]);
  });
});

describe('оба публикатора intelligence-monitor проходят гейт', () => {
  const src = code(read('lib/notifications/telegram-channel.ts'));

  it('postAINewsToChannel: гейт стоит перед публикацией', () => {
    const fn = src.slice(src.indexOf('function postAINewsToChannel'), src.indexOf('function postTravelNewsToChannel'));
    expect(fn, 'AI-канал снова публикует без фактчека')
      .toContain('factGatedText(postText, signalCtx, postPrompt)');
    expect(fn).toContain('Публикация отменена: факты поста не подтверждаются источниками');
  });

  it('postTravelNewsToChannel: гейт стоит перед публикацией', () => {
    const fn = src.slice(src.indexOf('function postTravelNewsToChannel'), src.indexOf('function parseRssItems'));
    expect(fn, 'travel-канал снова публикует без фактчека')
      .toContain('factGatedText(postText, signalCtx, postPrompt)');
  });

  it('гейт не прошёл — публикации нет (не фолбэк, а отмена)', () => {
    expect(src).toMatch(/if \(!gated\) \{/);
  });

  it('внутренние action_items не подаются в публичные посты', () => {
    const publicPart = src.slice(src.indexOf('function postAINewsToChannel'), src.indexOf('function parseRssItems'));
    expect(publicPart, 'внутренние рекомендации платформе снова утекают в публичный канал')
      .not.toMatch(/action_items\.join/);
    expect(publicPart).not.toMatch(/action_items\.map/);
  });

  it('сниппеты подаются целиком, а не 150-200-символьными огрызками', () => {
    const publicPart = src.slice(src.indexOf('function postAINewsToChannel'), src.indexOf('function parseRssItems'));
    expect(publicPart).not.toMatch(/snippet\.slice\(0, (?:150|200)\)/);
  });
});

describe('модуль общий, дайджест не отвязался', () => {
  it('scout-digest использует те же гейты из fact-check', () => {
    const src = code(read('lib/agents/scout-digest.ts'));
    expect(src).toMatch(/from '@\/lib\/agents\/fact-check'/);
    // Своих копий функций больше нет — одна реализация на всех.
    expect(src).not.toMatch(/function unsourcedPercents/);
    expect(src).not.toMatch(/function unsupportedClaims/);
  });
});

describe('склейка несвязанных источников — инцидент 01.08', () => {
  // Пост «Персистентная память для ИИ»: два несвязанных материала Habr
  // (агент Ouroboros и индексация Яндекса) были сшиты связками «Пример?»
  // и «А вот» в один сюжет, описание эксперимента подано как «доказал»,
  // а листикл «что это значит для бизнеса» требовал сам промпт публикатора.
  const factCheck = readFileSync(join(process.cwd(), 'lib/agents/fact-check.ts'), 'utf-8');
  const channel = readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf-8');

  it('судья проверяет СВЯЗКИ между источниками, а не только отдельные факты', () => {
    // Принцип в системном промпте судьи (не список кейсов): связь двух
    // фактов — тоже проверяемое утверждение.
    const sys = judgeSystemPrompt(code(factCheck));
    expect(sys, 'из промпта судьи пропал принцип проверки связок — склейка сюжетов вернётся')
      .toMatch(/СВЯЗ/);
    expect(sys).toMatch(/один сюжет|общий вывод/);
  });

  it('промпты публикаторов не требуют выдумывать «практический вывод»', () => {
    // Требование «что это значит для бизнеса» / «как влияет на туры» само
    // приглашало модель фантазировать выводы, которых нет в источниках.
    expect(channel, 'в промпт вернулось требование практического вывода — приглашение к выдумке')
      .not.toMatch(/Практический вывод/);
    // Вместо него — явное разрешение закончить фактами.
    expect(channel).toMatch(/пост\s+заканчивается\s+фактами/);
  });
});

describe('числовой гейт ловит цены, не только проценты (дайджест 01.08)', () => {
  it('цена в долларах, которой нет в источнике, — выдумка', () => {
    // Реальный кейс: пост «$0.27 за выход», источник — «$0.28».
    expect(unsourcedPercents('Цена: $0.14 вход и $0.27 выход', 'DeepSeek: $0.14 input, $0.28 output'))
      .toContain('$0.27');
  });

  it('цена, совпадающая с источником, проходит', () => {
    expect(unsourcedPercents('$0.14 за миллион токенов входа', 'input $0.14 per 1M tokens'))
      .toEqual([]);
  });

  it('рубли с разделителем тысяч ловятся', () => {
    // «от 68 000 ₽», которого нет в источнике.
    const bad = unsourcedPercents('Тур от 68 000 ₽', 'оператор указал цену 72 000 ₽');
    expect(bad.some((c) => c.includes('68'))).toBe(true);
  });

  it('валюта из источника не помечается', () => {
    expect(unsourcedPercents('стоит 990 руб', 'цена 990 руб за вход')).toEqual([]);
  });
})

describe('сбой судьи = отмена публикации, не пропуск (инцидент GPT-Realtime 01.08)', () => {
  const factCheck = readFileSync(join(process.cwd(), 'lib/agents/fact-check.ts'), 'utf-8');
  const channel = readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf-8');
  const scout = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');

  it('unsupportedClaims различает «чисто» ([]) и «судья не ответил» (null)', () => {
    // Раньше сбой возвращал [] — неотличимо от «подтверждено», и гейт
    // становился сквозным ровно когда переставал работать.
    expect(factCheck).toMatch(/Promise<string\[\] \| null>/);
    // Свойство, а не написание. 18.08 отказ стал называть причину, 22.08
    // добавилась ещё одна (unavailable) — и обе правки роняли сторожа,
    // пришпиленный к точной строке, при сохранном свойстве. Проверяем само
    // свойство: НИ ОДИН отказ провайдера не заканчивается успехом судьи.
    const refusals = [...factCheck.matchAll(/return \{ ok: false, why: '(\w+)'/g)].map(m => m[1]);
    // Пустота, отсутствие ответа и исключение — обязаны быть среди отказов.
    expect(refusals, 'пустой ответ провайдера снова трактуется как «чисто»').toContain('silent');
    expect(refusals, 'отказ всех провайдеров снова трактуется как «чисто»').toContain('unavailable');
    expect(refusals, 'исключение снова трактуется как «чисто»').toContain('threw');
    // Ни одна ветка проверки сырого ответа не возвращает ok: true.
    expect(factCheck, 'пустой ответ снова считается чистым')
      .not.toMatch(/!raw[^\n]*return \{ ok: true/);
    expect(factCheck, 'отсутствие ответа снова считается чистым')
      .not.toMatch(/raw === null[^\n]*return \{ ok: true/);
    // Обёртка сохраняет прежний контракт для тех, кому причина не нужна.
    expect(factCheck).toMatch(/return r\.ok \? r\.unsupported : null/);
  });

  it('судья проверяет экономическое/практическое следствие как факт', () => {
    const sys = judgeSystemPrompt(factCheck);
    expect(sys, 'принцип «следствие вне источника — факт» пропал').toMatch(/СЛЕДСТВИЕ/);
    expect(sys).toMatch(/без затрат на персонал|заменяет сотрудников/);
  });

  it('telegram-публикатор отменяет пост при null от судьи', () => {
    expect(channel, 'сбой судьи снова пропускает пост')
      .toMatch(/if \(claims === null\) return null/);
    expect(channel).toMatch(/if \(claims === null \|\| claims\.length > 0\) return null/);
  });

  it('scout-дайджест не публикует при null от судьи', () => {
    // Инвариант прежний — отказ судьи отменяет публикацию, — но с 29.08 он
    // выражен ИМЕНЕМ исхода, а не проверкой на null: judgeClaims возвращает
    // {ok:false, why}, и ветка отказа отдаёт точную причину вместо общего
    // «судья не ответил». Проверяем обе точки: канал и основной дайджест.
    expect(scout, 'отказ судьи в AI-канале больше не отменяет публикацию')
      .toMatch(/if \(!firstVerdict\.ok\)[\s\S]{0,120}aiDigest = null/);
    expect(scout, 'отказ повторной сверки в канале не отменяет публикацию')
      .toMatch(/if \(!recheck\.ok\)[\s\S]{0,80}aiDigest = null/);
    // Основной дайджест: непроверенность (null) — выход без отправки; остаток
    // выдумок с 02.09 вычёркивается по строкам (stripUnsupported), и выход
    // остаётся для «фразу не нашли» и «выпуск опустел» — сторож scout-strip-claims.
    expect(scout).toMatch(/if \(claims === null\) \{[\s\S]{0,400}factcheck_judge_mute/);
    expect(scout).toMatch(/stripUnsupported\(digest, claims\)/);
  });
});

/**
 * Судья фактгейта после прогона 22.08 (владелец: «разведчика почини»).
 *
 * Прогон дошёл ДО судьи: 52 сигнала, синтез состоялся, все 10 источников
 * живы — и встал на `judge_unparseable`. Значит провайдеры работали, а
 * версия «молчит провайдер» этим прогоном опровергнута. Осталось два
 * механизма, дающих «JSON не нашёлся» от работающей модели: преамбула
 * вокруг ответа и обрыв по потолку токенов. Оба закрыты здесь.
 */
describe('судья просит формат, а не уговаривает', () => {
  const factCheck = readFileSync(join(process.cwd(), 'lib/agents/fact-check.ts'), 'utf-8');
  const providers = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

  it('формат просится у провайдера, а не только словами в промпте', () => {
    expect(factCheck).toMatch(/json:\s*true/);
    expect(providers).toMatch(/response_format:\s*\{\s*type:\s*'json_object'\s*\}/);
  });

  it('у судьи свой потолок ответа, больше умолчания ветки', () => {
    const cap = /JUDGE_MAX_TOKENS\s*=\s*(\d+)/.exec(factCheck);
    expect(cap).not.toBeNull();
    // Умолчания ног быстрой ветки — 600-800. Судья цитирует утверждения,
    // ему нужно заметно больше, иначе ответ обрывается на середине.
    expect(Number(cap![1])).toBeGreaterThan(800);
    expect(factCheck).toMatch(/maxTokens: JUDGE_MAX_TOKENS/);
  });

  it('судья ждёт столько же, сколько качественный путь', () => {
    // ПЕРЕПИСАНО 23.08 вместе с переездом судьи.
    //
    // Правило родилось 22.08 из наблюдения: синтез на ТЕХ ЖЕ провайдерах
    // проходил (45 с), а судья на том же прогоне возвращал «не ответил никто»
    // (20 с) — вся разница была в пределе ожидания. Тогда предел подняли
    // константой JUDGE_TIMEOUT_MS и протащили её до ног быстрой ветки.
    //
    // Теперь судья ходит качественным путём, у которого свои 45 секунд — ровно
    // та же величина. Константа стала бы числом, которое ничем не управляет, и
    // её убрали. Правило при этом ЖИВО и проверяется по существу: предел
    // ожидания судьи равен пределу синтеза, потому что путь у них один.
    //
    // Сторож нарочно смотрит на ветку, а не на имя константы: пришпиленный к
    // написанию, он трижды краснел при сохранном правиле.
    // Судим КОД, а не прозу: в шапке fact-check.ts нарочно рассказана история
    // быстрой ветки, и сторож, читающий комментарии, краснел бы на памяти.
    const code = factCheck.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code, 'судья снова на быстрой ветке с её 20 секундами')
      .not.toMatch(/callAIFast/);
    expect(code, 'судья ушёл с качественного пути').toMatch(/callAIQualityOrNull\(/);
    // 04.09: предел вырос с 45 до 90 секунд вместе с включённым размышлением
    // DeepSeek на этом пути (замечание владельца о поверхностных ответах).
    // Сторож снова НЕ приколот к числу — он и написан против этого: важно, что
    // предел судьи один и тот же с синтезом и что он не меньше прежних 45 с.
    const qualityTimeout = /timeoutMs: (\d+)_000, label: 'deepseek:content'/.exec(providers);
    expect(qualityTimeout, 'у качественного пути пропал предел ожидания').not.toBeNull();
    expect(Number(qualityTimeout![1]), 'предел качественного пути стал меньше прежних 45 с')
      .toBeGreaterThanOrEqual(45);
  });

  it('обрыв назван обрывом, а не прозой', () => {
    // Разные беды — разный ремонт: потолок токенов против промпта.
    expect(factCheck).toMatch(/why: JudgeFailure = raw\.includes\('\{'\) \? 'truncated' : 'unparseable'/);
  });

  it('разбор берёт сбалансированный объект, а не «от первой до последней»', () => {
    // Жадная /\{[\s\S]*\}/ склеивала два объекта в заведомо битую строку.
    expect(factCheck).toMatch(/extractJsonObject/);
    expect(factCheck).not.toMatch(/raw\.match\(\/\\\{\[\\s\\S\]\*\\\}\/\)/);
  });

  it('улика доезжает до человека, а не гибнет в функции', () => {
    const digest = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
    // С 04.09 журнал пишет общий модуль (крон-роут, оркестратор, админка).
    const route = readFileSync(join(process.cwd(), 'lib/agents/scout-digest-run.ts'), 'utf-8');
    // Код называет класс беды, строка ответа — саму беду. Без неё чинят наугад.
    expect(digest).toMatch(/digest_skip_detail/);
    expect(digest).toMatch(/verdict\.sample/);
    expect(route).toMatch(/digest_skip_detail: result\.digest_skip_detail/);
  });

  it('повтор идёт на бедах разбора, но не на молчании провайдера', () => {
    // Молчащего вторым запросом не оживить, а гейт публикации не место
    // для долбёжки.
    expect(factCheck).toMatch(/fixableByAsking/);
    expect(factCheck).toMatch(/\['unparseable', 'truncated', 'bad_shape'\]/);
  });
});
