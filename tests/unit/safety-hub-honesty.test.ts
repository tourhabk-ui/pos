/**
 * Страница безопасности не показывает выдуманную обстановку и не сорит разметкой.
 *
 * Владелец прислал два скриншота 28 июля:
 *  1. Вкладка «Лавины»: «Лавинная опасность — Камчатка, 3/5, Значительная» и
 *     подпись «Март — апрель: пик лавинной активности». Конец июля. Уровень был
 *     жёстко зашит в разметку (DANGER_LEVEL[3]) и показывался круглый год, а
 *     заодно подсвечивался в шкале как «текущий». Выдуманный балл опасности на
 *     странице безопасности хуже отсутствия балла: по нему принимают решение
 *     идти или не идти.
 *  2. Вкладка «AI Спасатель»: «**Алло, это AI Спасатель Камчатки!**» со
 *     звёздочками и красными кружками эмодзи. Пузырь рендерит текст как есть,
 *     модель отвечала в markdown, а эмодзи в UI платформы запрещены.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isAvalancheSeason } from '@/app/hub/safety/_SafetyHubClient';
import { plainResponse, stripEmoji, stripMarkdownEmphasis } from '@/lib/text/plain-response';

const SRC = readFileSync(join(process.cwd(), 'app/hub/safety/_SafetyHubClient.tsx'), 'utf-8');

/**
 * Только то, что видит пользователь: строки комментариев отброшены. Иначе
 * проверка «этой подписи на экране нет» падает на комментарии, который эту же
 * подпись цитирует, объясняя, почему её убрали.
 */
const VISIBLE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('лавинная обстановка', () => {
  it('сезон считается от даты, а не написан в тексте', () => {
    expect(isAvalancheSeason(new Date('2026-01-15'))).toBe(true);
    expect(isAvalancheSeason(new Date('2026-04-10'))).toBe(true);
    expect(isAvalancheSeason(new Date('2026-05-31'))).toBe(true);
    expect(isAvalancheSeason(new Date('2026-11-02'))).toBe(true);
    // Скриншот владельца — 28 июля.
    expect(isAvalancheSeason(new Date('2026-07-28'))).toBe(false);
    expect(isAvalancheSeason(new Date('2026-08-20'))).toBe(false);
  });

  it('зашитого балла опасности на странице больше нет', () => {
    expect(SRC).not.toContain('DANGER_LEVEL[3].bg');
    expect(SRC).not.toContain('DANGER_LEVEL[3].color');
    expect(VISIBLE).not.toContain('— текущий уровень');
  });

  it('подпись про март-апрель не висит круглый год', () => {
    expect(VISIBLE).not.toContain('Март — апрель: пик лавинной активности');
  });

  it('честно сказано, что оперативного прогноза платформа не даёт', () => {
    expect(SRC).toContain('Оперативного прогноза по баллам платформа не даёт');
    expect(SRC).toContain('avalanche.ru');
  });

  it('у районов больше нет выдуманных числовых уровней', () => {
    // risk: 3 / risk: 4 были константами и читались как оценка на сегодня.
    expect(SRC).not.toMatch(/name: '[^']+', risk: \d/);
    expect(SRC).toContain('Лавиноопасные районы');
  });
});

describe('ответ Спасателя — чистый текст', () => {
  it('звёздочки markdown убираются, текст остаётся', () => {
    expect(plainResponse('**Алло, это AI Спасатель Камчатки!**')).toBe('Алло, это AI Спасатель Камчатки!');
    expect(stripMarkdownEmphasis('__важно__ и _курсив_')).toBe('важно и курсив');
  });

  it('эмодзи не доезжают до аварийного экрана', () => {
    const out = plainResponse('🔴 **Что болит? Где рана?** 🔴');
    expect(out).toBe('Что болит? Где рана?');
    expect(stripEmoji('ожог 🔥 рядом')).toBe('ожог рядом');
  });

  it('нумерация шагов не ломается — порядок действий значим', () => {
    const src = '1. **Тип травмы** (ушиб)\n2. **Локализация** (рука)';
    expect(plainResponse(src)).toBe('1. Тип травмы (ушиб)\n2. Локализация (рука)');
  });

  it('маркер списка превращается в тире, а не пропадает', () => {
    expect(plainResponse('* согреть\n* не поить алкоголем')).toBe('— согреть\n— не поить алкоголем');
  });

  it('обычный текст не портится', () => {
    const plain = 'Звоните 112. Координаты назовите оператору.';
    expect(plainResponse(plain)).toBe(plain);
  });

  it('чистка применяется к ответу ассистента в пузыре', () => {
    expect(SRC).toContain("msg.role === 'assistant' ? plainResponse(msg.content) : msg.content");
  });
});
