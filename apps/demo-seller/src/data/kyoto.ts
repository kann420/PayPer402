/**
 * Kyoto hotel fixtures. Fictional demo content: no real hotels, brands or guests. Real place names
 * are public landmarks. Prices are deterministic per (hotel, night), whatever day the request is made.
 */
import { createHash } from 'node:crypto';

/** Every data response says it is simulated. */
export const DEMO_SOURCE = 'Acme Data demo feed (simulated)';

export const CITIES = ['kyoto'] as const;
export const AREAS = ['gion', 'higashiyama', 'kawaramachi', 'kyoto-station', 'arashiyama'] as const;
export type Area = (typeof AREAS)[number];

export const PLACE_IDS = ['kiyomizu-dera', 'yasaka-shrine', 'gion-shijo-station', 'fushimi-inari', 'kyoto-station'] as const;
export type PlaceId = (typeof PLACE_IDS)[number];

export interface Place {
  id: PlaceId;
  name: string;
  lat: number;
  lng: number;
}

export const PLACES: Record<PlaceId, Place> = {
  'kiyomizu-dera': { id: 'kiyomizu-dera', name: 'Kiyomizu-dera', lat: 34.9949, lng: 135.785 },
  'yasaka-shrine': { id: 'yasaka-shrine', name: 'Yasaka Shrine', lat: 35.0037, lng: 135.7785 },
  'gion-shijo-station': { id: 'gion-shijo-station', name: 'Gion-Shijo Station', lat: 35.0037, lng: 135.7722 },
  'fushimi-inari': { id: 'fushimi-inari', name: 'Fushimi Inari Taisha', lat: 34.9671, lng: 135.7727 },
  'kyoto-station': { id: 'kyoto-station', name: 'Kyoto Station', lat: 34.9858, lng: 135.7588 },
};

export const HOTEL_IDS = [
  'higashiyama-stone-garden-inn',
  'gion-lantern-house',
  'yasaka-courtyard-hotel',
  'shijo-riverside-lodge',
  'kamo-river-suites',
  'kyoto-station-garden-hotel',
  'arashiyama-bamboo-retreat',
] as const;
export type HotelId = (typeof HOTEL_IDS)[number];

export interface Hotel {
  id: HotelId;
  name: string;
  area: Area;
  stars: number;
  style: string;
  tags: string[];
  rating: number;
  lat: number;
  lng: number;
  /** Off-season price per night in USD. */
  base: number;
  /** Five fictional guest reviews. */
  reviews: string[];
}

