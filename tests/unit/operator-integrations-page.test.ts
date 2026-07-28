/**
 * Страница интеграций оператора не показывает ему НАШИ настройки.
 *
 * Живой случай 28.07: оператор открыл «Интеграции с партнерами» и увидел
 * карточку «Камчатская Рыбалка — Не настроено» с предложением «добавьте API
 * ключи в переменные окружения: KAMCHATKA_FISHING_API_KEY=…». Это переменные
 * НАШЕГО сервера на Timeweb: оператор не может их задать даже теоретически, а
 * страница выглядела так, будто он что-то недоделал. Инструкции, что это за
 * ключи и где их взять, не было ни строчки.
 *
 * При этом рабочие каналы у платформы есть и ключей не требуют вовсе — фиды
 * Авито и Яндекса. Их на странице оператора не было.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PAGE = read('app/hub/operator/integrations/_IntegrationsPageClient.tsx');

describe('оператору не показывают внутренние настройки платформы', () => {
  it('имён переменных окружения на странице нет', () => {
    expect(PAGE).not.toContain('KAMCHATKA_FISHING_API_KEY=');
    expect(PAGE).not.toContain('KAMCHATKA_FISHING_API_SECRET=');
    expect(PAGE).not.toContain('переменные окружения');
  });

  it('вместо этого честно сказано, от кого зависит подключение', () => {
    expect(PAGE).toContain('Подключение ещё не открыто');
    expect(PAGE).toContain('открывает платформа');
    // И что от оператора действий не требуется — иначе он будет их искать.
    expect(PAGE).toContain('От вас ничего не требуется');
  });
});

describe('рабочие каналы продаж есть и объяснены', () => {
  it('фиды Авито и Яндекса на странице', () => {
    expect(PAGE).toContain('/api/channels/avito/feed');
    expect(PAGE).toContain('/api/channels/yandex/feed');
  });

  it('адрес фида можно скопировать — его переносят в чужой кабинет руками', () => {
    expect(PAGE).toContain('navigator.clipboard.writeText');
    expect(PAGE).toContain('Копировать');
  });

  it('к каждому каналу есть шаги подключения, а не только адрес', () => {
    expect(PAGE).toContain('Автозагрузка → Добавить фид');
    expect(PAGE).toContain('partner.yandex.ru/travel');
  });

  it('домен фида берётся из конфигурации, а не зашит', () => {
    expect(PAGE).toContain('process.env.NEXT_PUBLIC_SITE_URL');
  });
});
