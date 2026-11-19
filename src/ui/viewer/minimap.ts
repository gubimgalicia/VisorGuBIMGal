// T-160 (C16): the pure plan geometry behind the minimap. Model coordinates are metres, IFC Z up,
// X east and Y north. The minimap is a plan seen from above with north up, so screen x grows east
// and screen y grows south: a growing model y maps to a smaller screen y.
//
// Nothing here draws: the frame fits a plan bounds into a pixel box, and the view cone turns the
// camera's eye, target and field of view into a triangle on that plan.

const TAU = Math.PI * 2;

export interface MinimapFrame {
  /** Pixels per metre, the same on both axes. */
  scale: number;
  /** Screen x of model x = 0. */
  offsetX: number;
  /** Screen y of model y = 0. */
  offsetY: number;
  width: number;
  height: number;
}

/**
 * Fits the bounds into width x height minus padding on every side, keeping the aspect ratio
 * (one scale for both axes), centred. A point or a line has no extent to fit: it gets a scale of
 * 1 metre per the smaller free side, so the arithmetic never divides by zero.
 */
export function minimapFrame(
  bounds: { min: { x: number; y: number }; max: { x: number; y: number } },
  width: number,
  height: number,
  padding: number
): MinimapFrame {
  const freeWidth = Math.max(0, width - 2 * padding);
  const freeHeight = Math.max(0, height - 2 * padding);
  const spanX = bounds.max.x - bounds.min.x;
  const spanY = bounds.max.y - bounds.min.y;
  const scale =
    spanX > 0 && spanY > 0 ? Math.min(freeWidth / spanX, freeHeight / spanY) : Math.min(freeWidth, freeHeight);
  const centreX = (bounds.min.x + bounds.max.x) / 2;
  const centreY = (bounds.min.y + bounds.max.y) / 2;
  return {
    scale,
    offsetX: width / 2 - scale * centreX,
    offsetY: height / 2 + scale * centreY,
    width,
    height
  };
}

/** A model point on the plan. North up: model y grows towards the top, screen y downwards. */
export function toMinimap(frame: MinimapFrame, x: number, y: number): { x: number; y: number } {
  return { x: frame.offsetX + frame.scale * x, y: frame.offsetY - frame.scale * y };
}

/** The inverse of toMinimap. A degenerate frame (zero scale) has no inverse and yields the origin. */
export function toModel(frame: MinimapFrame, sx: number, sy: number): { x: number; y: number } {
  if (!(frame.scale > 0) || !Number.isFinite(frame.scale)) return { x: 0, y: 0 };
  return { x: (sx - frame.offsetX) / frame.scale, y: (frame.offsetY - sy) / frame.scale };
}

/**
 * The eye's position on the plan and a triangle showing where the camera looks: apex at the eye,
 * the other corners `length` minimap pixels along the plan direction to the target, rotated by
 * plus and minus half the horizontal field of view. `heading` is that direction in radians
 * clockwise from north (0 north, PI / 2 east). Looking straight down or up has no plan direction:
 * the triangle collapses onto the apex with heading 0. Non-finite input returns null.
 */
export function viewCone(
  frame: MinimapFrame,
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  horizontalFov: number,
  length: number
): { apex: { x: number; y: number }; left: { x: number; y: number }; right: { x: number; y: number }; heading: number } | null {
  const finite = (value: number) => Number.isFinite(value);
  if (![frame.scale, frame.offsetX, frame.offsetY, frame.width, frame.height].every(finite)) return null;
  if (![...eye, ...target, horizontalFov, length].every(finite)) return null;

  const apex = toMinimap(frame, eye[0], eye[1]);
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  if (dx === 0 && dy === 0) {
    return { apex, left: { ...apex }, right: { ...apex }, heading: 0 };
  }

  // Compass bearing: atan2(east, north), wrapped into [0, 2 PI).
  const heading = ((Math.atan2(dx, dy) % TAU) + TAU) % TAU;
  // The same direction in screen space, where y grows downwards: north is -PI / 2.
  const screenAngle = heading - Math.PI / 2;
  const half = horizontalFov / 2;
  const corner = (angle: number) => ({
    x: apex.x + length * Math.cos(angle),
    y: apex.y + length * Math.sin(angle)
  });
  // In screen space an angle smaller than the view's is counterclockwise, which is to the left.
  return { apex, left: corner(screenAngle - half), right: corner(screenAngle + half), heading };
}
