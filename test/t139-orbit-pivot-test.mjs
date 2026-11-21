// Unit tests for T-139: surface-depth orbit pivot unprojection (perspective & orthographic,
// origin & UTM), async pointer-movement buffering in canvasInput, section-plane filtering,
// and fallback order.
// Usage: node test/t139-orbit-pivot-test.mjs
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && context.parentURL) {
        const parentPath = fileURLToPath(context.parentURL);
        const candidate = path.resolve(path.dirname(parentPath), `${specifier}.ts`);
        if (existsSync(candidate)) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
      throw err;
    }
  }
});

const { Camera, resolveOrbitPivot, pickBatchOrbitPivot } = await import(
  '../src/infrastructure/renderer/Camera.ts'
);
const { attachCanvasInput } = await import('../src/infrastructure/renderer/canvasInput.ts');

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${id} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  );
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const vnear = (a, b, tol) => Array.isArray(a) && a.length === 3 && a.every((v, i) => near(v, b[i], tol));

function createMockCanvas(width = 800, height = 600) {
  const listeners = new Map();
  return {
    clientWidth: width,
    clientHeight: height,
    style: { touchAction: '', cursor: '' },
    getBoundingClientRect: () => ({ left: 10, top: 20, width, height }),
    setPointerCapture: () => {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners.get(type) ?? []) {
        fn({ preventDefault() {}, ...event });
      }
    }
  };
}

const TAN_HALF_FOV = Math.SQRT2 - 1; // tan(pi/8) = sqrt(2) - 1

// ---------------------------------------------------------------------------
// 1. Perspective unprojection at the origin (hand-calculated expected values)
// ---------------------------------------------------------------------------
// Pose: target = [0, 0, 0], distance = 10, azimuth = -pi/2 (looking +Y), elevation = 0, aspect = 2
// -> eye = [0, -10, 0], forward = [0, 1, 0], right = [1, 0, 0], up = [0, 0, 1]
// -> near = 0.02 m, far = 50000 m
// For forward distance d = 8 m (world y = -2):
// Reverse-Z depth z_rev = near*(far - d) / (d*(far - near)) = 0.02*49992 / (8*49999.98) = 6249 / 2499999
{
  const cam = new Camera();
  cam.setAspect(2);
  cam.setPose({
    target: [0, 0, 0],
    distance: 10,
    azimuth: -Math.PI / 2,
    elevation: 0,
    projection: 'perspective'
  });

  const zRev8m = 6249 / 2499999;
  const pCenter = typeof cam.unproject === 'function' ? cam.unproject(0, 0, zRev8m) : null;
  const expectedCenter = [0, -2, 0];
  check('T1a perspective unproject at origin (center)', vnear(pCenter, expectedCenter, 1e-9), {
    got: pCenter,
    expected: expectedCenter
  });

  // Off-center: ndcX = 0.5, ndcY = -0.25 at d = 8 m:
  // x_cam = 0.5 * 2 * 8 * tan(pi/8) = 8*(sqrt(2) - 1)
  // y_cam = -0.25 * 8 * tan(pi/8) = -2*(sqrt(2) - 1)
  const pOff = typeof cam.unproject === 'function' ? cam.unproject(0.5, -0.25, zRev8m) : null;
  const expectedOff = [8 * TAN_HALF_FOV, -2, -2 * TAN_HALF_FOV];
  const roundTrip = pOff ? cam.project(pOff) : null;
  check(
    'T1b perspective unproject at origin (off-center + project round-trip)',
    vnear(pOff, expectedOff, 1e-9) &&
      roundTrip !== null &&
      near(roundTrip.x, 0.5, 1e-9) &&
      near(roundTrip.y, -0.25, 1e-9),
    { got: pOff, expected: expectedOff, roundTrip }
  );

  // Invalid depths must return null (0 is cleared background in reverse-Z).
  const invalidOk =
    typeof cam.unproject === 'function' &&
    cam.unproject(0, 0, 0) === null &&
    cam.unproject(0, 0, -0.1) === null &&
    cam.unproject(0, 0, 1.01) === null &&
    cam.unproject(0, 0, Number.NaN) === null;
  check('T1c unproject rejects background/out-of-range depths', invalidOk, {
    z0: typeof cam.unproject === 'function' ? cam.unproject(0, 0, 0) : undefined
  });
}

