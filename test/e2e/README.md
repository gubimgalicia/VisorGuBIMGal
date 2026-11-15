# Browser checks (headless Chrome over CDP)

Keep the output folder outside the repo: Chrome profiles inside it crash the Vite watcher.

Needs Google Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` and Node 22 or later
(global `WebSocket`). Expected values come from the IFC text and geometry, not from the app.

```sh
npx vite --port 5173 --strictPort --host 127.0.0.1          # dev server: exposes the renderer hooks
node test/e2e/e2e.mjs gpu http://127.0.0.1:5173/ "$TEMP/gubim-e2e"    # WebGPU
node test/e2e/e2e.mjs gl2 http://127.0.0.1:5173/ "$TEMP/gubim-e2e"    # WebGL2 (navigator.gpu hidden)

npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1
node test/e2e/smoke.mjs gpu  "http://127.0.0.1:4173/VisorGuBIMGal/?model=/VisorGuBIMGal/samples/ManySimpleWalls.ifc" "$TEMP/gubim-e2e"
node test/e2e/smoke.mjs gl2  "<same url>" "$TEMP/gubim-e2e"
node test/e2e/smoke.mjs none "<same url>" "$TEMP/gubim-e2e"           # WebGPU without an adapter
```

`e2e.mjs` covers T-135 (view cube, ortho, saved view projection, orbit pivot, zoom to selection,
first person), T-136 (BCF topic, viewpoint with snapshot, restore, 3.0 export read back with an
independent unzip, re-import) and T-137 (face pick, 3D clip on both sides, plane cut equal to the
plan cut, DXF and SVG downloads, vertical face elevation with the door notch: 20.268 m).
