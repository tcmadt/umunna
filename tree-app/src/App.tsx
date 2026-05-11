import { useState, useMemo, useRef, useEffect } from 'react';
import { useSheetData, ENDPOINT_URL } from './useSheetData';
import {
  deriveUnions, assignGens, computeLayout, getPaths,
  getAncestors, getDescendants,
} from './dag';
import type { Person, PersonMap } from './types';

const NW = 110, NH = 36, GAPY = 160, PAD = 80, TOP_PAD = 60;

export default function App() {
  const { people, loading, error } = useSheetData(Infinity);
  const [hoveredPerson, setHoveredPerson] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
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
  const [historianMode, setHistorianMode] = useState(() => sessionStorage.getItem('umunna:historian') === '1');
  const [contributorMode, setContributorMode] = useState(() => sessionStorage.getItem('umunna:contributor') === '1');
  const [isPrinting, setIsPrinting] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [showMore, setShowMore] = useState(false);
  const isMobile = window.innerWidth < 640;

  useEffect(() => {
    if (!isPrinting) return;
    const done = () => setIsPrinting(false);
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => window.removeEventListener('afterprint', done);
  }, [isPrinting]);

  // Focus mode: compute visible set (±2 generations + spouses/co-parents)
  // Compute full gens from all people (needed for generation-band focus filtering)
  const fullGens = useMemo<Record<number, number>>(() => {
    if (!Object.keys(people).length) return {};
    const allUnions = deriveUnions(people);
    return assignGens(people, allUnions);
  }, [people]);

  // Focus mode: show everyone within ±2 generation rows of the focus person.
  // This naturally includes siblings (diff=0), parents (diff=1), grandparents (diff=2),
  // children (diff=1), grandchildren (diff=2), and in-laws at the same row level.
  const visibleIds = useMemo<Set<number>>(() => {
    if (focusId === null) return new Set(Object.keys(people).map(Number));
    const targetGen = fullGens[focusId] ?? 0;
    return new Set(
      Object.entries(fullGens)
        .filter(([, g]) => Math.abs(g - targetGen) <= 2)
        .map(([id]) => Number(id))
    );
  }, [focusId, people, fullGens]);

  const focusPeople = useMemo<PersonMap>(() => {
    if (focusId === null) return people;
    return Object.fromEntries(
      Object.entries(people).filter(([id]) => visibleIds.has(Number(id)))
    ) as PersonMap;
  }, [focusId, people, visibleIds]);

  const { unions, pos, svgW, svgH } = useMemo(() => {
    const empty = {
      unions: [], gens: {} as Record<number, number>,
      pos: {} as Record<number, { x: number; y: number }>,
      svgW: 800, svgH: 400,
    };
    if (!Object.keys(focusPeople).length) return empty;

    const unions = deriveUnions(focusPeople);
    const gens = assignGens(focusPeople, unions);
    const pos = computeLayout(focusPeople, unions, gens, NW, GAPY);

    Object.values(pos).forEach(p => { p.y += TOP_PAD; });

    const maxG = Math.max(...Object.values(gens), 0);
    const xs = Object.values(pos).map(p => p.x);
    const svgW = Math.max(800, Math.max(...xs) + NW / 2 + PAD);
    const svgH = maxG * GAPY + NH + PAD + TOP_PAD * 2;

    return { unions, pos, svgW, svgH };
  }, [focusPeople]);

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

  // Immediate family of selected person — determines tier-2 nodes
  const selectedFamily = useMemo(() => {
    if (selected === null) return new Set<number>();
    const s = new Set<number>();
    const person = people[selected];
    if (!person) return s;
    person.pIds.forEach(id => s.add(id));
    unions.forEach(u => {
      if (u.spouses.includes(selected)) {
        u.spouses.forEach(id => { if (id !== selected) s.add(id); });
        u.children.forEach(id => s.add(id));
      }
      if (u.children.includes(selected)) {
        u.children.forEach(id => { if (id !== selected) s.add(id); });
      }
    });
    return s;
  }, [selected, people, unions]);

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

  // Reset view when focus changes
  useEffect(() => {
    if (!svgRef.current || !Object.keys(pos).length) return;
    setVb(computeReadableVb());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

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

  // ── Touch pan + pinch zoom ───────────────────────────────────────────────────
  // Bypass React state during gesture — directly set SVG viewBox attribute for
  // smooth 60fps. Sync to React state once on touchend so the rest of the app
  // stays consistent.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    let lastTouches: Touch[] = [];

    function applyVb(v: { x: number; y: number; w: number; h: number }) {
      vbRef.current = v;
      el!.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    }

    const onTouchStart = (e: TouchEvent) => {
      didDragRef.current = false;
      lastTouches = Array.from(e.touches);
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const touches = Array.from(e.touches);
      const cur = vbRef.current ?? { x: 0, y: 0, w: svgWRef.current, h: svgHRef.current };
      const rect = el.getBoundingClientRect();

      if (touches.length === 1 && lastTouches.length >= 1) {
        const dx = touches[0].clientX - lastTouches[0].clientX;
        const dy = touches[0].clientY - lastTouches[0].clientY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDragRef.current = true;
        applyVb({
          ...cur,
          x: cur.x - dx * (cur.w / rect.width),
          y: cur.y - dy * (cur.h / rect.height),
        });
      } else if (touches.length === 2 && lastTouches.length >= 2) {
        const prevDist = Math.hypot(
          lastTouches[1].clientX - lastTouches[0].clientX,
          lastTouches[1].clientY - lastTouches[0].clientY,
        );
        const newDist = Math.hypot(
          touches[1].clientX - touches[0].clientX,
          touches[1].clientY - touches[0].clientY,
        );
        if (prevDist === 0) { lastTouches = touches; return; }
        const factor = prevDist / newDist;
        const midX = (touches[0].clientX + touches[1].clientX) / 2;
        const midY = (touches[0].clientY + touches[1].clientY) / 2;
        const mx = cur.x + (midX - rect.left) / rect.width * cur.w;
        const my = cur.y + (midY - rect.top) / rect.height * cur.h;
        const newW = Math.max(300, Math.min(svgWRef.current, cur.w * factor));
        const newH = Math.max(200, Math.min(svgHRef.current, cur.h * factor));
        applyVb({
          x: mx - (mx - cur.x) / cur.w * newW,
          y: my - (my - cur.y) / cur.h * newH,
          w: newW, h: newH,
        });
        didDragRef.current = true;
      }
      lastTouches = touches;
    };
    const onTouchEnd = () => {
      lastTouches = [];
      // Commit to React state once — one re-render per gesture, not per frame
      if (vbRef.current) setVb({ ...vbRef.current });
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [loading]);

  // ── Role keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'H' && e.shiftKey) {
        const code = window.prompt('Historian passcode:');
        if (code === 'Umunna5600.') {
          setHistorianMode(true);
          setContributorMode(true);
          sessionStorage.setItem('umunna:historian', '1');
          sessionStorage.setItem('umunna:contributor', '1');
        }
      }
      if (e.key === 'C' && e.shiftKey) {
        const code = window.prompt('Contributor passcode:');
        if (code === 'Owerre5600.') {
          setContributorMode(true);
          sessionStorage.setItem('umunna:contributor', '1');
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

      {/* Header */}
      {!isPrinting && <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 20px', flexShrink: 0 }}>
        <a href="/umunna/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flexShrink: 0 }}>
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="16" cy="9.5" rx="5.5" ry="8" fill="#1C0E06" stroke="#D08A25" strokeWidth="1.5"/>
            <ellipse cx="16" cy="22.5" rx="5.5" ry="8" fill="#1C0E06" stroke="#B85E28" strokeWidth="1.5"/>
            <ellipse cx="9.5" cy="16" rx="8" ry="5.5" fill="#1C0E06" stroke="#D08A25" strokeWidth="1.5"/>
            <ellipse cx="22.5" cy="16" rx="8" ry="5.5" fill="#1C0E06" stroke="#B85E28" strokeWidth="1.5"/>
            <circle cx="16" cy="16" r="3.5" fill="#E8BF60"/>
            <circle cx="16" cy="16" r="1.5" fill="#1C0E06"/>
          </svg>
          <h1 style={{ color: '#F0E8D8', fontSize: 13, letterSpacing: 4, fontWeight: 300, margin: 0, fontFamily: "'Fraunces', Georgia, serif" }}>
            UMUNNA
          </h1>
        </a>
        <div style={{ flex: 1 }} />
        {/* Focus smart search */}
        <FocusSearch
          people={people}
          focusId={focusId}
          onChange={id => { setFocusId(id); setSelected(null); }}
        />
        {/* ⋯ more menu */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setShowMore(m => !m)} style={styles.searchBtn} title="More">⋯</button>
          {showMore && (
            <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, background: '#1C0E06', border: '1px solid #3A1E0C', borderRadius: 6, padding: '6px 0', zIndex: 200, minWidth: 160 }}>
              {!isMobile && (
                <button onClick={() => { setIsPrinting(true); setShowMore(false); }}
                  style={styles.moreItem}>⬇ Export PDF</button>
              )}
              {(contributorMode || historianMode) && (
                <button onClick={() => { setShowSuggest(true); setShowMore(false); }}
                  style={styles.moreItem}>＋ Suggest change</button>
              )}
              {historianMode && (
                <div style={{ ...styles.moreItem, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#D08A25' }}>Historian</span>
                  <button onClick={() => { setHistorianMode(false); sessionStorage.removeItem('umunna:historian'); setShowMore(false); }} style={styles.closeBtn}>✕</button>
                </div>
              )}
              {contributorMode && !historianMode && (
                <div style={{ ...styles.moreItem, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#52A86E' }}>Contributor</span>
                  <button onClick={() => { setContributorMode(false); sessionStorage.removeItem('umunna:contributor'); setShowMore(false); }} style={styles.closeBtn}>✕</button>
                </div>
              )}
            </div>
          )}
        </div>
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
          style={{ display: 'block', cursor: dragStart ? 'grabbing' : 'grab', userSelect: 'none', touchAction: 'none' }}
          onMouseDown={onSvgMouseDown}
          onMouseMove={onSvgMouseMove}
          onMouseUp={onSvgMouseUp}
          onMouseLeave={onSvgMouseUp}
        >
          {/* Union paths — monochromatic amber */}
          {unions.map(u => {
            if (u.spouses.some(s => hiddenIds.has(s))) return null;
            if (isPrinting && (u.spouses.some(s => people[s]?.pending) || u.children.some(c => people[c]?.pending))) return null;
            const paths = getPaths(u, pos);
            const isActive = activePaths.has(u.id);
            const dimmed = hasHighlight && !isActive;
            return paths.map((p, i) => (
              <path key={`${u.id}-${i}`} d={p.d} fill="none"
                stroke={dimmed ? '#1a0c02' : 'rgba(208,138,37,1)'}
                strokeWidth={isActive
                  ? (p.type === 'descent' ? 1.5 : 1)
                  : (p.type === 'descent' ? 1 : 0.75)}
                strokeDasharray={p.type === 'partner' ? '2,4' : 'none'}
                strokeOpacity={dimmed ? 0.5 : p.type === 'partner' ? (isActive ? 0.5 : 0.25) : (isActive ? 0.8 : 0.3)}
                style={{ transition: 'stroke-opacity 0.2s, stroke-width 0.2s' }}
              />
            ));
          })}
          {/* Marriage diamonds */}
          {unions.map(u => {
            if (!u.married || u.spouses.length < 2) return null;
            if (u.spouses.some(s => hiddenIds.has(s))) return null;
            const sxs = u.spouses.map(s => pos[s]?.x).filter(x => x !== undefined) as number[];
            const sys = u.spouses.map(s => pos[s]?.y).filter(y => y !== undefined) as number[];
            if (sxs.length < 2) return null;
            const bx = (Math.min(...sxs) + Math.max(...sxs)) / 2;
            const by = sys[0];
            const isActive = activePaths.has(u.id);
            const dimmed = hasHighlight && !isActive;
            const ds = 4;
            return (
              <polygon key={`d-${u.id}`}
                points={`${bx},${by - ds} ${bx + ds},${by} ${bx},${by + ds} ${bx - ds},${by}`}
                fill={dimmed ? '#1a0c02' : '#D08A25'}
                opacity={dimmed ? 0.3 : isActive ? 0.9 : 0.55}
                style={{ pointerEvents: 'none', transition: 'all 0.2s' }}
              />
            );
          })}

          {/* Person nodes — circle portrait tiers */}
          {Object.values(focusPeople).map(person => {
            const p = pos[person.id];
            if (!p) return null;
            if (hiddenIds.has(person.id)) return null;
            if (isPrinting && person.pending) return null;
            const isFemale = person.g === 'f';
            const isSelected = person.id === selected;
            const isPending = !!person.pending;
            const hasPendingEdit = !!person.pendingEdit;

            // Tier: 1=subject, 2=immediate family, 3=everyone else
            const tier = selected === null ? 2
              : isSelected ? 1
              : selectedFamily.has(person.id) ? 2
              : 3;
            const r = tier === 1 ? 26 : tier === 2 ? 18 : 10;

            // Colors
            let fill   = isFemale ? '#1a0f06' : '#1C0E06';
            let stroke = isFemale ? '#D08A25' : '#B85E28';
            let txtClr = isFemale ? '#F0E8D8' : '#E8BF60';
            let nodeOpacity = tier === 3 ? 0.7 : 1;
            let sw = isSelected ? 2 : 1.5;

            if (isPending) { fill = '#160c04'; stroke = '#4a3020'; txtClr = '#6b4c2a'; }

            if (!isPending && highlight) {
              if (highlight.mode === 'hover') {
                if (person.id === highlight.id) { stroke = '#F0E8D8'; sw = 2.5; }
                else if (highlight.spouseIds.has(person.id)) { stroke = '#D08A25'; }
                else if (highlight.parentIds.has(person.id)) { stroke = '#B85E28'; }
                else if (highlight.childIds.has(person.id)) { stroke = '#E8BF60'; }
                else if (highlight.siblingIds.has(person.id)) { stroke = '#4AB8B0'; }
                else { nodeOpacity = 0.2; }
              } else {
                if (person.id === highlight.id) { fill = '#2a1a08'; stroke = '#F0E8D8'; sw = 2.5; }
                else if (highlight.ancestors.has(person.id)) { stroke = '#D08A25'; }
                else if (highlight.descendants.has(person.id)) { stroke = '#E8BF60'; }
                else { nodeOpacity = 0.12; }
              }
            }

            const firstName = person.name.split(' ')[0];
            const monogram = person.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

            return (
              <g key={person.id} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredPerson(person.id)}
                onMouseLeave={() => setHoveredPerson(null)}
                onClick={() => { if (didDragRef.current) return; setSelected(isSelected ? null : person.id); }}
              >
                {/* Invisible hit target for small nodes */}
                <circle cx={p.x} cy={p.y} r={Math.max(r, 14)} fill="transparent" />
                {/* Circle */}
                <circle cx={p.x} cy={p.y} r={r}
                  fill={fill} stroke={stroke} strokeWidth={sw}
                  strokeDasharray={isPending ? '3,2' : 'none'}
                  opacity={nodeOpacity}
                  style={{ transition: 'all 0.25s' }} />
                {/* Photo */}
                {person.photoUrl && (
                  <>
                    <clipPath id={`clip-${person.id}`}>
                      <circle cx={p.x} cy={p.y} r={r - 1} />
                    </clipPath>
                    <image href={person.photoUrl}
                      x={p.x - r} y={p.y - r} width={r * 2} height={r * 2}
                      clipPath={`url(#clip-${person.id})`}
                      preserveAspectRatio="xMidYMid slice"
                      opacity={nodeOpacity}
                      onError={e => { (e.target as SVGImageElement).style.display = 'none'; }} />
                  </>
                )}
                {/* Monogram or first name inside circle (no photo) */}
                {!person.photoUrl && (
                  <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle"
                    fontSize={tier === 1 ? 13 : tier === 2 ? 9 : 7}
                    fill={txtClr} fontFamily="'Outfit', sans-serif"
                    opacity={nodeOpacity}
                    style={{ pointerEvents: 'none', transition: 'opacity 0.25s' }}>
                    {tier === 3 ? monogram : firstName}
                  </text>
                )}
                {/* Name label below circle for tiers 1 and 2 */}
                {tier <= 2 && (
                  <text x={p.x} y={p.y + r + (tier === 1 ? 13 : 10)}
                    textAnchor="middle" fontSize={tier === 1 ? 11 : 9}
                    fill={txtClr} fontFamily="'Outfit', sans-serif"
                    opacity={nodeOpacity}
                    style={{ pointerEvents: 'none', transition: 'opacity 0.25s' }}>
                    {firstName}
                  </text>
                )}
                {/* Pending ? */}
                {isPending && (
                  <text x={p.x + r - 3} y={p.y - r + 5} fontSize={7} fill="#6b4c2a"
                    textAnchor="middle" style={{ pointerEvents: 'none' }}>?</text>
                )}
                {/* Pending edit dot */}
                {hasPendingEdit && !isPending && (
                  <circle cx={p.x + r - 3} cy={p.y - r + 3} r={3}
                    fill="#D08A25" opacity={0.9} style={{ pointerEvents: 'none' }} />
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
      {person.photoUrl ? (
        <div style={{ position: 'relative', height: 160, overflow: 'hidden', borderBottom: `1px solid ${accent}33` }}>
          <img src={person.photoUrl} alt={person.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 30%, rgba(12,7,2,0.95) 100%)' }} />
          <div style={{ position: 'absolute', bottom: 12, left: 16, right: 36 }}>
            <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 17, color: '#F0E8D8', lineHeight: 1.2 }}>{person.name}</div>
            {person.nicks.length > 0 && (
              <div style={{ fontSize: 10, color: '#8A7060', fontStyle: 'italic', marginTop: 3 }}>"{person.nicks.join(', ')}"</div>
            )}
          </div>
          <button onClick={onClose} style={{ ...styles.closeBtn, position: 'absolute', top: 10, right: 10 }}>✕</button>
        </div>
      ) : (
        <div style={{ ...styles.panelHead, borderBottom: `1px solid ${accent}44` }}>
          <div>
            <div style={{ fontSize: 28, marginBottom: 4 }}>{isFemale ? '👩🏾' : '👨🏾'}</div>
            <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 15, color: accent }}>{person.name}</div>
            {person.nicks.length > 0 && (
              <div style={{ fontSize: 11, color: '#6b4c2a', fontStyle: 'italic', marginTop: 2 }}>"{person.nicks.join(', ')}"</div>
            )}
          </div>
          <button onClick={onClose} style={styles.closeBtn}>✕</button>
        </div>
      )}
      {/* Pending / submittedBy labels */}
      {(person.pending || person.submittedBy) && (
        <div style={{ padding: '6px 16px 0', fontSize: 10 }}>
          {person.pending && <div style={{ color: '#D08A25', letterSpacing: 1.2, textTransform: 'uppercase' }}>Pending Suggestion</div>}
          {person.submittedBy && <div style={{ color: '#6b4c2a', marginTop: 2 }}>{person.pending ? 'Suggested' : 'Added'} by: {people[Number(person.submittedBy)]?.name ?? person.submittedBy}</div>}
        </div>
      )}
      <div style={{ padding: '12px 16px', fontSize: 12, lineHeight: 1.9, color: '#8A7060', fontFamily: "'Outfit', sans-serif" }}>
        {(person.birthDate || person.birthYear) && <div><span style={styles.lbl}>Born</span>{person.birthDate ?? person.birthYear}</div>}
        {(person.deathDate || person.deathYear) && <div><span style={styles.lbl}>Died</span>{person.deathDate ?? person.deathYear}</div>}
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
                  <PersonAutocomplete people={confirmedPeople} value={addSubmittedBy} onChange={setAddSubmittedBy} placeholder="Search your name…" />
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
                  <PersonAutocomplete people={confirmedPeople} value={editSubmittedBy} onChange={setEditSubmittedBy} placeholder="Search your name…" />
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

// ── FocusSearch ───────────────────────────────────────────────────────────────
function FocusSearch({ people, focusId, onChange }: {
  people: PersonMap;
  focusId: number | null;
  onChange: (id: number | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const focusPerson = focusId !== null ? people[focusId] : null;
  const sorted = Object.values(people).filter(p => !p.pending).sort((a, b) => a.name.localeCompare(b.name));
  const filtered = focusPerson ? sorted : query
    ? sorted.filter(p => p.name.toLowerCase().includes(query.toLowerCase()) || p.nicks.some(n => n.toLowerCase().includes(query.toLowerCase())))
    : sorted;

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={focusPerson ? focusPerson.name : query}
        onChange={e => { setQuery(e.target.value); onChange(null); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search name…"
        style={{ ...styles.searchInput, paddingRight: 28 }}
      />
      {focusPerson && (
        <button onMouseDown={() => { onChange(null); setQuery(''); }}
          style={{ position: 'absolute', right: 18, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#6b4c2a', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: 0 }}>
          ✕
        </button>
      )}
      <button onMouseDown={() => setOpen(o => !o)}
        style={{ position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#8A7060', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 0 }}>
        ▾
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, background: '#1C0E06', border: '1px solid #3A1E0C', borderRadius: 4, maxHeight: 220, overflowY: 'auto', zIndex: 300 }}>
          <div onMouseDown={() => { onChange(null); setQuery(''); setOpen(false); }}
            style={{ padding: '6px 10px', color: '#6b4c2a', fontSize: 11, cursor: 'pointer', fontFamily: "'Outfit', sans-serif", borderBottom: '1px solid #2a1408', fontStyle: 'italic' }}>
            All members
          </div>
          {filtered.slice(0, 60).map(p => (
            <div key={p.id} onMouseDown={() => { onChange(p.id); setQuery(''); setOpen(false); }}
              style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 11, fontFamily: "'Outfit', sans-serif", color: p.id === focusId ? '#D08A25' : '#F0E8D8', background: p.id === focusId ? '#2a1408' : 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#2a1408')}
              onMouseLeave={e => (e.currentTarget.style.background = p.id === focusId ? '#2a1408' : 'transparent')}>
              {p.name}
            </div>
          ))}
        </div>
      )}
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

// ── PersonAutocomplete ────────────────────────────────────────────────────────
// value = node ID as string; onChange fires with the selected ID string

function PersonAutocomplete({ people, value, onChange, placeholder }: {
  people: Person[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = people.find(p => String(p.id) === value);
  const filtered = (selected ? people : people.filter(p =>
    p.name.toLowerCase().includes(query.toLowerCase())
  )).slice(0, 20);

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={selected ? selected.name : query}
        onChange={e => { setQuery(e.target.value); onChange(''); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        style={styles.modalInput}
      />
      {open && !selected && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0,
          background: '#1C0E06', border: '1px solid #3A1E0C', borderRadius: 4,
          maxHeight: 160, overflowY: 'auto', zIndex: 300,
        }}>
          {filtered.map(p => (
            <div key={p.id}
              onMouseDown={() => { onChange(String(p.id)); setQuery(''); setOpen(false); }}
              style={{ padding: '6px 10px', cursor: 'pointer', color: '#F0E8D8', fontSize: 11,
                fontFamily: "'Outfit', sans-serif" }}
              onMouseEnter={e => (e.currentTarget.style.background = '#2a1408')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {p.name}
            </div>
          ))}
        </div>
      )}
      {selected && (
        <button
          onMouseDown={() => { onChange(''); setQuery(''); }}
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', color: '#6b4c2a', cursor: 'pointer', fontSize: 11 }}
        >✕</button>
      )}
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
    width: Math.min(280, window.innerWidth),
    background: '#160D05',
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
  moreItem: {
    display: 'block', width: '100%', textAlign: 'left' as const,
    background: 'none', border: 'none', color: '#F0E8D8', cursor: 'pointer',
    fontSize: 11, padding: '7px 14px', fontFamily: "'Outfit', sans-serif",
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
