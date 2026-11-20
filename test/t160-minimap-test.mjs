// T-160 (C16): the pure plan geometry behind the minimap. Model coordinates are metres, X east,
// Y north. The minimap is seen from above with north up, so screen x grows east and screen y grows
// south. Hand-computed frames, the inverse round trip, the compass headings and the view cone.
// node --experimental-strip-types test/t160-minimap-test.mjs
import assert from 'node:assert/strict';
import {
  eyeOf,
  minimapFrame,
  storeyAt,
  svgPlanSheet,
  toMinimap,
  toModel,
  viewCone
} from '../src/ui/viewer/minimap.ts';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

/** Floating comparison for hand-computed pixel values. */
const close = (actual, expected, what, epsilon = 1e-9) => {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon,
    `${what}: expected ${expected}, got ${actual}`
  );
};

/** A deterministic generator, so a failure can be reproduced. */
const seededRandom = (seed) => () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 4294967296;
};

const wideBounds = { min: { x: 0, y: 0 }, max: { x: 100, y: 50 } };
const tallBounds = { min: { x: 0, y: 0 }, max: { x: 50, y: 100 } };

check('wide bounds are centred with padding on every side', () => {
  // Free box 360 x 260: x needs 3.6 px/m, y would need 5.2, so the smaller scale wins.
  const frame = minimapFrame(wideBounds, 400, 300, 20);
  close(frame.scale, 3.6, 'scale');
  close(frame.offsetX, 20, 'offsetX'); // 200 - 3.6 * 50
  close(frame.offsetY, 240, 'offsetY'); // 150 + 3.6 * 25
  const low = toMinimap(frame, 0, 0);
  const high = toMinimap(frame, 100, 50);
  close(low.x, 20, 'west edge');
  close(high.x, 380, 'east edge');
  close(low.y, 240, 'south edge');
  close(high.y, 60, 'north edge');
});

check('tall bounds are centred with padding on every side', () => {
  // Free box 360 x 260: x would allow 7.2 px/m, y needs 2.6, so y decides.
  const frame = minimapFrame(tallBounds, 400, 300, 20);
  close(frame.scale, 2.6, 'scale');
  close(frame.offsetX, 135, 'offsetX'); // 200 - 2.6 * 25
  close(frame.offsetY, 280, 'offsetY'); // 150 + 2.6 * 50
  const low = toMinimap(frame, 0, 0);
  const high = toMinimap(frame, 50, 100);
  close(low.x, 135, 'west edge');
  close(high.x, 265, 'east edge');
  close(low.y, 280, 'south edge');
  close(high.y, 20, 'north edge');
});

check('north of the centre maps above it', () => {
  const frame = minimapFrame(wideBounds, 400, 300, 20);
  const centre = toMinimap(frame, 50, 25);
  const north = toMinimap(frame, 50, 30);
  const south = toMinimap(frame, 50, 20);
  close(centre.x, 200, 'centre x');
  close(centre.y, 150, 'centre y');
  close(north.x, centre.x, 'north keeps x');
  close(south.x, centre.x, 'south keeps x');
  assert.ok(north.y < centre.y, `north should be above: ${north.y} < ${centre.y}`);
  assert.ok(south.y > centre.y, `south should be below: ${south.y} > ${centre.y}`);
});

check('toModel(toMinimap(p)) returns p within 1e-9 for 1000 random points', () => {
  const frame = minimapFrame({ min: { x: -123.4, y: -56.7 }, max: { x: 987.6, y: 456.7 } }, 640, 480, 24);
  const random = seededRandom(20261120);
  for (let i = 0; i < 1000; i++) {
    const x = -2000 + 4000 * random();
    const y = -2000 + 4000 * random();
    const screen = toMinimap(frame, x, y);
    const model = toModel(frame, screen.x, screen.y);
    close(model.x, x, `point ${i} x`);
    close(model.y, y, `point ${i} y`);
  }
});

// A plan frame centred on model (0, 0): scale 1.8, screen centre (200, 200).
const coneFrame = minimapFrame({ min: { x: -100, y: -100 }, max: { x: 100, y: 100 } }, 400, 400, 20);
const eye = [0, 0, 10];
const directions = [
  { name: 'north', target: [0, 10, 10], heading: 0 },
  { name: 'east', target: [10, 0, 10], heading: Math.PI / 2 },
  { name: 'south', target: [0, -10, 10], heading: Math.PI },
  { name: 'west', target: [-10, 0, 10], heading: (3 * Math.PI) / 2 }
];

check('looking north and east gives headings 0 and PI/2', () => {
  for (const direction of directions.slice(0, 2)) {
    const cone = viewCone(coneFrame, eye, direction.target, Math.PI / 2, 50);
    assert.ok(cone, `${direction.name}: cone expected`);
    close(cone.heading, direction.heading, `${direction.name} heading`);
    close(cone.apex.x, 200, `${direction.name} apex x`);
    close(cone.apex.y, 200, `${direction.name} apex y`);
  }
});

