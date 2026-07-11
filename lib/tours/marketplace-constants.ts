/**
 * Общие константы каталога туров — без серверных зависимостей: импортируются
 * и клиентом (MarketplaceClient), и серверными страницами (/catalog,
 * /marketplace) для одинакового разбора deep-link параметра price.
 */

export const PRICE_RANGES: { value: string; label: string; min?: number; max?: number }[] = [
  { value: '',              label: 'Любая цена',         min: undefined, max: undefined },
  { value: '0-25000',       label: 'до 25 000 ₽',        min: 0,         max: 25000 },
  { value: '25000-60000',   label: '25 000 — 60 000 ₽',  min: 25000,     max: 60000 },
  { value: '60000-150000',  label: '60 000 — 150 000 ₽', min: 60000,     max: 150000 },
  { value: '150000',        label: 'от 150 000 ₽',       min: 150000,    max: undefined },
];
