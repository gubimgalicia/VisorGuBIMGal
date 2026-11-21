# Browser tests (headless Chrome over CDP)

Backlog D1. Expected values come from the IFC text, from formulas in the tests and from geometry,
never from the app's own code paths.

```sh
npm run test:e2e        # starts Vite, runs every suite on WebGPU, WebGL2 and WebGPU without an adapter
npm test                # unit tests, then the browser tests
```

| Variable | Meaning | Default |
|---|---|---|
| `E2E_MODES` | Backends: `gpu`, `gl2` (no `navigator.gpu`), `none` (WebGPU with no adapter) | `gpu,gl2,none` |
| `E2E_SUITES` | `tc`, `e2e`, `glb` | all |
| `E2E_OUT` | Output folder. Must be outside the repo: Chrome profiles inside it crash the Vite watcher | `<tmp>/gubim-e2e` |
| `E2E_PORT` | Vite port; the runner stops if it is taken | `5173` |
| `CHROME_PATH` | Chrome binary | per platform |
| `E2E_CHROME_FLAGS` | Extra Chrome flags, e.g. SwiftShader on a machine without a GPU | none |
| `E2E_UPDATE_REFS=1` | Write missing screenshot references into `ref/` | off |
| `E2E_REQUIRE_REFS=1` | A missing reference fails instead of being reported as NEW | off |

Needs Google Chrome and Node 22 or later (global `WebSocket`).

## Suites

- `tc.mjs`: acceptance tests TC-001..008 of `docs/01`.
  - TC-001: open a local file through the file input; the backend badge and renderer match the mode.
  - TC-002: SimpleWall and ManySimpleWalls both contain `#219`, a wall with the same GlobalId but a different name. A click on each selects that model's wall and the panel shows that file's name, never the other.
  - TC-003: hide and show by pick. Removing a model frees exactly its buffers; with every model removed, GPU memory is back to the empty scene. WebGPU's shared tables keep their grown capacity while any model is open, by design.
  - TC-004: GlobalId, name, class and every property set related to the wall in the STEP file.
  - TC-005: plan and section SVG identical when generated twice.
  - TC-006: DXF R12 (`AC1009`) and SVG downloads.
  - TC-007: the Galicia fixture's marker against an inverse UTM 29N written here (Snyder 1987), to 2e-5 degrees, and the PNOA layer present.
  - TC-008: every request is logged. None carries a body, and the only external requests are GETs for OpenStreetMap and IGN map tiles.
  - Screenshots of the 3D view and the plan preview, with overlays hidden, against `ref/<platform>-<mode>/`. More than 0.5 % of pixels off by more than 24 fails. A 3° change of the default iso angle fails at 1.9 %.
- `e2e.mjs`: T-135 navigation, T-136 BCF, T-137 face cut.
- `glb-check.mjs`: T-138 GLB export, read back with its own parser.
- `smoke.mjs`: the production build (`vite preview`) loads a sample: `node test/e2e/smoke.mjs gpu "http://127.0.0.1:4173/VisorGuBIMGal/?model=/VisorGuBIMGal/samples/ManySimpleWalls.ifc" "$TEMP/gubim-e2e"`.

## CI

The `browser` job in `.github/workflows/ci.yml` runs `gl2`, `none` and `gpu` on SwiftShader as
required steps. The Linux references in
`ref/linux-*` come from the first green run (CI run 44613444086, 2026-11-19), checked by eye against
the Windows ones. The job sets `E2E_REQUIRE_REFS=1`, so a missing reference fails. A new screenshot
lands in the `e2e-output` artifact (`new-refs/linux-*`) on its first run, to be checked and committed.