check('looking south and west gives headings PI and 3PI/2', () => {
  for (const direction of directions.slice(2)) {
    const cone = viewCone(coneFrame, eye, direction.target, Math.PI / 2, 50);
    assert.ok(cone, `${direction.name}: cone expected`);
    close(cone.heading, direction.heading, `${direction.name} heading`);
  }
});

check('the cone opens to the left and right of the direction of view', () => {
  for (const direction of directions) {
    const cone = viewCone(coneFrame, eye, direction.target, Math.PI / 2, 50);
    assert.ok(cone, `${direction.name}: cone expected`);
    // Screen direction of view: compass heading turned into screen space, where y grows downwards.
    const angle = direction.heading - Math.PI / 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const left = { x: cone.left.x - cone.apex.x, y: cone.left.y - cone.apex.y };
    const right = { x: cone.right.x - cone.apex.x, y: cone.right.y - cone.apex.y };
    // Screen y grows down, so a negative cross product is counterclockwise, that is, to the left.
    const crossLeft = dx * left.y - dy * left.x;
    const crossRight = dx * right.y - dy * right.x;
    assert.ok(crossLeft < -1e-9, `${direction.name}: left corner should be left, cross ${crossLeft}`);
    assert.ok(crossRight > 1e-9, `${direction.name}: right corner should be right, cross ${crossRight}`);
    close(Math.hypot(left.x, left.y), 50, `${direction.name} left length`, 1e-9);
    close(Math.hypot(right.x, right.y), 50, `${direction.name} right length`, 1e-9);
  }
});

check('a 90 degree field of view puts each corner 45 degrees off the view', () => {
  const angleBetween = (u, v) => {
    const cosine = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
    return Math.acos(Math.min(1, Math.max(-1, cosine)));
  };
  for (const direction of [directions[0], directions[1]]) {
    const cone = viewCone(coneFrame, eye, direction.target, Math.PI / 2, 100);
    assert.ok(cone, `${direction.name}: cone expected`);
    const angle = direction.heading - Math.PI / 2;
    const view = { x: Math.cos(angle), y: Math.sin(angle) };
    const left = { x: cone.left.x - cone.apex.x, y: cone.left.y - cone.apex.y };
    const right = { x: cone.right.x - cone.apex.x, y: cone.right.y - cone.apex.y };
    close(angleBetween(view, left), Math.PI / 4, `${direction.name} left angle`, 1e-12);
    close(angleBetween(view, right), Math.PI / 4, `${direction.name} right angle`, 1e-12);
    close(angleBetween(left, right), Math.PI / 2, `${direction.name} cone angle`, 1e-12);
  }
});

check('looking straight down or up gives a degenerate cone, never NaN', () => {
  for (const target of [[3, 4, 0], [3, 4, 20]]) {
    const cone = viewCone(coneFrame, [3, 4, 10], target, Math.PI / 2, 50);
    assert.ok(cone, 'cone expected');
    const apex = toMinimap(coneFrame, 3, 4);
    assert.deepEqual(cone.apex, apex);
    assert.deepEqual(cone.left, apex);
    assert.deepEqual(cone.right, apex);
    assert.equal(cone.heading, 0);
    for (const value of [cone.apex.x, cone.apex.y, cone.left.x, cone.left.y, cone.right.x, cone.right.y, cone.heading]) {
      assert.ok(Number.isFinite(value), `finite value expected, got ${value}`);
    }
  }
});

check('a point bounds uses 1 metre per the smaller free side', () => {
  // Free box 180 x 80: the smaller side is 80, so 80 px/m.
  const frame = minimapFrame({ min: { x: 5, y: 7 }, max: { x: 5, y: 7 } }, 200, 100, 10);
  close(frame.scale, 80, 'scale');
  const centre = toMinimap(frame, 5, 7);
  close(centre.x, 100, 'centre x');
  close(centre.y, 50, 'centre y');
  const east = toMinimap(frame, 6, 7);
  close(east.x, 180, 'one metre east');
  close(east.y, 50, 'one metre east keeps y');
  const back = toModel(frame, centre.x, centre.y);
  close(back.x, 5, 'inverse x');
  close(back.y, 7, 'inverse y');
});

check('a line bounds uses 1 metre per the smaller free side', () => {
  // Both a horizontal and a vertical line have one zero span and must not divide by zero.
  const horizontal = minimapFrame({ min: { x: 0, y: 0 }, max: { x: 10, y: 0 } }, 200, 100, 10);
  const vertical = minimapFrame({ min: { x: 0, y: 0 }, max: { x: 0, y: 10 } }, 200, 100, 10);
  for (const [name, frame] of [['horizontal', horizontal], ['vertical', vertical]]) {
    close(frame.scale, 80, `${name} scale`);
    const centre = toMinimap(frame, name === 'horizontal' ? 5 : 0, name === 'horizontal' ? 0 : 5);
    close(centre.x, 100, `${name} centre x`);
    close(centre.y, 50, `${name} centre y`);
    assert.ok(Number.isFinite(frame.offsetX) && Number.isFinite(frame.offsetY), `${name} offsets should be finite`);
  }
});

