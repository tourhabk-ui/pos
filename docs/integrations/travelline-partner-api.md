# TravelLine Partner API — что известно из первоисточников

**29.09.2026. Только чтение: документация и спецификации; API с ключами не вызывался.**

Источники: Swagger-спецификации на partner.qatl.ru (тест) и partner.tlintegration.com (прод), спецификация и сценарии TL: Dev Portal, база знаний TravelLine. Черновик прошёл отдельную перепроверку по тем же первоисточникам (все страницы и спецификации открыты заново 29.09), её поправки внесены — перечень в разделе 9. Всё, что зависит от живого ответа API, помечено «не удалось проверить» и собрано в разделах 7 и 8.

## Сводка

1. Каналу продаж нужны три модуля: Search (цены и наличие в момент брони), Content (описания объектов), Reservation (бронь); настоящие Swagger лежат на partner.qatl.ru / partner.tlintegration.com, не Petstore (раздел 1).
2. Путь брони: поиск → варианты по объекту (здесь `checksum`) → `verify` до оплаты (`createBookingToken`) → оплата → создание брони после оплаты; отмена — расчёт штрафа → `cancel` с `expectedPenaltyAmount` (раздел 3).
3. Reservation есть в двух версиях: в v1 деньги берёт канал (для Ведара это денежный путь §7 CLAUDE.md), в v2 гость платит на странице TravelLine и бронь до оплаты `Unconfirmed`. Какая версия нужна для сертификации — неизвестно (вопрос 7).
4. Авторизация — OAuth 2.0 client credentials без refresh; срок токена в источниках расходится (15 минут / 900 с против `expires_in: 1800`), нужен ли `X-API-KEY` — неясно (раздел 1).
5. Ошибки в Swagger не описаны вовсе (только `200`), бизнес-отказы — только словами; прошедшие даты поиска дают `200` с пустыми данными — третье состояние по §4.0 (разделы 3, 4).
6. Самый узкий лимит — агрегационный поиск, 3/с и 20/мин на весь клиент: без кеша на нашей стороне живой поиск упрётся в него (раздел 4).
7. Сертификация — чек-лист из 13 пунктов плюс отдельные для услуг (11) и раннего заезда / позднего выезда (6); цены интеграции в источниках нет (раздел 5).
8. Не проверено вызовом: срок токена, `X-API-KEY`, тела ошибок, коды предупреждений, сроки жизни токена брони и checksum (раздел 8).

Сокращения источников, дальше по тексту:

- **[RSV1]** https://partner.qatl.ru/api/reservation/swagger/v1/swagger.json (прод-копия: https://partner.tlintegration.com/api/reservation/swagger/v1/swagger.json)
- **[RSV2]** https://partner.qatl.ru/api/reservation/swagger/v2/swagger.json
- **[SRCH]** https://partner.qatl.ru/api/search/swagger/v1/swagger.json
- **[CONT]** https://partner.qatl.ru/api/content/swagger/v1/swagger.json
- **[GEO]** https://partner.qatl.ru/api/geo/swagger/v1/swagger.json
- **[REF]** https://partner.qatl.ru/api/reference-data/swagger/v1/swagger.json
- **[RR]** https://partner.qatl.ru/api/read-reservation/swagger/v1/swagger.json
- **[BP]** https://partner.qatl.ru/docs/booking-process/ и её https://partner.qatl.ru/docs/booking-process/index.js
- **[PUB]** https://partner.qatl.ru/docs/public-api/ и её https://partner.qatl.ru/docs/public-api/index.js
- **[DP]** https://www.travelline.ru/dev-portal/openapi/spec.json и страница https://www.travelline.ru/dev-portal/docs/api/
- **[AUTH]** https://www.travelline.ru/dev-portal/docs/scenarios/authorization/
- **[DP-SEARCH]** https://www.travelline.ru/dev-portal/docs/scenarios/search-api/search-get-accommodation-options-by-property/
- **[DP-PARTNER]** https://www.travelline.ru/dev-portal/docs/connect/partner/
- **[DP-HOTEL]** https://www.travelline.ru/dev-portal/docs/connect/hotel/
- **[KB-CONNECT]** https://www.travelline.ru/support/knowledge-base/kak-kanalu-prodazh-podklyuchit-partner-api/ (старый адрес `.../kak-podklyuchit-partner-api/` отвечает 301 сюда)
- **[KB-SEARCH]** https://www.travelline.ru/support/knowledge-base/search-api-poisk-dostupnykh-razmeshcheniy/
- **[KB-CONTENT]** https://www.travelline.ru/support/knowledge-base/content-api-opisanie-obektov-razmeshcheniya/
- **[KB-SERV]** https://www.travelline.ru/support/knowledge-base/kak-kanalu-prodazh-prodavat-uslugi-cherez-partner-api/
- **[KB-RZPV]** https://www.travelline.ru/support/knowledge-base/?id=327312 (ранний заезд и поздний выезд)
- **[KB-WHAT]** https://www.travelline.ru/support/knowledge-base/chto-takoe-partner-api/
- **[PARTNERSHIP]** https://www.travelline.ru/about/technical-partners/partnership/

---

## 1. Что это и где живёт

### Что такое Partner API

TL: Partner API — «компонент платформы TravelLine, разработанный для интеграции платформы с внешними системами: каналами продаж, турагентами и туроператорами» ([KB-WHAT]). Больше про состав модулей эта статья ничего не говорит: ни названий Search / Content / Reservation, ни Availability and Rates API в ней нет.

Состав модулей и два рода интеграции описаны на другой странице, [PARTNERSHIP] («Модули интеграции Partner API»):

- **хранение данных на стороне TravelLine**: Search API («искать доступное проживание в момент бронирования и не хранить эти данные у себя»), Content API (отели, категории номеров, тарифы), Reservation API (создавать, изменять, отменять бронирования);
- **хранение данных на стороне канала**: Availability and Rates API (цены, ограничения и доступное проживание хранятся у себя).

Для Ведара подходит первый род: хранить у себя цены и квоты гостиниц нам незачем. Это наш вывод, а не строка документации.

Цены TravelLine передаёт как есть из кабинета отеля: «Мы передаем цены, не зная брутто это или нетто. Наценки и скидки создаются на стороне канала» ([KB-SEARCH]).

### Где лежат настоящие спецификации

Swagger на https://partner.qatl.ru/docs/booking-process/ **не** Petstore. Страница подгружает `index.js` с пятью спецификациями: Content, Search, Reservation V1, Geo, Reference Data ([BP]). Petstore остался только в неиспользуемом `swagger-initializer.js`. Проверено в браузере (Playwright): страница рисует «TravelLine Partner - Content API v1» и выпадающий список из 5 API.

Вторая страница, [PUB], — другой набор из восьми: Content, Search, Read Reservation, Reference Data, PMS Universal (v2), **Reservation V2**, PMS Analytics, PMS Integration Storage. Geo и Reservation V1 в ней **нет**.

Общая спецификация dev-портала [DP] покрывает Content, Reference Data, Search, Read Reservation, а также PMS, аналитику, инвентарь и отзывы — но **не** канальный Reservation API (verify, создание, отмена). Ловушка: тег «Reservation» в [DP] — это `GET /v1/properties/{propertyId}/bookings[/{number}]`, то есть Read Reservation, а не канальная бронь. Описание канального Reservation есть только в swagger.json на partner.qatl.ru и partner.tlintegration.com ([RSV1], [RSV2]).

### Среды

| | Тест | Прод |
|---|---|---|
| Документация | https://partner.qatl.ru/docs/booking-process/ , /docs/public-api/ | https://partner.tlintegration.com/docs/booking-process/ , /docs/public-api/ |
| Базовые адреса API (`servers` в Swagger) | `https://partner.qatl.ru/api/{content,search,reservation,geo,reference-data}/` | `https://partner.tlintegration.com/api/{content,search,reservation,geo,reference-data}/` |
| Токен | `https://partner.qatl.ru/auth/token` — известен только из `securitySchemes.oAuth2...tokenUrl` тестовых Swagger ([RSV1]); на dev-портале не назван | `https://partner.tlintegration.com/auth/token` — «Рабочая среда» ([AUTH]) |
| Тестовые объекты | 7291 — назван по-разному: в [KB-SERV] «TL: PartnerAPI для сертификации услуг», в [KB-CONTENT] (скриншот ответа Geo) «PartnerAPI для интеграции»; 8616 «TL: Partner API для сертификации РЗПВ» ([KB-RZPV]); 8618 «PartnerAPI для интеграции 8» и 8619 «PartnerAPI для интеграции 9» ([KB-CONTENT], тот же скриншот) | — |

