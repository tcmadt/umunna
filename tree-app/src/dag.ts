import type { PersonMap, Union } from './types';

const PALETTE = [
  '#f43f5e', '#3b82f6', '#a855f7', '#10b981',
  '#6366f1', '#f59e0b', '#0ea5e9', '#ec4899',
];

// ─── DERIVE UNIONS ────────────────────────────────────────────────────────────
// Creates unions from (a) explicit sIds spouse links and (b) shared pIds.
// Only unions built from sIds get married=true (marriage bar drawn).
export function deriveUnions(people: PersonMap): Union[] {
  const ids = new Set(Object.keys(people).map(Number));
  const map = new Map<string, Union>();
  let n = 0;

  function sortKey(a: number[]): string {
    return [...a].sort((x, y) => x - y).join(',');
  }
  function getOrCreate(spouses: number[], married: boolean): Union {
    const k = sortKey(spouses);
    if (!map.has(k)) {
      map.set(k, {
        id: `u${n++}`,
        spouses: [...spouses].sort((a, b) => a - b),
        children: [],
        color: '',
        married,
      });
    }
    const u = map.get(k)!;
    // Once marked married, stays married
    if (married) u.married = true;
    return u;
  }

  // Pass 1: explicit marriage links (sIds)
  const seenPairs = new Set<string>();
  Object.values(people).forEach(p => {
    (p.sIds ?? []).filter(s => ids.has(s)).forEach(s => {
      const k = sortKey([p.id, s]);
      if (!seenPairs.has(k)) {
        seenPairs.add(k);
        getOrCreate([p.id, s], true);
      }
    });
  });

  // Pass 2: parent pairs from pIds (creates union if not already there)
  Object.values(people).forEach(p => {
    const parents = (p.pIds ?? []).filter(pid => ids.has(pid));
    if (parents.length > 0) {
      const u = getOrCreate(parents, false);
      if (!u.children.includes(p.id)) u.children.push(p.id);
    }
  });

  // Assign colors by index
  const all = [...map.values()];
  all.forEach((u, i) => { u.color = PALETTE[i % PALETTE.length]; });
  return all;
}

// ─── ASSIGN GENERATIONS ───────────────────────────────────────────────────────
// 1. Roots (no parents in dataset) = gen 0
// 2. Propagate: child gen = max(parent gens) + 1
// 3. Normalize: spouses must be in the same generation (take max)
// 4. Re-propagate after normalization
export function assignGens(people: PersonMap, unions: Union[]): Record<number, number> {
  const ids = new Set(Object.keys(people).map(Number));
  const gen: Record<number, number> = {};

  // Step 1: roots
  Object.values(people).forEach(p => {
    if (!(p.pIds ?? []).some(pid => ids.has(pid))) gen[p.id] = 0;
  });

  // Step 2: propagate down
  function propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      unions.forEach(u => {
        const parentGens = u.spouses.map(s => gen[s]).filter(g => g !== undefined) as number[];
        if (!parentGens.length) return;
        const childGen = Math.max(...parentGens) + 1;
        u.children.forEach(c => {
          if (gen[c] === undefined || gen[c] < childGen) {
            gen[c] = childGen;
            changed = true;
          }
        });
      });
    }
  }
  propagate();

  // Default any unassigned
  Object.values(people).forEach(p => { if (gen[p.id] === undefined) gen[p.id] = 0; });

  // Step 3: normalize spouse generations (take max, iterate until stable)
  let changed = true;
  while (changed) {
    changed = false;
    Object.values(people).forEach(p => {
      (p.sIds ?? []).filter(s => ids.has(s)).forEach(s => {
        const maxG = Math.max(gen[p.id] ?? 0, gen[s] ?? 0);
        if (gen[p.id] !== maxG || gen[s] !== maxG) {
          gen[p.id] = maxG;
          gen[s] = maxG;
          changed = true;
        }
      });
    });
  }

  // Step 4: re-propagate after spouse normalization
  propagate();

  return gen;
}

// ─── LAYOUT ───────────────────────────────────────────────────────────────────
export interface Pos { x: number; y: number; }