// ---------------------------------------------------------------------------
// 2. Orthographic unprojection at the origin (hand-calculated expected values)
// ---------------------------------------------------------------------------
// Same pose with projection = 'orthographic':
// -> halfH = 10 * tan(pi/8) = 10*(sqrt(2) - 1), halfW = 20*(sqrt(2) - 1)
// -> symmetric depth range near = -25000 m, far = 25000 m (span = 50000 m)
// For forward distance d = 8 m (world y = -2):
// Reverse-Z ortho depth z_ortho = (far - d) / (far - near) = (25000 - 8) / 50000 = 24992 / 50000
// At ndcX = 0.5, ndcY = -0.25:
// -> x_cam = 0.5 * halfW = 10*(sqrt(2) - 1), y_cam = -0.25 * halfH = -2.5*(sqrt(2) - 1)
{
  const cam = new Camera();
  cam.setAspect(2);
  cam.setPose({
    target: [0, 0, 0],
    distance: 10,
    azimuth: -Math.PI / 2,
    elevation: 0,
    projection: 'orthographic'
  });

  const zOrtho8m = (25000 - 8) / 50000;
  const pOrtho = typeof cam.unproject === 'function' ? cam.unproject(0.5, -0.25, zOrtho8m) : null;
  const expectedOrtho = [10 * TAN_HALF_FOV, -2, -2.5 * TAN_HALF_FOV];
  const roundTrip = pOrtho ? cam.project(pOrtho) : null;
  check(
    'T2 orthographic unproject at origin (off-center + project round-trip)',
    vnear(pOrtho, expectedOrtho, 1e-9) &&
      roundTrip !== null &&
      near(roundTrip.x, 0.5, 1e-9) &&
      near(roundTrip.y, -0.25, 1e-9),
    { got: pOrtho, expected: expectedOrtho, roundTrip }
  );
}

