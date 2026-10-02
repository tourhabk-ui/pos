/**
 * Запрос первой загрузки витрины жилья — один для сервера и браузера.
 * Сервер отрисовывает по нему первую страницу, браузер по нему решает, что
 * пришедшее с сервера — ровно то, что он спросил бы сам, и не спрашивает
 * повторно. Разойдись они — человек увидел бы на миг одну выдачу, а потом
 * другую.
 */
export const ACCOMMODATIONS_FIRST_PAGE_LIMIT = 20;
export const ACCOMMODATIONS_DEFAULT_SORT = 'rating_desc';
export const ACCOMMODATIONS_FIRST_PAGE_QUERY =
  `page=1&limit=${ACCOMMODATIONS_FIRST_PAGE_LIMIT}&sort=${ACCOMMODATIONS_DEFAULT_SORT}`;
