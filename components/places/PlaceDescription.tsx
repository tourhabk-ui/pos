'use client';

import { useState } from 'react';
import type { DescriptionSource } from '@/lib/text/description-source';

interface Props {
  name: string;
  essence: string | null;
  description: string | null;
  /** Подпись источника текста (#1830); null — подписывать нечего. */
  descriptionSource?: DescriptionSource | null;
  /** Описание снято как путевая заметка и ждёт переписи (миграция 1247). */
  descriptionWithdrawn?: boolean;
  /** Описание написала модель (журнал происхождения, lib/places/description-by-model). */
  byModel?: boolean;
  /** Описание написано голосом впечатления, и источника у него нет (lib/places/description-voice). */
  impression?: boolean;
  placeId: string;
}

export default function PlaceDescription({ essence, description, descriptionSource, descriptionWithdrawn, byModel, impression, placeId }: Props) {
  const [expanded, setExpanded] = useState(false);

  const paragraphs = description?.split('\n').filter(p => p.trim()) ?? [];
  const isLong = paragraphs.length > 3 || (description?.length ?? 0) > 600;

  const withdrawn = Boolean(descriptionWithdrawn) && paragraphs.length === 0;
  if (!essence && paragraphs.length === 0 && !withdrawn) return null;

  return (
    <section className="space-y-3">
      {/* Essence / lede */}
      {essence && (
        <p
          className="text-base sm:text-lg text-[var(--text-secondary)] leading-relaxed font-medium"
          style={{ maxWidth: '66ch' }}
        >
          {essence}
        </p>
      )}

      {/* Description body.
          Обрезка по СТРОКАМ, а не выцветанием в фон (правка 14.09). Маска-
          градиент растворяла последние две строки в подложку посреди
          предложения — читалось ровно как то, чем и было: текст, тающий в
          муть. `line-clamp` режет честно и по границе строки; что текст
          продолжается, говорит кнопка под ним, а не спецэффект. */}
      {/* Описание снято как путевая заметка от первого лица (14.10, слово
          владельца «2 да»): «вчера поднялся», «идёшь неделю» читались как
          наблюдение о сегодняшнем месте, а наблюдения не было. Молчание
          читалось бы как «рассказать нечего» — поэтому сказано словами.
          Снимается не только дневник (14.10, 1257): у «Вида на долину Голубых
          озёр» сняты выдуманные «термально-минеральные озёра», и «путевая
          заметка» назвала бы чужую причину — поэтому формулировка общая.
          «И переписываем по справочникам» снято 22.10 (1310, «всю не правду»):
          без автора и источника сняты сотни описаний разом, а переписывать
          их некому — модель тексты мест не пишет, справку по источнику кладёт
          миграция, место за местом. Обещание работы, которой нет, — та же
          неправда, что и снятый текст. */}
      {withdrawn && (
        <p className="text-sm leading-relaxed text-[var(--text-muted)]" style={{ maxWidth: '68ch' }}>
          Описание этого места было написано не по источникам — мы его убрали. Факты ниже — из
          данных платформы.
        </p>
      )}

      {paragraphs.length > 0 && (
        <div className="space-y-3">
          <div className={isLong && !expanded ? 'line-clamp-6' : undefined}>
            {paragraphs.map((p, i) => (
              <p
                key={i}
                className="text-[var(--text-secondary)] leading-relaxed"
                style={{ fontSize: '16px', lineHeight: '1.75', maxWidth: '68ch' }}
              >
                {p}
              </p>
            ))}
          </div>
          {isLong && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="text-sm text-[var(--ocean)] hover:text-[var(--accent)] font-medium transition-colors"
            >
              {expanded ? '↑ Свернуть' : '↓ Читать полностью'}
            </button>
          )}

          {/* Источник ТЕКСТА — под самим текстом, а не в подвале карточки
              (#1830, шаг 4): подпись относится к этим абзацам, и человек
              должен видеть её там, где читает. Приглушённо: это сноска, а не
              часть рассказа о месте.
              Адрес подтвердил владелец из браузера 14.09 — с раннера он
              отдавал 403 (см. description-source.ts). Нет адреса — остаётся
              текст: подпись называет источник и без ссылки. */}
          {/* Кто писал текст — сказано, когда это знает журнал (15.10, §0):
              машинный текст читался наравне с текстом из справочника. */}
          {byModel && (
            <p className="text-xs text-[var(--text-muted)] pt-1" style={{ maxWidth: '68ch' }}>
              Описание написала модель по данным платформы — на месте сверяйтесь.
            </p>
          )}

          {/* Впечатление без источника (15.10, §0): «тишина», «запах», «плеск»
              читались как наблюдение о месте, а наблюдения не было. Кузьмич и
              MCP помечают такой текст с 26.09 — карточка говорит то же. */}
          {impression && (
            <p className="text-xs text-[var(--text-muted)] pt-1" style={{ maxWidth: '68ch' }}>
              Описание написано как впечатление, а не по наблюдению: его подробности не сверены с источниками.
            </p>
          )}

          {descriptionSource && (
            <p className="text-xs text-[var(--text-muted)] pt-1" style={{ maxWidth: '68ch' }}>
              {descriptionSource.url ? (
                <a
                  href={descriptionSource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[var(--ocean)] transition-colors"
                >
                  {descriptionSource.label}
                </a>
              ) : descriptionSource.label}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
