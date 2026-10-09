# Pinned Archify feasibility input (test-only)

- Upstream: [tt-a1i/archify](https://github.com/tt-a1i/archify)
- Revision: [`9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993`](https://github.com/tt-a1i/archify/tree/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993), identified by the supplied research as template label `2.17.0-dev.1` (not represented as a stable release).
- Input: [`archify/assets/template.html`](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/archify/assets/template.html), preserved verbatim as `archify-template.html` for offline browser feasibility tests.
- Raw size: 774,866 bytes. SHA-256: `505f1c6baa9c2454475c048aa75df8abd867e680e7b3b794b9218a95a56fc370`.
- Viewer contract: [`viewer/README.md`](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/viewer/README.md). The pinned contract describes generated static SVG input; Finder indexes once and has no reindex/mount/destroy API; Camera and several geometry-dependent modules retain page-lifetime references/listeners.
- License: [`archify/LICENSE`](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/archify/LICENSE), reproduced in `LICENSE`. Its MIT notice attributes Archify and Cocoon AI.
- The template embeds JetBrains Mono variable WOFF2 subsets and includes their SIL Open Font License 1.1 notice/text. It identifies Google Fonts service revision v24 and the JetBrains Mono Project Authors (2020).

The fixture is not a production viewer, runtime asset, new dependency, or claim that the upstream template supports live JSON. The pinned input file remains checksum-identical. No production source or package configuration is changed by this feasibility gate.

## Local Finder refresh experiment

`finder-live.patch.json` is an integration-authored, test-only patch recipe against that exact pinned template. It changes three uniquely matched anchors in the Finder capability: make its existing item collector reusable, add explicit `refresh()`, and read count from the refreshed index. The browser test applies the recipe in memory only after verifying the original SHA-256; every anchor must match exactly once.

The patch file is 776 bytes (LF); the patched HTML is 775,040 bytes, a net addition of 174 bytes to the pinned input. It adds no dependency, listener, runtime download or separate initialization. Browser tests compare unpatched versus patched behavior while the inserted node is still attached, verify actual Archify focus after selection, then independently verify removal/reindexing. This proves only a localized Finder remedy, not the complete live profile, graph layout or final update-maintenance strategy.

The original E0 NO-GO commit's search-after-removal assertion was defective. Commit `0302f2e` corrected it; this E0R proof below closes the bounded feasibility gate without changing the pinned input or production source.

## E0R bounded live-profile proof (test-only)

`live-profile.patch.json` keeps the same three localized Finder anchors and adds only unique `</head>` / `</body>` references to the two external fixture assets. Application checks the pinned input's exact byte count and SHA-256, then requires every anchor to match exactly once. The original `finder-live.patch.json` remains unchanged.

| Candidate item | Raw bytes | SHA-256 |
| --- | ---: | --- |
| Pinned input HTML | 774,866 | `505f1c6baa9c2454475c048aa75df8abd867e680e7b3b794b9218a95a56fc370` |
| Patched viewer HTML | 775,134 | `f18ad0819a3e8413c5d9e0ad6f4bf73680f37ce374c3eaa82a8441803baf768f` |
| External profile JS | 11,594 | `2065e1d6d647e030189ee8d639a4a84228c06f815c2f6b192cc3ef7cfe195983` |
| External profile CSS | 606 | `840e950479da0a335add60341ee5a3e4b9b51069135e5e388b3c5e0253d34e05` |
| Patch recipe | 1,000 | `cc830d7796d76fde7019d4553d244f8febd43cecb0219afad3ceca23137b6f2c` |

The three viewer assets total **787,334 B** raw, a **12,468 B net addition** over the pinned input and below the 1 MB review threshold. The HTML patch adds 268 B: 174 B from the Finder hook plus the two external references. Five unique anchor sites are touched: three within one Finder capability, two asset-link insertion points. These are feasibility fixture measurements, not a production tarball or final package delta.

The real-Chrome profile starts with six synthetic fixture nodes (workflow, two tasks, agent, tool, result) and six explicit dependency/invokes/produces relations. It creates real Archify-owned SVG child geometry: finite positive node bounding boxes and edge path lengths. The fixture uses deterministic five-column/six-row ID slots (30-node bound, 180×72 cards) and simple orthogonal relation paths (100-edge bound); existing IDs retain slots. Status-only updates visibly change node status without changing slots/camera. Structural insertion refreshes Archify Finder; selecting the attached new ID proves `Archify.focus.active()` and neighbor highlighting; removing that selected node clears focus, selected markers, search results, and the focus hash while preserving camera state. Archify's `zoomIn()` and `centerAt()` exercise its actual camera; a viewport resize preserves the fixed viewBox, slots, and zoom level.

The browser loads the authentic pinned template plus external local JS/CSS under `sandbox="allow-scripts"` with no `allow-same-origin`. CSP denies default resources, connections, workers, nested frames, objects, base URLs and forms; the child allows only self/inline script and style plus data images/fonts. `unsafe-inline` is retained solely because the pinned 774 KB template contains inline scripts/styles. The test enables CDP network observation before iframe navigation, checks observed requests are same-origin/allowlisted, confirms the fixture HTTP server serves the HTML/JS/CSS and checks zero startup CSP violations. This is not production CSP/nonce/network proof: the test bootstrap uses a fixed fixture nonce and `postMessage('*')` only to transfer an empty-of-run-data `MessagePort`.

Archify embed mode is the boundary: Route Probe refuses `begin()` and is asserted inactive; Story, Export and Radar interactions are not part of this live profile. No broad viewer code is deleted or rewritten. The fixture JS is an E0 renderer experiment, not the product adapter or retry/causality mapper. Its fixed slots and elbow paths do not provide dense-graph collision avoidance. The synthetic graph does not establish workflow snapshot semantics, partial-data presentation, HTTP route/package/export integration, or production CSP/handshake security. Reopen/teardown is exercised through three repeated cycles (plus initial disposal), not the E4 50-cycle/heap suite. Later production work must independently pin/version the source, preserve licenses, generate the three shipped assets reproducibly/offline, and rerun the exact-anchor/browser checks; these test-only vendor/profile fixtures must not enter the package.

Focused verification in `.tmp/archify/baseline` (official-source scratch with existing dependencies; not committed): core build passed; the required browser command `PI_TRAJECTORY_CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe' node --expose-gc --test --test-name-pattern='Pinned Archify E0 sandbox spike' --test-timeout=120000 packages/core/dist/trajectory/test/trajectory-browser.test.js` passed **3/3, 0 skipped** in real Chrome; focused ESLint on `trajectory-browser.test.ts` and `node --check` on fixture JS passed. Exact outputs are retained locally in `.tmp/archify/logs/e0r/`.

**E0R gate: GO for bounded feasibility only.** The pinned viewer supports the requested bounded graph hooks with five localized anchors and about 12.5 KB of measured raw asset growth; a missing upstream reindex API is not a hard blocker. This does not authorize claiming the complete Semantic Map is implemented or shipping these fixture assets. E1–E4 still own production source integration, data/security/lifecycle tests, package/export/server routes, final size measurement, and full acceptance.
