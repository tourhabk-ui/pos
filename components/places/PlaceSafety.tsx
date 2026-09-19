import Link from 'next/link';
import { AlertTriangle, Backpack, Radio, Phone, Users, ShieldAlert, Flame, Wind, Mountain, Waves, Eye, Thermometer, CloudLightning, Signal, Leaf, Heart, Book } from 'lucide-react';
import { HAZARD_LABELS } from './types';
import type { PlaceSafety as SafetyData } from './types';
import { MCHS_ONLINE_FORM_URL, MCHS_DEADLINE_SHORT } from '@/lib/safety/mchs-registration';
import { EmergencyAction } from '@/components/shared/EmergencyAction';

interface Props {
  safety: SafetyData;
  placeId: string;
}

function HazardIcon({ hazard }: { hazard: string }) {
  const cls = 'w-3.5 h-3.5 flex-shrink-0';
  switch (hazard) {
    case 'bears':
    case 'wildlife':      return <AlertTriangle className={cls} />;
    case 'avalanche':     return <Wind className={cls} />;
    case 'rockfall':      return <Mountain className={cls} />;
    case 'thermal':       return <Thermometer className={cls} />;
    case 'volcanic_gas':  return <Flame className={cls} />;
    case 'altitude':      return <Mountain className={cls} />;
    case 'river_crossing':return <Waves className={cls} />;
    case 'fog':           return <Eye className={cls} />;
    case 'ice':           return <CloudLightning className={cls} />;
    case 'no_signal':     return <Signal className={cls} />;
    case 'weather':       return <CloudLightning className={cls} />;
    default:              return <AlertTriangle className={cls} />;
  }
}

/**
 * Блок безопасности — без коробки в коробке (правка 14.09).
 *
 * До этой правки он был карточкой в жёлтой рамке, внутри которой лежали ещё
 * карточки (высота, до медпомощи, природоохранный лимит) и чипы в рамках
 * (опасности, снаряжение). Три уровня вложенности при том, что язык Ведара
 * прямо запрещает карточку внутри карточки (vedar-design §3), и владелец на
 * это же и указал: «всё равно кринж».
 *
 * Заголовок раздела даёт теперь сама карточка места («Что знать»), поэтому
 * рамка и шапка здесь лишние. Осталось то, что действительно про опасность:
 * чем опасно, что взять, связь, регистрация МЧС, телефоны, эвакуация,
 * офлайн-инструкции.
 *
 * Высота, до медпомощи, лимит посещения и опасности ОТСЮДА УБРАНЫ — они
 * рисовались трижды (герой, характеристики, этот блок). Единственное место
 * теперь — таблица фактов `PlaceFacts`.
 *
 * Коробка осталась ровно у двух вещей, и обе — действия: кнопка 112
 * (непрозрачная, `--danger`, §5 языка) и ссылка на офлайн-инструкции.
 */
export default function PlaceSafety({ safety, placeId: _ }: Props) {
  const hasAnyData =
    safety.requiredGear.length > 0 ||
    safety.satCommunicatorRequired ||
    Boolean(safety.emergencyAccess) ||
    safety.registrationRequired ||
    Boolean(safety.phoneRangerMches);

  return (
    <section className="space-y-4">
      {/* Шапка — типографикой, а не рамкой. */}
      <p className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
        <ShieldAlert className="h-4 w-4 text-[var(--warning)]" aria-hidden />
        Безопасность
      </p>

      {hasAnyData && (
        <dl className="divide-y divide-[var(--border)]">
          {safety.requiredGear.length > 0 && (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="flex shrink-0 items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                <Backpack className="h-3.5 w-3.5" aria-hidden /> Снаряжение
              </dt>
              <dd className="text-right text-sm font-medium text-[var(--text-primary)]">
                {safety.requiredGear.join(' · ')}
              </dd>
            </div>
          )}

          {safety.satCommunicatorRequired && (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="flex shrink-0 items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                <Radio className="h-3.5 w-3.5" aria-hidden /> Связь
              </dt>
              <dd className="text-right text-sm font-semibold text-[var(--warning)]">
                нужен спутниковый мессенджер
              </dd>
            </div>
          )}

          {safety.registrationRequired && (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="flex shrink-0 items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                <Users className="h-3.5 w-3.5" aria-hidden /> Регистрация
              </dt>
              <dd className="text-right text-sm font-semibold">
                <a
                  href={MCHS_ONLINE_FORM_URL}
                  title={MCHS_DEADLINE_SHORT}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--warning)] hover:underline"
                >
                  МЧС обязательна
                </a>
              </dd>
            </div>
          )}

          {safety.emergencyAccess && (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="shrink-0 text-sm text-[var(--text-secondary)]">Эвакуация</dt>
              <dd className="text-right text-sm text-[var(--text-primary)]">{safety.emergencyAccess}</dd>
            </div>
          )}
        </dl>
      )}

      {/* Экстренная помощь. Единственный акцент блока — и он про действие. */}
      <div className="flex flex-wrap items-center gap-2">
        <EmergencyAction
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--danger)] px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          <Phone className="h-3.5 w-3.5" aria-hidden /> 112
        </EmergencyAction>

        {/* Региональный номер МЧС — ТОЛЬКО если он задан для точки в БД.
            Никаких выдуманных fallback: неверный номер в ЧП опаснее его
            отсутствия. Единый источник — 112 выше. */}
        {safety.phoneRangerMches && (
          <a
            href={`tel:${safety.phoneRangerMches.replace(/[^\d+]/g, '')}`}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
          >
            <Phone className="h-3.5 w-3.5" aria-hidden />
            {safety.phoneRangerMches} МЧС
          </a>
        )}

        <Link
          href="/safety/offline"
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
        >
          <Book className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden />
          Инструкции выживания
        </Link>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        Инструкции работают офлайн — медведь, вулкан, гипотермия.
      </p>
    </section>
  );
}
