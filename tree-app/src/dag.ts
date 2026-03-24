import type { PersonMap, Union } from './types';

const PALETTE = [
  '#D08A25', '#B85E28', '#52A86E', '#4E8FCC',
  '#8A52C8', '#4AB8B0', '#C05050', '#E8BF60',
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
    // Snapshot of already-placed nodes before we place any children in this subtree
    const preplacedSnapshot = new Set(placed);

    // Sort all children by birth year (oldest → leftmost)
    const sortedChildren = [...u.children].sort((a, b) =>
      (parseInt(people[a]?.birthYear || '9999')) - (parseInt(people[b]?.birthYear || '9999'))
    );
    const processedChildUs = new Set<string>();
    sortedChildren.forEach(c => {
      const cu = childUs.find(cu => cu.spouses.includes(c));
      if (cu) {
        if (!processedChildUs.has(cu.id)) {
          processedChildUs.add(cu.id);
          x = layoutSubtree(cu, x);
        }
      } else if (!placed.has(c)) {
        pos[c] = { x, y: childY };
        placed.add(c);
        x += GAPX;
      }
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

    // Clamp: parents must not be placed left of startX (would overlap prior siblings).
    // If centering would violate this, shift all children placed in this subtree rightward.
    const idealLeft = centerX - ((u.spouses.length - 1) * GAPX) / 2;
    if (idealLeft < startX) {
      const shift = startX - idealLeft;
      // Shift every node placed during this subtree call
      Object.keys(pos).forEach(id => {
        const n = Number(id);
        if (!preplacedSnapshot.has(n)) pos[n].x += shift;
      });
      // Recompute childXs after shift
      childXs.length = 0;
      childUs.forEach(cu => {
        cu.spouses.forEach(s => { if (pos[s]) childXs.push(pos[s].x); });
      });
      singles.forEach(c => { if (pos[c]) childXs.push(pos[c].x); });
      x += shift;
    }

    const finalCenterX = childXs.length
      ? (Math.min(...childXs) + Math.max(...childXs)) / 2
      : startX + ((u.spouses.length - 1) * GAPX) / 2;

    placeSpouses(u, finalCenterX - ((u.spouses.length - 1) * GAPX) / 2, parentGen * GAPY);

    // Ensure we return far enough right that next sibling doesn't overlap
    const rightEdge = finalCenterX + (u.spouses.length / 2) * GAPX + GAPX * 0.5;
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

export function getAncestors(pid: number, people: PersonMap): Set<number> {
  const result = new Set<number>();
  const visited = new Set<number>();
  const queue = [...(people[pid]?.pIds ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (people[id]) {
      result.add(id);
      people[id].pIds.forEach(p => queue.push(p));
    }
  }
  return result;
}

export function getDescendants(pid: number, unions: Union[]): Set<number> {
  const result = new Set<number>();
  const visited = new Set<number>();
  const queue = [pid];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    unions.forEach(u => {
      if (u.spouses.includes(id)) {
        u.children.forEach(c => {
          if (!result.has(c)) { result.add(c); queue.push(c); }
        });
      }
    });
  }
  return result;
}
