# Umunna — Project Context for Claude Code

## Repo structure
- `index.html` — welcome/landing page only. Enter button navigates to `tree.html`.
- `tree.html` — the full family tree application. All tree features live here.
- `Code.js` — Google Apps Script. Serves family data via JSONP (doGet) and receives suggestions (doPost).
- `appsscript.json` — Apps Script config.

## Data model
Family data loads via JSONP from Apps Script into object `P` (global, keyed by string ID).
Each person object:
```js
{
  name: string,
  g: 'm' | 'f',           // derived from Sex column (M/F) in Sheet1
  pIds: number[],          // parent IDs
  sIds: number[],          // spouse IDs
  nicks: string[],
  notes: string,
  rel: string,             // 'you'|'parent'|'grandparent'|'great-grandparent'|'ancestor'|'aunt-uncle'|'cousin'|'distant'
  birthYear: string,
  deathYear: string,
  placeOfBirth: string,
  currentLocation: string,
}
```

## Key globals (tree.html)
- `P` — canonical family data from Google Sheets. Never mutate directly.
- `EXTRA_MEMBERS` — historian-added members not yet in Sheet
- `SUGGESTIONS` — array of suggestion objects, persisted to window.storage 'umunna:suggestions'
- `PENDING` — overlay of unverified suggestions rendered on tree, persisted to 'umunna:pending'
- `PHOTOS` — photo URLs keyed by node ID, persisted to 'umunna:photos'
- `HISTORIAN_MODE` — boolean, unlocked with passcode 'Umunna5600.'
- `_centerId` — integer, which node is the visual root
- `_searchHits` — Set of matching node IDs for search
- `_collapsed` — Set of collapsed node IDs (string, matching d3 stratify IDs)
- `RC` — maps rel string → hex color
- `RL` — maps rel string → display label
- `NW = 110, NH = 46` — node width/height

## D3 Tree Renderer
The tree uses **D3 v7.8.5** (loaded from cdnjs). `const L` (hardcoded positions) and `computeLayout()` are **removed**. Layout is fully automatic via `d3.tree()`.

Additional D3 globals:
- `_d3zoom` — d3.zoom() behavior instance (created once, re-attached each render)
- `_d3g` — reference to current main `<g>` group inside SVG
- `_currentTransform` — d3.ZoomTransform, persisted across re-renders
- `_nodeXY` — `{[id: number]: {x, y}}` group-space coords cached after each render

`renderTree()` flow:
1. `d3.stratify()` builds hierarchy from `P` using `pIds[0]` as tree parent (`__root__` synthetic node for roots)
2. `d3.tree().nodeSize([130, 136])` computes positions
3. Collapsed nodes (in `_collapsed`) have `children` moved to `_children`
4. Draws row lines, edges (primary + secondary parent dashed), spouse lines (dashed horizontal + midpoint dot), nodes
5. Collapse toggle: gold circle at node bottom; shows hidden descendant count; 400ms fade-in transition

`scrollToNode(id)` uses `_nodeXY` + `_d3zoom.transform` with 500ms transition.

## Key functions (tree.html)
- `renderTree()` — draws the D3 SVG tree
- `openNode(id)` — opens right-side info panel
- `showCtx(event, id)` — right-click context menu
- `searchTree(q)` — highlights matching nodes
- `setCenter(id)` — sets _centerId and re-renders
- `scrollToNode(id)` — pans D3 view to a node
- `avatar(p)` — returns 👨🏾 or 👩🏾 based on p.g
- `gender(p)` — returns 'm' or 'f'
- `displayName(p)` — returns p.name
- `shortName(p)` — first word + truncated rest
- `loadViaJSONP(url)` — fetches data from Apps Script endpoint
- `init()` — loads storage, fetches P via JSONP, sets _dataReady
- `showToast(msg)` — bottom toast notification
- `showLoader(on)` — fullscreen loading spinner
- `saveSuggestions()` — persists SUGGESTIONS to window.storage
- `saveExtra()` — persists EXTRA_MEMBERS to window.storage

## Key HTML elements (tree.html)
- `#tree-canvas` — SVG container (overflow:hidden, d3.zoom handles pan)
- `#main-tree` — the SVG element
- `#info-panel` — right slide-in panel
  - `#p-avatar, #p-name, #p-nick, #p-rel, #p-body, #p-foot`
- `#queue-panel` — left slide-in, Historian suggestion queue
- `#modal-suggest` — suggestion submission modal
- `#modal-member` — Historian add/edit member modal
  - `#m-title, #m-fullname, #m-nicks, #m-notes, #m-rel-to, #m-rel-type`
- `#modal-passcode` — Historian unlock modal
- `#ctx-menu` — right-click context menu
- `#historian-stripe` — top banner shown in Historian mode
- `#tree-search` — search input in header

## Google Sheets (data source)
Sheet name: `Sheet1`
Columns: `ID | Name | Parent ID | Spouse ID | Place/Notes | Sex | Year of Birth | Year of Death | Place of Birth | Current Location`
Submissions sheet columns: `Timestamp | Type | Summary | From | Notes | Status`

## Apps Script endpoint
URL stored in `const SHEETS_ENDPOINT` in tree.html.
- GET + `?callback=fn` → JSONP response for family data
- POST → writes to Submissions sheet

Project ID: `1HBG6Ha88BK-Wpuny4531wPFRnk55adLT4P8Wte8E80XK10dlIgQLmoTU`

Gender check uses `.startsWith('F')` (not `.toUpperCase() === 'F'`).

## Storage keys (window.storage)
- `umunna:suggestions` — SUGGESTIONS array
- `umunna:pending` — PENDING overlay object
- `umunna:photos` — PHOTOS object {nodeId: url}
- `umunna:extra` — EXTRA_MEMBERS + NEXT_ID

## Design system
Colors via CSS variables: --bg, --bg2, --card, --card2, --border, --gold, --amber, --terra, --cream, --muted, --green, --blue, --purple, --teal, --red
Fonts: Fraunces (display/headings) + Outfit (body)
Dark earthy aesthetic — mahogany, amber, cream on near-black background.

## Rules for all edits
- Edit `tree.html` unless explicitly told otherwise
- Never mutate `P` directly
- Surgical edits only — do not rewrite unrelated code
- Preserve all existing function signatures
- New storage keys follow pattern 'umunna:keyname'
