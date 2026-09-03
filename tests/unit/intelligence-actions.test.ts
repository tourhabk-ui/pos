/**
 * Кнопка и роут говорят на одном языке (владелец 23.08).
 *
 * На проде «AI-дайджест» отвечал «Ошибка: Invalid input». Причина: в Zod-схеме
 * роута перечня действий не было `publish_ai_news`, хотя ветка для него
 * написана целиком. Кнопка не работала НИ РАЗУ с момента появления — запрос
 * заворачивался до ветки.
 *
 * Почему это не поймал никто:
 *  - tsc: две проверки выше сужают `body.action` до `never`, а сравнение
 *    `never` с литералом язык разрешает. Мёртвая ветка компилируется молча;
 *  - тесты: контракт между кнопкой и роутом не проверялся ничем;
 *  - человек: наружу шло Zod-овское «Invalid input» — ни поля, ни значения.
 *
 * Правило: перечень действий, ветки роута и вызовы клиента — одно множество.
 * Расхождение любой пары красит сборку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_ACTIONS } from '@/app/api/admin/intelligence-sources/test/route';

const ROUTE = readFileSync(
  join(process.cwd(), 'app/api/admin/intelligence-sources/test/route.ts'), 'utf-8');
const CLIENT = readFileSync(
  join(process.cwd(), 'app/hub/admin/brain/_IntelligenceClient.tsx'), 'utf-8');

/**
 * Действия, которые клиент шлёт ИМЕННО В ЭТОТ роут.
 *
 * Отбор по адресу, а не по всему файлу: на той же странице есть кнопки к
 * другому роуту (`intelligence-feed/[id]/action` — toggle_done/archive), и
 * мешать два контракта в один значит сделать сторожа бессмысленным.
 */
function actionsSentByClient(src: string): string[] {
  const out: string[] = [];
  const re = /fetch\(\s*'\/api\/admin\/intelligence-sources\/test'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const near = src.slice(m.index, m.index + 400);
    const a = /action:\s*'([a-z_]+)'/.exec(near);
    if (a) out.push(a[1]);
  }
  return out;
}

/** Действия, которые роут реально обрабатывает: body.action === '...'. */
function actionsHandledByRoute(src: string): string[] {
  return [...src.matchAll(/body\.action === '([a-z_]+)'/g)].map(m => m[1]);
}

describe('перечень действий, ветки роута и кнопки — одно множество', () => {
  it('каждое действие из перечня имеет ветку в роуте', () => {
    const handled = new Set(actionsHandledByRoute(ROUTE));
    for (const a of TEST_ACTIONS) {
      expect(handled.has(a), `действие '${a}' принимается, но не обрабатывается`).toBe(true);
    }
  });

  it('каждая ветка роута объявлена в перечне', () => {
    // Ровно этот случай и был: ветка publish_ai_news существовала, а в перечне
    // её не было — Zod заворачивал запрос до неё.
    for (const a of actionsHandledByRoute(ROUTE)) {
      expect((TEST_ACTIONS as readonly string[]).includes(a),
        `ветка '${a}' написана, но роут её не принимает — мёртвый код`).toBe(true);
    }
  });

  it('каждое действие, которое шлёт кнопка, роут принимает', () => {
    const sent = actionsSentByClient(CLIENT);
    expect(sent.length).toBeGreaterThan(0);
    for (const a of sent) {
      expect((TEST_ACTIONS as readonly string[]).includes(a),
        `кнопка шлёт '${a}', роут такого не принимает`).toBe(true);
    }
  });

  it('publish_ai_news на месте — та самая кнопка', () => {
    expect((TEST_ACTIONS as readonly string[])).toContain('publish_ai_news');
    expect(actionsSentByClient(CLIENT)).toContain('publish_ai_news');
  });
});

describe('отказ разбора называет себя', () => {
  it('Zod-овское сообщение наружу не уходит', () => {
    // «Invalid input» не называет ни поля, ни допустимых значений, и оно
    // по-английски. CLAUDE.md: ошибки — понятные сообщения на русском.
    expect(ROUTE).not.toMatch(/error: parsed\.error\.issues\[0\]\?\.message/);
  });

  it('ошибка по действию перечисляет допустимые', () => {
    expect(ROUTE).toMatch(/Неизвестное действие/);
    expect(ROUTE).toMatch(/TEST_ACTIONS\.join\(', '\)/);
  });

  it('ошибка по другому полю называет поле', () => {
    expect(ROUTE).toMatch(/issue\?\.path\.join\('\.'\)/);
  });
});
