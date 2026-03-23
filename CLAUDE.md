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
- `_collapsed` — Set of collapsed node IDs (D3 tree)
- `RC` — maps rel string → hex color
- `RL` — maps rel string → display label
- `NW = 110, NH = 46` — node width/height

## Key functions (tree.html)
- `renderTree()` — draws the SVG tree
- `openNode(id)` — opens right-side info panel
- `showCtx(event, id)` — right-click context menu
- `searchTree(q)` — highlights matching nodes
- `setCenter(id)` — sets _centerId and re-renders
- `avatar(p)` — returns 👨🏾 or 👩🏾 based on p.g
- `gender(p)` — returns 'm' or 'f'
- `displayName(p)` — returns p.name
- `shortName(p)` — first word + truncated rest
- `enterTree()` — called by Enter button, waits for data then renders
- `loadViaJSONP(url)` — fetches data from Apps Script endpoint
- `init()` — loads storage, fetches P via JSONP, sets _dataReady
- `showToast(msg)` — bottom toast notification
- `showLoader(on)` — fullscreen loading spinner
- `saveSuggestions()` — persists SUGGESTIONS to window.storage
- `saveExtra()` — persists EXTRA_MEMBERS to window.storage

## Key HTML elements (tree.html)
- `#tree-canvas` — scrollable SVG container
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
- `#members-content` — All Members view content area
- `#discover-content` — Discover view content area

## Google Sheets (data source)
Sheet name: `Sheet1`
Columns: `ID | Name | Parent ID | Spouse ID | Place/Notes | Sex | Year of Birth | Year of Death | Place of Birth | Current Location`
Submissions sheet columns: `Timestamp | Type | Summary | From | Notes | Status`

## Apps Script endpoint
URL stored in `const SHEETS_ENDPOINT` in tree.html.
- GET + `?callback=fn` → JSONP response for family data
- POST → writes to Submissions sheet

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
