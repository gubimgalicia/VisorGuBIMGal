// C24, walking a storey: the storey list, where the eye stands, and the camera holding the eye at
// that height through every first-person move, until fitting, a preset or a pose releases it.
// node --experimental-strip-types test/t164-storey-walk-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !path.extname(specifier)) {
        // A module file, or a folder's index (src/ui/i18n).
        try {
          return next(specifier + '.ts', context);
        } catch {
          return next(specifier + '/index.ts', context);
        }
      }
      throw error;
    }
  }
});
const { walkStoreys, walkStart, EYE_HEIGHT } = await import('../src/ui/viewer/storeyWalk.ts');
const { Camera, WALK_DISTANCE } = await import('../src/infrastructure/renderer/Camera.ts');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const node = (type, name, level, children = []) => ({ expressId: 1, type, name, level, children });
const tree = (storeys) => ({ root: node('IfcProject', 'P', undefined, [node('IfcSite', 'S', undefined, [node('IfcBuilding', 'B', undefined, storeys)])]) });

check('storeys lowest first, one per name and level across models', () => {
  const a = tree([node('IfcBuildingStorey', 'Level 2', 3), node('IfcBuildingStorey', 'Level 1', 0)]);
  const b = tree([node('IfcBuildingStorey', 'Level 1', 0), node('IfcBuildingStorey', 'Roof', 6.5)]);
  assert.deepEqual(walkStoreys([a, null, b]), [
    { name: 'Level 1', level: 0 },
    { name: 'Level 2', level: 3 },
    { name: 'Roof', level: 6.5 }
  ]);
  assert.deepEqual(walkStoreys([tree([])]), []);
});

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 9 } };
// A pose whose eye is at target + distance * (cos e cos a, cos e sin a, sin e).
const poseWithEye = (x, y) => ({ target: [x - 2, y, 0], distance: 2, azimuth: 0, elevation: 0, projection: 'perspective' });

check('the eye stands where the camera is when that is over the models, else over their centre', () => {
  const inside = walkStart(poseWithEye(4, 5), bounds, 3);
  assert.ok(near(inside.x, 4) && near(inside.y, 5) && near(inside.z, 3 + EYE_HEIGHT), JSON.stringify(inside));
  const outside = walkStart(poseWithEye(40, 5), bounds, 3);
  assert.deepEqual(outside, { x: 5, y: 10, z: 3 + EYE_HEIGHT });
  assert.deepEqual(walkStart(null, null, 0), { x: 0, y: 0, z: EYE_HEIGHT });
});

const eyeZ = (camera) => camera.getEye()[2];

check('walkAt stands the eye there, looking level, held at that height', () => {
  const camera = new Camera();
  camera.walkAt(4, 5, 4.6);
  const eye = camera.getEye();
  assert.ok(near(eye[0], 4) && near(eye[1], 5) && near(eye[2], 4.6), JSON.stringify(eye));
  assert.equal(camera.getPose().elevation, 0);
  assert.equal(camera.getDistance(), WALK_DISTANCE);
  assert.equal(camera.getEyeLock(), 4.6);
});

check('walking moves across the floor only, even looking down, and never climbs', () => {
  const camera = new Camera();
  camera.walkAt(4, 5, 4.6);
  camera.look(30, 80); // turn and look down
  const before = camera.getEye();
  camera.walk(2, 0, 0);
  const after = camera.getEye();
  assert.ok(near(after[2], 4.6), `eye z ${after[2]}`);
  assert.ok(near(Math.hypot(after[0] - before[0], after[1] - before[1]), 2, 1e-9), 'a full 2 m step across the floor');
  camera.walk(0, 1.5, 3); // sideways, and an attempt to fly up
  assert.ok(near(eyeZ(camera), 4.6));
});

check('looking, panning and zooming keep the eye at the storey height', () => {
  const camera = new Camera();
  camera.walkAt(0, 0, 1.6);
  camera.look(-50, -120);
  assert.ok(near(eyeZ(camera), 1.6));
  camera.pan(40, 60);
  assert.ok(near(eyeZ(camera), 1.6));
  camera.zoomBy(0.5);
  assert.ok(near(eyeZ(camera), 1.6));
  camera.orbit(10, 10);
  assert.ok(near(eyeZ(camera), 1.6));
});

check('fitting, a preset or a pose release the eye; releasing leaves the camera where it is', () => {
  const camera = new Camera();
  camera.walkAt(1, 2, 1.6);
  camera.fitToBounds(bounds);
  assert.equal(camera.getEyeLock(), null);
  camera.walkAt(1, 2, 1.6);
  camera.setPreset('iso', bounds);
  assert.equal(camera.getEyeLock(), null);
  camera.walkAt(1, 2, 1.6);
  camera.setPose(poseWithEye(3, 3));
  assert.equal(camera.getEyeLock(), null);
  camera.walkAt(1, 2, 1.6);
  const before = camera.getEye();
  camera.releaseEyeLock();
  assert.equal(camera.getEyeLock(), null);
  assert.deepEqual(camera.getEye(), before);
  camera.walk(0, 0, 1);
  assert.ok(near(eyeZ(camera), 2.6), 'free again: it can climb');
});

console.log(`\nt164-storey-walk-test: ${passed}/6 pass`);
