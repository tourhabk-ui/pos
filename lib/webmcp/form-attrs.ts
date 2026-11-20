/**
 * WebMCP, декларативная часть: атрибуты форм, по которым Chrome сам строит
 * инструмент из формы (объяснение webmachinelearning/webmcp,
 * declarative-api-explainer.md; в спецификацию эта часть пока не входит,
 * и имена атрибутов могут поменяться).
 *
 * Имя параметра — атрибут `name` поля. Поэтому у галочки согласия на ПД
 * имени нет и не будет: агент её не заполняет, её ставит человек.
 *
 * Правило одно: форма заявки НИКОГДА не получает `toolautosubmit`. Без него
 * браузер, заполнив форму, переводит фокус на кнопку отправки, а агент
 * просит человека проверить поля и нажать её самому. Автоотправка дозволена
 * только поиску — он ничего не пишет и никому ничего не отправляет.
 * Держит tests/unit/webmcp-form-attrs.test.tsx.
 */

/** Атрибуты формы-инструмента. Строки — чтобы React вывел их в HTML как есть. */
export interface WebMcpFormAttrs {
  toolname: string;
  tooldescription: string;
  toolautosubmit?: '';
}

/** Поиск туров каталога: только чтение, можно отправлять агенту самому. */
export const CATALOG_SEARCH_FORM_TOOL: WebMcpFormAttrs = {
  toolname: 'vedar_catalog_search',
  tooldescription: 'Найти туры по Камчатке в каталоге Ведара по словам из названия (вулкан, рыбалка, медведи, вертолёт). '
    + 'Открывает каталог с этим отбором; порядок туров одно правило для всех, место в списке не продаётся. '
    + 'Search Kamchatka tours on Vedar by title words.',
  toolautosubmit: '',
};

/** Заявка на тур: агент заполняет, отправляет человек. */
export const TOUR_REQUEST_FORM_TOOL: WebMcpFormAttrs = {
  toolname: 'vedar_tour_request',
  tooldescription: 'Заполнить заявку на этот тур Ведара: число участников, имя, телефон, почта, пожелания оператору. '
    + 'Дату человек выбирает в календаре формы. Это заявка, не бронь: места подтверждает оператор, оплата — ему напрямую. '
    + 'Форма не отправляется сама: попроси человека проверить поля, поставить галочку согласия на обработку данных и нажать кнопку. '
    + 'Fill in a tour request; the person reviews it, gives consent and submits it.',
};

/** Описание параметра — атрибут поля формы. */
export function toolParam(description: string): { toolparamdescription: string } {
  return { toolparamdescription: description };
}

/**
 * Отправку формы начал агент (`SubmitEvent.agentInvoked`, объяснение WebMCP).
 * Значение для отправки, которую нажал человек, объяснение не называет;
 * признак читается только там, где ошибка безвредна — в поиске.
 */
export function isAgentInvokedSubmit(event: Event): boolean {
  return (event as { agentInvoked?: unknown }).agentInvoked === true;
}