// ---------------------------------------------------------------------------
// 3. UTM coordinates (500000, 4700000, 350) in perspective & orthographic
// ---------------------------------------------------------------------------
// Iso angles: azimuth = -pi/4, elevation = atan(1/sqrt(2)), distance = 25, aspect = 16/9
// -> forward = [-1/sqrt(3), 1/sqrt(3), -1/sqrt(3)]
// -> right   = [ 1/sqrt(2), 1/sqrt(2),  0        ]
// -> up      = [-1/sqrt(6), 1/sqrt(6),  sqrt(2/3)]
// -> eye     = target - 25 * forward
// -> near    = 0.05 m, far = 50000 m
// Point P_utm at d = 18 m, x_cam = 3 m, y_cam = -1.5 m from eye:
{
  const utmTarget = [500000, 4700000, 350];
  const invSqrt3 = 1 / Math.sqrt(3);
  const invSqrt2 = 1 / Math.SQRT2;
  const invSqrt6 = 1 / Math.sqrt(6);
  const sqrt2Over3 = Math.sqrt(2 / 3);

  const forward = [-invSqrt3, invSqrt3, -invSqrt3];
  const right = [invSqrt2, invSqrt2, 0];
  const up = [-invSqrt6, invSqrt6, sqrt2Over3];
  const eye = [
    utmTarget[0] - 25 * forward[0],
    utmTarget[1] - 25 * forward[1],
    utmTarget[2] - 25 * forward[2]
  ];
  const d = 18;
  const xCam = 3;
  const yCam = -1.5;
  const expectedUtm = [
    eye[0] + d * forward[0] + xCam * right[0] + yCam * up[0],
    eye[1] + d * forward[1] + xCam * right[1] + yCam * up[1],
    eye[2] + d * forward[2] + xCam * right[2] + yCam * up[2]
  ];

  // 3a. Perspective at UTM with f32-quantized GPU depth
  const camPersp = new Camera();
  camPersp.setAspect(16 / 9);
  camPersp.setPose({
    target: utmTarget,
    distance: 25,
    azimuth: -Math.PI / 4,
    elevation: Math.atan(1 / Math.SQRT2),
    projection: 'perspective'
  });
  const h = 1 / TAN_HALF_FOV;
  const ndcXPersp = ((h / (16 / 9)) * xCam) / d;
  const ndcYPersp = (h * yCam) / d;
  const zPerspF64 = (0.05 * (50000 - d)) / (d * (50000 - 0.05));
  const zPerspF32 = Math.fround(zPerspF64);
  const gotUtmPersp =
    typeof camPersp.unproject === 'function'
      ? camPersp.unproject(ndcXPersp, ndcYPersp, zPerspF32)
      : null;
  const errPerspMm = gotUtmPersp
    ? Math.hypot(
        gotUtmPersp[0] - expectedUtm[0],
        gotUtmPersp[1] - expectedUtm[1],
        gotUtmPersp[2] - expectedUtm[2]
      ) * 1000
    : Infinity;
  check('T3a UTM perspective unprojection within 1 mm (f32 depth)', errPerspMm < 1.0, {
    got: gotUtmPersp,
    expected: expectedUtm,
    errMm: errPerspMm
  });

  // 3b. Orthographic at UTM with f32-quantized GPU depth
  const camOrtho = new Camera();
  camOrtho.setAspect(16 / 9);
  camOrtho.setPose({
    target: utmTarget,
    distance: 25,
    azimuth: -Math.PI / 4,
    elevation: Math.atan(1 / Math.SQRT2),
    projection: 'orthographic'
  });
  const halfH = 25 * TAN_HALF_FOV;
  const halfW = halfH * (16 / 9);
  const ndcXOrtho = xCam / halfW;
  const ndcYOrtho = yCam / halfH;
  const zOrthoF64 = (25000 - d) / 50000;
  const zOrthoF32 = Math.fround(zOrthoF64);
  const gotUtmOrtho =
    typeof camOrtho.unproject === 'function'
      ? camOrtho.unproject(ndcXOrtho, ndcYOrtho, zOrthoF32)
      : null;
  const errOrthoMm = gotUtmOrtho
    ? Math.hypot(
        gotUtmOrtho[0] - expectedUtm[0],
        gotUtmOrtho[1] - expectedUtm[1],
        gotUtmOrtho[2] - expectedUtm[2]
      ) * 1000
    : Infinity;
  check('T3b UTM orthographic unprojection within 3 mm (f32 depth)', errOrthoMm < 3.0, {
    got: gotUtmOrtho,
    expected: expectedUtm,
    errMm: errOrthoMm
  });
}

