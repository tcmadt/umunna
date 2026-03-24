import { useState, useMemo } from 'react';
import { useSheetData } from './useSheetData';
import {
  deriveUnions, assignGens, computeLayout, getPaths,
  getAncestors, getDescendants,
} from './dag';
import type { Person } from './types';

const NW = 110, NH = 36, GAPY = 160, PAD = 80, TOP_PAD = 60;

const LANE_LABELS = [
  'GREAT-GRANDPARENTS', 'GREAT-GRANDPARENTS',
  'GRANDPARENTS', 'GRANDPARENTS',
  'PARENTS', 'PARENTS',
  'MAIN GEN.', 'CHILDREN',
];

export default function App() {
  const { people, loading, error } = useSheetData(Infinity);
  const [hoveredPerson, setHoveredPerson] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  const [focusedViewBox, setFocusedViewBox] = useState<string | null>(null);

  const { unions, pos, svgW, svgH, lanes } = useMemo(() => {
    const empty = {
      unions: [], gens: {} as Record<number, number>,
      pos: {} as Record<number, { x: number; y: number }>,
      svgW: 800, svgH: 400,
      lanes: [] as { g: number; y: number; h: number; label: string }[],
    };
    if (!Object.keys(people).length) return empty;

    const unions = deriveUnions(people);
    const gens = assignGens(people, unions);
    const pos = computeLayout(people, unions, gens, NW, GAPY);

    Object.values(pos).forEach(p => { p.y += TOP_PAD; });

    const maxG = Math.max(...Object.values(gens), 0);
    const xs = Object.values(pos).map(p => p.x);
    const svgW = Math.max(800, Math.max(...xs) + NW / 2 + PAD);
    const svgH = maxG * GAPY + NH + PAD + TOP_PAD * 2;

    const lanes = Array.from({ length: maxG + 1 }, (_, g) => ({
      g,
      y: Math.max(0, g * GAPY - GAPY / 2 + TOP_PAD),
      h: GAPY,
      label: LANE_LABELS[g] ?? `GEN ${g}`,
    }));

    return { unions, gens, pos, svgW, svgH, lanes };
  }, [people]);

  // ── Highlight state ─────────────────────────────────────────────────────────
  // hover: 1-degree neighborhood; bloodline: full ancestor+descendant chain
  const highlight = useMemo(() => {
    if (hoveredPerson !== null) {
      const person = people[hoveredPerson];
      if (!person) return null;
      const spouseIds = new Set<number>();
      const parentIds = new Set<number>(person.pIds);
      const childIds = new Set<number>();
      const siblingIds = new Set<number>();
      unions.forEach(u => {
        if (u.spouses.includes(hoveredPerson)) {
          u.spouses.forEach(s => { if (s !== hoveredPerson) spouseIds.add(s); });
          u.children.forEach(c => childIds.add(c));
        }
        if (u.children.includes(hoveredPerson)) {
          u.children.forEach(s => { if (s !== hoveredPerson) siblingIds.add(s); });
        }
      });
      return { mode: 'hover' as const, id: hoveredPerson, spouseIds, parentIds, childIds, siblingIds };
    }
    if (selected !== null) {
      return {
        mode: 'bloodline' as const,
        id: selected,
        ancestors: getAncestors(selected, people),
        descendants: getDescendants(selected, unions),
      };
    }
    return null;
  }, [hoveredPerson, selected, people, unions]);

  const activePaths = useMemo(() => {
    const s = new Set<string>();
    if (!highlight) return s;
    if (highlight.mode === 'hover') {
      unions.forEach(u => {
        if (u.spouses.includes(highlight.id) || u.children.includes(highlight.id)) s.add(u.id);
      });
    } else {
      const blood = new Set([highlight.id, ...highlight.ancestors, ...highlight.descendants]);
      unions.forEach(u => {
        if (u.spouses.some(id => blood.has(id)) || u.children.some(id => blood.has(id))) s.add(u.id);
      });
    }
    return s;
  }, [highlight, unions]);

  const hasHighlight = highlight !== null;
  const selectedPerson: Person | null = selected !== null ? (people[selected] ?? null) : null;

  // ── Visibility: hide childless-only spouses unless their partner is selected ─
  const hiddenByDefault = useMemo(() => {
    const s = new Set<number>();
    Object.values(people).forEach(person => {
      const isChild = unions.some(u => u.children.includes(person.id));
      if (isChild) return;
      const hasChildrenInAnyUnion = unions.some(u =>
        u.spouses.includes(person.id) && u.children.length > 0
      );
      if (hasChildrenInAnyUnion) return;
      if (unions.some(u => u.spouses.includes(person.id))) s.add(person.id);
    });
    return s;
  }, [people, unions]);

  const hiddenIds = useMemo(() => {
    const result = new Set(hiddenByDefault);
    if (selected !== null) {
      unions.forEach(u => {
        if (u.spouses.includes(selected))
          u.spouses.forEach(s => result.delete(s));
      });
    }
    return result;
  }, [hiddenByDefault, selected, unions]);

  // ── Search ──────────────────────────────────────────────────────────────────
  const searchHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return Object.values(people).filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.nicks.some(n => n.toLowerCase().includes(q))
    ).map(p => p.id);
  }, [searchQuery, people]);

  const VB_W = 500, VB_H = 320;
  function centerOn(id: number) {
    const p = pos[id];
    if (!p) return;
    setFocusedViewBox(`${p.x - VB_W / 2} ${p.y - VB_H / 2} ${VB_W} ${VB_H}`);
  }
  function stepSearch(dir: 1 | -1) {
    if (!searchHits.length) return;
    const next = (searchIdx + dir + searchHits.length) % searchHits.length;
    setSearchIdx(next);
    centerOn(searchHits[next]);
  }

  if (loading) return (
    <div style={styles.page}>
      <div style={{ color: '#8A7060', fontSize: 13, letterSpacing: 2 }}>Loading family data…</div>
    </div>
  );

  if (error) return (
    <div style={styles.page}>
      <div style={{ color: '#C05050', fontSize: 13 }}>{error}</div>
    </div>
  );

  return (
    <div style={styles.page}>

      {/* Slim header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 20px', flexShrink: 0, flexWrap: 'wrap' }}>
        <h1 style={{ color: '#F0E8D8', fontSize: 14, letterSpacing: 4, fontWeight: 300, margin: 0, fontFamily: "'Fraunces', Georgia, serif" }}>
          UMUNNA — FAMILY TREE
        </h1>
        <p style={{ color: '#8A7060', fontSize: 10, letterSpacing: 1, margin: 0, flex: 1 }}>
          Hover to explore · click for bloodline
        </p>
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="text"
            placeholder="Search name…"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setSearchIdx(0); if (e.target.value.trim()) { const hits = Object.values(people).filter(p => p.name.toLowerCase().includes(e.target.value.trim().toLowerCase()) || p.nicks.some(n => n.toLowerCase().includes(e.target.value.trim().toLowerCase()))).map(p => p.id); if (hits.length) { const p = pos[hits[0]]; if (p) setFocusedViewBox(`${p.x - VB_W/2} ${p.y - VB_H/2} ${VB_W} ${VB_H}`); } } else { setFocusedViewBox(null); } }}
            style={styles.searchInput}
          />
          {searchHits.length > 0 && (
            <>
              <span style={{ color: '#8A7060', fontSize: 10 }}>{searchIdx + 1}/{searchHits.length}</span>
              <button onClick={() => stepSearch(-1)} style={styles.searchBtn}>‹</button>
              <button onClick={() => stepSearch(1)} style={styles.searchBtn}>›</button>
            </>
          )}
          {focusedViewBox && (
            <button onClick={() => { setFocusedViewBox(null); setSearchQuery(''); }} style={styles.searchBtn} title="Reset view">⌂</button>
          )}
        </div>
      </div>

      {/* Tree card — fills remaining height */}
      <div style={styles.card}>
        <svg
          viewBox={focusedViewBox ?? `0 0 ${svgW} ${svgH}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block', transition: 'all 0.5s ease' }}
        >
          {/* Lane banding */}
          {lanes.map((lane, i) => (
            <g key={i}>
              <rect x={0} y={lane.y} width={svgW} height={lane.h}
                fill={i % 2 === 0 ? '#130A02' : '#0E0702'} />
              <text x={10} y={lane.y + 14} fontSize={7.5} fill="#2a1408"
                fontFamily="'Outfit', sans-serif" letterSpacing={1.5}>
                {lane.label}
              </text>
            </g>
          ))}

          {/* Union paths */}
          {unions.map(u => {
            if (u.spouses.some(s => hiddenIds.has(s))) return null;
            const paths = getPaths(u, pos);
            const isActive = activePaths.has(u.id);
            const dimmed = hasHighlight && !isActive;
            return paths.map((p, i) => (
              <path key={`${u.id}-${i}`} d={p.d} fill="none"
                stroke={dimmed ? '#1a0c02' : u.color}
                strokeWidth={isActive
                  ? (p.type === 'marriage' ? 2.5 : 3)
                  : (p.type === 'marriage' ? 1.5 : 2)}
                strokeDasharray={p.type === 'marriage' ? '5,4' : 'none'}
                strokeOpacity={dimmed ? 1 : isActive ? 1 : 0.65}
                style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
              />
            ));
          })}

          {/* Person nodes */}
          {Object.values(people).map(person => {
            const p = pos[person.id];
            if (!p) return null;
            if (hiddenIds.has(person.id)) return null;
            const isFemale = person.g === 'f';
            const isSelected = person.id === selected;

            // Base warm earthy colors
            let fill   = isFemale ? '#160D05' : '#1C0E06';
            let stroke = isFemale ? '#D08A25' : '#B85E28';
            let txtClr = isFemale ? '#F0E8D8' : '#E8BF60';
            let nodeOpacity = 1;
            let sw = isSelected ? 2.5 : 1;

            // Search hit glow (overrides dimming but not hover/bloodline)
            const isSearchHit = searchHits.includes(person.id);
            const isCurrentHit = searchHits[searchIdx] === person.id;

            if (highlight) {
              if (highlight.mode === 'hover') {
                if (person.id === highlight.id) {
                  stroke = '#F0E8D8'; sw = 3;
                } else if (highlight.spouseIds.has(person.id)) {
                  stroke = '#D08A25'; sw = 2;
                } else if (highlight.parentIds.has(person.id)) {
                  stroke = '#B85E28'; sw = 2;
                } else if (highlight.childIds.has(person.id)) {
                  stroke = '#E8BF60'; sw = 2;
                } else if (highlight.siblingIds.has(person.id)) {
                  stroke = '#4AB8B0'; sw = 2;
                } else {
                  fill = '#0C0702'; stroke = '#1a0c02'; txtClr = '#3a2010'; nodeOpacity = 0.35;
                }
              } else { // bloodline
                if (person.id === highlight.id) {
                  fill = '#2a1a08'; stroke = '#F0E8D8'; sw = 3;
                } else if (highlight.ancestors.has(person.id)) {
                  stroke = '#D08A25'; sw = 2;
                } else if (highlight.descendants.has(person.id)) {
                  stroke = '#E8BF60'; sw = 2;
                } else {
                  fill = '#0C0702'; stroke = '#120a02'; txtClr = '#2a1808'; nodeOpacity = 0.18;
                }
              }
            }

            return (
              <g key={person.id} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredPerson(person.id)}
                onMouseLeave={() => setHoveredPerson(null)}
                onClick={() => setSelected(isSelected ? null : person.id)}
              >
                <rect x={p.x - NW / 2} y={p.y - NH / 2} width={NW} height={NH} rx={5}
                  fill={fill}
                  stroke={isCurrentHit ? '#F0E8D8' : isSearchHit ? '#E8BF60' : stroke}
                  strokeWidth={isCurrentHit ? 3 : isSearchHit ? 2 : sw}
                  opacity={nodeOpacity}
                  style={{ transition: 'all 0.2s' }} />
                {person.photoUrl ? (
                  <>
                    <clipPath id={`clip-${person.id}`}>
                      <circle cx={p.x - NW / 2 + 18} cy={p.y} r={12} />
                    </clipPath>
                    <image
                      href={person.photoUrl}
                      x={p.x - NW / 2 + 6} y={p.y - 12} width={24} height={24}
                      clipPath={`url(#clip-${person.id})`}
                      preserveAspectRatio="xMidYMid slice"
                      opacity={nodeOpacity}
                    />
                    <text x={p.x - NW / 2 + 34} y={p.y} dominantBaseline="middle"
                      fontSize={9} fill={txtClr} fontFamily="'Outfit', sans-serif"
                      opacity={nodeOpacity}
                      style={{ transition: 'fill 0.2s, opacity 0.2s', pointerEvents: 'none' }}>
                      {person.name.split(' ')[0]}
                    </text>
                  </>
                ) : (
                  <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle"
                    fontSize={9} fill={txtClr} fontFamily="'Outfit', sans-serif"
                    opacity={nodeOpacity}
                    style={{ transition: 'fill 0.2s, opacity 0.2s', pointerEvents: 'none' }}>
                    {person.name.split(' ')[0]}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>


      {/* Info panel */}
      {selectedPerson && (
        <InfoPanel person={selectedPerson} people={people} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function InfoPanel({ person, people, onClose }: {
  person: Person;
  people: Record<number, Person>;
  onClose: () => void;
}) {
  const isFemale = person.g === 'f';
  const accent = isFemale ? '#D08A25' : '#B85E28';
  const parents  = person.pIds.map(id => people[id]).filter(Boolean) as Person[];
  const spouses  = person.sIds.map(id => people[id]).filter(Boolean) as Person[];
  const children = Object.values(people).filter(p => p.pIds.includes(person.id));

  return (
    <div style={styles.panel}>
      <div style={{ ...styles.panelHead, borderBottom: `1px solid ${accent}44` }}>
        <div>
          {person.photoUrl ? (
            <img src={person.photoUrl} alt={person.name}
              style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', marginBottom: 8, border: `2px solid ${accent}` }} />
          ) : (
            <div style={{ fontSize: 24, marginBottom: 4 }}>{isFemale ? '👩🏾' : '👨🏾'}</div>
          )}
          <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 15, color: accent }}>
            {person.name}
          </div>
          {person.nicks.length > 0 && (
            <div style={{ fontSize: 11, color: '#6b4c2a', fontStyle: 'italic', marginTop: 2 }}>
              "{person.nicks.join(', ')}"
            </div>
          )}
        </div>
        <button onClick={onClose} style={styles.closeBtn}>✕</button>
      </div>
      <div style={{ padding: '12px 16px', fontSize: 12, lineHeight: 1.9, color: '#8A7060', fontFamily: "'Outfit', sans-serif" }}>
        {person.birthYear && <div><span style={styles.lbl}>Born</span>{person.birthYear}</div>}
        {person.deathYear && <div><span style={styles.lbl}>Died</span>{person.deathYear}</div>}
        {person.placeOfBirth && <div><span style={styles.lbl}>From</span>{person.placeOfBirth}</div>}
        {person.currentLocation && <div><span style={styles.lbl}>Lives</span>{person.currentLocation}</div>}
        {person.notes && <div style={{ marginTop: 8, color: '#6b4c2a', lineHeight: 1.6 }}>{person.notes}</div>}
        {parents.length > 0 && <PanelSection label="Parents" items={parents} accent={accent} />}
        {spouses.length > 0 && <PanelSection label={spouses.length > 1 ? 'Spouses' : 'Spouse'} items={spouses} accent={accent} />}
        {children.length > 0 && <PanelSection label="Children" items={children} accent={accent} />}
      </div>
    </div>
  );
}

function PanelSection({ label, items, accent }: { label: string; items: Person[]; accent: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 9, letterSpacing: 1.5, color: accent, textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      {items.map(p => (
        <div key={p.id} style={{ color: '#F0E8D8', fontSize: 12, fontFamily: "'Outfit', sans-serif" }}>{p.name}</div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: '#0C0702',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: "'Outfit', Georgia, sans-serif",
  },
  card: {
    flex: 1,
    background: '#160D05',
    borderTop: '1px solid #3A1E0C',
    borderBottom: '1px solid #3A1E0C',
    overflow: 'hidden',
    position: 'relative',
  },
  legend: {
    display: 'flex', gap: 8, padding: '8px 20px',
    flexWrap: 'wrap', justifyContent: 'center',
    flexShrink: 0,
  },
  pill: {
    display: 'flex', alignItems: 'center', gap: 6,
    cursor: 'pointer', padding: '4px 10px', borderRadius: 20,
    transition: 'all 0.15s',
  },
  panel: {
    position: 'fixed', right: 0, top: 0, bottom: 0,
    width: 280, background: '#160D05',
    borderLeft: '1px solid #3A1E0C',
    zIndex: 100, overflowY: 'auto',
  },
  panelHead: { padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  closeBtn: { background: 'none', border: 'none', color: '#8A7060', cursor: 'pointer', fontSize: 14 },
  lbl: { color: '#6b4c2a', marginRight: 6 },
  searchInput: {
    background: '#1C0E06', border: '1px solid #3A1E0C', borderRadius: 4,
    color: '#F0E8D8', fontSize: 11, padding: '4px 8px', outline: 'none',
    fontFamily: "'Outfit', sans-serif", width: 140,
  },
  searchBtn: {
    background: 'none', border: '1px solid #3A1E0C', borderRadius: 4,
    color: '#8A7060', cursor: 'pointer', fontSize: 12, padding: '3px 7px',
  },
};

