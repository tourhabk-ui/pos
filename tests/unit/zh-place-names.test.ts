/**
 * Сторож китайских названий мест в ответе (#3382). Офлайн-тест 14.11: модели
 * писали Курильское озеро «库页湖» — «库页» это Сахалин (库页岛).
 *
 * Держится связка целиком: список названий сходится со словарём запросов
 * (каждое китайское написание переводится обратно в то же русское название),
 * подсказка MCP называет места из ответа, ответ Кузьмича ошибочное написание
 * не пропускает ни до показа, ни после (поправкой хвостом).
 */
import { describe, it, expect, vi } from 'vitest';
import { ZH_PLACE_NAMES, ZH_WRONG_NAMES, zhPlaceNamesIn, zhPlaceNamesNote, fixWrongZhPlaceNames } from '@/lib/zh/place-names';
import { localizeQuery } from '@/lib/mcp/query-lang';

vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn(async () => undefined) }));

describe('список названий — одна правда со словарём запросов', () => {
  it('каждое китайское написание переводится обратно в своё русское название', () => {
    for (const p of ZH_PLACE_NAMES) {
      const back = localizeQuery(p.zh).text;
      // «阿瓦恰火山» → «Авачинский»: начало названия; иначе — слово в слово.
      expect(back === p.ru || p.ru.startsWith(`${back} `), `${p.zh} → ${back}, ждали ${p.ru}`).toBe(true);
    }
  });
  it('ошибочное написание не стоит правильным ни у одного места, а правильное — есть в списке', () => {
    for (const w of ZH_WRONG_NAMES) {
      expect(ZH_PLACE_NAMES.some((p) => p.zh === w.wrong)).toBe(false);
      expect(ZH_PLACE_NAMES.some((p) => p.zh === w.right)).toBe(true);
      expect(w.why.length).toBeGreaterThan(10);
    }
  });
});

describe('названия узнаются в русском тексте с падежами', () => {
  it('Курильское озеро, Мутновский, Петропавловск', () => {
    const found = zhPlaceNamesIn('Вертолёт до Курильского озера, облёт над Мутновским, вылет из Петропавловска-Камчатского.').map((p) => p.zh);
    expect(found).toEqual(['库里尔湖', '彼得罗巴甫洛夫斯克', '穆特诺夫斯基']);
  });
  it('Авачинский перевал — не вулкан; Авачинская бухта — бухта', () => {
    expect(zhPlaceNamesIn('Тур на Авачинский перевал').map((p) => p.zh)).toEqual([]);
    expect(zhPlaceNamesIn('Прогулка по Авачинской бухте').map((p) => p.zh)).toEqual(['阿瓦恰湾']);
    expect(zhPlaceNamesIn('Восхождение на Авачинский вулкан').map((p) => p.zh)).toEqual(['阿瓦恰火山']);
  });
  it('прилагательное «горелый» со строчной — не вулкан', () => {
    expect(zhPlaceNamesIn('пахнет горелым')).toEqual([]);
    expect(zhPlaceNamesIn('кратер Горелого').map((p) => p.zh)).toEqual(['戈列雷']);
  });
});

describe('подсказка клиенту MCP', () => {
  it('называет места ответа и предупреждает об ошибочном написании', () => {
    const note = zhPlaceNamesNote('Курильское озеро — тур «Местечко Камчатка».');
    expect(note).toContain('Курильское озеро = 库里尔湖 (not 库页湖)');
  });
  it('мест из списка нет — пусто', () => {
    expect(zhPlaceNamesNote('Туры не найдены.')).toBe('');
  });
});

describe('ответ Кузьмича', () => {
  it('замена только ошибочного написания', () => {
    expect(fixWrongZhPlaceNames('前往库页湖观熊').text).toBe('前往库里尔湖观熊');
    expect(fixWrongZhPlaceNames('前往库里尔湖观熊').fixed).toEqual([]);
    expect(fixWrongZhPlaceNames('库页岛').text).toBe('库页岛');
  });

  it('до показа — исправлено в тексте; уже показано — поправка хвостом', async () => {
    const { finishKuzmichAnswer, correctShownAnswer } = await import('@/lib/kuzmich/answer-guards');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const done = finishKuzmichAnswer({ surface: 'widget', answer: '可以乘直升机前往库页湖观熊。', question: '库里尔湖怎么去？', toolRuns: [], context: '', lang: 'zh' });
    expect(done.text).toContain('库里尔湖观熊');
    expect(done.text).not.toContain('库页湖');
    const shown = correctShownAnswer({ surface: 'web-stream', answer: '可以乘直升机前往库页湖观熊。', question: '库里尔湖怎么去？', toolRuns: [], context: '' });
    expect(shown.tail).toContain('“库页湖”应为“库里尔湖”');
    expect(err).toHaveBeenCalledWith('[kuzmich-zh-place-names] ошибочное китайское название места', expect.objectContaining({ surface: 'widget' }));
    err.mockRestore();
  });
});

describe('llms-zh.txt', () => {
  it('раздел с китайскими названиями мест и ошибочным написанием', async () => {
    const { llmsZhFile } = await import('@/lib/mcp/zh-layer');
    const file = llmsZhFile('https://vedarai.ru', false);
    expect(file).toContain('## 地名的中文写法');
    expect(file).toContain('- 库里尔湖（Курильское озеро）');
    expect(file).toContain('不要写“库页湖”，应为“库里尔湖”');
  });
});
