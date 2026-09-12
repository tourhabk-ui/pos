/**
 * Подтверждённые пары `places.id ↔ VolcanoNumber` (Global Volcanism Program).
 *
 * Шаг 1 пайплайна #1830 («описания вулканов из Remarks ГВП — перевод +
 * проверка, не автовставка»): прежде чем тянуть `Remarks` и переводить,
 * нужно ЗНАТЬ, что запись `places` и запись ГВП — один и тот же вулкан, а
 * не просто ближайший сосед по расстоянию (кросс-чек `places-gvp-crosscheck`
 * — улика, не факт, см. `lib/geo/gvp-crosscheck.ts`).
 *
 * ── Как собран список (12.09, полный прогон run 1 + хвост offset=100) ──────
 *
 * 117 мест `location_type='volcano'`, 70 вулканов ГВП в границах Камчатки.
 * Пара внесена сюда ТОЛЬКО когда совпали оба условия одновременно:
 *
 *   1. `nearestKm` ≤ ~5 км (для большинства — сотни метров, у крупных
 *      комплексных вулканов, `isExtendedObject`, попадаются единицы км —
 *      это норма для протяжённого объекта, не ошибка координаты);
 *   2. английское имя ГВП узнаваемо соответствует русскому имени места
 *      транслитерацией («Sheveluch» — Шивелуч, «Klyuchevskoy» — Ключевской).
 *
 * Оба условия обязательны: расстояние без имени путает соседние вулканы
 * (например «Кратер Келля» и «кратер Сосед» стоят в 16 км от Ключевского —
 * это спутниковые кратеры ЕГО группы, а не сам Ключевской); имя без
 * расстояния уже подводило платформу раньше (23.08, урок `place-link.ts`:
 * тёзки за сотни километров).
 *
 * ── Что НЕ вошло — и почему это не ошибка списка ────────────────────────────
 *
 * Из 117 мест сюда попало 52 (41 exact + 10 complex-member + 1 distance-only).
 * Остальные 65 — не «не нашли», а «нет
 * прямого аналога»: ГВП каталогизирует ~70 крупных построек, а `places`
 * держит и множество спутниковых пиков/кратеров/хребтов внутри вулканических
 * комплексов (напр. «Сопка Кризалис», «Харчинский», «Шиш» — 40-70 км до
 * ближайшего каталогизированного вулкана ГВП). У них попросту нет отдельной
 * записи в этой базе — не гадаем, оставляем без пары.
 *
 * ── Один VolcanoNumber — несколько places (норма для сложных вулканов) ─────
 *
 * Толбачик (300240) сопоставлен с несколькими записями («Вулкан Толбачик»,
 * «Вулкан Плоский Толбачик», «Острый Толбачик») — это разные вершины ОДНОГО
 * вулканического комплекса, каждая законно ссылается на общее описание ГВП.
 * Решение, давать ли им одинаковый переведённый текст или различать вершины
 * в тексте, — вопрос шага 2 (перевод), не этого файла.
 *
 * ── Полуувереные случаи — оставлены с пометкой, не обещаны фактом ───────────
 *
 * `confidence: 'exact'` — имя и расстояние совпали однозначно.
 * `confidence: 'complex-member'` — распознаваемая вершина/часть комплекса,
 * названного в ГВП по-другому (охватывающее имя), расстояние ≤ 5 км.
 * `confidence: 'distance-only'` — расстояние ~0 км, но имя явно НЕ совпадает
 * (напр. «Крестовский» в 0.1 км от Ushkovsky) — вероятно, спутниковый пик со
 * своим именем внутри той же группы; годится для проверки владельцем перед
 * шагом 2, не для автоматической публикации текста без имени-подтверждения.
 *
 * Реестр — не приговор: это тоже улика, которую перед шагом 2 стоит пробежать
 * глазами (владелец знает эти вулканы вживую, я — только по транслитерации).
 */

export type GvpPairConfidence = 'exact' | 'complex-member' | 'distance-only';

export interface GvpConfirmedPair {
  placeId: string;
  placeName: string;
  volcanoNumber: number;
  gvpName: string;
  distanceKm: number;
  confidence: GvpPairConfidence;
}

