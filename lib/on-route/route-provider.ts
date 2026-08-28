/**
 * lib/on-route/route-provider.ts — контракт автомобильного маршрутизатора
 * (владелец 28.08, PR 5B-1, инфраструктурная часть).
 *
 * Владелец зафиксировал для первого релиза: car — да, foot — только по
 * известной сети (5B-2, отдельно), внешний онлайн-маршрутизатор — только
 * через серверный адаптер (ключ не в браузере). Источник самого
 * маршрутизатора при этом ОСТАВЛЕН НЕРЕШЁННЫМ — владелец попросил
 * спроектировать адаптер провайдер-агностично, не выбирая источник.
 *
 * Отсюда сознательное ограничение этого файла: `found`/`not_found` сюда
 * НЕ добавлены. Их форма — единицы расстояния/времени, кодировка
 * геометрии, само устройство «путь найден» — целиком зависит от
 * КОНКРЕТНОГО провайдера (Yandex Router API / 2ГИС / OSRM — у каждого
 * своя форма ответа), а свести реальный найденный путь ещё и в
 * `RouteOption` (lib/on-route/destination.ts) нельзя без выбора: у этого
 * типа сегодня нет поля под геометрию, а `lineGrade` описывает СНЯТЫЙ
 * трек — приписать туда посчитанный маршрутизатором путь значило бы
 * соврать о происхождении линии (§12 CLAUDE.md). Придумывать эту форму
 * без реального провайдера — ровно то «нет данных, значит выдумка» из
 * §4.0. Проектирует её PR, который выбирает источник.
 *
 * `notWiredCarRouteProvider` — единственная реализация сегодня: честно
 * отвечает `not_wired`, а не молчит и не выдаёт локальную заглушку за
 * реальный маршрут.
 */

export interface CarRouteQuery {
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
}

export type CarRouteProviderResult =
  | { status: 'not_wired'; message: string }
  | { status: 'error'; retryable: boolean; message: string };

export interface CarRouteProvider {
  route(query: CarRouteQuery): Promise<CarRouteProviderResult>;
}

export const CAR_PROVIDER_NOT_WIRED_MESSAGE =
  'Автомобильный маршрутизатор ещё не подключён — источник для PR 5B-1 не выбран.';

export const notWiredCarRouteProvider: CarRouteProvider = {
  async route(): Promise<CarRouteProviderResult> {
    return { status: 'not_wired', message: CAR_PROVIDER_NOT_WIRED_MESSAGE };
  },
};