// ---------------------------------------------------------------------------
// 4. Buffering of pointer movement until the async pivot arrives
// ---------------------------------------------------------------------------
{
  const cam = new Camera();
  cam.setAspect(800 / 600);
  cam.setPose({
    target: [0, 0, 0],
    distance: 15,
    azimuth: -Math.PI / 4,
    elevation: Math.atan(1 / Math.SQRT2),
    projection: 'perspective'
  });

  const surfacePivot = [2.83, 3.32, 4.52];
  const beforeNdc = cam.project(surfacePivot);
  const pose0 = cam.getPose();

  let resolvePivot;
  const pivotPromise = new Promise((res) => {
    resolvePivot = res;
  });

  let viewChanges = 0;
  let clicks = 0;
  const canvas = createMockCanvas(800, 600);
  const detach = attachCanvasInput(canvas, cam, {
    onViewChange: () => {
      viewChanges++;
    },
    onClick: () => {
      clicks++;
    },
    getOrbitPivot: () => pivotPromise
  });

  // Press at (400, 300) and drag by (40, 12) + (40, 12) = (80, 24) while pivot is still pending
  canvas.dispatch('pointerdown', {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: 410,
    clientY: 320,
    shiftKey: false
  });
  canvas.dispatch('pointermove', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 450,
    clientY: 332
  });
  canvas.dispatch('pointermove', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 490,
    clientY: 344
  });

  const poseWhilePending = cam.getPose();
  const unchangedWhilePending =
    poseWhilePending.azimuth === pose0.azimuth &&
    poseWhilePending.elevation === pose0.elevation &&
    vnear(poseWhilePending.target, pose0.target, 1e-12) &&
    viewChanges === 0;

  // Now resolve the async pivot
  resolvePivot(surfacePivot);
  await Promise.resolve();

  const poseAfterResolve = cam.getPose();
  const afterNdc = cam.project(surfacePivot);
  const ndcDrift = afterNdc
    ? Math.hypot(afterNdc.x - beforeNdc.x, afterNdc.y - beforeNdc.y)
    : Infinity;

  canvas.dispatch('pointerup', {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: 490,
    clientY: 344
  });

  check(
    'T4a async pivot buffers moves while pending and pins surface point on resolve',
    unchangedWhilePending &&
      Math.abs(poseAfterResolve.azimuth - pose0.azimuth) > 0.5 &&
      viewChanges === 1 &&
      ndcDrift < 1e-9 &&
      clicks === 0,
    {
      unchangedWhilePending,
      dAz: poseAfterResolve.azimuth - pose0.azimuth,
      viewChanges,
      ndcDrift
    }
  );

  // T4b: pointerup arrives BEFORE async pivot resolves -> buffered drag is still applied on resolve
  let resolvePivot2;
  const pivotPromise2 = new Promise((res) => {
    resolvePivot2 = res;
  });
  const cam2 = new Camera();
  cam2.setAspect(800 / 600);
  cam2.setPose(pose0);
  let viewChanges2 = 0;
  const detach2 = attachCanvasInput(canvas, cam2, {
    onViewChange: () => {
      viewChanges2++;
    },
    onClick: () => {},
    getOrbitPivot: () => pivotPromise2
  });
  detach();

  canvas.dispatch('pointerdown', {
    pointerId: 2,
    pointerType: 'mouse',
    button: 0,
    clientX: 410,
    clientY: 320,
    shiftKey: false
  });
  canvas.dispatch('pointermove', {
    pointerId: 2,
    pointerType: 'mouse',
    clientX: 490,
    clientY: 344
  });
  canvas.dispatch('pointerup', {
    pointerId: 2,
    pointerType: 'mouse',
    button: 0,
    clientX: 490,
    clientY: 344
  });
  resolvePivot2(surfacePivot);
  await Promise.resolve();

  const afterNdc2 = cam2.project(surfacePivot);
  const ndcDrift2 = afterNdc2
    ? Math.hypot(afterNdc2.x - beforeNdc.x, afterNdc2.y - beforeNdc.y)
    : Infinity;
  check(
    'T4b fast drag released before pivot resolves still applies buffered orbit',
    Math.abs(cam2.getPose().azimuth - pose0.azimuth) > 0.5 &&
      viewChanges2 === 1 &&
      ndcDrift2 < 1e-9,
    { dAz: cam2.getPose().azimuth - pose0.azimuth, viewChanges2, ndcDrift2 }
  );

  // T4c: pointerdown + pointerup without moving still selects and does not rotate
  let resolvePivot3;
  const pivotPromise3 = new Promise((res) => {
    resolvePivot3 = res;
  });
  const cam3 = new Camera();
  cam3.setAspect(800 / 600);
  cam3.setPose(pose0);
  let clicks3 = 0;
  let viewChanges3 = 0;
  detach2();
  const detach3 = attachCanvasInput(canvas, cam3, {
    onViewChange: () => {
      viewChanges3++;
    },
    onClick: () => {
      clicks3++;
    },
    getOrbitPivot: () => pivotPromise3
  });
  canvas.dispatch('pointerdown', {
    pointerId: 3,
    pointerType: 'mouse',
    button: 0,
    clientX: 410,
    clientY: 320,
    shiftKey: false
  });
  canvas.dispatch('pointerup', {
    pointerId: 3,
    pointerType: 'mouse',
    button: 0,
    clientX: 410,
    clientY: 320
  });
  resolvePivot3(surfacePivot);
  await Promise.resolve();
  detach3();

  check(
    'T4c click without moving selects and does not rotate',
    clicks3 === 1 && viewChanges3 === 0 && cam3.getPose().azimuth === pose0.azimuth,
    { clicks3, viewChanges3 }
  );
}