**Тест и прод отличаются** (сравнение скачанных спецификаций): Content, Search, Geo, Reference Data и Reservation v2 совпадают полностью. В Reservation v1 **только в тесте** есть агентские скидки: `roomStays[].discounts {kind: AgentCommission, amount}`, обязательное `total.discountAmount`, `total.discounts`. В прод-копии их нет ([RSV1] против прод-копии).

### Авторизация

OAuth 2.0, client credentials ([AUTH], тег «Авторизация» в [DP]):

```
POST /auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<из секрета>&client_secret=<из секрета, в лог не выводить>
```

- Токен передаётся в каждом запросе: `Authorization: Bearer <access_token>` ([AUTH]).
- Refresh-токена нет: «Обновление токена не поддерживается. После истечения срока действия запросите новый токен». Рекомендация: «Кешируйте на стороне клиента токен доступа» ([AUTH]).
- Токен — JWT, `iss` = `https://partner.tlintegration.com/auth/realms/PartnerApi`, `aud` = `TravelLine.PartnerAPI`, в claim `api_accesses` перечислены доступные API (в примере `["reservation_api","content"]`) ([AUTH], [DP]). Сам JWT из примера сюда не переносится.
- Лимит на получение токена: 3/с, 15/мин, 300/ч **с одного IP** ([DP]). Отсюда прямое требование: токен кешировать, не запрашивать на каждый вызов.

**Срок жизни токена — источники расходятся:**

- текст dev-портала: «Токен доступа действует 15 минут»; в JWT из примера `exp − iat` = 900 с, то есть тоже 15 минут ([AUTH], [DP]);
- пример ответа в сценарии авторизации: `"expires_in": 1800`, то есть 30 минут ([AUTH]).

Верить надо полю `expires_in` фактического ответа, а не этой строке. Какой срок на самом деле — **не удалось проверить** (нужен вызов с ключами; вопрос 3).

**Заголовок X-API-KEY.** Схемы в спецификациях объявлены по-разному — утверждение «ApiKey есть во всех спецификациях» неверно:

- Content, Search, Reservation v1, Geo: в `securitySchemes` две схемы, `ApiKey` (заголовок `X-API-KEY`) и `oAuth2`, и обе стоят в **одном** объекте `security`, что по OpenAPI означает «нужны обе» ([CONT], [SRCH], [RSV1], [GEO]);
- Reference Data: те же две схемы, но как **альтернативы** ([REF]);
- Reservation v2: в `securitySchemes` объявлена **только** `oAuth2`, `ApiKey` нет вовсе ([RSV2]); так же у Read Reservation — только `oauth2` ([RR]).

Dev-портал говорит только про `Authorization: Bearer`. Нужен ли `X-API-KEY` на деле и где его взять — **не удалось проверить** (вопрос 4).

### Два способа подключения

- **Прямое подключение партнёра** ([DP-PARTNER]) — «для доступа к данным нескольких средств размещения». Каналу продаж (ОТА) и туроператору — писать на partner_ota@travelline.ru, любой другой внешней системе — на public_api@travelline.ru. После обработки запроса партнёр получает тестовый личный кабинет TravelLine, где настраивает тарифы, категории номеров и способы оплаты, и тестовую среду для запросов и сертификации. После сертификации интеграция размещается в «Каталоге интеграций», откуда её может подключить любое средство размещения.
- **Подключение через средство размещения** ([DP-HOTEL]) — для доступа к конкретному объекту: отельер сам создаёт в своём кабинете подключение API, указывает доступные API и передаёт партнёру сгенерированные `client_id` и `client_secret`; партнёр работает от имени этого объекта.

База знаний описывает путь канала третьим адресом — connectivity@travelline.ru (раздел 5). Какой адрес правильный для нас — вопрос 1.

### Ключи и контекст у нас