export const GVP_CONFIRMED_PAIRS: readonly GvpConfirmedPair[] = [
  // ── exact: имя и расстояние совпадают однозначно ──────────────────────
  { placeId: '625fac2b-1790-441c-b57e-1a70ddf74dd8', placeName: 'Ичинский Вулкан', volcanoNumber: 300280, gvpName: 'Ichinsky', distanceKm: 0.1, confidence: 'exact' },
  { placeId: 'a41cf39b-5a64-43da-89f1-3ad5b9d5887c', placeName: 'Терпук', volcanoNumber: 300550, gvpName: 'Terpuk', distanceKm: 0.2, confidence: 'exact' },
  { placeId: '9fc3d079-62b5-4812-94a5-3ab168ca12ae', placeName: 'Комарова', volcanoNumber: 300220, gvpName: 'Komarov', distanceKm: 0.2, confidence: 'exact' },
  { placeId: '00a71c01-6a76-4227-91ba-c62ec50aefc1', placeName: 'Желтовская Сопка', volcanoNumber: 300030, gvpName: 'Zheltovsky', distanceKm: 0.2, confidence: 'exact' },
  { placeId: 'ce3db5c5-69c8-41b9-8a95-8b088ac2230e', placeName: 'Асача', volcanoNumber: 300058, gvpName: 'Asacha', distanceKm: 0.2, confidence: 'exact' },
  { placeId: '44be8f5a-809d-47aa-bfa9-858e65cdfe77', placeName: 'Вулкан Кроноцкий (Кроноцкая сопка)', volcanoNumber: 300150, gvpName: 'Kronotsky', distanceKm: 0.2, confidence: 'exact' },
  { placeId: 'dea62fd1-4317-431e-9b6a-da1fb6e4fea9', placeName: 'Вулкан Карымская сопка', volcanoNumber: 300130, gvpName: 'Karymsky', distanceKm: 0.2, confidence: 'exact' },
  { placeId: 'a8bef8cd-f162-48f4-9814-bf7cc0f35629', placeName: 'Дзензур', volcanoNumber: 300110, gvpName: 'Dzenzursky', distanceKm: 0.3, confidence: 'exact' },
  { placeId: '90382b16-f857-4948-842e-32a792a42cf0', placeName: 'вулкан Фусса', volcanoNumber: 290340, gvpName: 'Fuss Peak', distanceKm: 0.3, confidence: 'exact' },
  { placeId: '14f062f3-665b-4311-a99f-035480e3dce5', placeName: 'Шишейка', volcanoNumber: 300511, gvpName: 'Shisheika', distanceKm: 0.3, confidence: 'exact' },
  { placeId: 'dec9e9ec-dbe2-46d0-aed3-6d9797af2b52', placeName: 'Камень', volcanoNumber: 300251, gvpName: 'Kamen', distanceKm: 0.3, confidence: 'exact' },
  { placeId: 'f2260dcf-a94b-4532-abb0-8ba55a1c5781', placeName: 'Вулкан Тауншиц', volcanoNumber: 300140, gvpName: 'Taunshits', distanceKm: 0.4, confidence: 'exact' },
  { placeId: '20d7b84d-8145-48a3-9177-3d7f40ec9915', placeName: 'Вулкан Крашенинникова', volcanoNumber: 300190, gvpName: 'Krasheninnikov', distanceKm: 0.4, confidence: 'exact' },
  { placeId: '2b9c567e-1ffc-403e-a69a-6d72c93b88ae', placeName: 'Кошелева', volcanoNumber: 300020, gvpName: 'Koshelev', distanceKm: 0.5, confidence: 'exact' },
  { placeId: '164f612c-32da-4f0f-b261-c45c09dc2933', placeName: 'Вулкан Вилючинский', volcanoNumber: 300040, gvpName: 'Vilyuchinsky', distanceKm: 0.6, confidence: 'exact' },
  { placeId: 'c962d02c-ce85-4d9f-aa54-272944de56f2', placeName: 'Алаид', volcanoNumber: 290390, gvpName: 'Alaid', distanceKm: 0.6, confidence: 'exact' },
  { placeId: '347377fb-7e57-46f1-8ce5-e09d5b997106', placeName: 'Спокойный', volcanoNumber: 300520, gvpName: 'Spokoiny', distanceKm: 0.7, confidence: 'exact' },
  { placeId: 'f4fa9a04-a746-491e-871c-bcef3725f7d0', placeName: 'Вулкан Академии Наук', volcanoNumber: 300160, gvpName: 'Akademia Nauk', distanceKm: 0.9, confidence: 'exact' },
  { placeId: '4dad7765-bd22-4df9-8848-9189df00cb49', placeName: 'Киненин', volcanoNumber: 300420, gvpName: 'Kinenin', distanceKm: 0.9, confidence: 'exact' },
  { placeId: '6e3a46a9-104d-4181-958a-2a47698f2982', placeName: 'Вулкан Ксудач', volcanoNumber: 300050, gvpName: 'Ksudach', distanceKm: 0.9, confidence: 'exact' },
  { placeId: '5d5ab623-3faf-41d7-80c0-536130118432', placeName: 'Кальдера Курильское озеро', volcanoNumber: 300000, gvpName: 'Kurile Lake', distanceKm: 1.0, confidence: 'exact' },
  { placeId: '57918158-2844-435a-a509-c61430a2f5e8', placeName: 'Вулкан Бархатная сопка', volcanoNumber: 300065, gvpName: 'Barkhatnaya Sopka', distanceKm: 2.0, confidence: 'exact' },
  { placeId: '775aa3de-d278-4398-ac95-40e9ed616957', placeName: 'Вулкан Большой Семячик', volcanoNumber: 300200, gvpName: 'Bolshoi Semiachik', distanceKm: 2.3, confidence: 'exact' },
  { placeId: '36af71d6-94f0-41b2-98e7-b802c167505a', placeName: 'Еловский', volcanoNumber: 300460, gvpName: 'Elovsky', distanceKm: 2.5, confidence: 'exact' },
  { placeId: '77e5d9e1-4746-45fc-bb1a-8527003edf5f', placeName: 'Шивелуч', volcanoNumber: 300270, gvpName: 'Sheveluch', distanceKm: 3.4, confidence: 'exact' },
  { placeId: 'f59475f4-8295-4f38-a62c-e0c51337eac6', placeName: 'Вулкан Толбачик', volcanoNumber: 300240, gvpName: 'Tolbachik', distanceKm: 4.3, confidence: 'exact' },
  { placeId: '910476b9-fa29-4678-964b-ee23fe5754d0', placeName: 'Опала', volcanoNumber: 300080, gvpName: 'Opala', distanceKm: 0.1, confidence: 'exact' },
  { placeId: 'c280a049-f9df-4bc4-8d75-eb752652f16d', placeName: 'Кихпиныч', volcanoNumber: 300180, gvpName: 'Kikhpinych', distanceKm: 0.1, confidence: 'exact' },
  { placeId: 'e0b131dc-6dcb-472c-b0a7-90fee55204b6', placeName: 'Вулкан Камбальная сопка', volcanoNumber: 300010, gvpName: 'Kambalny', distanceKm: 0.1, confidence: 'exact' },
  { placeId: 'acb8f5d3-9b44-48ec-9a81-1c8c71e451b9', placeName: 'Вулкан Мутновский', volcanoNumber: 300060, gvpName: 'Mutnovsky', distanceKm: 0.1, confidence: 'exact' },
  { placeId: '54b106de-d81a-42af-9a41-32ee49604309', placeName: 'Вулкан Ключевская сопка', volcanoNumber: 300260, gvpName: 'Klyuchevskoy', distanceKm: 0.1, confidence: 'exact' },
  { placeId: '3031409e-4a99-4f07-80dc-0a92e0a06d02', placeName: 'Жупановский', volcanoNumber: 300120, gvpName: 'Zhupanovsky', distanceKm: 0.1, confidence: 'exact' },
  { placeId: '86431378-7709-4c8b-8d92-dab24dc1daaf', placeName: 'Безымянный', volcanoNumber: 300250, gvpName: 'Bezymianny', distanceKm: 0.1, confidence: 'exact' },
  { placeId: '3a98a68d-76c8-4835-8d6d-24f7dd867cb8', placeName: 'Вулкан Авачинский', volcanoNumber: 300100, gvpName: 'Avachinsky', distanceKm: 0.1, confidence: 'exact' },
  { placeId: 'd00dc9e7-1ee9-4a50-9071-8586740e5ee8', placeName: 'Хангар', volcanoNumber: 300272, gvpName: 'Khangar', distanceKm: 0.1, confidence: 'exact' },
  { placeId: 'dea99549-5ecb-41fe-af19-15f216eeac68', placeName: 'Корякская сопка', volcanoNumber: 300090, gvpName: 'Koryaksky', distanceKm: 0.1, confidence: 'exact' },
  { placeId: 'dc0ad1a8-d86b-4fa3-965c-90f7a577e7f7', placeName: 'Вулкан Кизимен (Щапинская сопка)', volcanoNumber: 300230, gvpName: 'Kizimen', distanceKm: 0.0, confidence: 'exact' },
  { placeId: '1eed3971-5265-44a5-b42c-9457e49e30df', placeName: 'Эбеко', volcanoNumber: 290380, gvpName: 'Ebeko', distanceKm: 0.0, confidence: 'exact' },
  { placeId: '898cdc12-cd1b-4b44-860f-b4edec4f615e', placeName: 'Гамчен', volcanoNumber: 300210, gvpName: 'Gamchen', distanceKm: 0.0, confidence: 'exact' },
  { placeId: '663aa99c-13aa-49cd-9a6b-9e1cf74b5206', placeName: 'Карпинского', volcanoNumber: 290350, gvpName: 'Karpinsky Group', distanceKm: 0.0, confidence: 'exact' },
  // id — рукописный тестовый uuid (миграция 105), не обычная случайная генерация.
  // Миграция 851 подтверждает: запись настоящая, координаты верные, только имя
  // почищено от рекламного хвоста «— затерянный мир». Пара валидна.
  { placeId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789', placeName: 'Вулкан Ходутка', volcanoNumber: 300053, gvpName: 'Khodutka', distanceKm: 0.0, confidence: 'exact' },

  // ── complex-member: вершина/часть комплекса, названного в ГВП шире ────
  { placeId: 'a85e7905-fbfb-4723-93e5-80ac91ace883', placeName: 'Вернадского', volcanoNumber: 290370, gvpName: 'Vernadsky Ridge', distanceKm: 4.0, confidence: 'complex-member' },
  { placeId: '2464bbc3-7576-48af-975b-10b6ccf24e19', placeName: 'Чашаконджа', volcanoNumber: 300450, gvpName: 'Alney-Chashakondzha', distanceKm: 4.5, confidence: 'complex-member' },
  { placeId: '5694d055-9713-44af-8bcb-670ff63bb3e9', placeName: 'Узон', volcanoNumber: 300170, gvpName: 'Uzon', distanceKm: 4.5, confidence: 'complex-member' },
  { placeId: '2886ce3b-0753-41fb-bacc-f80e3f75d1aa', placeName: 'Вулкан Горелый', volcanoNumber: 300070, gvpName: 'Gorely', distanceKm: 4.6, confidence: 'complex-member' },
  { placeId: 'f7b849df-456d-449c-9416-39683e27b472', placeName: 'Вулкан Плоский Толбачик', volcanoNumber: 300240, gvpName: 'Tolbachik', distanceKm: 3.9, confidence: 'complex-member' },
  { placeId: '5030c438-3bdd-47d5-93bc-6a571e0190cb', placeName: 'Острый Толбачик', volcanoNumber: 300240, gvpName: 'Tolbachik', distanceKm: 0.1, confidence: 'complex-member' },
  { placeId: '40538b19-13a9-4e67-becf-1cbafcdc03e4', placeName: 'Острая Зимина', volcanoNumber: 300242, gvpName: 'Zimina', distanceKm: 2.0, confidence: 'complex-member' },
  { placeId: '1141a9a2-b1be-4fdc-ab63-71b192d3398f', placeName: 'Вулкан Овальная Зимина', volcanoNumber: 300242, gvpName: 'Zimina', distanceKm: 0.3, confidence: 'complex-member' },
  { placeId: '3134db1a-9e33-46e5-b706-32e043ff71ba', placeName: 'Южный Черпук', volcanoNumber: 300273, gvpName: 'Cherpuk Group', distanceKm: 2.7, confidence: 'complex-member' },
  { placeId: '80671c42-60a3-46fd-b895-a44ea3692670', placeName: 'Группа Ольхового', volcanoNumber: 300052, gvpName: 'Olkoviy-Ozernoy Volcanic Field', distanceKm: 2.4, confidence: 'complex-member' },

  // ── distance-only: расстояние ~0 км, имя явно другое — проверить владельцу ──
  { placeId: '95f08ebc-d645-4bd1-99d6-ba88b4198046', placeName: 'Крестовский', volcanoNumber: 300261, gvpName: 'Ushkovsky', distanceKm: 0.1, confidence: 'distance-only' },
] as const;
