// @vitest-environment node
/**
 * Записка модели не уходит на витрину (инцидент 04.09).
 *
 * В AI-канал (1.8К подписчиков) опубликовалось: «Не вижу текста статьи в
 * сигнале — только HTML-обёртка Telegram-виджета… Пришли, пожалуйста,
 * выдержки из статей». Это реплика ОПЕРАТОРУ, а не пост.
 *
 * Причин было две, и сторож держит обе:
 *  1) материала не дали — со страницы поста t.me снималась обёртка виджета и
 *     подавалась модели как «текст статьи»;
 *  2) записку никто не остановил — оба фактчека ищут НЕподтверждённые
 *     утверждения, а в отказе утверждений нет вовсе, значит и
 *     неподтверждённых ноль: ворота отработали честно и пропустили.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgePostRefusal } from '@/lib/agents/post-refusal';
import { telegramPostText, telegramPreviewUrlForPost } from '@/lib/agents/scout-telegram';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-digest';

const DIGEST = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');

/** Тот самый текст, который вышел в канал. */
const PUBLISHED = `Не вижу текста статьи в сигнале — только HTML-обёртка Telegram-виджета без содержимого поста. Не могу написать пост по этому материалу, так как нет ни одного фактического сигнала для синтеза.

Пришли, пожалуйста, выдержки из статей (текст, который был в самих постах/материалах), и я соберу дайджест по правилам.`;

const REAL_POST = `AI и Tech

— На GitHub опубликован chrome-tab-group-cleaner: расширение закрывает группы вкладок по расписанию. Автор пишет, что рутина съедала у него полчаса в неделю.
— Обсуждение на Hacker News: нужны ли тесты прототипу, который живёт две недели.

Инженерный вывод: инструменты вокруг вайб-кодинга дозревают быстрее, чем сам подход.`;

describe('распознавание отказа', () => {
  it('текст, ушедший в канал 04.09, распознаётся отказом с называемой причиной', () => {
    const v = judgePostRefusal(PUBLISHED);
    expect(v.refused).toBe(true);
    expect(v.reason.length).toBeGreaterThan(0);
  });

  it('настоящий выпуск отказом не считается', () => {
    expect(judgePostRefusal(REAL_POST).refused).toBe(false);
  });

  it('пустой текст — не отказ: это отдельный исход (synthesis_null)', () => {
    expect(judgePostRefusal('').refused).toBe(false);
    expect(judgePostRefusal('   ').refused).toBe(false);
  });

  it('ловятся три семьи признаков по отдельности', () => {
    // заявление о невозможности
    expect(judgePostRefusal('Не могу составить дайджест: материала недостаточно.').refused).toBe(true);
    // обращение к оператору
    expect(judgePostRefusal('Скинь мне ссылки на статьи, и будет пост.').refused).toBe(true);
    // разговор о конвейере
    expect(judgePostRefusal('В сигнале нет содержимого поста.').refused).toBe(true);
  });

  it('русские признаки ловятся без латиницы в тексте', () => {
    // Первая редакция детектора писала границы через `\b`, а `\w` в JS —
    // только латиница: `/\bне могу\b/` на русском не срабатывает никогда.
    // Из трёх семей живой оставалась одна — по слову «html-обёртка».
    const noLatin = 'Не вижу текста статьи в сигнале. Пришлите, пожалуйста, выдержки.';
    expect(/[A-Za-z]/.test(noLatin)).toBe(false);
    expect(judgePostRefusal(noLatin).refused).toBe(true);
  });

  it('причина называет найденную фразу, а не исходник регулярки', () => {
    const v = judgePostRefusal(PUBLISHED);
    expect(v.reason).toContain('«');
    expect(v.reason).not.toContain('(?<!');
  });
});

describe('материал: текст поста, а не обёртка виджета', () => {
  const HTML = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="vibecoding_tg/100">
    <div class="tgme_widget_message_text js-message_text">Первый пост<br/>вторая строка</div>
    <a class="tgme_widget_message_date" href="https://t.me/vibecoding_tg/100"><time></time></a>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="vibecoding_tg/101">
    <div class="tgme_widget_message_text js-message_text">Второй пост про агентов</div>
    <a class="tgme_widget_message_date" href="https://t.me/vibecoding_tg/101"><time></time></a>
  </div>
</div>`;

  it('ссылка на пост ведёт к превью канала', () => {
    expect(telegramPreviewUrlForPost('https://t.me/vibecoding_tg/101')).toBe('https://t.me/s/vibecoding_tg');
    expect(telegramPreviewUrlForPost('https://habr.com/ru/post/1')).toBeNull();
    expect(telegramPreviewUrlForPost('https://t.me/+abc')).toBeNull();
  });

  it('со страницы превью берётся ИМЕННО запрошенный пост', () => {
    expect(telegramPostText(HTML, 'https://t.me/vibecoding_tg/101')).toBe('Второй пост про агентов');
    expect(telegramPostText(HTML, 'https://t.me/vibecoding_tg/100')).toContain('Первый пост');
  });

  it('поста нет на странице — честная пустота, а не чужой текст и не обёртка', () => {
    expect(telegramPostText(HTML, 'https://t.me/vibecoding_tg/999')).toBe('');
  });
});

describe('ворота стоят в конвейере', () => {
  it('ссылка t.me читается через превью, а не как обычная статья', () => {
    expect(DIGEST).toMatch(/telegramPreviewUrlForPost\(url\)/);
    expect(DIGEST).toMatch(/telegramPostText\(html, url\)/);
  });

  it('отказ перехватывается на обоих путях публикации', () => {
    expect(DIGEST).toMatch(/judgePostRefusal\(digest\)/);
    expect(DIGEST).toMatch(/judgePostRefusal\(aiDigest\)/);
    expect(DIGEST).toMatch(/aiSkip = 'ai_model_refusal'/);
    expect(DIGEST).toMatch(/digest_skip_reason: 'model_refusal'/);
  });

  it('у обеих причин есть человеческие слова в отчёте', () => {
    expect(SKIP_REASON_LABELS.model_refusal).toBeTruthy();
    expect(SKIP_REASON_LABELS.ai_model_refusal).toBeTruthy();
  });
});
