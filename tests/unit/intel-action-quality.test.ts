/**
 * Разведка отличает дело от размышления (владелец 23.08).
 *
 * Повод: выпуск разведки приписал демонстрации «что BLIP замечает на картинке
 * первым» задачу «валидации восприятия изображений в туристических маршрутах»
 * и предложил распознавать медведей и камни. Связи в источнике нет — она
 * сочинена, и сочинена промптом, который требует применимости от чего угодно.
 *
 * Оба пункта того выпуска начинались с «Проанализировать возможность» и
 * «Исследовать применение». Два разбора эволюции подряд дали 34/48 и 33/47
 * вердиктов «шум», и почти весь шум выглядел так же.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyActionItem, triageActionItems, stripPriority } from '@/lib/agents/intel/action-quality';

describe('род пункта по ведущему глаголу', () => {
  it('размышление названо размышлением', () => {
    for (const s of [
      '[средний] — Проанализировать возможность интеграции визуального теста BLIP',
      '[средний] — Исследовать применение теста для оценки восприятия AI-агентов',
      '[низкий] — Оценить стоимость развёртывания приватной LLM',
      '[высокий] — Изучить документацию OpenAI Responses API',
      'Рассмотреть интеграцию hooks',
    ]) {
      expect(classifyActionItem(s), s).toBe('research');
    }
  });

  it('дело названо делом', () => {
    for (const s of [
      '[высокий] — Добавить индекс на operator_bookings(booking_date)',
      '[средний] — Перенести судью фактгейта на локальную модель',
      '[низкий] — Починить ссылку в напоминании туристу',
      'Внедрить модуль отчётов для операторов',
    ]) {
      expect(classifyActionItem(s), s).toBe('actionable');
    }
  });

  it('«протестировать ВОЗМОЖНОСТЬ» — размышление в одежде дела', () => {
    // Глагол дела, а дополнение выдаёт: возможность анализируют, не делают.
    expect(classifyActionItem('[средний] — Протестировать возможность интеграции Ultrafast mode')).toBe('research');
    // А просто «протестировать» конкретное — дело.
    expect(classifyActionItem('[средний] — Протестировать приём треков из MAPS.ME')).toBe('actionable');
  });

  it('незнакомый глагол — «не знаю», а не шум', () => {
    // Третий исход не равен второму: глушить незнакомое молча значит
    // повторять ту же беду с другой стороны (§4.0).
    expect(classifyActionItem('[средний] — Отрефакторить слой планировщика')).toBe('unclear');
    expect(classifyActionItem('')).toBe('unclear');
  });

  it('приоритет в скобках не мешает разбору', () => {
    expect(stripPriority('[высокий] — Добавить индекс')).toBe('Добавить индекс');
    expect(stripPriority('Добавить индекс')).toBe('Добавить индекс');
  });
});

describe('отбор пунктов выпуска', () => {
  it('размышления отсеиваются, дело и непонятое остаются', () => {
    const t = triageActionItems([
      '[средний] — Проанализировать возможность интеграции BLIP',
      '[высокий] — Добавить проверку фото на входе',
      '[средний] — Отрефакторить приёмник',
    ]);
    expect(t.kept).toHaveLength(2);
    expect(t.dropped).toHaveLength(1);
    expect(t.allResearch).toBe(false);
  });

  it('отсев виден: «пусто» и «отсеяли всё» — разные состояния', () => {
    const both = triageActionItems([
      '[средний] — Проанализировать возможность интеграции BLIP',
      '[средний] — Исследовать применение теста',
    ]);
    expect(both.kept).toEqual([]);
    expect(both.dropped).toHaveLength(2);
    expect(both.allResearch).toBe(true);

    // Пунктов не было вовсе — это НЕ «все размышления».
    const none = triageActionItems([]);
    expect(none.allResearch).toBe(false);
    expect(none.dropped).toEqual([]);
  });
});

describe('разведка подключила судью и перестала требовать применимости', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/services/intelligence-monitor.service.ts'), 'utf-8');

  it('отбор применён к пунктам находки', () => {
    expect(SRC).toMatch(/triageActionItems\(raw\)/);
    expect(SRC).toMatch(/action_items: triage\.kept/);
  });

  it('находка без дел не будит человека, но и не исчезает', () => {
    // critical и notable уходят в Telegram и канал; informational остаётся
    // в базе и отчёте.
    expect(SRC).toMatch(/triage\.allResearch \? 'informational' : claimed/);
  });

  it('отсев называется вслух', () => {
    expect(SRC).toMatch(/отсеяно размышлений/);
  });

  it('промпт разрешает ответ «не применимо» прямым текстом', () => {
    // Требовать применимости от чего угодно — заказ на выдумку (§4.0).
    expect(SRC).toMatch(/НЕ применимы/);
    expect(SRC).toMatch(/не выводи применимость из соседства/i);
    expect(SRC).toMatch(/action_item — ДЕЙСТВИЕ, а не размышление/);
  });
});
