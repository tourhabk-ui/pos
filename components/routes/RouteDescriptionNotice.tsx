/**
 * Описание маршрута снято до переписи по источникам — сказано словами (15.10).
 *
 * 150 описаний записал агент по одному названию маршрута (миграция 1261,
 * владелец: «5 скрой»). Без этой строки пустое место под заголовком читалось
 * бы как «рассказать нечего», а не как «мы убрали непроверенное и пишем
 * заново». Текст — тот же, что у карточки места (PlaceDescription, 1247):
 * одно правило — одна формулировка.
 *
 * Показывается, только когда описания на карточке нет: переписанное по
 * источникам ложится в description, и тогда объяснять нечего.
 */
interface Props {
  withdrawn: boolean;
  hasDescription: boolean;
}

export default function RouteDescriptionNotice({ withdrawn, hasDescription }: Props) {
  if (!withdrawn || hasDescription) return null;
  return (
    <section>
      <p className="text-sm leading-relaxed text-[var(--text-muted)]" style={{ maxWidth: '68ch' }}>
        Описание этого маршрута было написано не по источникам — мы его убрали и переписываем по
        справочникам. Факты ниже — из данных платформы.
      </p>
    </section>
  );
}
