import type { PersonMap, Union } from './types';

const PALETTE = [
  '#f43f5e', '#3b82f6', '#a855f7', '#10b981',
  '#6366f1', '#f59e0b', '#0ea5e9', '#ec4899',
];

export function deriveUnions(people: PersonMap): Union[] {
  const ids = new Set(Object.keys(people).map(Number));
  const map = new Map<string, Union>();
  let n = 0;

  function key(a: number[]): string {
    return [...a].sort((x, y) => x - y).join(',');
  }
  function get(spouses: number[]): Union {
    const k = key(spouses);
    if (!map.has(k)) {
      map.set(k, {
        id: `u${n++}`,
        spouses: [...spouses].sort((a, b) => a - b),
        children: [],
        color: PALETTE[n % PALETTE.length],
      });
    }
    return map.get(k)!;
  }

  // Create a union for every married pair
  const seen = new Set<string>();
  Object.values(people).forEach(p => {
    (p.sIds ?? []).filter(s => ids.has(s)).forEach(s => {
      const k = key([p.id, s]);
      if (!seen.has(k)) { seen.add(k); get([p.id, s]); }
    });
  });

  // Attach children to their parents' union
  Object.values(people).forEach(p => {
    const parents = (p.pIds ?? []).filter(pid => ids.has(pid));
    if (parents.length) {
      const u = get(parents);
      if (!u.children.includes(p.id)) u.children.push(p.id);
    }
  });

  // Assign colors by index after all unions are known
  const all = [...map.values()];
  all.forEach((u, i) => { u.color = PALETTE[i % PALETTE.length]; });
  return all;
}

export function assignGens(people: PersonMap, unions: Union[]): Record<number, number> {
  const ids = new Set(Object.keys(people).map(Number));
  const gen: Record<number, number> = {};

  // Roots = people with no parents in this set
  Object.values(people).forEach(p => {
    if (!(p.pIds ?? []).some(pid => ids.has(pid))) gen[p.id] = 0;
  });

  let changed = true;
  while (changed) {
    changed = false;
    unions.forEach(u => {
      const pg = u.spouses.map(s => gen[s]).filter(g => g !== undefined) as number[];
      if (!pg.length) return;
      const childGen = Math.max(...pg) + 1;
      u.children.forEach(c => {
        if (gen[c] === undefined || gen[c] < childGen) {
          gen[c] = childGen;
          changed = true;
        }
      });
    });
  }

  Object.values(people).forEach(p => { if (gen[p.id] === undefined) gen[p.id] = 0; });
  return gen;
}

export interface Pos { x: number; y: number; }

export function computeLayout(
  people: PersonMap,
  unions: Union[],
  gens: Record<number, number>,
  NW: number,
  GAPY: number,
): Record<number, Pos> {
  const GAPX = NW + 20;
  const maxG = Math.max(...Object.values(gens), 0);
  const byG: number[][] = Array.from({ length: maxG + 1 }, () => []);
  Object.values(people).forEach(p => byG[gens[p.id]].push(p.id));

  const pos: Record<number, Pos> = {};

  for (let g = 0; g <= maxG; g++) {
    const y = g * GAPY;
    const seen = new Set<number>();
    const units: number[][] = [];

    byG[g].forEach(id => {
      if (seen.has(id)) return;
      seen.add(id);
      const sp = (people[id].sIds ?? []).find(
        s => people[s] && gens[s] === g && !seen.has(s)
      );
      if (sp !== undefined) { seen.add(sp); units.push([id, sp]); }
      else units.push([id]);
    });

    // Sort units by parent x-midpoint
    units.sort((a, b) => {
      const mid = (u: number[]) => {
        const parents = u.flatMap(id => (people[id].pIds ?? []).filter(pid => pos[pid]));
        return parents.length
          ? parents.reduce((s, pid) => s + pos[pid].x, 0) / parents.length
          : Infinity;
      };
      return mid(a) - mid(b);
    });

    let cur = 0;
    units.forEach(unit => {
      const parents = unit.flatMap(id =>
        (people[id].pIds ?? []).filter(pid => pos[pid])
      );
      const ideal = parents.length
        ? parents.reduce((s, pid) => s + pos[pid].x, 0) / parents.length
        : cur + ((unit.length - 1) * GAPX) / 2;
      const sx = Math.max(cur, ideal - ((unit.length - 1) * GAPX) / 2);
      unit.forEach((id, i) => { pos[id] = { x: sx + i * GAPX, y }; });
      cur = sx + unit.length * GAPX + GAPX * 0.5;
    });
  }

  // Bottom-up: re-center parents over their children
  for (let g = maxG - 1; g >= 0; g--) {
    unions.forEach(u => {
      const sp = u.spouses.filter(s => gens[s] === g && pos[s]);
      const ch = u.children.filter(c => gens[c] === g + 1 && pos[c]);
      if (!sp.length || !ch.length) return;
      const cMid = (Math.min(...ch.map(c => pos[c].x)) + Math.max(...ch.map(c => pos[c].x))) / 2;
      const pMid = sp.reduce((s, id) => s + pos[id].x, 0) / sp.length;
      const dx = Math.round(cMid - pMid);
      if (Math.abs(dx) < 2) return;
      sp.forEach(s => { pos[s].x += dx; });
    });
    // Push right to fix overlaps
    const row = byG[g].filter(id => pos[id]).sort((a, b) => pos[a].x - pos[b].x);
    for (let i = 1; i < row.length; i++) {
      if (pos[row[i]].x < pos[row[i - 1]].x + GAPX) {
        pos[row[i]].x = pos[row[i - 1]].x + GAPX;
      }
    }
  }

  // Shift so min x = 0
  const minX = Math.min(...Object.values(pos).map(p => p.x));
  Object.values(pos).forEach(p => { p.x -= minX; });

  return pos;
}

export interface PathDef { type: 'marriage' | 'descent'; d: string; }

export function getPaths(u: Union, pos: Record<number, Pos>): PathDef[] {
  const paths: PathDef[] = [];
  const sx = u.spouses.map(s => pos[s]?.x).filter(x => x !== undefined) as number[];
  const sy = u.spouses.map(s => pos[s]?.y).filter(y => y !== undefined) as number[];
  if (!sx.length || !sy.length) return paths;

  const by = sy[0];
  const bx = (Math.min(...sx) + Math.max(...sx)) / 2;

  if (sx.length >= 2) {
    paths.push({ type: 'marriage', d: `M ${Math.min(...sx)},${by} H ${Math.max(...sx)}` });
  }

  const ch = u.children.map(c => pos[c]).filter(Boolean) as Pos[];
  if (!ch.length) return paths;

  const cx = ch.map(p => p.x);
  const cy = ch[0].y;
  const minCx = Math.min(...cx), maxCx = Math.max(...cx);
  const cMid = (minCx + maxCx) / 2;

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

export function personUnionIds(pid: number, unions: Union[]): string[] {
  return unions
    .filter(u => u.spouses.includes(pid) || u.children.includes(pid))
    .map(u => u.id);
}