- `TRAVELLINE_CLIENT_ID` и `TRAVELLINE_CLIENT_SECRET` лежат в секретах GitHub и в переменных приложения Timeweb (со слов владельца, прогон 624, `.github/triggers/probe-url.json`). Какого они рода — партнёрское подключение или подключение конкретного объекта — из репозитория не видно (вопрос 2).
- Вызовы с ними — **только с раннера GitHub**, ключи и токен в лог не выводятся. Для этого отчёта не делалось ни одного вызова.
- На коммите `a98a4347` (main) эти переменные не читает ни один файл репозитория. TravelLine упоминается в двух местах: маркер пробы `.github/triggers/probe-url.json` (проба PR #2087 читала **документацию**, URL-проба без ключей, а не API) и миграция `migrations/1035_prospect_blue_lagoon.sql` — база отдыха «Голубая лагуна» (озеро Микижа), чья онлайн-бронь идёт через TravelLine (объект 5194), записана в `partner_prospects`; решение, подключать ли TravelLine, там оставлено за владельцем. Кода интеграции нет; когда появится первый потребитель ключей, по правилу 10.09 CLAUDE.md он должен прийти вместе со сторожем.

---

## 2. Таблица методов

Базовые адреса — раздел 1. `*` — обязательное поле по схеме. Во всех спецификациях (Content, Search, Reservation v1/v2, Geo, Reference Data, Read Reservation) у всех методов описан только ответ `200` (см. раздел 4).

| Группа | HTTP | Адрес | Назначение | Вход | Выход | Источник |
|---|---|---|---|---|---|---|
| Auth | POST | `/auth/token` | Получить `access_token` | form: `grant_type=client_credentials`, `client_id`, `client_secret` | `{access_token, expires_in, refresh_expires_in: 0, token_type: "Bearer", not-before-policy, scope}`; ошибка `{error: "unauthorized_client", error_description}` | [AUTH] |
| Search v1 | POST | `/api/search/v1/properties/room-stays/search` | Минимальные цены по списку объектов (до 200). **checksum не отдаёт** | `SimpleSearchCriteria {propertyIds[] (≤200), adults*, childAges?, arrivalDate*, departureDate*, include?, mealPreference?, pricePreference?, corporateIds?}` | `{roomStays[] ShortRoomStay, warnings[]}` | [SRCH] |
| Search v1 | GET | `/api/search/v1/properties/{propertyId}/room-stays` | Все варианты размещения по одному объекту — **источник checksum** | path `propertyId*`; query `arrivalDate*`, `departureDate*` (YYYY-MM-DD), `adults*`, `childAges[]?`, `corporateIds[]?` | `{roomStays[] DetailedRoomStay {…, total, cancellationPolicy, mealPlanCode, checksum*, fullPlacementsName, extraServicesAvailable}, warnings[]}` | [SRCH], [KB-SEARCH] |
| Search v1 | POST | `/api/search/v1/properties/{propertyId}/services` | Доп. услуги под выбранные условия | `{stayDates, roomType{id, placements[{code}]}, ratePlan{id}, guestCount{adultCount, childAges[]}}` | услуги `{id, kind, maxQuantity, quantity, currencyCode, calculationMethod, total, quantityByGuests}` | [SRCH], [KB-SERV] |
| Search v1 | POST | `/api/search/v1/properties/{propertyId}/extra-stays` | Ранний заезд / поздний выезд | `SearchExtraStaysCriteria` | `SearchExtraStaysByPropertyResponse` | [SRCH], [KB-RZPV] |
| Reservation v1 | POST | `/api/reservation/v1/bookings/verify` | Проверка возможности брони: наличие, ограничения, цена; выдаёт `createBookingToken`. Вызывать **до оплаты** | `{booking: {propertyId*, roomStays[]* (с checksum*), customer*, services?, prepayment?, bookingComments?, corporateId?}}` | `VerifyBookingResult {booking \| null, alternativeBooking \| null, warnings[]}` | [RSV1], [KB-CONNECT] п.13 |
| Reservation v1 | POST | `/api/reservation/v1/bookings` | Создание брони **после оплаты** | `{booking: {…как verify…, createBookingToken*}}` | `CreateBookingResult {booking: CreatedBooking}` с `number`, `status`, `version` | [RSV1] |
| Reservation v1 | GET | `/api/reservation/v1/bookings/{number}` | Получить бронь по номеру | path `number*` | `GetBookingRs {booking: CreatedBooking}` | [RSV1] |
| Reservation v1 | POST | `/api/reservation/v1/bookings/{number}/verify` | Проверка возможности изменения | `{booking: {propertyId*, roomStays[]* (roomStayIndex, checksum*), customer*, version*, …}}` | `VerifyModificationRs {booking: VerifyModificationResult}` — **без** `alternativeBooking` и `warnings` | [RSV1] |
| Reservation v1 | POST | `/api/reservation/v1/bookings/{number}/modify` | Изменение брони | то же тело, `version*` | `GetBookingRs` | [RSV1] |
| Reservation v1 | GET | `/api/reservation/v1/bookings/{number}/calculate-cancellation-penalty` | Штраф на момент отмены | path `number*`; query `cancellationDateTimeUtc*` (в схеме обязателен, в описании — «if not specified…», раздел 3) | `{penaltyAmount: number}` | [RSV1] |
| Reservation v1 | POST | `/api/reservation/v1/bookings/{number}/cancel` | Отмена | `{reason?, expectedPenaltyAmount?}` | `GetBookingRs` (status `Cancelled`, `cancellation{penaltyAmount, reason, cancelledUtc}`) | [RSV1] |
| Reservation v2 | POST | `/api/reservation/v2/bookings/verify` | Проверка + способы гарантии/оплаты `guaranteeOptions` | как v1, без `prepayment` и `corporateId` | `VerifyBookingResult`, `booking.guaranteeOptions[]* {id, paymentMethodCode, paymentMethodType, prepayment, name, description, legalNotice}` | [RSV2] |
| Reservation v2 | POST | `/api/reservation/v2/bookings` | Создание с гарантией/оплатой через TravelLine | `createBookingToken*`, `customer*` (contacts обязательны), `guarantee* {id*, successUrl?, declineUrl?}` | `status Confirmed \| Cancelled \| Unconfirmed`, `guarantee.paymentUrl` | [RSV2] |
| Reservation v2 | GET | `/api/reservation/v2/bookings/{number}/calculate-cancellation-penalty` | Штраф | как v1 | `{penaltyAmount}` | [RSV2] |
| Reservation v2 | POST | `/api/reservation/v2/bookings/{number}/cancel` | Отмена | `{reason?, expectedPenaltyAmount?}` | `CancelBookingResult {booking}` | [RSV2] |
| Content v1 | GET | `/api/content/v1/properties` | Список объектов с контентом, постранично | `since?`, `count?` (≤200), `include?` (`All` — всё; пусто — только Id), `languageCode?` (`en`) | `PropertyInfoPage` (с `next`) | [CONT], [KB-CONTENT] |
| Content v1 | GET | `/api/content/v1/properties/{propertyId}` | Карточка объекта | `languageCode?` | `PropertyInfoType` | [CONT] |
| Content v1 | GET | `/api/content/v1/properties/{propertyId}/cancellation-rules` | Правила отмены объекта | path | `cancellationRules[] {referencePointKind, cancellationTerms[] {…, penaltyCalculationMethod, penaltyValue}}` | [CONT] |
| Content v1 | GET | `/api/content/v1/properties/{propertyId}/extra-stay-rules` | Правила раннего заезда / позднего выезда | path | `ExtraStayRulesResponse` | [CONT] |
| Content v1 | GET | `/api/content/v1/meal-plans`, `/room-type-categories`, `/room-amenity-categories` | Справочники питания, категорий номеров, оснащения | — | массивы справочников | [CONT] |
| Geo v1 | GET | `/api/geo/v1/properties/circle-search` | Объекты в круге | `latitude`, `longitude`, `radius` (1..30000 м), `since?`, `count?` (≤500) | `PropertiesPage` | [GEO] |
| Geo v1 | GET | `/api/geo/v1/countries/{countryCode}/properties`, `/regions/{regionId}/properties`, `/cities/{cityId}/properties` | Объекты по стране / региону / городу; результат идёт в агрегационный поиск | path; `since?`, `count?` (≤500) | `PropertiesPage {next, properties[{id, name, cityId, regionId, countryCode, longitude, latitude}]}` | [GEO], [KB-CONTENT] |
| Geo v1 | GET | `/api/geo/v1/countries`, `/countries/{countryCode}/regions`, `/countries/{countryCode}/cities` | Справочники стран, регионов, городов | `countryCode` — ISO alpha-3 (`RUS`) | списки | [GEO] |
| Reference Data v1 | POST / GET | `/api/reference-data/corporates`, `/corporates/{corporateId}` | Создать / получить корпоративного клиента | `CorporateRq` / path | `CorporateRs` | [REF] |
| Reference Data v1 | GET | `/api/reference-data/payment-methods`, `/property-amenity-types`, `/property-kinds` | Справочники способов оплаты, удобств, типов объектов | `languageCode?` | справочники | [REF] |

Для контекста, **не канальный** метод: Read Reservation — `/api/read-reservation/v1/properties/{propertyId}/bookings[/{number}]` ([RR]). Это отдельный API из [PUB] (в [DP] — под тегом «Reservation»), и отдельные лимиты «Read Reservation» в [DP] относятся к нему, а не к канальному `GET /api/reservation/v1/bookings/{number}`.

---

## 3. Бронирование подробно

### Порядок вызовов

Диаграмма из [KB-CONNECT] (6 шагов):

1. `POST api/search/v1/properties/room-stays/search` — минимальные цены по списку объектов.
2. `GET api/search/v1/properties/{propertyId}/room-stays` — все варианты по одному объекту (здесь берётся `checksum`).
3. `POST api/reservation/v1/bookings/verify` — «Актуальность цены / наличие квоты».
4. Оплата на стороне канала.
5. `POST api/reservation/v1/bookings` — создание брони, уменьшение квоты в каналах, доставка в систему отеля; в ответе номер брони.
6. Канал сохраняет номер брони.

Пункт 13 чек-листа: «Перед шагом оплаты должен быть вызван метод /bookings/verify. После оплаты вызывается метод создания бронирования» ([KB-CONNECT]).

С услугами между шагами 2 и 3 добавляется цикл `POST .../properties/{propertyId}/services`, а verify возвращает **новый** checksum с учётом услуг ([KB-SERV]). То же для раннего заезда и позднего выезда ([KB-RZPV]).

### Создание: POST /api/reservation/v1/bookings

Тест: `https://partner.qatl.ru/api/reservation/v1/bookings`, прод: `https://partner.tlintegration.com/api/reservation/v1/bookings`. Тело — `application/json` (также `text/json`, `application/*+json`) ([RSV1]).

Тело `CreateBookingRequest {booking*: CreateBookingRq}` ([RSV1]):

- `propertyId*` — строка.
- `roomStays[]*`, в каждом:
  - `stayDates* {arrivalDateTime*, departureDateTime*}` — **местное время отеля**, формат `YYYY-MM-DDThh:mm`;
  - `ratePlan* {id*}`;
  - `roomType* {id*, placements[]* {code*}}`, код вида `AdultBed-2`;
  - `guests[]* {firstName*, lastName*, middleName?, citizenship? (ISO 3166-1 alpha-3), sex? Male|Female}`;
  - `guestCount* {adultCount*, childAges?}`;
  - `checksum*` — строка;
  - необязательные: `roomStayIndex`, `services[] {id*, quantity?, quantityByGuests?}`, `extraStay {earlyArrival | lateDeparture {overriddenDateTime*}}`; `discounts[] {kind: AgentCommission, amount}` — **только в тестовой** спецификации.
- `customer* {firstName*, lastName*, middleName?, citizenship?, contacts? {phones[]* {phoneNumber*}, emails[]* {emailAddress*}}, comment? (≤250)}`. В v1 `contacts` необязательны, в v2 обязательны ([RSV2]).
- `createBookingToken*` — «Token for booking creation. Obtained by method ’Checking possibility of booking creation’. One booking can be created with one token».
- Необязательные:
  - `services[] {id*}` — услуги с `ChargeType = PerReservation`;
  - `prepayment {paymentType: Cash | PrePay, prepaidSum, remark (≤50)}`. Cash — «Payment is made at the hotel, including partial payment in the channel»; PrePay — «Full payment made in the channel»; `prepaidSum` — «Amount of payment actually received from the guest in the channel»;
  - `bookingComments[]` — «Maximum number of comments: 5 по 250 characters»;
  - `corporateId` — обязателен, если бронь ссылается на корпоративный тариф.

Ответ `200`: `CreateBookingResult {booking*: CreatedBooking}` ([RSV1]). Обязательны по схеме: `propertyId`, `roomStays`, `customer`, `total`, `taxes`, `cancellationPolicy`, `cancellation`, `createdDateTime`, `modifiedDateTime`.

- `number` — «Booking No. Returns upon successful booking», пример `20191001-1024-45675262`;
- `status` — `Confirmed | Cancelled` (в v2 ещё `Unconfirmed`);
- `version` — версия брони, нужна для изменения;
- `createdDateTime*`, `modifiedDateTime*` — UTC;
- `total* {priceBeforeTax*, taxAmount*, taxes[]}`; в тестовой спецификации ещё `discountAmount*` и `discounts[]`;
- `taxes[]* {index*, name, description}`, `currencyCode`;
- `cancellationPolicy* {freeCancellationPossible, freeCancellationDeadlineLocal, freeCancellationDeadlineUtc, penaltyAmount}`;
- `cancellation* {penaltyAmount, reason, cancelledUtc*}` — **противоречие в самой схеме**: поле в `required`, а описание его схемы `BookingCancellation` — «To be added if booking is cancelled». Что приходит в `cancellation` у подтверждённой брони (null, пустой объект, поля нет) — неизвестно (вопрос 14);
- `roomStays[]` (с `ratePlan {id, name, description, vat}`, `roomType {id, name, placements[] {code, count, kind, minAge, maxAge}}`, `checksum`, `dailyRates`, `total`, `services`, `extraStayCharge`, `cancellationPolicy`), `customer`, `prepayment`, `services`, `bookingComments`, `corporateId`.

`placements[].kind` — полный enum: `Adult | ExtraAdult | Child | ExtraChild | ChildBandWithoutBed`; `minAge`/`maxAge` указываются только для детских мест ([RSV1]).

Налоги: `priceBeforeTax` — цена без налогов и сборов, оплачиваемых при заезде; `taxAmount` — налоги и сборы, которые гость платит при заезде, без НДС (курортный сбор). НДС приходит в ответах создания и чтения брони в `roomStays[].ratePlan.vat` и `roomStays[].services[].vat` (схема `Vat {applicable*, included, percent}`), туда же относятся налоги УСН ([RSV1], [KB-SEARCH]).

### Контрольная сумма цены (checksum)

- Поле `roomStays[].checksum` (строка, обязательное) — «Check hash sum of accommodation conditions» ([RSV1]).
- **Где берётся:** `DetailedRoomStay.checksum` в ответе `GET /api/search/v1/properties/{propertyId}/room-stays`. Агрегационный поиск (`ShortRoomStay`) checksum **не** отдаёт ([SRCH]).
- **Как передаётся:** строкой в каждом `roomStay` запроса verify. В ответе verify (`VerifyBookingRs.roomStays[].checksum`) приходит актуальное значение вместе с `createBookingToken`; с ними вызывается create ([RSV1]).
- С услугами: «В ответе на этот запрос [verify], значение checksum изменится из-за включения дополнительных платных услуг в бронь. После осуществления оплаты нужно вызвать метод создания бронирования, где проводится проверка корректности checksum» ([KB-SERV], п.6; то же для раннего заезда — [KB-RZPV], п.3).
- **Если условия изменились** (цена, правила отмены, состав тарифа), verify отвечает: `booking` = null, в `alternativeBooking` — бронь на новых условиях, заполнены `warnings` ([RSV1], описание `VerifyBookingResult`).
- Чек-лист, п.7: гостю показывается сообщение при отказе «Condition change»; «Для проверки в методе /bookings/verify можно изменить значение поля checksum» ([KB-CONNECT]).
- **Наблюдение, не контракт:** пример checksum в Swagger — base64 от JSON `{"ChecksumWithOutExtras": {"TotalAmountAfterTax", "CurrencyCode", "StartPenaltyAmount"}, "ChecksumWithExtras": {…}}` ([RSV1]). Считать поле непрозрачной строкой; можно ли опираться на внутренности — вопрос 17.

### Предоплата и деньги

- Чек-лист, п.4: цена показывается из `priceBeforeTax`; «Если каналом берется предоплата, то она должна быть меньше или равна priceBeforeTax». П.5: налог не входит в предоплату и показывается отдельной строкой как оплачиваемый в отеле, либо не показывается вовсе ([KB-CONNECT]).
- **v1:** деньги берёт канал, в брони это отражается полем `prepayment` ([RSV1]).
- **v2:** в create обязателен `guarantee {id*}` (из `verify.guaranteeOptions`), поля `prepayment` нет. В ответе `guarantee.paymentUrl` — «URL to the secure hosted payment page» и статус `Unconfirmed` — «unconfirmed booking awaiting payment». Способы: `paymentMethodCode` = `AtArrival | BankCardGuarantee | BankCard | SBP`, `paymentMethodType` = `Cash | Prepay` ([RSV2]). В v2 **нет** методов GET брони и modify.

Для Ведара это развилка, а не деталь: в v1 оплату гостиницы принимаем мы, то есть она проходит по денежному пути, который CLAUDE.md §7 держит под «не трогать»; в v2 гость платит на странице TravelLine. Какая версия допустима для сертификации — не известно (вопрос 7).

### Получение: GET /api/reservation/v1/bookings/{number}

Ответ `GetBookingRs {booking: CreatedBooking}` — те же поля, что у созданной брони: `number`, `status`, `version`, `createdDateTime`, `modifiedDateTime`, `total`, `taxes`, `cancellation`, `cancellationPolicy`, `roomStays`, `customer`, `prepayment` ([RSV1]). В v2 метода нет ([RSV2]).

### Изменение (только v1)

- Проверка: `POST /api/reservation/v1/bookings/{number}/verify` — «A positive response means it is possible to modify a booking with the specified parameters». Ответ `VerifyModificationRs {booking: VerifyModificationResult}` ([RSV1]).
- Само изменение: `POST /api/reservation/v1/bookings/{number}/modify` → `GetBookingRs` ([RSV1]).
- Тело обоих: `ModifyBookingRequest {booking: ModifyBookingRq}`, обязательны `propertyId`, `roomStays`, `customer`, `version` («Booking version», берётся из брони). В `roomStays` снова обязателен `checksum`, а `roomStayIndex` — «Must be specified for modification flow». `createBookingToken` в изменении не участвует ([RSV1]).
- **Пробел:** в отличие от `VerifyBookingResult` у создания, у `VerifyModificationRs` нет полей `alternativeBooking` и `warnings` — только `booking`. Как проверка изменения сообщает, что условия изменились или изменение невозможно, в схеме не описано ([RSV1]; вопрос 13).

### Отмена и штраф

**Расчёт штрафа:** `GET /api/reservation/v1/bookings/{number}/calculate-cancellation-penalty?cancellationDateTimeUtc=…` ([RSV1]).

- **Противоречие в схеме:** `cancellationDateTimeUtc` стоит `required: true`, пример `2026-09-30T14:00:00Z`, а описание того же параметра — «Date and time for cancellation in UTC. if not specified, current local time is taken. Date and time format complies with ISO-8601 YYYY-MM-DDThh:mm:ss». То есть одновременно «обязателен» и «если не указан»; вдобавок в описании «UTC» и «current local time», а формат без `Z` при примере с `Z` (вопрос 15). Пока нет ответа — передавать всегда, явно, в UTC.
- Ответ: `ResultOfCalculatePenalty {penaltyAmount: number}` — «Penalty amount for cancellation». Числового примера в схеме нет.
- Чек-лист, п.8: «При отмене брони вызывается метод calculate-cancellation-penalty и корректно отображаются условия отмены на текущую дату» ([KB-CONNECT]). Для броней с услугами — включая стоимость услуг из предоплаты ([KB-SERV]).

**Отмена:** `POST /api/reservation/v1/bookings/{number}/cancel`, тело `BookingCancellationRq {reason?, expectedPenaltyAmount?}` ([RSV1]).

- `expectedPenaltyAmount`: «If not specified - no penalty amount checked is carried out. If specified - the query will return an error, if the expected penalty amount is not the same as the actual calculated penalty, the booking will remain uncancelled».
- Ответ: `GetBookingRs {booking}` со `status: Cancelled` и `cancellation {penaltyAmount, reason, cancelledUtc*}` (UTC).
- В v2 путь `/v2/…/cancel`, тело с теми же полями, ответ `CancelBookingResult {booking: CreatedBooking}` ([RSV2]).

Практический вывод: передавать `expectedPenaltyAmount` из только что посчитанного штрафа — тогда TravelLine не отменит бронь по сумме, которую гость не видел. Это наша рекомендация, а не требование документации.

**Политика отмены в поиске и в брони** (`CancellationPolicy`): «Current information at the time of booking. The calculate-cancellation-penalty method should be used to update the penalty information» ([RSV1]).

- `freeCancellationDeadlineLocal/Utc` = null и `freeCancellationPossible` = true — отмена только бесплатная; null и false — бесплатная отмена невозможна.
- `penaltyAmount` = null — отмена всегда бесплатна; «Depending on the date of cancellation, the amount of the penalty may vary in both directions».

Разбор комбинаций на примерах ([KB-SEARCH]):

| freeCancellationPossible | deadline | penaltyAmount | Смысл |
|---|---|---|---|
| false | null | 4000 | штраф 4000 уже сейчас |
| true | 2025-09-30T12:00 | 4000 | бесплатно до срока, дальше 4000 |
| true | null | null | бесплатно всегда |

Правила объекта отдаёт `GET /api/content/v1/properties/{propertyId}/cancellation-rules` ([CONT]):

- `penaltyCalculationMethod`: `PrepaymentPercent | FirstNights | NoPenalty | FirstNightPercent | Percent | Fixed`;
- `referencePointKind`: `ProviderArrivalTime | ProviderDepartureTime | GuestArrivalTime | CustomArrivalTime | BookingCreationTime`.

### Ограничения поиска

- Данные на год вперёд: «Максимально количество дней между… arrivalDate и departureDate равно 100», «…между датой arrivalDate и текущей датой — 365» ([KB-SEARCH]).
- **Прошедшие даты дают `200` с пустыми данными, а не ошибку** — видно на скриншоте в [KB-SEARCH] (раздел «Что делать, если запрос… не содержит ошибок и на него не приходит ответ»: «Поля arrivalDate и departureDate должны содержать даты в будущем»). Тело на скриншоте: `roomStays` и `services` — пустые массивы, а `content` — **объект** `{"services": [], "ratePlans": [], "roomTypes": []}`; поля `warnings` на скриншоте нет. Пустой ответ неотличим от «мест нет». По §4.0 CLAUDE.md это третье состояние: даты проверять до запроса, а пустоту без проверенных дат не выдавать за «мест нет» (вопрос 10).
- Время ответа ([KB-SEARCH]): поиск по одному объекту — p90 866 мс, p95 1050 мс; агрегационный — p90 1111 мс, p95 1728 мс.
- **Фильтр по питанию (`mealPreference.mealsIncluded`) — три источника, три ответа:**
  - Swagger [SRCH] (и схема `SearchApi_MealsIncluded` в [DP]): «MealsIncluded can be used only with the MealType: "All" or "MealOnly"»;
  - текст спецификации dev-портала [DP] (раздел про агрегационный поиск): «Фильтр по типу питания можно использовать только при наличии типа питания `MealOnly`» — только MealOnly;
  - база знаний [KB-SEARCH]: «только при наличии питания типа MealOnly или MealPriority».
  - При этом enum `mealType` в Swagger — только `All | MealOnly | RoomOnly`; `MealPriority` из базы знаний в нём нет. Какой набор верен — вопрос 20.

---

## 4. Ошибки и лимиты

### Коды

- **В Swagger** (Content, Search, Reservation v1/v2, Geo, Reference Data, Read Reservation) у всех методов описан только ответ `200`. Схемы тела ошибки для этих API нет — ни ProblemDetails, ни ErrorRs.
- **Общая таблица кодов dev-портала** (тег «Коды ошибок» в [DP]):

| Код | Смысл по [DP] |
|---|---|
| 400 Bad Request | «В содержании запроса есть ошибка» |
| 401 Unauthorized | нет OAuth-токена или истёк срок его действия |
| 403 Forbidden | «нет доступа к определенным методам API» |
| 404 Not Found | — |
| 429 Too Many Requests | превышен лимит |
| 500 Internal Server Error | — |
| 503 Service Unavailable | — |

- **Ошибка токена** ([AUTH]): `{"error": "unauthorized_client", "error_description": "Invalid client or Invalid client credentials"}`.
- **Предупреждения в ответе 200:** `warnings[] {code, message}`. Пример в Reservation и Search: `NotEnoughRights` / «Not enough rights to hotel». В Reference Data тот же объект описан как «Error code» / «Error message», пример `404` / «Corporate not found» ([RSV1], [SRCH], [REF]).
- **Бизнес-ошибки описаны только словами**, без кода и тела: несовпадение `expectedPenaltyAmount` («the query will return an error… the booking will remain uncancelled»); изменившиеся условия (verify отвечает `booking` = null, `alternativeBooking`, `warnings`) ([RSV1]).

### Лимиты

Тег «Лимиты» в [DP]: «Если лимит превышен, API вернет ошибку 429 Too Many Requests… ограничения применяются отдельно к каждому клиенту API… независимо от IP-адреса и количества используемых токенов доступа». Окно скользящее — секунда, минута, час.

| Группа | /с | /мин | /ч |
|---|---|---|---|
| Стандартные — «все методы API, для которых не заданы отдельные ограничения» | 50 | 200 | 3000 |
| Search: поиск по минимальной цене | 3 | 20 | 900 |
| Search: варианты размещения | 50 | 200 | 1000 |
| Search: варианты с услугами или ранним заездом / поздним выездом | 10 | 50 | 500 |
| Search: услуги или ранний заезд / поздний выезд | 10 | 100 | 1000 |
| Read Reservation (отдельный API [RR], `/api/read-reservation/…`): список | 3 | 100 | 3000 |
| Read Reservation: детали брони | 10 | 200 | 4000 |
| PMS Integration Storage и Public Reviews | 50 | 1200 | 30000 |
| Авторизация — **с одного IP** | 3 | 15 | 300 |

- Заголовки ответа: `x-ratelimit-remaining-hour`, `x-ratelimit-remaining-minute`, `x-ratelimit-remaining-second`; при `429` — `retry-after` в секундах ([DP]).
- Строки «Read Reservation» относятся к `/api/read-reservation/v1/properties/{propertyId}/bookings[/{number}]` ([RR]), а **не** к канальному `GET /api/reservation/v1/bookings/{number}`. Канальный Reservation API (verify, create, cancel, modify, get) отдельной строкой не указан. По формулировке про «все методы… для которых не заданы отдельные ограничения» он, вероятно, под стандартными 50/200/3000 — **это вывод, а не строка документации** (вопрос 18).
- Самый узкий лимит для нас — агрегационный поиск, 3 запроса в секунду и 20 в минуту на весь клиент. Живой поиск «по всей Камчатке» на каждый заход туриста в него упрётся; нужен кеш на нашей стороне. Это наш вывод.

---

## 5. Подключение и сертификация

### Шаги подключения ([KB-CONNECT])

1. Заявка на [PARTNERSHIP].
2. TravelLine присылает документацию и доступ к тестовой среде на e-mail.
3. Реализовать интеграцию на тесте.
4. Самостоятельно пройти чек-лист: по пунктам 1–8 нужны скриншоты, по 9–13 не нужны.
5. Записать видео пути бронирования по диаграмме. Путь гостя из 8 этапов: ввод условий проживания → поиск по региону/городу → поиск по отелю → ввод данных заказа → оплата → подтверждение → чтение брони (в личном кабинете, окно с деталями брони и штрафом за отмену) → отмена брони (с подтверждением отмены).
6. Скриншоты и ссылку на сайт, где можно проверить бронирование, отправить на connectivity@travelline.ru. **Адрес двоится:** видимый connectivity@travelline.ru в HTML — простой текст, а сразу перед ним стоит пустая ссылка `mailto:cm.partner@travelline.pro`; так в шагах 6 и 7. В [KB-RZPV] то же самое с пустой ссылкой `mailto:partner_ota_dynamic_dev@travelline.ru` после видимого адреса. Похоже на остатки прежних адресов — вопрос 1.
7. Анкета канала: https://disk.yandex.ru/i/SMBvGeSXArxVyA — сделать копию, заполнить, прислать ссылку туда же. Содержимое анкеты **не удалось проверить**: ссылка отдаёт капчу Яндекса.
8. За 2–3 рабочих дня техкоманда согласует сроки сертификации. «В стоимость интеграции входит только 2 сертификации»; остальные за доплату, сумма не названа.
9. Договор и оплата.
10. За 2–3 рабочих дня согласуют дату добавления канала в TL: Channel Manager и открывают его пилотному отелю.
11. Пилотный отель выбирает категории и тарифы для канала.
12. Через 5 минут после настройки канал доступен для брони; TravelLine сам сообщает каналу, что отель всё настроил.
13. Тест на живой среде по тому же чек-листу, после чего подключение открывается всем отелям.

Dev-портал описывает прямое подключение партнёра иначе ([DP-PARTNER], подробно в разделе 1): адреса partner_ota@travelline.ru (ОТА и туроператоры) и public_api@travelline.ru (прочие системы), тестовый личный кабинет TravelLine с настройкой тарифов, категорий номеров и способов оплаты, тестовая среда, а после сертификации — «Каталог интеграций».

### Основной чек-лист ([KB-CONNECT], все 13 пунктов сверены дословно)

| № | Что проверяют | Скриншот |
|---|---|---|
| 1 | Интерфейс поиска: даты заезда и выезда, город или отель, число взрослых, число детей, возраст детей | да |
| 2 | Все условия варианта внутри объекта: название номера/категории, цена, питание, штраф за отмену (размер, дата, время, часовой пояс наступления), время заезда и выезда с часовым поясом, расселение (основные и доп. места) | да |
| 3 | Нет дублирующих вариантов размещения (на тесте все варианты уникальны) | да |
| 4 | Цена из `priceBeforeTax`; предоплата не больше `priceBeforeTax` | да |
| 5 | Налог не входит в предоплату и не показывается в стоимости проживания; показывается отдельной строкой «оплачивается в отеле» или не показывается | да |
| 6 | Можно ввести минимум одного гостя и заказчика, если он не гость | да |
| 7 | Гость видит сообщение при отказе «Condition change» от `/bookings/verify` (проверяется подменой checksum) | да |
| 8 | Бронь можно отменить; вызывается `calculate-cancellation-penalty`, условия отмены на текущую дату показаны верно | да |
| 9 | Названия объектов и категорий совпадают с API | нет |
| 10 | Порядок фото объекта и категорий как в API; фото хранятся у канала | нет |
| 11 | Контент и изображения у канала; при поиске и брони Content API не вызывается, картинки из TravelLine не грузятся | нет |
| 12 | Данные запроса создания брони передаются в API корректно | нет |
| 13 | `/bookings/verify` до оплаты, создание брони после | нет |

### Чек-лист платных услуг ([KB-SERV], 11 пунктов, отдельная сертификация)

Процесс: доработка на тесте → самопроверка (пункты 1–8 со скриншотами, 9–11 без) → видео брони с услугами → скриншоты и ссылка на connectivity@travelline.ru → сертификация за 5 рабочих дней, при любом замечании доработка → за 2 рабочих дня включают функцию на проде → канал сам сообщает отелям. Тестовый объект 7291 «TL: PartnerAPI для сертификации услуг».

1. Полная информация по услуге: название, стоимость, доступное количество, изображения (если есть).
2. Услуги не дублируются.
3. Показ по `calculationMethod`: `PerPerson` (за гостя), `PerPersonByAge` (по возрасту), `PerUse` (за штуку, до `maxQuantity`), `PerStay` (за номер). Проверка — поиск на двух взрослых и детей 5 и 10 лет.
4. Можно искать услуги не на всех гостей брони (меняя `placements` и `guestCount`).
5. `PerUse` в количестве больше `quantity`, но не больше `maxQuantity`; обновлённая стоимость показана до подтверждения.
6. verify до оплаты, checksum меняется из-за услуг; create после оплаты проверяет checksum.
7. Обновлённая стоимость показана гостю до оплаты.
8. Отмена с `calculate-cancellation-penalty`, включая стоимость услуг из предоплаты.
9. Порядок фото услуг как в API; контент и изображения у канала.
10. При поиске и брони Content API не вызывается.
11. Данные запроса создания брони передаются корректно.

### Чек-лист раннего заезда и позднего выезда ([KB-RZPV], 6 пунктов, отдельная сертификация)

Тестовый объект 8616 «TL: Partner API для сертификации РЗПВ». Скриншоты по пунктам 1, 2, 4, 5; сертификация за 5 рабочих дней, включение на проде за 2.

1. Полная информация: период раннего заезда / позднего выезда, стоимость, валюта.
2. Нет дублирующих периодов (проверка — два взрослых и ребёнок 5 лет).
3. verify до оплаты, checksum меняется; create после оплаты проверяет checksum.
4. Обновлённая стоимость показана гостю до оплаты.
5. Отмена с `calculate-cancellation-penalty`, включая стоимость раннего заезда / позднего выезда из предоплаты.
6. Данные запроса создания брони передаются корректно.

### Контент и его обновление ([KB-CONTENT])

- Контент синхронизируется только по объектам, которые настроили связку с каналом в Channel Manager. Отель настроил → каналу приходит e-mail с `propertyId` и названием объекта → канал вызывает `api/content/v1/properties` и сохраняет у себя описание, категории, тарифы, услуги, фото.
- TravelLine не проверяет данные, которые вносит отельер, — проверяет канал.
- Вебхуки `propertyAdded`, `PropertyDeleted`, `PropertyModified`: канал поднимает публичный endpoint с авторизацией API-KEY или Basic; при ответе не 200 — повтор через 1 с, перерыв 45 с; события хранятся 3 дня; пачки раз в 2 минуты, внутри пачки возможны повторы. Тело — массив `[{entityId, eventCreationTime, eventType}]`.
- Даже с вебхуками раз в сутки ночью обновлять контент через Content API: доставка событий не гарантируется.

---

## 6. Примеры ответов (из документации, без наших ключей)

Значения ниже — из примеров TravelLine; где значение подставлено нами, это сказано явно. Ни одного нашего вызова за ними нет. Токены, JWT и checksum заменены заглушками в угловых скобках.

**Токен** ([AUTH]; JWT не переносится):

```json
{"access_token": "<JWT, не переносится>", "expires_in": 1800, "refresh_expires_in": 0,
 "token_type": "Bearer", "not-before-policy": 0, "scope": ""}
```

В этом же примере `exp − iat` у JWT = 900 с, а `api_accesses` = `["reservation_api","content"]` — отсюда расхождение со `expires_in` (раздел 1, вопрос 3).

**Ошибка токена** ([AUTH]):

```json
{"error": "unauthorized_client", "error_description": "Invalid client or Invalid client credentials"}
```

**Поиск по объекту** — первый из двух вариантов `roomStays` примера [DP-SEARCH], поля и значения без изменений, кроме checksum (в оригинале base64 от JSON, здесь заглушка). Поля `extraStays` и `extraServices` в примере есть (оба `null`), а в схеме `DetailedRoomStay` их нет ни в [SRCH], ни в [DP]; параметров `includeExtraStays` / `includeExtraServices`, с которыми сделан запрос сценария, у метода в схемах тоже нет. В [DP] они упомянуты только текстом («при указании `includeExtraStays=true` и `includeExtraServices=true`»), а поле `extraStays` в схемах есть лишь в ответе отдельного метода `/extra-stays` (вопрос 19):

```json
{"roomStays": [{
  "extraServicesAvailable": true, "extraStays": null, "extraServices": null,
  "propertyId": "6639",
  "roomType": {"placements": [{"code": "AdultBed-1", "count": 1, "kind": "Adult", "minAge": null, "maxAge": null}], "id": "394546"},
  "ratePlan": {"id": "440534", "corporateIds": null},
  "guestCount": {"adultCount": 1, "childAges": []},
  "stayDates": {"arrivalDateTime": "2025-09-21T08:00", "departureDateTime": "2025-09-22T20:00"},
  "availability": 75, "currencyCode": "RUB",
  "total": {"priceBeforeTax": 4100, "taxAmount": 410,
            "taxes": [{"amount": 410, "name": "Динамический", "description": "Описание динамического налога"}]},
  "cancellationPolicy": {"freeCancellationPossible": false, "freeCancellationDeadlineLocal": null,
                         "freeCancellationDeadlineUtc": null, "penaltyAmount": 410},
  "includedServices": [], "mealPlanCode": "RoomOnly",
  "checksum": "<checksum: base64 от JSON, в примере полный>",
  "fullPlacementsName": "1 взрослый на основном месте.",
  "bookingFormLink": "Booking form link"
}, {"…": "второй вариант"}], "services": [], "content": null, "warnings": [null]}
```

**Пустой ответ поиска при прошедших датах** (скриншот в [KB-SEARCH]) — `content` здесь объект, а не `null` и не массив:

```json
{"roomStays": [], "services": [], "content": {"services": [], "ratePlans": [], "roomTypes": []}}
```

**checksum из примера Swagger, раскодированный base64** ([RSV1]; наблюдение, не контракт):

```json
{"ChecksumWithOutExtras": {"TotalAmountAfterTax": "55.50", "CurrencyCode": "GBP", "StartPenaltyAmount": "9.72"},
 "ChecksumWithExtras":    {"TotalAmountAfterTax": "55.50", "CurrencyCode": "GBP", "StartPenaltyAmount": "9.72"}}
```

**Запрос создания брони**, собран из значений `example` в [RSV1]; checksum и токен брони заменены заглушками. Значения примеров между собой не согласованы (место `AdultBed-2` при одном взрослом и ребёнке 5 лет) — это набор примеров полей, а не настоящая бронь:

```json
{"booking": {
  "propertyId": "1024",
  "roomStays": [{
    "stayDates": {"arrivalDateTime": "2026-10-30T14:00", "departureDateTime": "2026-10-31T12:00"},
    "ratePlan": {"id": "133528"},
    "roomType": {"id": "82751", "placements": [{"code": "AdultBed-2"}]},
    "guests": [{"firstName": "John", "lastName": "Doe", "middleName": "Smith", "citizenship": "GBR", "sex": "Male"}],
    "guestCount": {"adultCount": 1, "childAges": [5]},
    "checksum": "<checksum из ответа verify>"
  }],
  "customer": {"firstName": "John", "lastName": "Doe",
               "contacts": {"phones": [{"phoneNumber": "+442012345678"}], "emails": [{"emailAddress": "email@example.com"}]},
               "comment": "Preferably a room with a sea view"},
  "prepayment": {"remark": "Payment in channel", "paymentType": "Cash"},
  "bookingComments": ["Preferably a room with a sea view"],
  "createBookingToken": "<createBookingToken из ответа verify>"
}}
```

**Ответ 200 на создание** — фрагмент (опущены обязательные `customer` и `cancellation`). Числа и строки — значения `example` из [RSV1]. **Подставлено нами, в Swagger примера нет:**

- `status` — выбран из enum `Confirmed | Cancelled`, у поля нет example;
- `ratePlan.vat.applicable` и `vat.included` — в схеме `Vat` у них нет example (есть только `percent: 20`), поэтому стоят заглушки типа, а не `true`;
- `placements[].kind` — нет example, показан полный enum вместо выдуманного `"Adult"`.

`cancellation` намеренно не показан: схема держит его в `required`, а описание говорит «To be added if booking is cancelled», и у брони со статусом `Confirmed` его содержимое не определено (раздел 3, вопрос 14). Заполнять его здесь значениями из примера отмены значило бы показать бронь, которая одновременно подтверждена и отменена. `discountAmount` — только в тестовой спецификации.

```json
{"booking": {
  "propertyId": "1024",
  "number": "20191001-1024-45675262",
  "status": "Confirmed",
  "version": "MjAyMzA1MTktNzI5Mi0xMTc1MzI1Mi0y",
  "createdDateTime": "2026-10-30T12:00:00Z",
  "modifiedDateTime": "2026-10-30T12:00:00Z",
  "currencyCode": "GBP",
  "total": {"priceBeforeTax": 76.47, "taxAmount": 0.81, "discountAmount": 0.21,
            "taxes": [{"amount": 0.81, "index": 1}]},
  "taxes": [{"index": 1, "name": "Lodging fee", "description": "Fee per guest, payable at check-in"}],
  "cancellationPolicy": {"freeCancellationPossible": true, "freeCancellationDeadlineLocal": "2026-10-30T12:00",
                         "freeCancellationDeadlineUtc": "2026-10-30T12:00Z", "penaltyAmount": 9.74},
  "roomStays": [{
    "roomStayIndex": 1,
    "ratePlan": {"id": "133528", "name": "Online booking", "description": "Best prices, here",
                 "vat": {"applicable": "<boolean, примера нет>", "included": "<boolean | null, примера нет>", "percent": 20}},
    "roomType": {"id": "82751", "name": "Standard",
                 "placements": [{"code": "AdultBed-2", "count": 2,
                                 "kind": "<Adult | ExtraAdult | Child | ExtraChild | ChildBandWithoutBed>"}]},
    "checksum": "<checksum>",
    "dailyRates": [{"priceBeforeTax": 76.47, "date": "2026-10-30"}]
  }]
}}
```

**verify при изменившихся условиях** — форма по описанию `VerifyBookingResult` ([RSV1]); конкретный код предупреждения в документации не приведён:

```json
{"booking": null,
 "alternativeBooking": {"…": "VerifyBookingRs с новыми условиями и createBookingToken"},
 "warnings": [{"code": "<не документирован>", "message": "…"}]}
```

**Предупреждение** ([RSV1], [SRCH]):

```json
{"code": "NotEnoughRights", "message": "Not enough rights to hotel"}
```

**Штраф:** `GET …/calculate-cancellation-penalty?cancellationDateTimeUtc=2026-09-30T14:00:00Z` → `{"penaltyAmount": <number>}` ([RSV1]; числового примера в схеме нет).

**Отмена:** `POST …/cancel` с телом `{"reason": "Booking cancellation", "expectedPenaltyAmount": <number из calculate-cancellation-penalty>}` ([RSV1]). В ответе `status: "Cancelled"` и `cancellation: {"penaltyAmount": 9.74, "reason": "Booking cancellation", "cancelledUtc": "2026-10-30T12:00:00Z"}` (значения — `example` схемы `BookingCancellation`; только здесь, у отменённой брони, заполненный `cancellation` уместен).

**Лимиты:** заголовки `x-ratelimit-remaining-hour`, `x-ratelimit-remaining-minute`, `x-ratelimit-remaining-second`; при 429 — `retry-after: <секунды>` ([DP]).

---

## 7. Что осталось неясным — вопросы для письма

Кому: Галина Константинова, connectivity@travelline.ru.

**Адрес и род подключения**

1. Куда писать каналу продаж? В [KB-CONNECT] видимый адрес connectivity@travelline.ru стоит рядом с пустой ссылкой `mailto:cm.partner@travelline.pro`, в [KB-RZPV] — с пустой `mailto:partner_ota_dynamic_dev@travelline.ru`; dev-портал ([DP-PARTNER]) называет partner_ota@travelline.ru для ОТА и public_api@travelline.ru для прочих систем.
2. Выданная нам пара `client_id` / `client_secret` — это прямое подключение партнёра (с тестовым личным кабинетом) или подключение API конкретного объекта ([DP-HOTEL])? К каким тестовым объектам она даёт доступ (7291, 8616, 8618, 8619)?

**Авторизация и среда**

3. Срок жизни токена: dev-портал пишет «15 минут», в JWT из примера `exp − iat` = 900 с, а в примере ответа `expires_in` = 1800 ([AUTH]). Какой срок в тесте и в проде? Можно ли всегда полагаться на `expires_in`?
4. Нужен ли заголовок `X-API-KEY` вместе с `Authorization: Bearer`? В Swagger Content, Search, Reservation v1 и Geo обе схемы стоят в одном требовании `security`, в Reference Data — альтернативами, в Reservation v2 и Read Reservation объявлен только oAuth2. Если нужен, где его взять?
5. Верен ли адрес токена тестовой среды `https://partner.qatl.ru/auth/token`? Он известен только из `securitySchemes` Swagger; dev-портал называет лишь рабочий адрес.
6. Какие тела и коды отдают сами методы API при 400, 401, 403, 404, 429? Описана только ошибка `/auth/token`, в Swagger у всех методов — только `200`.

**Бронирование**

7. Какую версию Reservation API нужно реализовать для сертификации канала — v1 (из /docs/booking-process/ и диаграммы чек-листа) или v2 (из /docs/public-api/, с `guarantee`, `paymentUrl`, способами AtArrival / BankCardGuarantee / BankCard / SBP и статусом Unconfirmed)? Доступна ли v2 каналам и можно ли смешивать её с v1? В v2 нет GET брони и modify — как в ней читать и менять бронь?
8. Если v1 с предоплатой в канале (`prepayment.paymentType` = Cash / PrePay, `prepaidSum`): как деньги доходят до отеля, какая модель расчётов канал–отель и какая комиссия? Агентские скидки `AgentCommission` есть в тестовой спецификации и отсутствуют в прод-спецификации — это функция в разработке или тестовый артефакт?
9. Коды и тела ошибок Reservation API: в Swagger описан только `200`. Что приходит при неверном или устаревшем checksum, повторно использованном или просроченном `createBookingToken`, несовпадении `expectedPenaltyAmount` («the query will return an error»), отсутствии мест, устаревшем `version` в modify?
10. Как отличить в поиске «мест нет» от «даты вне допустимого окна» (прошедшие даты, больше 100 ночей, дальше 365 дней)? Сейчас оба случая выглядят как `200` с пустыми `roomStays`; приходит ли в этом случае `warnings` и с каким кодом?
11. Полный список кодов `warnings`. В документации есть только `NotEnoughRights`. Какой код у отказа «Condition change» из пункта 7 чек-листа?
12. Срок жизни `createBookingToken` и checksum. Идемпотентен ли create: что будет при повторе после таймаута, если первая попытка на самом деле создала бронь? Задокументировано только «One booking can be created with one token».
13. Проверка изменения (`POST /bookings/{number}/verify`): у `VerifyModificationRs` нет `alternativeBooking` и `warnings`, в отличие от `VerifyBookingResult` у создания. Как она сообщает, что условия изменились или изменение невозможно — ошибкой HTTP, пустым `booking`, чем-то ещё?
14. `cancellation` у `CreatedBooking` в схеме обязателен, а в описании — «To be added if booking is cancelled». Что приходит в этом поле у подтверждённой брони: null, пустой объект, поле отсутствует?
15. `cancellationDateTimeUtc` в `calculate-cancellation-penalty`: в схеме обязателен, в описании — «if not specified, current local time is taken». Обязателен ли он на деле? Если не передан — берётся местное время отеля или UTC? Формат в описании `YYYY-MM-DDThh:mm:ss`, в примере — с `Z`. Как правильно?
16. Как канал узнаёт об отмене или изменении брони со стороны отеля? Вебхуки для каналов описаны только контентные (propertyAdded, PropertyDeleted, PropertyModified). Нужно опрашивать `GET /v1/bookings/{number}`? С какой частотой, в каких лимитах?
17. checksum — непрозрачная строка или можно опираться на её содержимое (в примерах это base64 от JSON с TotalAmountAfterTax, CurrencyCode, StartPenaltyAmount)?

**Лимиты**

18. Какие лимиты у канального Reservation API (verify, create, cancel, modify, get)? В таблице dev-портала отдельной строки нет; действуют ли стандартные 50/с, 200/мин, 3000/ч? Строка «Read Reservation» относится к `/api/read-reservation/…`, верно? Одинаковы ли лимиты в тестовой среде?

**Расхождения в документации**

19. Сценарий поиска на dev-портале ([DP-SEARCH]) передаёт параметры `includeExtraStays`, `includeExtraServices` и показывает поля `extraStays`, `extraServices`, которых нет в схеме `room-stays` ни в одном Swagger. Они существуют, и в какой среде?
20. `mealPreference.mealsIncluded`: Swagger — «only with MealType All or MealOnly», текст спецификации dev-портала — только MealOnly, база знаний — MealOnly или MealPriority. При этом в enum Swagger `mealType` есть только All, MealOnly и RoomOnly, а `MealPriority` нет. Какой набор верен и существует ли `MealPriority`?
21. Объект 7291 в одной статье назван «TL: PartnerAPI для сертификации услуг», в другой (скриншот ответа Geo) — «PartnerAPI для интеграции». Для основной сертификации и для сертификации услуг это один объект?

**Организационное**

22. Стоимость интеграции и сертификации: в базе знаний только «В стоимость интеграции входит только 2 сертификации», цены нет. Сколько стоит интеграция и каждая сертификация сверх двух? Отдельные сертификации услуг и РЗПВ входят в эти две?
23. Анкета канала (https://disk.yandex.ru/i/SMBvGeSXArxVyA) из нашей сети открывается капчей. Можно ли получить её файлом?

---

## 8. Не удалось проверить

Это не «всё хорошо», а список того, о чём этот отчёт не знает. Каждый пункт — отдельное неизвестное, и заполнять его догадкой нельзя (§4.0 CLAUDE.md).

1. **Поведение живого API.** С ключами не вызывался ни один метод — это запрещено условиями задачи. Поэтому неизвестны: реальный `expires_in` и срок токена (900 или 1800 с), нужен ли `X-API-KEY`, тела и коды ошибок методов, коды `warnings` (в том числе у «Condition change»), сроки жизни `createBookingToken` и checksum, что приходит в `cancellation` у подтверждённой брони, как ведёт себя `calculate-cancellation-penalty` без `cancellationDateTimeUtc`, чем отвечает проверка изменения при изменившихся условиях, существуют ли `extraStays` / `extraServices` и `MealPriority`. Проверять это можно только запуском на раннере GitHub с секретами `TRAVELLINE_CLIENT_ID` / `TRAVELLINE_CLIENT_SECRET`, без вывода ключей и токена в лог, и только методами чтения (токен, Content, Search) — ни verify, ни create, ни cancel.
2. **Содержимое анкеты канала.** https://disk.yandex.ru/i/SMBvGeSXArxVyA отдаёт капчу Яндекса; что в ней спрашивают — неизвестно.
3. **Цена.** Стоимости интеграции и сертификаций в источниках нет вовсе — есть только «В стоимость интеграции входит только 2 сертификации» ([KB-CONNECT]).
4. **Какой адрес для заявки канала действующий** — из документации не следует (три видимых адреса и два скрытых, вопрос 1).
5. **Какая версия Reservation (v1 или v2) нужна для сертификации** — документация отвечает на это двумя разными страницами (вопрос 7).

---

## 9. Поправки после перепроверки (29.09)

Черновик перепроверен отдельным проходом по тем же первоисточникам. Выдумки в ключевых местах не нашлось: адрес и тело создания брони, передача checksum, отмена и штраф, лимиты и все 13 пунктов чек-листа совпали дословно. Исправлено:

- Availability and Rates API и набор Search / Content / Reservation приписаны [PARTNERSHIP], а не [KB-WHAT] — в статье «Что такое Partner API» их нет.
- Пример ответа create: `vat.applicable` / `vat.included`, `placements[].kind` и `status` помечены как подставленные (в Swagger примера нет); заполненный `cancellation` при `Confirmed` убран, противоречие схемы (`required` против «To be added if booking is cancelled») названо.
- `ApiKey` объявлен не во всех спецификациях: в Reservation v2 (и Read Reservation) — только oAuth2.
- Состав /docs/public-api/: Geo и Reservation V1 в нём нет.
- `content` в пустом ответе поиска — объект `{services, ratePlans, roomTypes}`, не массив.
- Во фрагмент примера поиска возвращены `"extraStays": null` и `"extraServices": null`; уточнено, что в [DP] они есть только текстом.
- Противоречие по `mealsIncluded` — три источника, не два.
- Enum `kind` размещения — полный, с `ExtraAdult` и `ChildBandWithoutBed`.
- Добавлено: лимиты Read Reservation относятся к `/api/read-reservation/…`; пробел `VerifyModificationRs`; страницы прямого подключения и подключения через объект на dev-портале; чек-лист РЗПВ (6 пунктов, объект 8616); разные имена объекта 7291; пустые `mailto` рядом с видимым адресом; противоречие `cancellationDateTimeUtc`.
- Путь гостя на диаграмме — 8 этапов; в репозитории TravelLine упоминается не только маркером пробы, но и миграцией 1035.
- Checksum-строки из примеров заменены заглушками; JWT из примера не переносится.
