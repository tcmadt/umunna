import { useState, useMemo, useRef, useEffect } from 'react';
import { useSheetData, ENDPOINT_URL } from './useSheetData';
import {
  deriveUnions, assignGens, computeLayout, getPaths,
  getAncestors, getDescendants,
} from './dag';
import type { Person } from './types';

const NW = 110, NH = 36, GAPY = 160, PAD = 80, TOP_PAD = 60;

export default function App() {
  const { people, loading, error } = useSheetData(Infinity);
  const [hoveredPerson, setHoveredPerson] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  // Pan/zoom state — null means "show full tree"
  const [vb, setVb] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragStart, setDragStart] = useState<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const didDragRef = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  // Refs so the wheel handler (attached once) always sees fresh values
  const vbRef = useRef(vb);
  const svgWRef = useRef(800);
  const svgHRef = useRef(400);
  vbRef.current = vb;

  // Phase D state
  const [showSuggest, setShowSuggest] = useState(false);
  const [historianMode, setHistorianMode] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);

  useEffect(() => {
    if (!isPrinting) return;
    const done = () => setIsPrinting(false);
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => window.removeEventListener('afterprint', done);
  }, [isPrinting]);

  const { unions, gens, pos, svgW, svgH, lanes } = useMemo(() => {
    const empty = {
      unions: [], gens: {} as Record<number, number>,
      pos: {} as Record<number, { x: number; y: number }>,
      svgW: 800, svgH: 400,
      lanes: [] as { g: number; y: number; h: number }[],
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
    }));

    return { unions, gens, pos, svgW, svgH, lanes };
  }, [people]);

  // ── Dynamic lane labels relative to selected node ───────────────────────────
  function laneLabel(g: number): string {
    if (selected === null) return '';
    const diff = g - (gens[selected] ?? 0);
    if (diff === 0) return '';
    if (diff === -1) return 'PARENTS';
    if (diff === -2) return 'GRANDPARENTS';
    if (diff === -3) return 'GREAT-GRANDPARENTS';
    if (diff < -3) return 'ANCESTORS';
    if (diff === 1) return 'CHILDREN';
    if (diff === 2) return 'GRANDCHILDREN';
    if (diff === 3) return 'GREAT-GRANDCHILDREN';
    return 'DESCENDANTS';
  }

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
    const revealFor = hoveredPerson ?? selected;
    if (revealFor !== null) {
      unions.forEach(u => {
        if (u.spouses.includes(revealFor))
          u.spouses.forEach(s => result.delete(s));
      });
    }
    return result;
  }, [hiddenByDefault, hoveredPerson, selected, unions]);

  // Keep dimension refs in sync for wheel handler
  svgWRef.current = svgW;
  svgHRef.current = svgH;

  // ── Compute a readable initial viewBox centered on the tree ─────────────────
  // Scales so nodes are at least MIN_NODE_PX wide on screen, fits tree if smaller.
  function computeReadableVb() {
    const el = svgRef.current;
    const cw = el?.clientWidth  || 800;
    const ch = el?.clientHeight || 400;
    const MIN_NODE_PX = 70;
    const fitScale   = Math.min(cw / svgW, ch / svgH);
    const scale      = Math.max(fitScale, MIN_NODE_PX / NW);
    const vbW = cw / scale;
    const vbH = ch / scale;
    const xs = Object.values(pos).map(p => p.x);
    const ys = Object.values(pos).map(p => p.y);
    const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : svgW / 2;
    const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : svgH / 2;
    return { x: cx - vbW / 2, y: cy - vbH / 2, w: vbW, h: vbH };
  }

  // Set readable initial viewBox once data is loaded
  useEffect(() => {
    if (loading || !svgRef.current || !Object.keys(pos).length) return;
    setVb(computeReadableVb());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // ── Non-passive wheel listener for zoom ─────────────────────────────────────
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cur = vbRef.current ?? { x: 0, y: 0, w: svgWRef.current, h: svgHRef.current };
      // Mouse position in SVG coordinate space
      const mx = cur.x + (e.clientX - rect.left) / rect.width * cur.w;
      const my = cur.y + (e.clientY - rect.top) / rect.height * cur.h;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const newW = Math.max(300, Math.min(svgWRef.current, cur.w * factor));
      const newH = Math.max(200, Math.min(svgHRef.current, cur.h * factor));
      setVb({
        x: mx - (mx - cur.x) / cur.w * newW,
        y: my - (my - cur.y) / cur.h * newH,
        w: newW,
        h: newH,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [loading]);

  // ── Historian mode keyboard shortcut ────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'H' && e.shiftKey) {
        const code = window.prompt('Historian passcode:');
        if (code === 'Umunna5600.') setHistorianMode(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Search ──────────────────────────────────────────────────────────────────
  const searchHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return Object.values(people).filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.nicks.some(n => n.toLowerCase().includes(q))
    ).map(p => p.id);
  }, [searchQuery, people]);

  function centerOn(id: number) {
    const p = pos[id];
    if (!p) return;
    const el = svgRef.current;
    const cw = el?.clientWidth  || 800;
    const ch = el?.clientHeight || 400;
    // Zoom in to ~2× the readable scale so the target node is prominent
    const scale = (90 / NW) * 2;
    const w = cw / scale;
    const h = ch / scale;
    setVb({ x: p.x - w / 2, y: p.y - h / 2, w, h });
  }
  function stepSearch(dir: 1 | -1) {
    if (!searchHits.length) return;
    const next = (searchIdx + dir + searchHits.length) % searchHits.length;
    setSearchIdx(next);
    centerOn(searchHits[next]);
  }

  // ── Pan handlers ────────────────────────────────────────────────────────────
  function onSvgMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    didDragRef.current = false;
    const cur = vbRef.current ?? { x: 0, y: 0, w: svgWRef.current, h: svgHRef.current };
    setDragStart({ mx: e.clientX, my: e.clientY, vx: cur.x, vy: cur.y });
  }
  function onSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.mx;
    const dy = e.clientY - dragStart.my;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDragRef.current = true;
    if (!didDragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cur = vbRef.current ?? { x: 0, y: 0, w: svgWRef.current, h: svgHRef.current };
    setVb({
      ...cur,
      x: dragStart.vx - dx * (cur.w / rect.width),
      y: dragStart.vy - dy * (cur.h / rect.height),
    });
  }
  function onSvgMouseUp() { setDragStart(null); }

  // ── Historian approve/reject ─────────────────────────────────────────────────
  async function handleApprove(pendingId: string) {
    try {
      await fetch(ENDPOINT_URL, {
        method: 'POST',
        body: JSON.stringify({ type: 'approve', pendingId }),
      });
      window.location.reload();
    } catch {
      alert('Failed to approve. Please try again.');
    }
  }
  async function handleReject(pendingId: string) {
    if (!window.confirm('Reject this suggestion?')) return;
    try {
      await fetch(ENDPOINT_URL, {
        method: 'POST',
        body: JSON.stringify({ type: 'reject', pendingId }),
      });
      window.location.reload();
    } catch {
      alert('Failed to reject. Please try again.');
    }
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
      {!isPrinting && <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 20px', flexShrink: 0, flexWrap: 'wrap' }}>
        <a href="/umunna/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flexShrink: 0 }}>
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="16" cy="9.5" rx="5.5" ry="8" fill="#1C0E06" stroke="#D08A25" strokeWidth="1.5"/>
            <ellipse cx="16" cy="22.5" rx="5.5" ry="8" fill="#1C0E06" stroke="#B85E28" strokeWidth="1.5"/>
            <ellipse cx="9.5" cy="16" rx="8" ry="5.5" fill="#1C0E06" stroke="#D08A25" strokeWidth="1.5"/>
            <ellipse cx="22.5" cy="16" rx="8" ry="5.5" fill="#1C0E06" stroke="#B85E28" strokeWidth="1.5"/>
            <circle cx="16" cy="16" r="3.5" fill="#E8BF60"/>
            <circle cx="16" cy="16" r="1.5" fill="#1C0E06"/>
          </svg>
          <h1 style={{ color: '#F0E8D8', fontSize: 14, letterSpacing: 4, fontWeight: 300, margin: 0, fontFamily: "'Fraunces', Georgia, serif" }}>
            UMUNNA — FAMILY TREE
          </h1>
        </a>
        <p style={{ color: '#8A7060', fontSize: 10, letterSpacing: 1, margin: 0, flex: 1 }}>
          Hover to explore · click for bloodline
        </p>
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="text"
            placeholder="Search name…"
            value={searchQuery}
            onChange={e => { const q = e.target.value; setSearchQuery(q); setSearchIdx(0); if (q.trim()) { const hits = Object.values(people).filter(p => p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.nicks.some(n => n.toLowerCase().includes(q.trim().toLowerCase()))).map(p => p.id); if (hits.length) centerOn(hits[0]); } else { setVb(computeReadableVb()); } }}
            style={styles.searchInput}
          />
          {searchHits.length > 0 && (
            <>
              <span style={{ color: '#8A7060', fontSize: 10 }}>{searchIdx + 1}/{searchHits.length}</span>
              <button onClick={() => stepSearch(-1)} style={styles.searchBtn}>‹</button>
              <button onClick={() => stepSearch(1)} style={styles.searchBtn}>›</button>
            </>
          )}
          <button onClick={() => { setVb(computeReadableVb()); setSearchQuery(''); }} style={styles.searchBtn} title="Reset view">⌂</button>
        </div>
        {/* Suggest + button */}
        <button onClick={() => setShowSuggest(true)} style={styles.suggestBtn}>Suggest +</button>
        {/* PDF export button */}
        <button onClick={() => setIsPrinting(true)} style={styles.searchBtn} title="Export PDF">⬇ PDF</button>
        {/* Historian badge */}
        {historianMode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#2a1a04', border: '1px solid #D08A25', borderRadius: 4, padding: '3px 10px' }}>
            <span style={{ color: '#D08A25', fontSize: 10, letterSpacing: 1.5 }}>HISTORIAN</span>
            <button onClick={() => setHistorianMode(false)} style={{ ...styles.closeBtn, fontSize: 10 }}>✕</button>
          </div>
        )}
      </div>}

      {/* Cancel button shown on-screen during print preview, hidden from actual print */}
      {isPrinting && (
        <button
          className="no-print"
          onClick={() => setIsPrinting(false)}
          style={{ position: 'fixed', top: 16, right: 16, zIndex: 10000, background: '#2a1408', border: '1px solid #B85E28', color: '#E8BF60', borderRadius: 4, padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}
        >
          ✕ Cancel
        </button>
      )}

      {/* Tree card — fills remaining height */}
      <div style={isPrinting ? { position: 'fixed', inset: 0, background: '#0C0702', zIndex: 9999 } : styles.card}>
        <svg
          ref={svgRef}
          viewBox={isPrinting ? `0 0 ${svgW} ${svgH}` : (vb ? `${vb.x} ${vb.y} ${vb.w} ${vb.h}` : `0 0 ${svgW} ${svgH}`)}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block', cursor: dragStart ? 'grabbing' : 'grab', userSelect: 'none' }}
          onMouseDown={onSvgMouseDown}
          onMouseMove={onSvgMouseMove}
          onMouseUp={onSvgMouseUp}
          onMouseLeave={onSvgMouseUp}
        >
          {/* Lane banding */}
          {lanes.map((lane, i) => (
            <g key={i}>
              <rect x={0} y={lane.y} width={svgW} height={lane.h}
                fill={i % 2 === 0 ? '#130A02' : '#0E0702'} />
              <text x={10} y={lane.y + 14} fontSize={7.5} fill="#2a1408"
                fontFamily="'Outfit', sans-serif" letterSpacing={1.5}>
                {laneLabel(lane.g)}
              </text>
            </g>
          ))}

          {/* Union paths */}
          {unions.map(u => {
            if (u.spouses.some(s => hiddenIds.has(s))) return null;
            if (isPrinting && (u.spouses.some(s => people[s]?.pending) || u.children.some(c => people[c]?.pending))) return null;
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
            if (isPrinting && person.pending) return null;
            const isFemale = person.g === 'f';
            const isSelected = person.id === selected;

            const isPending = !!person.pending;
            const hasPendingEdit = !!person.pendingEdit;

            // Base warm earthy colors
            let fill   = isFemale ? '#160D05' : '#1C0E06';
            let stroke = isFemale ? '#D08A25' : '#B85E28';
            let txtClr = isFemale ? '#F0E8D8' : '#E8BF60';
            let nodeOpacity = 1;
            let sw = isSelected ? 2.5 : 1;

            // Pending nodes get muted styling
            if (isPending) {
              fill = '#1a0f06';
              stroke = '#6b4c2a';
              txtClr = '#8A7060';
            }

            // Search hit glow (overrides dimming but not hover/bloodline)
            const isSearchHit = searchHits.includes(person.id);
            const isCurrentHit = searchHits[searchIdx] === person.id;

            if (!isPending && highlight) {
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
                onClick={() => { if (didDragRef.current) return; setSelected(isSelected ? null : person.id); }}
              >
                <rect x={p.x - NW / 2} y={p.y - NH / 2} width={NW} height={NH} rx={5}
                  fill={fill}
                  stroke={isCurrentHit ? '#F0E8D8' : isSearchHit ? '#E8BF60' : stroke}
                  strokeWidth={isCurrentHit ? 3 : isSearchHit ? 2 : sw}
                  strokeDasharray={isPending ? '4,3' : 'none'}
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
                {/* Pending "?" badge */}
                {isPending && (
                  <text x={p.x + NW / 2 - 6} y={p.y - NH / 2 + 8} fontSize={8} fill="#6b4c2a"
                    textAnchor="middle" dominantBaseline="middle"
                    style={{ pointerEvents: 'none' }}>?</text>
                )}
                {/* Pending edit orange dot */}
                {hasPendingEdit && !isPending && (
                  <circle cx={p.x + NW / 2 - 5} cy={p.y - NH / 2 + 5} r={4}
                    fill="#D08A25" opacity={0.9}
                    style={{ pointerEvents: 'none' }} />
                )}
              </g>
            );
          })}
        </svg>
      </div>


      {/* Info panel */}
      {selectedPerson && !isPrinting && (
        <InfoPanel
          person={selectedPerson}
          people={people}
          onClose={() => setSelected(null)}
          historianMode={historianMode}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {/* Suggest modal */}
      {showSuggest && !isPrinting && (
        <SuggestModal people={people} onClose={() => setShowSuggest(false)} />
      )}
    </div>
  );
}

// ── InfoPanel ────────────────────────────────────────────────────────────────

function InfoPanel({ person, people, onClose, historianMode, onApprove, onReject }: {
  person: Person;
  people: Record<number, Person>;
  onClose: () => void;
  historianMode: boolean;
  onApprove: (pendingId: string) => void;
  onReject: (pendingId: string) => void;
}) {
  const isFemale = person.g === 'f';
  const accent = isFemale ? '#D08A25' : '#B85E28';
  const parents  = person.pIds.map(id => people[id]).filter(Boolean) as Person[];
  const spouses  = person.sIds.map(id => people[id]).filter(Boolean) as Person[];
  const children = Object.values(people).filter(p => p.pIds.includes(person.id));

  const FIELD_LABELS: Record<string, string> = {
    name: 'Name', sex: 'Gender', birthYear: 'Birth Year', deathYear: 'Death Year',
    placeOfBirth: 'Place of Birth', currentLocation: 'Current Location',
    photoUrl: 'Photo URL', notes: 'Notes',
  };

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
          {/* Pending suggestion label */}
          {person.pending && (
            <div style={{ fontSize: 10, color: '#D08A25', letterSpacing: 1.2, marginTop: 4, textTransform: 'uppercase' }}>
              Pending Suggestion
            </div>
          )}
          {person.submittedBy && (
            <div style={{ fontSize: 10, color: '#6b4c2a', marginTop: 2 }}>
              Suggested by: {person.submittedBy}
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

        {/* Historian actions for pending new person */}
        {historianMode && person.pending && person.pendingId && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              onClick={() => { if (window.confirm('Approve and add to tree?')) onApprove(person.pendingId!); }}
              style={styles.approveBtn}>✓ Approve</button>
            <button onClick={() => onReject(person.pendingId!)} style={styles.rejectBtn}>✕ Reject</button>
          </div>
        )}

        {/* Pending edit section */}
        {person.pendingEdit && (
          <div style={{ marginTop: 16, borderTop: '1px solid #2a1408', paddingTop: 12 }}>
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: '#D08A25', textTransform: 'uppercase', marginBottom: 8 }}>
              Edit Suggested
            </div>
            {Object.entries(person.pendingEdit.fields).map(([key, val]) => (
              <div key={key} style={{ fontSize: 11, color: '#8A7060', marginBottom: 4 }}>
                <span style={{ color: '#6b4c2a', marginRight: 6 }}>{FIELD_LABELS[key] ?? key}:</span>
                {val}
              </div>
            ))}
            {person.pendingEdit.submittedBy && (
              <div style={{ fontSize: 10, color: '#6b4c2a', marginTop: 4 }}>
                Suggested by: {person.pendingEdit.submittedBy}
              </div>
            )}
            {historianMode && person.pendingEdit.pendingId && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => { if (window.confirm('Approve this edit?')) onApprove(person.pendingEdit!.pendingId); }}
                  style={styles.approveBtn}>✓ Approve Edit</button>
                <button onClick={() => onReject(person.pendingEdit!.pendingId)} style={styles.rejectBtn}>✕ Reject</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PanelSection ─────────────────────────────────────────────────────────────

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

// ── SuggestModal ──────────────────────────────────────────────────────────────

function SuggestModal({ people, onClose }: { people: Record<number, Person>; onClose: () => void }) {
  const [tab, setTab] = useState<'add' | 'edit'>('add');

  // Add Person form
  const [addName, setAddName] = useState('');
  const [addGender, setAddGender] = useState<'m' | 'f'>('m');
  const [addConnectedTo, setAddConnectedTo] = useState('');
  const [addRelType, setAddRelType] = useState<'child of' | 'parent of' | 'spouse of'>('child of');
  const [addSecondParent, setAddSecondParent] = useState(''); // ID string from select
  const [addBirthYear, setAddBirthYear] = useState('');
  const [addPlaceOfBirth, setAddPlaceOfBirth] = useState('');
  const [addCurrentLocation, setAddCurrentLocation] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addPhotoUrl, setAddPhotoUrl] = useState('');
  const [addSubmittedBy, setAddSubmittedBy] = useState('');
  const [addStatus, setAddStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  // Edit Person form
  const [editTarget, setEditTarget] = useState('');
  const [editName, setEditName] = useState('');
  const [editBirthYear, setEditBirthYear] = useState('');
  const [editDeathYear, setEditDeathYear] = useState('');
  const [editPlaceOfBirth, setEditPlaceOfBirth] = useState('');
  const [editCurrentLocation, setEditCurrentLocation] = useState('');
  const [editPhotoUrl, setEditPhotoUrl] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editParent1, setEditParent1] = useState('');
  const [editParent2, setEditParent2] = useState('');
  const [editSpouse, setEditSpouse] = useState('');
  const [editSubmittedBy, setEditSubmittedBy] = useState('');
  const [editStatus, setEditStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  const confirmedPeople = Object.values(people).filter(p => !p.pending).sort((a, b) => a.name.localeCompare(b.name));

  async function submitAdd() {
    if (!addName.trim()) { alert('Name is required.'); return; }
    setAddStatus('sending');
    const connectedId = addConnectedTo ? Number(addConnectedTo) : null;
    let pIds: number[] = [];
    let sIds: number[] = [];
    const fullNotes = addNotes;
    if (connectedId) {
      if (addRelType === 'child of') {
        pIds = [connectedId];
        const secondId = addSecondParent ? Number(addSecondParent) : null;
        if (secondId) pIds.push(secondId);
      } else if (addRelType === 'spouse of') {
        sIds = [connectedId];
      } else if (addRelType === 'parent of') {
        pIds = []; // historian will wire up the reverse connection
      }
    }
    try {
      await fetch(ENDPOINT_URL, {
        method: 'POST',
        body: JSON.stringify({
          type: 'suggest-new',
          name: addName.trim(),
          sex: addGender === 'f' ? 'F' : 'M',
          pIds,
          sIds,
          birthYear: addBirthYear,
          placeOfBirth: addPlaceOfBirth,
          currentLocation: addCurrentLocation,
          notes: fullNotes,
          photoUrl: addPhotoUrl,
          submittedBy: addSubmittedBy,
        }),
      });
      setAddStatus('done');
    } catch {
      setAddStatus('error');
    }
  }

  async function submitEdit() {
    const targetId = editTarget ? Number(editTarget) : null;
    if (!targetId) { alert('Please select a person to edit.'); return; }
    const fields: Record<string, string> = {};
    if (editName.trim()) fields.name = editName.trim();
    if (editBirthYear.trim()) fields.birthYear = editBirthYear.trim();
    if (editDeathYear.trim()) fields.deathYear = editDeathYear.trim();
    if (editPlaceOfBirth.trim()) fields.placeOfBirth = editPlaceOfBirth.trim();
    if (editCurrentLocation.trim()) fields.currentLocation = editCurrentLocation.trim();
    if (editPhotoUrl.trim()) fields.photoUrl = editPhotoUrl.trim();
    if (editNotes.trim()) fields.notes = editNotes.trim();
    const parentIds = [editParent1, editParent2].map(Number).filter(Boolean);
    if (parentIds.length) fields.pIds = parentIds.join(',');
    if (editSpouse) fields.sIds = editSpouse;
    if (Object.keys(fields).length === 0) { alert('No changes entered.'); return; }
    setEditStatus('sending');
    try {
      await fetch(ENDPOINT_URL, {
        method: 'POST',
        body: JSON.stringify({
          type: 'suggest-edit',
          targetId,
          fields,
          submittedBy: editSubmittedBy,
        }),
      });
      setEditStatus('done');
    } catch {
      setEditStatus('error');
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#160D05', border: '1px solid #3A1E0C', borderRadius: 8, width: 420, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Modal header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #3A1E0C' }}>
          <span style={{ color: '#F0E8D8', fontSize: 13, fontFamily: "'Fraunces', Georgia, serif", letterSpacing: 2 }}>SUGGEST A CHANGE</span>
          <button onClick={onClose} style={styles.closeBtn}>✕</button>
        </div>
        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #3A1E0C' }}>
          {(['add', 'edit'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, background: 'none', border: 'none', padding: '10px 0',
              color: tab === t ? '#D08A25' : '#6b4c2a', cursor: 'pointer',
              fontSize: 11, letterSpacing: 1, fontFamily: "'Outfit', sans-serif",
              borderBottom: tab === t ? '2px solid #D08A25' : '2px solid transparent',
            }}>
              {t === 'add' ? 'Add Person' : 'Edit Person'}
            </button>
          ))}
        </div>
        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '16px 18px', flex: 1 }}>
          {tab === 'add' && (
            addStatus === 'done' ? (
              <div style={{ color: '#52A86E', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>
                Suggestion submitted! A historian will review it.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <ModalField label="Full name *">
                  <input value={addName} onChange={e => setAddName(e.target.value)} style={styles.modalInput} placeholder="e.g. Chukwuemeka Obi" />
                </ModalField>
                <ModalField label="Gender">
                  <select value={addGender} onChange={e => setAddGender(e.target.value as 'm' | 'f')} style={styles.modalInput}>
                    <option value="m">Male</option>
                    <option value="f">Female</option>
                  </select>
                </ModalField>
                <ModalField label="Relationship">
                  <select value={addRelType} onChange={e => setAddRelType(e.target.value as typeof addRelType)} style={styles.modalInput}>
                    <option value="child of">child of</option>
                    <option value="parent of">parent of</option>
                    <option value="spouse of">spouse of</option>
                  </select>
                </ModalField>
                <ModalField label={addRelType === 'child of' ? 'Parent 1' : addRelType === 'spouse of' ? 'Spouse' : 'Child of'}>
                  <select value={addConnectedTo} onChange={e => setAddConnectedTo(e.target.value)} style={styles.modalInput}>
                    <option value="">— select —</option>
                    {confirmedPeople.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                  </select>
                </ModalField>
                {addRelType === 'child of' && (
                  <ModalField label="Parent 2 (optional)">
                    <select value={addSecondParent} onChange={e => setAddSecondParent(e.target.value)} style={styles.modalInput}>
                      <option value="">— select —</option>
                      {confirmedPeople.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                    </select>
                  </ModalField>
                )}
                <ModalField label="Birth year">
                  <input value={addBirthYear} onChange={e => setAddBirthYear(e.target.value)} style={styles.modalInput} placeholder="e.g. 1965" />
                </ModalField>
                <ModalField label="Place of birth">
                  <input value={addPlaceOfBirth} onChange={e => setAddPlaceOfBirth(e.target.value)} style={styles.modalInput} placeholder="e.g. Enugu, Nigeria" />
                </ModalField>
                <ModalField label="Current location">
                  <input value={addCurrentLocation} onChange={e => setAddCurrentLocation(e.target.value)} style={styles.modalInput} placeholder="e.g. Lagos, Nigeria" />
                </ModalField>
                <ModalField label="Notes">
                  <textarea value={addNotes} onChange={e => setAddNotes(e.target.value)} style={{ ...styles.modalInput, resize: 'vertical', minHeight: 56 }} placeholder="Any additional info…" />
                </ModalField>
                <ModalField label="Photo URL">
                  <input value={addPhotoUrl} onChange={e => setAddPhotoUrl(e.target.value)} style={styles.modalInput} placeholder="https://…" />
                </ModalField>
                <ModalField label="Your name (optional)">
                  <input value={addSubmittedBy} onChange={e => setAddSubmittedBy(e.target.value)} style={styles.modalInput} placeholder="How should we credit you?" />
                </ModalField>
                {addStatus === 'error' && (
                  <div style={{ color: '#C05050', fontSize: 11 }}>Something went wrong. Please try again.</div>
                )}
                <button onClick={submitAdd} disabled={addStatus === 'sending'} style={{ ...styles.suggestBtn, marginTop: 4, alignSelf: 'flex-end' }}>
                  {addStatus === 'sending' ? 'Sending…' : 'Submit Suggestion'}
                </button>
              </div>
            )
          )}
          {tab === 'edit' && (
            editStatus === 'done' ? (
              <div style={{ color: '#52A86E', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>
                Edit suggestion submitted! A historian will review it.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <ModalField label="Person to edit *">
                  <select value={editTarget} onChange={e => setEditTarget(e.target.value)} style={styles.modalInput}>
                    <option value="">— select —</option>
                    {confirmedPeople.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                  </select>
                </ModalField>
                <div style={{ fontSize: 10, color: '#6b4c2a', marginBottom: 2 }}>Fill in only the fields you want to change:</div>
                <ModalField label="Name">
                  <input value={editName} onChange={e => setEditName(e.target.value)} style={styles.modalInput} placeholder="New name" />
                </ModalField>
                <ModalField label="Birth year">
                  <input value={editBirthYear} onChange={e => setEditBirthYear(e.target.value)} style={styles.modalInput} placeholder="e.g. 1965" />
                </ModalField>
                <ModalField label="Death year">
                  <input value={editDeathYear} onChange={e => setEditDeathYear(e.target.value)} style={styles.modalInput} placeholder="e.g. 2010" />
                </ModalField>
                <ModalField label="Place of birth">
                  <input value={editPlaceOfBirth} onChange={e => setEditPlaceOfBirth(e.target.value)} style={styles.modalInput} placeholder="e.g. Enugu, Nigeria" />
                </ModalField>
                <ModalField label="Current location">
                  <input value={editCurrentLocation} onChange={e => setEditCurrentLocation(e.target.value)} style={styles.modalInput} placeholder="e.g. Lagos" />
                </ModalField>
                <ModalField label="Photo URL">
                  <input value={editPhotoUrl} onChange={e => setEditPhotoUrl(e.target.value)} style={styles.modalInput} placeholder="https://…" />
                </ModalField>
                <ModalField label="Notes">
                  <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} style={{ ...styles.modalInput, resize: 'vertical', minHeight: 56 }} placeholder="Correction or addition…" />
                </ModalField>
                <ModalField label="Parent 1">
                  <select value={editParent1} onChange={e => setEditParent1(e.target.value)} style={styles.modalInput}>
                    <option value="">— no change —</option>
                    {confirmedPeople.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                  </select>
                </ModalField>
                <ModalField label="Parent 2">
                  <select value={editParent2} onChange={e => setEditParent2(e.target.value)} style={styles.modalInput}>
                    <option value="">— no change —</option>
                    {confirmedPeople.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                  </select>
                </ModalField>
                <ModalField label="Spouse">
                  <select value={editSpouse} onChange={e => setEditSpouse(e.target.value)} style={styles.modalInput}>
                    <option value="">— no change —</option>
                    {confirmedPeople.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                  </select>
                </ModalField>
                <ModalField label="Your name (optional)">
                  <input value={editSubmittedBy} onChange={e => setEditSubmittedBy(e.target.value)} style={styles.modalInput} placeholder="How should we credit you?" />
                </ModalField>
                {editStatus === 'error' && (
                  <div style={{ color: '#C05050', fontSize: 11 }}>Something went wrong. Please try again.</div>
                )}
                <button onClick={submitEdit} disabled={editStatus === 'sending'} style={{ ...styles.suggestBtn, marginTop: 4, alignSelf: 'flex-end' }}>
                  {editStatus === 'sending' ? 'Sending…' : 'Submit Edit'}
                </button>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function ModalField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 10, color: '#6b4c2a', letterSpacing: 0.8, fontFamily: "'Outfit', sans-serif" }}>{label}</label>
      {children}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  suggestBtn: {
    background: '#1C0E06', border: '1px solid #D08A25', borderRadius: 4,
    color: '#D08A25', cursor: 'pointer', fontSize: 11, padding: '4px 10px',
    fontFamily: "'Outfit', sans-serif", letterSpacing: 0.5,
  },
  approveBtn: {
    background: '#1a3a1a', border: '1px solid #52A86E', borderRadius: 4,
    color: '#52A86E', cursor: 'pointer', fontSize: 11, padding: '5px 12px',
  },
  rejectBtn: {
    background: '#3a1a1a', border: '1px solid #C05050', borderRadius: 4,
    color: '#C05050', cursor: 'pointer', fontSize: 11, padding: '5px 12px',
  },
  modalInput: {
    background: '#1C0E06', border: '1px solid #3A1E0C', borderRadius: 4,
    color: '#F0E8D8', fontSize: 11, padding: '5px 8px', outline: 'none',
    fontFamily: "'Outfit', sans-serif", width: '100%', boxSizing: 'border-box',
  },
};
