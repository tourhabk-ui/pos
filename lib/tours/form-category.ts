/**
 * Категория формы «Новый тур» → тип активности и тип местности тура.
 *
 * До 25.09 форма отправляла activity_type/location_type = 'other' всегда, а
 * слаг категории («rybalka», «vulkani») — в location_name, и турист видел его
 * как «локацию» тура. Категория — это то, ЧТО за тур, а не ГДЕ он.
 */
export type TourActivity = 'trekking' | 'thermal' | 'boat_trip' | 'rafting' | 'fishing' | 'bears' | 'helicopter' | 'jeep' | 'other';
export type TourLocation = 'volcano' | 'hot_spring' | 'bay' | 'lake' | 'mountain' | 'river' | 'geyser' | 'other';

const MAP: Record<string, { activity: TourActivity; location: TourLocation }> = {
  vulkani:              { activity: 'trekking',   location: 'volcano' },
  geyzery:              { activity: 'trekking',   location: 'geyser' },
  rybalka:              { activity: 'fishing',    location: 'river' },
  termalnye_istochniki: { activity: 'thermal',    location: 'hot_spring' },
  medvedi:              { activity: 'bears',      location: 'other' },
  morskie_progulki:     { activity: 'boat_trip',  location: 'bay' },
  vertoletnye_tury:     { activity: 'helicopter', location: 'other' },
  trekking:             { activity: 'trekking',   location: 'other' },
  dzhip:                { activity: 'jeep',       location: 'other' },
  splav:                { activity: 'rafting',    location: 'river' },
  ozera:                { activity: 'other',      location: 'lake' },
  gory:                 { activity: 'trekking',   location: 'mountain' },
  reki:                 { activity: 'other',      location: 'river' },
};

export function categoryToTourTypes(category: string): { activity_type: TourActivity; location_type: TourLocation } {
  const m = MAP[category];
  return m ? { activity_type: m.activity, location_type: m.location } : { activity_type: 'other', location_type: 'other' };
}
