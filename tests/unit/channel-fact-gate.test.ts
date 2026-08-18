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
    // Свойство, а не написание: пустой ответ провайдера обязан быть ОТКАЗОМ,
    // а не «чисто». 18.08 отказ стал называть свою причину (silent /
    // unparseable / bad_shape / threw), и прежняя редакция сторожа покраснела
    // на этом, хотя свойство сохранилось.
    expect(factCheck, 'пустой ответ провайдера снова трактуется как «чисто»')
      .toMatch(/if \(!raw \|\| !raw\.trim\(\)\) return \{ ok: false, why: 'silent' \}/);
    expect(factCheck, 'исключение снова трактуется как «чисто»')
      .toMatch(/return \{ ok: false, why: 'threw' \}/);
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
    expect(scout).toMatch(/if \(claims === null\)/);
    expect(scout).toMatch(/claims === null \|\| claims\.length > 0/);
  });
});