check('non-finite input returns null', () => {
  const cases = [
    [[NaN, 0, 0], [0, 0, 0], Math.PI / 2, 10],
    [[0, Infinity, 0], [0, 0, 0], Math.PI / 2, 10],
    [[0, 0, 0], [0, 0, -Infinity], Math.PI / 2, 10],
    [[0, 0, 0], [0, 0, 0], NaN, 10],
    [[0, 0, 0], [0, 0, 0], Math.PI / 2, Infinity]
  ];
  for (const [caseEye, caseTarget, fov, length] of cases) {
    assert.equal(viewCone(coneFrame, caseEye, caseTarget, fov, length), null);
  }
  const brokenFrame = { ...coneFrame, offsetX: NaN };
  assert.equal(viewCone(brokenFrame, eye, [0, 10, 10], Math.PI / 2, 50), null);
});

// T-161 (C16): the storey under the camera's eye, the eye from a pose, and the sheet an exported
// plan draws on.
const storeys = [
  { name: 'Baja', level: 0 },
  { name: 'Primera', level: 3 },
  { name: 'Segunda', level: 6 }
];

check('storeyAt takes the highest level at or below the eye', () => {
  assert.deepEqual(storeyAt(4, storeys), { name: 'Primera', level: 3 });
  assert.deepEqual(storeyAt(6, storeys), { name: 'Segunda', level: 6 });
  assert.deepEqual(storeyAt(100, storeys), { name: 'Segunda', level: 6 });
});

check('storeyAt below every storey takes the lowest, and there is no storey without one', () => {
  assert.deepEqual(storeyAt(-2.5, storeys), { name: 'Baja', level: 0 });
  // Unsorted input, a storey without a usable level, and no storeys at all.
  assert.deepEqual(storeyAt(3.5, [storeys[2], storeys[0], storeys[1]]), { name: 'Primera', level: 3 });
  assert.deepEqual(storeyAt(-1, [{ name: 'sin cota', level: NaN }, storeys[0]]), { name: 'Baja', level: 0 });
  assert.equal(storeyAt(3, []), null);
  assert.equal(storeyAt(3, [{ name: 'sin cota', level: Infinity }]), null);
  assert.equal(storeyAt(Number.NaN, storeys), null);
});

check('eyeOf follows Camera.getEye, with hand-computed poses', () => {
  // elevation 0 and azimuth PI/2 move the eye 5 m along +Y; elevation PI/2 moves it 10 m up.
  const north = eyeOf({ target: [1, 2, 3], distance: 5, azimuth: Math.PI / 2, elevation: 0 });
  close(north[0], 1, 'north eye x');
  close(north[1], 7, 'north eye y');
  close(north[2], 3, 'north eye z');
  const top = eyeOf({ target: [0, 0, 0], distance: 10, azimuth: 0, elevation: Math.PI / 2 });
  close(top[0], 0, 'top eye x');
  close(top[1], 0, 'top eye y');
  close(top[2], 10, 'top eye z');
  // 45 degrees in both angles and a distance of 4 put the eye 2 m east, 2 m north and
  // 2 * sqrt(2) m up from the target.
  const isometric = eyeOf({ target: [3, -4, 1.5], distance: 4, azimuth: Math.PI / 4, elevation: Math.PI / 4 });
  close(isometric[0], 5, 'isometric eye x');
  close(isometric[1], -2, 'isometric eye y');
  close(isometric[2], 1.5 + 2 * Math.SQRT2, 'isometric eye z');
  const below = eyeOf({ target: [0, 0, 10], distance: 2, azimuth: 0, elevation: -Math.PI / 2 });
  close(below[2], 8, 'looking up eye z');
});

check('svgPlanSheet recovers the writer margin, and the frame maps model x, y as svg.rs does', () => {
  // A 10 x 6 m drawing: svg.rs leaves 0.2 m (2 %) on every side, so the viewBox is 10.4 x 6.4.
  const sheet = svgPlanSheet('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10.4 6.4">');
  assert.ok(sheet, 'sheet expected');
  close(sheet.margin, 0.2, 'margin');
  const frame = minimapFrame({ min: { x: 0, y: 0 }, max: { x: 10, y: 6 } }, sheet.width, sheet.height, sheet.margin);
  close(frame.scale, 1, 'scale in sheet units');
  // svg.rs places model (0, 0) at (margin, high.y + margin) and model (10, 6) at
  // (width - margin, margin): the sheet counts y downwards.
  const low = toMinimap(frame, 0, 0);
  const high = toMinimap(frame, 10, 6);
  close(low.x, 0.2, 'south-west x');
  close(low.y, 6.2, 'south-west y');
  close(high.x, 10.2, 'north-east x');
  close(high.y, 0.2, 'north-east y');
  assert.equal(svgPlanSheet('<svg/>'), null);
  assert.equal(svgPlanSheet('<svg viewBox="0 0 0 4">'), null);
});

console.log(`\nt160-minimap-test: ${passed}/16 pass`);
