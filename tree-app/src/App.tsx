import { useState, useMemo } from 'react';
import { useSheetData } from './useSheetData';
import {
  deriveUnions, assignGens, computeLayout, getPaths, personUnionIds,
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
  const [hoveredUnion, setHoveredUnion] = useState<string | null>(null);
  const [hoveredPerson, setHoveredPerson] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

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

    // Shift every y down by TOP_PAD so gen-0 nodes don't clip at the top
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

  const activeIds = useMemo(() => {
    const s = new Set<string>();
    if (hoveredUnion) s.add(hoveredUnion);
    if (hoveredPerson !== null) personUnionIds(hoveredPerson, unions).forEach(id => s.add(id));
    return s;
  }, [hoveredUnion, hoveredPerson, unions]);

  const hasActive = activeIds.size > 0;
  const selectedPerson: Person | null = selected !== null ? (people[selected] ?? null) : null;

  if (loading) return (
    <div style={styles.page}>
      <div style={{ color: '#374151', fontSize: 13, letterSpacing: 2 }}>Loading family data…</div>
    </div>
  );

  if (error) return (
    <div style={styles.page}>
      <div style={{ color: '#f43f5e', fontSize: 13 }}>{error}</div>
    </div>
  );

  return (
    <div style={styles.page}>

      {/* Slim header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '10px 20px', flexShrink: 0 }}>
        <h1 style={{ color: '#e2e8f0', fontSize: 14, letterSpacing: 4, fontWeight: 300, margin: 0 }}>
          UMUNNA — FAMILY TREE
        </h1>
        <p style={{ color: '#374151', fontSize: 10, letterSpacing: 1, margin: 0 }}>
          Hover to isolate · click for details
        </p>
      </div>

      {/* Tree card — fills remaining height */}
      <div style={styles.card}>
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block' }}
        >
          {/* Lane banding */}
          {lanes.map((lane, i) => (
            <g key={i}>
              <rect x={0} y={lane.y} width={svgW} height={lane.h}
                fill={i % 2 === 0 ? '#13132a' : '#111128'} />
              <text x={10} y={lane.y + 14} fontSize={7.5} fill="#252545"
                fontFamily="Georgia, serif" letterSpacing={1.5}>
                {lane.label}
              </text>
            </g>
          ))}

          {/* Union paths */}
          {unions.map(u => {
            const paths = getPaths(u, pos);
            const isActive = activeIds.has(u.id);
            const dimmed = hasActive && !isActive;
            return paths.map((p, i) => (
              <path key={`${u.id}-${i}`} d={p.d} fill="none"
                stroke={dimmed ? '#1a1a30' : u.color}
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
            const uids = personUnionIds(person.id, unions);
            const isActive = hasActive && uids.some(uid => activeIds.has(uid));
            const dimmed = hasActive && !isActive;
            const isFemale = person.g === 'f';
            const isSelected = person.id === selected;

            const fill   = dimmed ? '#0d0d1c' : isFemale ? '#2a1525' : '#141a2e';
            const stroke = dimmed ? '#1a1a30' : isFemale ? '#db2777' : '#3b82f6';
            const txtClr = dimmed ? '#222240' : isFemale ? '#f9a8d4' : '#93c5fd';

            return (
              <g key={person.id} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredPerson(person.id)}
                onMouseLeave={() => setHoveredPerson(null)}
                onClick={() => setSelected(isSelected ? null : person.id)}
              >
                <rect x={p.x - NW / 2} y={p.y - NH / 2} width={NW} height={NH} rx={5}
                  fill={fill} stroke={stroke}
                  strokeWidth={isActive || isSelected ? 2 : 1}
                  style={{ transition: 'all 0.2s' }} />
                <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill={txtClr} fontFamily="Georgia, serif"
                  style={{ transition: 'fill 0.2s', pointerEvents: 'none' }}>
                  {person.name.split(' ')[0]}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Union legend */}
      <div style={styles.legend}>
        {unions.filter(u => u.spouses.length >= 2 || u.children.length > 0).map(u => (
          <div key={u.id}
            onMouseEnter={() => setHoveredUnion(u.id)}
            onMouseLeave={() => setHoveredUnion(null)}
            style={{
              ...styles.pill,
              background: hoveredUnion === u.id ? u.color + '22' : 'transparent',
              border: `1px solid ${hoveredUnion === u.id ? u.color : '#1e1e38'}`,
            }}
          >
            <div style={{ width: 18, height: 2, background: u.color, borderRadius: 1 }} />
            <span style={{
              fontSize: 10, fontFamily: 'Georgia, serif', letterSpacing: 0.5,
              color: hoveredUnion === u.id ? u.color : '#374151',
              transition: 'color 0.15s',
            }}>
              {u.spouses.map(id => people[id]?.name.split(' ')[0] ?? '?').join(' & ')}
            </span>
          </div>
        ))}
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
  const accent = isFemale ? '#db2777' : '#3b82f6';
  const parents  = person.pIds.map(id => people[id]).filter(Boolean) as Person[];
  const spouses  = person.sIds.map(id => people[id]).filter(Boolean) as Person[];
  const children = Object.values(people).filter(p => p.pIds.includes(person.id));

  return (
    <div style={styles.panel}>
      <div style={{ ...styles.panelHead, borderBottom: `1px solid ${accent}44` }}>
        <div>
          <div style={{ fontSize: 24, marginBottom: 4 }}>{isFemale ? '👩🏾' : '👨🏾'}</div>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 15, color: accent }}>
            {person.name}
          </div>
          {person.nicks.length > 0 && (
            <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 2 }}>
              "{person.nicks.join(', ')}"
            </div>
          )}
        </div>
        <button onClick={onClose} style={styles.closeBtn}>✕</button>
      </div>
      <div style={{ padding: '12px 16px', fontSize: 12, lineHeight: 1.9, color: '#9ca3af' }}>
        {person.birthYear && <div><span style={styles.lbl}>Born</span>{person.birthYear}</div>}
        {person.deathYear && <div><span style={styles.lbl}>Died</span>{person.deathYear}</div>}
        {person.placeOfBirth && <div><span style={styles.lbl}>From</span>{person.placeOfBirth}</div>}
        {person.currentLocation && <div><span style={styles.lbl}>Lives</span>{person.currentLocation}</div>}
        {person.notes && <div style={{ marginTop: 8, color: '#6b7280', lineHeight: 1.6 }}>{person.notes}</div>}
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
        <div key={p.id} style={{ color: '#d1d5db', fontSize: 12 }}>{p.name}</div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: '#0b0b18',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'Georgia, serif',
  },
  card: {
    flex: 1,
    background: '#11111e',
    borderTop: '1px solid #1e1e38',
    borderBottom: '1px solid #1e1e38',
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
    width: 280, background: '#11111e',
    borderLeft: '1px solid #1e1e38',
    zIndex: 100, overflowY: 'auto',
  },
  panelHead: { padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  closeBtn: { background: 'none', border: 'none', color: '#374151', cursor: 'pointer', fontSize: 14 },
  lbl: { color: '#4b5563', marginRight: 6 },
};