// ---------------------------------------------------------------------------
// 5. Fallback order & section plane filtering
// ---------------------------------------------------------------------------
{
  const cam = new Camera();
  cam.setAspect(2);
  cam.setPose({
    target: [0, 0, 0],
    distance: 10,
    azimuth: -Math.PI / 2,
    elevation: 0,
    projection: 'perspective'
  });
  // eye = [0, -10, 0], looking +Y, near = 0.02, far = 50000
  // Batch box spans y in [-6, 5], so ray at (0, 0) enters batch box at [0, -6, 0] (d = 4 m).
  const models = [{ visible: true, batches: [{ min: [-5, -6, -5], max: [5, 5, 5] }] }];

  const zSurfaceAtMinus2 = 6249 / 2499999; // d = 8 m -> world [0, -2, 0]
  const zFrontAtMinus4 = (0.02 * (50000 - 6)) / (6 * (50000 - 0.02)); // d = 6 m -> world [0, -4, 0]

  // T5a: Valid surface hit takes precedence over batch-box entry point
  const pSurface =
    typeof resolveOrbitPivot === 'function'
      ? resolveOrbitPivot(cam, 0, 0, { hit: true, depth: zSurfaceAtMinus2 }, models, [])
      : null;
  check('T5a surface hit takes precedence over batch-box entry', vnear(pSurface, [0, -2, 0], 1e-9), {
    got: pSurface,
    expected: [0, -2, 0],
    batchBoxEntry: [0, -6, 0]
  });

  // T5b: Section plane cuts away front surface at y = -4 (normal = [0, -1, 0], offset = 3 keeps y >= -3)
  // so pivot must be on the cut-revealed surface at y = -2, not the removed surface at y = -4.
  const sectionPlanes = [{ normal: [0, -1, 0], offset: 3 }];
  const pSectioned =
    typeof resolveOrbitPivot === 'function'
      ? resolveOrbitPivot(
          cam,
          0,
          0,
          [
            { hit: true, depth: zFrontAtMinus4 },
            { hit: true, depth: zSurfaceAtMinus2 }
          ],
          models,
          sectionPlanes
        )
      : null;
  check(
    'T5b section plane discards removed surface and picks cut-revealed surface',
    vnear(pSectioned, [0, -2, 0], 1e-9),
    { got: pSectioned, expected: [0, -2, 0], removed: [0, -4, 0] }
  );

  // T5c: Over background (hit: false), return null (no pivot change) even when ray passes through batch box
  const pBg =
    typeof resolveOrbitPivot === 'function'
      ? resolveOrbitPivot(cam, 0, 0, { hit: false }, models, [])
      : undefined;
  check('T5c confirmed background returns null (no pivot change)', pBg === null, { got: pBg });

  // T5d: When surface point cannot be had (hit: null or unusable depth), fall back to batch-box entry point
  const pFallbackNull =
    typeof resolveOrbitPivot === 'function'
      ? resolveOrbitPivot(cam, 0, 0, { hit: null }, models, [])
      : null;
  const pFallbackCorrupt =
    typeof resolveOrbitPivot === 'function'
      ? resolveOrbitPivot(cam, 0, 0, { hit: true, depth: 0 }, models, [])
      : null;
  const expectedBox = pickBatchOrbitPivot(cam.rayAt(0, 0), models, []);
  check(
    'T5d unavailable surface point falls back to batch-box point',
    vnear(pFallbackNull, [0, -6, 0], 1e-9) &&
      vnear(pFallbackCorrupt, [0, -6, 0], 1e-9) &&
      vnear(expectedBox, [0, -6, 0], 1e-9),
    { pFallbackNull, pFallbackCorrupt, expectedBox }
  );

  // T5e: Fallback over background (ray misses all boxes) returns null
  const pFallbackMiss =
    typeof resolveOrbitPivot === 'function'
      ? resolveOrbitPivot(cam, 0, 0, { hit: null }, [{ visible: true, batches: [{ min: [20, 20, 20], max: [30, 30, 30] }] }], [])
      : undefined;
  check('T5e fallback outside batch boxes returns null', pFallbackMiss === null, {
    got: pFallbackMiss
  });
}