export const HOTELS: Record<HotelId, Hotel> = {
  'higashiyama-stone-garden-inn': {
    id: 'higashiyama-stone-garden-inn',
    name: 'Higashiyama Stone Garden Inn',
    area: 'higashiyama',
    stars: 4,
    style: 'Ryokan-style inn',
    tags: ['garden', 'quiet lane', 'tatami rooms'],
    rating: 4.7,
    lat: 34.9985,
    lng: 135.7815,
    base: 155,
    reviews: [
      'The inn sits on a back lane and we heard nothing at night except the garden fountain. We slept better here than anywhere else on the trip.',
      'A short walk down the hill brought us to Kiyomizu-dera in about ten minutes. We went early and had the path almost to ourselves.',
      'The stone garden was lovely with the cherry trees in bloom. Breakfast was served in a small room that looks onto it.',
      'Rooms are small but spotless, with thick walls and good futons. The staff booked us a quiet table for dinner nearby.',
      'Not the cheapest place in the area, but the calm and the location were worth it. Evenings were peaceful even at the height of the season.',
    ],
  },
  'gion-lantern-house': {
    id: 'gion-lantern-house',
    name: 'Gion Lantern House',
    area: 'gion',
    stars: 4,
    style: 'Boutique townhouse hotel',
    tags: ['central', 'lantern-lit street', 'tea room'],
    rating: 4.3,
    lat: 35.003,
    lng: 135.776,
    base: 150,
    reviews: [
      'The location is perfect for evening walks through Gion. The downside is the street outside, which stays busy and loud until after midnight.',
      'Lovely lobby and a friendly host. Our room faced the main street and we heard groups of people talking late at night.',
      'Great value for the area and very central. Bring earplugs if you are a light sleeper, because the lane is lively in the evenings.',
      'The tea room on the ground floor is a nice touch. The rooms are comfortable, though the window glass is thin and noise comes through.',
      'We loved being so close to the restaurants. It was noisy until about one in the morning on the weekend.',
    ],
  },
  'yasaka-courtyard-hotel': {
    id: 'yasaka-courtyard-hotel',
    name: 'Yasaka Courtyard Hotel',
    area: 'gion',
    stars: 5,
    style: 'Luxury courtyard hotel',
    tags: ['courtyard', 'very quiet', 'spa'],
    rating: 4.8,
    lat: 35.0025,
    lng: 135.779,
    base: 210,
    reviews: [
      'The most peaceful hotel we have stayed in. The rooms open onto a courtyard and the only sound at night was the wind in the bamboo.',
      'Superb service and an excellent spa. It is expensive, and prices rise a lot during the cherry blossom weeks.',
      'Quiet, elegant and a few minutes from Yasaka Shrine. The beds are the best of our whole trip.',
      'We booked for the blossoms and were not disappointed. The courtyard garden is stunning, and the rooms are completely silent.',
      'A real treat. Everything felt calm and unhurried, though the price was well above what we usually pay.',
    ],
  },
  'shijo-riverside-lodge': {
    id: 'shijo-riverside-lodge',
    name: 'Shijo Riverside Lodge',
    area: 'kawaramachi',
    stars: 3,
    style: 'Budget riverside lodge',
    tags: ['cheap', 'riverside', 'nightlife nearby'],
    rating: 3.7,
    lat: 35.0035,
    lng: 135.77,
    base: 90,
    reviews: [
      'Very cheap for the location and clean. But the bars on the next street are loud until three in the morning and the walls are thin.',
      'Good base for shopping and food. We could hear our neighbours through the wall and the bar street all night.',
      'The river view is nice and the price is hard to beat. Noise at night was a problem, so this is not a place for quiet sleepers.',
      'Basic rooms, friendly desk staff. Thin walls, and a party in the next room kept us up one night.',
      'You get what you pay for. The location is handy, but expect noise from the street and the nearby bars.',
    ],
  },
  'kamo-river-suites': {
    id: 'kamo-river-suites',
    name: 'Kamo River Suites',
    area: 'kawaramachi',
    stars: 4,
    style: 'Apartment-style suites',
    tags: ['river view', 'kitchenette', 'spacious'],
    rating: 4.4,
    lat: 35.005,
    lng: 135.771,
    base: 140,
    reviews: [
      'Spacious suites with a small kitchen and a view of the river. A good choice for a longer stay.',
      'The location is easy for trains and shops. The rooms are quiet because they face the river, not the street.',
      'Comfortable beds and a very clean kitchenette. The check-in was quick and the staff spoke good English.',
      'We liked the walk along the river in the evening. It books out early in the spring, so reserve well ahead.',
      'Great for families. The suite had room for all of us and the neighbourhood is calm after dark.',
    ],
  },
  'kyoto-station-garden-hotel': {
    id: 'kyoto-station-garden-hotel',
    name: 'Kyoto Station Garden Hotel',
    area: 'kyoto-station',
    stars: 3,
    style: 'Modern business hotel',
    tags: ['quiet', 'near station', 'rooftop garden'],
    rating: 4.0,
    lat: 34.987,
    lng: 135.76,
    base: 110,
    reviews: [
      'Quiet rooms and very easy for the train. Everything runs smoothly and the beds are comfortable.',
      'Good value and a calm place to sleep. It is a long walk or a bus ride to Gion, so plan on using transit.',
      'The rooftop garden is a pleasant surprise. The location suits day trips by rail, but it is far from the old streets of Gion.',
      'No noise at night at all. We walked to Gion once, which took more than half an hour.',
      'Clean, modern and cheap for what you get. Not the most atmospheric part of town, but handy for the station.',
    ],
  },
  'arashiyama-bamboo-retreat': {
    id: 'arashiyama-bamboo-retreat',
    name: 'Arashiyama Bamboo Retreat',
    area: 'arashiyama',
    stars: 4,
    style: 'Countryside retreat',
    tags: ['bamboo grove', 'hot spring bath', 'secluded'],
    rating: 4.6,
    lat: 35.015,
    lng: 135.673,
    base: 180,
    reviews: [
      'Peaceful and beautiful, with a small hot spring bath. It is far from central Kyoto, so allow time for the train.',
      'The bamboo grove is a short walk from the door. Evenings are silent.',
      'A lovely retreat after busy days in the city. Dinner was excellent, with seasonal dishes.',
      'We stayed two nights and loved the quiet. Getting to Gion takes about forty minutes by train.',
      'Great hosts and a very calm setting. Better as a break from sightseeing than as a base for it.',
    ],
  },
};

/** The cherry blossom window: March 25 to April 10 inclusive, any year. */
export const SEASON = { start: '03-25', end: '04-10', factor: 1.5 } as const;
export const MAX_NIGHTS = 14;
const MAX_JITTER = 0.03;
const DAY_MS = 86_400_000;

