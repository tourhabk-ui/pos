// @vitest-environment node
/**
 * Модели дают ТЕКСТ поста, а не обёртку виджета (04.09).
 *
 * У инцидента с репликой в канале две половины, и чинятся они в разных
 * местах. Публикацию реплики остановил общий валидатор постов
 * (`modelRefusalIssue` в lib/notifications/post-validation) — он стоит на
 * всех каналах и это правильное для него место.
 *
 * Но ПРИЧИНА реплики осталась бы: Telegram-источники добавлены 03.09, и
 * сигналом стала ссылка на пост `t.me/<канал>/<id>`. Страница отдельного
 * поста отдаёт HTML-обёртку виджета без содержимого — её и снимали как
 * «ТЕКСТ СТАТЬИ». Модель честно отвечала, что текста нет.
 *
 * Без этой половины выпуск не публиковался бы каждый раз — уже не с
 * репликой на витрине, а с кодом `model_refusal` в журнале. Тише, но всё
 * так же без выпуска.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { telegramPostText, telegramPreviewUrlForPost } from '@/lib/agents/scout-telegram';

const DIGEST = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');

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

describe('ссылка на пост → превью канала', () => {
  it('пост канала распознаётся', () => {
    expect(telegramPreviewUrlForPost('https://t.me/vibecoding_tg/101')).toBe('https://t.me/s/vibecoding_tg');
    expect(telegramPreviewUrlForPost('https://t.me/s/vibecoding_tg/101')).toBe('https://t.me/s/vibecoding_tg');
  });

  it('чужой хост и приглашение — не пост канала', () => {
    expect(telegramPreviewUrlForPost('https://habr.com/ru/post/1')).toBeNull();
    expect(telegramPreviewUrlForPost('https://t.me/+abc')).toBeNull();
    expect(telegramPreviewUrlForPost('https://t.me/vibecoding_tg')).toBeNull();
  });
});

describe('со страницы превью берётся ИМЕННО запрошенный пост', () => {
  it('нужный пост, а не первый попавшийся', () => {
    expect(telegramPostText(HTML, 'https://t.me/vibecoding_tg/101')).toBe('Второй пост про агентов');
    expect(telegramPostText(HTML, 'https://t.me/vibecoding_tg/100')).toContain('Первый пост');
  });

  it('поста нет на странице — честная пустота, а не чужой текст и не обёртка', () => {
    // Пустая строка означает «текста нет», и модель тогда опирается на
    // заголовок — как и до появления Telegram-источников. Отдать соседний
    // пост было бы хуже отказа: выпуск получил бы чужой факт под нужной
    // ссылкой.
    expect(telegramPostText(HTML, 'https://t.me/vibecoding_tg/999')).toBe('');
    expect(telegramPostText('', 'https://t.me/vibecoding_tg/101')).toBe('');
  });
});

describe('конвейер читает превью, а не страницу поста', () => {
  it('у ссылки t.me своя ветка добычи текста', () => {
    expect(DIGEST).toMatch(/telegramPreviewUrlForPost\(url\)/);
    expect(DIGEST).toMatch(/telegramPostText\(html, url\)/);
  });

  it('прямой и релейный запрос — один помощник на обе ветки', () => {
    // Иначе гео-закрытый источник читался бы через реле, а превью канала —
    // напрямую, и с прода (t.me заблокирован) не читалось бы вовсе.
    expect(DIGEST).toMatch(/async function fetchMaybeViaRelay/);
    expect(DIGEST).toMatch(/await fetchMaybeViaRelay\(tgPreview\)/);
  });
});
