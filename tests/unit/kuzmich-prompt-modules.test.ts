/**
 * Промпт Кузьмича — ядро и части по ситуации (#3399, п. 5; разбор промпта
 * 15.11, слово владельца «го»).
 *
 * Ядро (роль, безопасность, отказ выдумывать, формат) стоит в каждом ходе и
 * кешируется. Части «заявка», «программа на несколько дней» и «смежные
 * активности» добавляются по вопросу хода существующими детекторами, ниже
 * маркера кеша. Правила ядра — без угроз «нарушение = сбой системы» и
 * «НИКОГДА»: правило и одна фраза причины.
 */
import { describe, it, expect } from 'vitest';
import {
  KUZMICH_SYSTEM, KUZMICH_MODULE_REQUEST, KUZMICH_MODULE_MULTIDAY, KUZMICH_MODULE_ADJACENT,
  kuzmichModulesFor, kuzmichSystemContent,
} from '@/lib/kuzmich/core';
import { analyzePrompt } from '@/lib/agents/eval/prompt-bloat';
import { groupSystemContent } from '@/lib/kuzmich/group-prompt';

describe('какие части нужны ходу', () => {
  it('разговор о заявке — часть «заявка»', () => {
    for (const q of ['Хочу записаться на Мутновский', 'почему заявка не создаётся?', 'как забронировать тур', 'оформи']) {
      expect(kuzmichModulesFor(q, { placeFound: false }), q).toContain(KUZMICH_MODULE_REQUEST);
    }
  });

  it('поездка на несколько дней — часть «программа»', () => {
    for (const q of ['Что посмотреть за 5 дней в июле?', 'составь план поездки', 'у нас несколько дней на Камчатке']) {
      expect(kuzmichModulesFor(q, { placeFound: false }), q).toContain(KUZMICH_MODULE_MULTIDAY);
    }
  });

  it('место нашлось — часть «смежные активности»; в беде — только ядро', () => {
    expect(kuzmichModulesFor('Расскажи про Халактырский пляж', { placeFound: true })).toContain(KUZMICH_MODULE_ADJACENT);
    expect(kuzmichModulesFor('Расскажи про Халактырский пляж', { placeFound: false })).not.toContain(KUZMICH_MODULE_ADJACENT);
    expect(kuzmichModulesFor('Потерялся у Авачинского, нет связи', { placeFound: true })).not.toContain(KUZMICH_MODULE_ADJACENT);
  });

  it('обычный вопрос о погоде — без частей', () => {
    expect(kuzmichModulesFor('Какая погода в Петропавловске?', { placeFound: false })).toBe('');
  });
});

describe('где стоят части', () => {
  it('ниже маркера кеша: ядро и каталог кешируются как прежде', () => {
    const { system } = kuzmichSystemContent({ tourContext: 'КАТАЛОГ', modules: KUZMICH_MODULE_REQUEST, mchsBlock: '', facts: 'ФАКТЫ' });
    const cut = system.indexOf(KUZMICH_MODULE_REQUEST);
    expect(system.startsWith(`${KUZMICH_SYSTEM}\n\nКАТАЛОГ`)).toBe(true);
    expect(cut).toBeGreaterThan(system.indexOf('КАТАЛОГ'));
  });

  it('части — не данные хода: ни судье выдумок (dynamic), ни сверке (guardContext) (ревью #3416)', () => {
    const { system, dynamic, guardContext } = kuzmichSystemContent({ tourContext: 'КАТАЛОГ', modules: KUZMICH_MODULE_ADJACENT, mchsBlock: 'МЧС', facts: 'ФАКТЫ' });
    expect(system).toContain(KUZMICH_MODULE_ADJACENT);
    expect(dynamic).not.toContain('Дачные источники');
    expect(guardContext).not.toContain('Дачные источники');
    expect(dynamic).toContain('ФАКТЫ');
  });
});

describe('ядро', () => {
  it('частей в ядре нет — они приходят по ходу', () => {
    for (const m of [KUZMICH_MODULE_REQUEST, KUZMICH_MODULE_MULTIDAY, KUZMICH_MODULE_ADJACENT]) {
      expect(KUZMICH_SYSTEM).not.toContain(m.slice(0, 40));
    }
  });

  it('правила без угроз: ни «сбой системы», ни «НИКОГДА», ни «ЗАПРЕЩЕНО»', () => {
    expect(KUZMICH_SYSTEM).not.toMatch(/сбой системы|НИКОГДА|ЗАПРЕЩЕНО|Никогда\./);
    expect(analyzePrompt('kuzmich-core', KUZMICH_SYSTEM).prohibitions).toBeLessThanOrEqual(4);
  });

  it('заявку подтверждает оператор — в ядре, а не только в части «заявка»', () => {
    expect(KUZMICH_SYSTEM).toContain('оператор подтверждает');
  });
});

describe('групповой чат Telegram (ревью #3416)', () => {
  it('получает ту же часть «заявка», что и личный чат; без неё правила о сроке ответа оператора у группы не было бы', () => {
    const sys = groupSystemContent('хочу записаться на тур', 'КАТАЛОГ');
    expect(sys.startsWith(KUZMICH_SYSTEM)).toBe(true);
    expect(sys).toContain(KUZMICH_MODULE_REQUEST);
    expect(sys).toContain('КАТАЛОГ');
    expect(groupSystemContent('какая погода', 'КАТАЛОГ')).not.toContain(KUZMICH_MODULE_REQUEST);
  });
});
