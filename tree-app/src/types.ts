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
}

export interface Union {
  id: string;
  spouses: number[];
  children: number[];
  color: string;
}

export type PersonMap = Record<number, Person>;
