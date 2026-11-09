/** Виды деятельности в заявке на подключение (/partner). */
export const BUSINESS_TYPES = {
  tours: 'Туры и экскурсии',
  fishing: 'Рыбалка',
  stay: 'Гостевой дом, база, отель',
  car_rental: 'Прокат автомобилей',
  transfer: 'Трансфер',
  guide: 'Гид',
  other: 'Другое',
} as const;

export type BusinessType = keyof typeof BUSINESS_TYPES;
export const BUSINESS_TYPE_KEYS = Object.keys(BUSINESS_TYPES) as [BusinessType, ...BusinessType[]];