// ---------------------------------------------------------------------------
// 6. Close-up orthographic inspection, tight framing, and wheel zoom in FP
// ---------------------------------------------------------------------------
{
  // T6a: Zoomed in close (distance = 0.5 m inside a 20 m building), front facade at depth = -9.5 m
  // behind `eye` is NOT clipped: project, unproject, frustum, and rayAt/batch pick all succeed.
  const cam = new Camera();
  cam.setAspect(16 / 9);
  cam.setPose({
    target: [0, 0, 0],
    distance: 0.5,
    azimuth: -Math.PI / 2,
    elevation: 0,
    projection: 'orthographic'
  });
  // eye = [0, -0.5, 0], looking +Y; front facade is at y = -10 (depth = -9.5 m behind eye!)
  const facadePoint = [0.1, -10, 0.05];
  const ndc = cam.project(facadePoint);
  const zFacade = (25000 - -9.5) / 50000;
  const unproj = ndc ? cam.unproject(ndc.x, ndc.y, zFacade) : null;
  const frustum = cam.frustum();
  // Near plane is plane 0: n . p + d >= 0
  const nearSide =
    frustum[0] * facadePoint[0] +
    frustum[1] * facadePoint[1] +
    frustum[2] * facadePoint[2] +
    frustum[3];
  const models = [{ visible: true, batches: [{ min: [-10, -10, -3], max: [10, 10, 3] }] }];
  const picked = pickBatchOrbitPivot(cam.rayAt(0, 0), models, []);
  check(
    'T6a close-up orthographic view does not clip facade behind eye',
    ndc !== null &&
      unproj !== null &&
      vnear(unproj, facadePoint, 1e-9) &&
      nearSide > 0 &&
      vnear(picked, [0, -10, 0], 1e-9),
    { ndc, unproj, nearSide, picked }
  );

  // T6b: Orthographic framing via setPreset('front') and fitToBounds fits tightly (>75% of limiting axis)
  const bldg = { min: { x: -10, y: -5, z: 0 }, max: { x: 10, y: 5, z: 6 } };
  const camFit = new Camera();
  camFit.setAspect(16 / 9);
  camFit.setProjection('orthographic');
  camFit.setPreset('front', bldg);
  let maxAbsX = 0;
  let maxAbsY = 0;
  let allInside = true;
  for (const x of [bldg.min.x, bldg.max.x]) {
    for (const y of [bldg.min.y, bldg.max.y]) {
      for (const z of [bldg.min.z, bldg.max.z]) {
        const s = camFit.project([x, y, z]);
        if (!s || Math.abs(s.x) > 1 || Math.abs(s.y) > 1) allInside = false;
        if (s) {
          maxAbsX = Math.max(maxAbsX, Math.abs(s.x));
          maxAbsY = Math.max(maxAbsY, Math.abs(s.y));
        }
      }
    }
  }
  const fill = Math.max(maxAbsX, maxAbsY);
  check(
    'T6b orthographic preset frames building tightly inside viewport',
    allInside && fill > 0.75 && fill < 0.95,
    { allInside, maxAbsX, maxAbsY, fill, distance: camFit.getDistance() }
  );

  // T6c: Wheel scrolling zooms in orthographic mode even when navigationMode is first-person
  const camFp = new Camera();
  camFp.setAspect(16 / 9);
  camFp.setPose({
    target: [0, 0, 0],
    distance: 20,
    azimuth: -Math.PI / 2,
    elevation: 0,
    projection: 'orthographic'
  });
  const canvas = createMockCanvas(800, 600);
  const detach = attachCanvasInput(canvas, camFp, {
    onViewChange: () => {},
    onClick: () => {},
    getNavigationMode: () => 'first-person'
  });
  canvas.dispatch('wheel', { deltaY: -100, preventDefault: () => {} });
  detach();
  check(
    'T6c wheel zooms in orthographic mode even while in first-person navigation',
    camFp.getDistance() < 20,
    { distanceAfterWheel: camFp.getDistance() }
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pass`);
if (failed.length > 0) process.exit(1);