/** True when `date` (`YYYY-MM-DD`) is a real calendar date. */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

/** Whole days from `checkIn` to `checkOut`; both must be real dates. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
}

/** The night dates from `checkIn` (inclusive) to `checkOut` (exclusive). */
export function stayNights(checkIn: string, checkOut: string): string[] {
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  return Array.from({ length: nightsBetween(checkIn, checkOut) }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

export function inSeason(date: string): boolean {
  const monthDay = date.slice(5);
  return monthDay >= SEASON.start && monthDay <= SEASON.end;
}

/** A deterministic value in [0, 1] from SHA-256 of `key`. */
function unit(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) / 0xffffffff;
}

/** Price per night in whole USD: `base x season x (1 + j)`, `j` in [-0.03, +0.03]. */
export function nightlyPrice(hotelId: HotelId, date: string): number {
  const jitter = (unit(`${hotelId}|${date}`) * 2 - 1) * MAX_JITTER;
  return Math.round(HOTELS[hotelId].base * (inSeason(date) ? SEASON.factor : 1) * (1 + jitter));
}

/** Rooms left on one night: 1 to 6, or 0 for the sold-out hotel inside the season. */
export function roomsOn(hotelId: HotelId, date: string): number {
  if (hotelId === 'kamo-river-suites' && inSeason(date)) return 0;
  return 1 + Math.min(5, Math.floor(unit(`${hotelId}|${date}|rooms`) * 6));
}

export interface Rates {
  hotelId: HotelId;
  name: string;
  checkIn: string;
  checkOut: string;
  nights: { date: string; pricePerNight: number }[];
  total: number;
  averagePerNight: number;
  currency: 'USD';
  roomsLeft: number;
  available: boolean;
  cancellation: string;
  seasonNote?: string;
}

export const SEASON_NOTE = 'Cherry blossom season: rates for these dates are usually higher than the indicative price.';

/** Rates for a stay. `roomsLeft` is the minimum across the nights. */
export function ratesFor(hotelId: HotelId, checkIn: string, checkOut: string): Rates {
  const dates = stayNights(checkIn, checkOut);
  const nights = dates.map((date) => ({ date, pricePerNight: nightlyPrice(hotelId, date) }));
  const total = nights.reduce((sum, night) => sum + night.pricePerNight, 0);
  const roomsLeft = Math.min(...dates.map((date) => roomsOn(hotelId, date)));
  return {
    hotelId,
    name: HOTELS[hotelId].name,
    checkIn,
    checkOut,
    nights,
    total,
    averagePerNight: Math.round(total / nights.length),
    currency: 'USD',
    roomsLeft,
    available: roomsLeft > 0,
    cancellation: 'Free cancellation until 7 days before check-in.',
    ...(dates.some(inSeason) ? { seasonNote: SEASON_NOTE } : {}),
  };
}

const WALK_DETOUR = 1.3;
const WALK_METRES_PER_MINUTE = 80;
const EARTH_RADIUS_M = 6_371_000;

function haversineMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Walking distance (haversine x 1.3) in km with one decimal, and minutes at 80 m/min rounded up. */
export function walkBetween(hotelId: HotelId, placeId: PlaceId): { distanceKm: number; minutes: number } {
  const metres = haversineMetres(HOTELS[hotelId], PLACES[placeId]) * WALK_DETOUR;
  return { distanceKm: Math.round(metres / 100) / 10, minutes: Math.ceil(metres / WALK_METRES_PER_MINUTE) };
}

/**
 * An area search also returns hotels within this walk of the area's anchor landmark, the way
 * travel sites show "in or near Gion". Arashiyama has no anchor, so it matches its own hotels only.
 */
export const NEARBY_MINUTES = 15;
const AREA_ANCHORS: Record<Area, PlaceId | undefined> = {
  gion: 'yasaka-shrine',
  higashiyama: 'kiyomizu-dera',
  kawaramachi: 'gion-shijo-station',
  'kyoto-station': 'kyoto-station',
  arashiyama: undefined,
};

/** True when the hotel is in `area` or within a NEARBY_MINUTES walk of the area's anchor. */
export function inOrNear(hotelId: HotelId, area: Area): boolean {
  if (HOTELS[hotelId].area === area) return true;
  const anchor = AREA_ANCHORS[area];
  return anchor !== undefined && walkBetween(hotelId, anchor).minutes <= NEARBY_MINUTES;
}

/** Daily price index for the forecast: 100 is the off-season level. */
export function priceIndex(date: string): number {
  return inSeason(date) ? SEASON.factor * 100 : 100;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}