export function computeLayout(
  people: PersonMap,
  unions: Union[],
  gens: Record<number, number>,
  NW: number,
  GAPY: number,
): Record<number, Pos> {
  const GAPX = NW + 20; // center-to-center distance between adjacent nodes
  const pos: Record<number, Pos> = {};
  const placed = new Set<number>();

  // Which union (if any) produced this person as a child?
  function parentUnionOf(uid: number): Union | null {
    return unions.find(u => u.children.includes(uid)) ?? null;
  }

  // Child unions of U: unions where at least one spouse is a child of U
  function childUnionsOf(u: Union): Union[] {
    return unions.filter(cu => cu !== u && cu.spouses.some(s => u.children.includes(s)));
  }

  // Children of U who are NOT spouses in any union (leaf people)
  function singleChildrenOf(u: Union): number[] {
    return u.children.filter(c => !unions.some(cu => cu.spouses.includes(c)));
  }

  // Root unions: no spouse of theirs was produced by another union
  const rootUnions = unions.filter(u => !u.spouses.some(s => parentUnionOf(s) !== null));

  // ── Recursive subtree layout ──────────────────────────────────────────────
  // Returns the next available x after placing this subtree.
  function layoutSubtree(u: Union, startX: number): number {
    const childUs = childUnionsOf(u);
    const singles = singleChildrenOf(u);
    const parentGen = Math.max(...u.spouses.map(s => gens[s] ?? 0));
    const childY = (parentGen + 1) * GAPY;

    // ── No children: leaf union ──
    if (childUs.length === 0 && singles.length === 0) {
      placeSpouses(u, startX, parentGen * GAPY);
      return startX + Math.max(u.spouses.length, 1) * GAPX;
    }

    // ── Has children: recurse first, then center parents above ──
    let x = startX;

    childUs.forEach(cu => { x = layoutSubtree(cu, x); });

    singles.forEach(c => {
      if (!placed.has(c)) {
        pos[c] = { x, y: childY };
        placed.add(c);
      }
      x += GAPX;
    });

    // Collect all child x-positions to find center
    const childXs: number[] = [];
    childUs.forEach(cu => {
      cu.spouses.forEach(s => { if (pos[s]) childXs.push(pos[s].x); });
    });
    singles.forEach(c => { if (pos[c]) childXs.push(pos[c].x); });

    const centerX = childXs.length
      ? (Math.min(...childXs) + Math.max(...childXs)) / 2
      : startX + ((u.spouses.length - 1) * GAPX) / 2;

    placeSpouses(u, centerX - ((u.spouses.length - 1) * GAPX) / 2, parentGen * GAPY);

    // Ensure we return far enough right that next sibling doesn't overlap
    const rightEdge = centerX + (u.spouses.length / 2) * GAPX + GAPX * 0.5;
    return Math.max(x, rightEdge);
  }

  // Place spouses of a union side-by-side starting at x.
  // Already-placed spouses keep their position; unplaced ones go adjacent.
  function placeSpouses(u: Union, startX: number, y: number) {
    const alreadyPlaced = u.spouses.filter(s => placed.has(s));
    if (alreadyPlaced.length === u.spouses.length) return; // all placed

    if (alreadyPlaced.length === 0) {
      // Nobody placed yet — lay them out in order
      u.spouses.forEach((s, i) => {
        pos[s] = { x: startX + i * GAPX, y };
        placed.add(s);
      });
    } else {
      // Some already placed — anchor to rightmost placed, put unplaced to the right
      const anchorX = Math.max(...alreadyPlaced.map(s => pos[s].x));
      u.spouses.filter(s => !placed.has(s)).forEach((s, i) => {
        pos[s] = { x: anchorX + (i + 1) * GAPX, y };
        placed.add(s);
      });
    }
  }

  // ── Layout all root unions ──
  let x = 0;
  rootUnions.forEach(u => { x = layoutSubtree(u, x); });

  // ── Place any remaining unplaced people (truly isolated) ──
  Object.values(people).forEach(p => {
    if (!placed.has(p.id)) {
      pos[p.id] = { x, y: (gens[p.id] ?? 0) * GAPY };
      placed.add(p.id);
      x += GAPX;
    }
  });

  // ── Shift so leftmost node has a comfortable margin ──
  const minX = Math.min(...Object.values(pos).map(p => p.x));
  const PAD = 60;
  const shift = PAD - minX;
  if (Math.abs(shift) > 0) Object.values(pos).forEach(p => { p.x += shift; });

  return pos;
}

// ─── PATHS ────────────────────────────────────────────────────────────────────
export interface PathDef { type: 'marriage' | 'descent'; d: string; }

export function getPaths(u: Union, pos: Record<number, Pos>): PathDef[] {
  const paths: PathDef[] = [];
  const sx = u.spouses.map(s => pos[s]?.x).filter(x => x !== undefined) as number[];
  const sy = u.spouses.map(s => pos[s]?.y).filter(y => y !== undefined) as number[];
  if (!sx.length || !sy.length) return paths;

  const by = sy[0];
  const bx = (Math.min(...sx) + Math.max(...sx)) / 2;

  // Marriage bar only for explicitly married unions
  if (u.married && sx.length >= 2) {
    paths.push({ type: 'marriage', d: `M ${Math.min(...sx)},${by} H ${Math.max(...sx)}` });
  }

  const ch = u.children.map(c => pos[c]).filter(Boolean) as Pos[];
  if (!ch.length) return paths;

  const cx = ch.map(p => p.x);
  const cy = ch[0].y;
  const minCx = Math.min(...cx), maxCx = Math.max(...cx);
  const cMid = (minCx + maxCx) / 2;

  // Bezier for long in-law single-child descent
  const isLongInlaw = Math.abs(bx - cMid) > 150 && cx.length === 1;

  if (isLongInlaw) {
    const cpy = by + (cy - by) * 0.5;
    paths.push({ type: 'descent', d: `M ${bx},${by} C ${bx},${cpy} ${cx[0]},${cpy} ${cx[0]},${cy}` });
  } else {
    const trunkY = by + (cy - by) * 0.45;
    paths.push({ type: 'descent', d: `M ${bx},${by} V ${trunkY}` });
    if (cx.length > 1) {
      paths.push({ type: 'descent', d: `M ${minCx},${trunkY} H ${maxCx}` });
      cx.forEach(x => paths.push({ type: 'descent', d: `M ${x},${trunkY} V ${cy}` }));
    } else {
      paths.push({ type: 'descent', d: `M ${cx[0]},${trunkY} V ${cy}` });
    }
  }

  return paths;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
export function personUnionIds(pid: number, unions: Union[]): string[] {
  return unions
    .filter(u => u.spouses.includes(pid) || u.children.includes(pid))
    .map(u => u.id);
}
