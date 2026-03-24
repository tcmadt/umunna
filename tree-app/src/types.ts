export interface Person {
  id: number;
  name: string;
  g: 'f' | 'm';
  pIds: number[];
  sIds: number[];
  nicks: string[];
  notes: string;
  rel: string;
  birthYear: string;
  deathYear: string;
  placeOfBirth: string;
  currentLocation: string;
  photoUrl: string;
}

export interface Union {
  id: string;
  spouses: number[];
  children: number[];
  color: string;
  married: boolean; // true only when spouses have explicit sIds to each other
}

export type PersonMap = Record<number, Person>;
