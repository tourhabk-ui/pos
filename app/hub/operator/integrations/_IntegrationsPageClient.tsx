'use client';

import React, { useState, useEffect } from 'react';
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  ExternalLink,
  Fish,
  Copy,
  Check,
  Package
} from 'lucide-react';

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

interface PartnerStatus {
  partner: {
    id: string;
    name: string;
    website: string;
    type: string;
  };
  sync: {
    lastSync: string | null;
    toursCount: number;
    status: 'ok' | 'error' | 'never';
  };
  configured: boolean;
}

interface SyncResult {
  success: boolean;
  toursImported: number;
  toursUpdated: number;
  errors: string[];
  syncedAt: string;
}

export default function IntegrationsPageClient() {
  const [partners, setPartners] = useState<PartnerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
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

  useEffect(() => {
    fetchPartners();
  }, []);

  const fetchPartners = async () => {
    try {
      const response = await fetch('/api/partners/kamchatka-fishing');
      const data = await response.json();

      if (data.success) {
        setPartners([data.data]);
      }
    } catch (error) {
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async (partnerId: string) => {
    setSyncing(partnerId);
    setSyncResult(null);

    try {
      const response = await fetch(`/api/partners/${partnerId}`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        setSyncResult(data.data);
        fetchPartners();
      } else {
        setSyncResult({
          success: false,
          toursImported: 0,
          toursUpdated: 0,
          errors: [data.error || 'Sync failed'],
          syncedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      setSyncResult({
        success: false,
        toursImported: 0,
        toursUpdated: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        syncedAt: new Date().toISOString(),
      });
    } finally {
      setSyncing(null);
    }
  };

  const getStatusIcon = (status: string, configured: boolean) => {
    if (!configured) return <AlertCircle className="w-5 h-5 text-[var(--warning)]" />;
    if (status === 'ok') return <CheckCircle className="w-5 h-5 text-[var(--success)]" />;
    if (status === 'error') return <XCircle className="w-5 h-5 text-[var(--danger)]" />;
    return <AlertCircle className="w-5 h-5 text-[var(--text-muted)]" />;
  };

  const getPartnerIcon = (type: string) => {
    switch (type) {
      case 'fishing-tours':
        return <Fish className="w-8 h-8 text-[var(--accent)]" />;
      default:
        return <Package className="w-8 h-8 text-[var(--text-muted)]" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[var(--accent)]/20 border-t-[var(--accent)] rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[var(--text-muted)]">Загрузка интеграций...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 lg:p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Интеграции</h1>
        <p className="text-[var(--text-muted)] mt-1">Каналы продаж и партнёрские подключения</p>
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

      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Партнёрские подключения</h2>
        <p className="text-[var(--text-muted)] text-sm mt-0.5">
          Обмен турами и бронированиями с другими сервисами по их API.
        </p>
      </div>

      {/* Sync Result Alert */}
      {syncResult && (
        <div className={`p-4 rounded-lg border ${
          syncResult.success
            ? 'bg-[var(--success)]/5 border-[var(--success)]/30'
            : 'bg-[var(--danger)]/5 border-[var(--danger)]/30'
        }`}>
          <div className="flex items-start gap-3">
            {syncResult.success ? (
              <CheckCircle className="w-5 h-5 text-[var(--success)] mt-0.5" />
            ) : (
              <XCircle className="w-5 h-5 text-[var(--danger)] mt-0.5" />
            )}
            <div>
              <h3 className={`font-semibold ${syncResult.success ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                {syncResult.success ? 'Синхронизация завершена' : 'Ошибка синхронизации'}
              </h3>
              {syncResult.success ? (
                <p className="text-[var(--text-muted)] text-sm mt-1">
                  Импортировано: {syncResult.toursImported} туров,
                  Обновлено: {syncResult.toursUpdated}
                </p>
              ) : (
                <ul className="text-[var(--danger)] text-sm mt-1">
                  {syncResult.errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Partners Grid */}
      <div className="grid gap-5">
        {partners.map((partner) => (
          <div
            key={partner.partner.id}
            className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-[var(--bg-hover)] rounded-md">
                  {getPartnerIcon(partner.partner.type)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">{partner.partner.name}</h2>
                    {getStatusIcon(partner.sync.status, partner.configured)}
                  </div>
                  <a
                    href={partner.partner.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--accent)] hover:underline text-sm flex items-center gap-1 mt-1"
                  >
                    {partner.partner.website}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>

              <button
                onClick={() => handleSync(partner.partner.id)}
                disabled={!partner.configured || syncing === partner.partner.id}
                className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 transition-colors ${
                  partner.configured
                    ? 'bg-[var(--accent)] text-[var(--bg-card)] hover:opacity-90'
                    : 'bg-[var(--bg-hover)] text-[var(--text-muted)] cursor-not-allowed'
                }`}
              >
                <RefreshCw className={`w-4 h-4 ${syncing === partner.partner.id ? 'animate-spin' : ''}`} />
                {syncing === partner.partner.id ? 'Синхронизация...' : 'Синхронизировать'}
              </button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mt-6">
              <div className="bg-[var(--bg-hover)] rounded-md p-4">
                <p className="text-[var(--text-muted)] text-sm">Статус</p>
                <p className={`text-lg font-semibold ${
                  !partner.configured ? 'text-[var(--warning)]' :
                  partner.sync.status === 'ok' ? 'text-[var(--success)]' :
                  partner.sync.status === 'error' ? 'text-[var(--danger)]' :
                  'text-[var(--text-muted)]'
                }`}>
                  {!partner.configured ? 'Не настроено' :
                   partner.sync.status === 'ok' ? 'Активно' :
                   partner.sync.status === 'error' ? 'Ошибка' :
                   'Не синхронизировано'}
                </p>
              </div>
              <div className="bg-[var(--bg-hover)] rounded-md p-4">
                <p className="text-[var(--text-muted)] text-sm">Туров</p>
                <p className="text-lg font-semibold text-[var(--text-primary)]">{partner.sync.toursCount}</p>
              </div>
              <div className="bg-[var(--bg-hover)] rounded-md p-4">
                <p className="text-[var(--text-muted)] text-sm">Последняя синхронизация</p>
                <p className="text-lg font-semibold text-[var(--text-primary)]">
                  {partner.sync.lastSync
                    ? new Date(partner.sync.lastSync).toLocaleDateString('ru-RU')
                    : 'Никогда'}
                </p>
              </div>
            </div>

            {/* Пока подключения нет — честно говорим, от кого оно зависит.
                Прежде здесь висели имена переменных окружения НАШЕГО сервера с
                предложением «добавить API ключи»: оператор физически не может
                этого сделать, и страница выглядела сломанной по его вине. */}
            {!partner.configured && (
              <div className="mt-4 p-4 bg-[var(--warning)]/5 border border-[var(--warning)]/20 rounded-md">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-[var(--warning)] mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-[var(--warning)]">Подключение ещё не открыто</h4>
                    <p className="text-[var(--text-muted)] text-sm mt-1">
                      Обмен по API открывает платформа: нужен договор с партнёром и выданный
                      им доступ. От вас ничего не требуется — как только канал заработает,
                      статус здесь сменится сам.
                    </p>
                    <p className="text-[var(--text-muted)] text-sm mt-2">
                      Пока туры расходятся через каналы продаж выше — они работают уже сейчас.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {partners.length === 0 && (
          <div className="text-center py-12 text-[var(--text-muted)]">
            <Package className="w-16 h-16 mx-auto mb-4 opacity-40" />
            <p>Нет подключенных партнеров</p>
          </div>
        )}
      </div>
    </div>
  );
}
