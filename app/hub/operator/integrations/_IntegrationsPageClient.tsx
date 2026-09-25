'use client';

import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * Каналы продаж, которые работают ПРЯМО СЕЙЧАС и не требуют никаких ключей:
 * оператор берёт готовый адрес фида и вставляет его в свой кабинет площадки.
 * Раньше этой половины на странице не было вовсе — вместо неё оператору
 * показывали имена переменных окружения НАШЕГО сервера, задать которые он
 * физически не может.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

const SALES_CHANNELS = [
  {
    id: 'avito',
    name: 'Авито — Автозагрузка',
    feedUrl: `${SITE_URL}/api/channels/avito/feed`,
    note: 'Авито перечитывает фид каждые 2-4 часа.',
    steps: [
      'Кабинет Авито → Настройки → Автозагрузка → Добавить фид',
      'Вставить адрес фида, сохранить',
      'Дождаться первой загрузки',
    ],
  },
  {
    id: 'yandex',
    name: 'Яндекс.Услуги и Яндекс.Путешествия',
    feedUrl: `${SITE_URL}/api/channels/yandex/feed`,
    note: 'Яндекс перечитывает фид раз в сутки.',
    steps: [
      'business.yandex.ru → XML-импорт (для Услуг)',
      'partner.yandex.ru/travel → тип «экскурсии» (для Путешествий)',
      'Вставить адрес фида, сохранить',
    ],
  },
];

/*
 * Блока «Партнёрские подключения» («Камчатская Рыбалка») здесь больше нет
 * (25.09, аудит кабинета оператора, пакет «Г», п.9). Он показывался КАЖДОМУ
 * оператору, хотя это подключение платформы, а не его; синхронизация ничего
 * не сохраняла (lib/partners/kamchatka-fishing/sync.ts) и при этом отвечала
 * «Импортировано: N туров» — ложный успех. Управлять таким подключением —
 * дело администратора, и роут /api/partners/kamchatka-fishing теперь
 * admin-only.
 */

export default function IntegrationsPageClient() {
  const [copied, setCopied] = useState<string | null>(null);

  const copyFeed = async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Буфер недоступен (нет защищённого контекста) — адрес виден целиком
      // и выделяется руками, поэтому молча не мешаем.
    }
  };

  return (
    <div className="p-5 lg:p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Интеграции</h1>
        <p className="text-[var(--text-muted)] mt-1">Каналы продаж ваших туров</p>
      </div>

      {/* Каналы продаж — работают сегодня, ключи не нужны */}
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Каналы продаж</h2>
          <p className="text-[var(--text-muted)] text-sm mt-0.5">
            Ваши опубликованные туры отдаются площадкам готовым фидом. Ничего настраивать
            у нас не нужно: скопируйте адрес и вставьте его в свой кабинет площадки.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {SALES_CHANNELS.map((ch) => (
            <div key={ch.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
              <h3 className="font-semibold text-[var(--text-primary)]">{ch.name}</h3>

              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate px-3 py-2 bg-[var(--bg-hover)] rounded-md text-xs text-[var(--text-secondary)]" title={ch.feedUrl}>
                  {ch.feedUrl}
                </code>
                <button
                  type="button"
                  onClick={() => copyFeed(ch.id, ch.feedUrl)}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  {copied === ch.id ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied === ch.id ? 'Скопировано' : 'Копировать'}
                </button>
              </div>

              <ol className="mt-3 space-y-1.5 text-sm text-[var(--text-secondary)] list-decimal list-inside">
                {ch.steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
              <p className="mt-2 text-xs text-[var(--text-muted)]">{ch.note}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Партнёрские подключения по API — статично и честно: подключений нет,
          кнопки синхронизации нет (она рапортовала несделанный импорт). */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Партнёрские подключения по API</h2>
        <p className="font-semibold text-[var(--warning)] text-sm mt-2">Подключение ещё не открыто</p>
        <p className="text-[var(--text-muted)] text-sm mt-1">
          Обмен турами по API с другими сервисами открывает платформа: нужен договор с
          партнёром и выданный им доступ. От вас ничего не требуется. Пока туры расходятся
          через каналы продаж выше — они работают уже сейчас.
        </p>
      </div>
    </div>
  );
}
