import type { NavigationMode } from '../../domain/kernel/RendererPort';
import type { Vec3 } from '../../domain/measure/geometry';
import type { Camera } from './Camera';

/** Travel in CSS pixels, from where the pointer went down, under which a release still picks. */
const CLICK_SLOP = 3;

export interface CanvasInputHandlers {
  /** The camera moved and the view needs a frame. */
  onViewChange(): void;
  /** A press and release that did not move, in CSS pixels from the canvas's top left. */
  onClick(cssX: number, cssY: number): void;
  /** A mouse moving with no button down, in CSS pixels; null once it leaves the canvas. */
  onHover?(at: { x: number; y: number } | null): void;
  /** The mouse cursor while no button is down; 'grab' if not given. */
  idleCursor?(): string;
  /** Returns the 3D world point under `(cssX, cssY)` to use as the orbit pivot on pointer down. */
  getOrbitPivot?(cssX: number, cssY: number): Vec3 | null;
  /** Current navigation mode ('orbit' by default, or 'first-person'). */
  getNavigationMode?(): NavigationMode;
}

interface Pair {
  midX: number;
  midY: number;
  separation: number;
}

/**
 * Mouse, pen, touch, and first-person keyboard on the canvas. One pointer orbits around the pointed
 * 3D surface (or looks around in first-person mode), or pans with the middle or right button or Shift;
 * two touches pinch to zoom and move together to pan; a press that does not move picks.
 * Returns a function that removes everything it added.
 */
export function attachCanvasInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  handlers: CanvasInputHandlers
): () => void {
  /** Pointers down on the canvas, at their last applied position. */
  const pointers = new Map<number, { x: number; y: number }>();
  let panning = false;
  let orbitPivot: Vec3 | null = null;
  let pressX = 0;
  let pressY = 0;
  let pressButton = 0;
  /** Since the first pointer went down: it travelled, or a second one joined. */
  let moved = false;
  let multi = false;
  /** The first two pointers as last applied; the pair is applied once per frame, so both fingers
   *  of one touch move land together and a two-finger pan does not wobble the zoom. */
  let lastPair: Pair | null = null;
  let pairFrame = 0;

  const isFirstPerson = (): boolean => handlers.getNavigationMode?.() === 'first-person';

  const pairOf = (): Pair | null => {
    if (pointers.size < 2) return null;
    const [a, b] = pointers.values();
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      separation: Math.hypot(b.x - a.x, b.y - a.y)
    };
  };

  const applyPair = () => {
    pairFrame = 0;
    const pair = pairOf();
    if (!pair || !lastPair) {
      lastPair = pair;
      return;
    }
    if (pair.separation >= 1 && lastPair.separation >= 1) {
      camera.zoomBy(lastPair.separation / pair.separation);
    }
    camera.pan(pair.midX - lastPair.midX, pair.midY - lastPair.midY);
    lastPair = pair;
    handlers.onViewChange();
  };

  /** Applies any pending two-finger move, or drops it, before the set of pointers changes. */
  const settlePair = (apply: boolean) => {
    if (pairFrame) {
      cancelAnimationFrame(pairFrame);
      pairFrame = 0;
      if (apply) applyPair();
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (pointers.size === 0) {
      moved = false;
      multi = false;
      pressX = e.clientX;
      pressY = e.clientY;
      pressButton = e.button;
      panning = e.pointerType !== 'touch' && (e.button === 1 || e.button === 2 || e.shiftKey);
      if (!panning && !isFirstPerson() && handlers.getOrbitPivot) {
        const rect = canvas.getBoundingClientRect();
        orbitPivot = handlers.getOrbitPivot(e.clientX - rect.left, e.clientY - rect.top);
      } else {
        orbitPivot = null;
      }
      if (e.pointerType === 'mouse') canvas.style.cursor = panning ? 'move' : 'grabbing';
    } else {
      settlePair(true);
      multi = true;
      orbitPivot = null;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastPair = pairOf();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; its release still arrives.
    }
  };

  const idleCursor = () => handlers.idleCursor?.() ?? 'grab';

  const onPointerMove = (e: PointerEvent) => {
    const pointer = pointers.get(e.pointerId);
    if (!pointer) {
      if (e.pointerType === 'mouse' && pointers.size === 0 && handlers.onHover) {
        const rect = canvas.getBoundingClientRect();
        handlers.onHover({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
      return;
    }
    if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > CLICK_SLOP) moved = true;

    if (pointers.size >= 2) {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (!pairFrame) pairFrame = requestAnimationFrame(applyPair);
      return;
    }

    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (panning) {
      camera.pan(dx, dy);
    } else if (isFirstPerson()) {
      camera.look(dx, dy);
    } else if (orbitPivot) {
      camera.orbitAround(orbitPivot, dx, dy);
    } else {
      camera.orbit(dx, dy);
    }
    handlers.onViewChange();
  };

  const release = (e: PointerEvent, completed: boolean) => {
    if (!pointers.has(e.pointerId)) return;
    settlePair(completed);
    const wasOnly = pointers.size === 1;
    pointers.delete(e.pointerId);
    lastPair = pairOf();
    if (pointers.size > 0) return;

    panning = false;
    orbitPivot = null;
    if (e.pointerType === 'mouse') canvas.style.cursor = idleCursor();
    if (completed && wasOnly && !moved && !multi && pressButton === 0) {
      const rect = canvas.getBoundingClientRect();
      handlers.onClick(e.clientX - rect.left, e.clientY - rect.top);
    }
  };

  const onPointerUp = (e: PointerEvent) => release(e, true);
  const onPointerCancel = (e: PointerEvent) => release(e, false);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (isFirstPerson()) {
      const step = Math.max(0.3, Math.min(20, camera.getDistance() * 0.08));
      camera.walk(e.deltaY < 0 ? step : -step, 0, 0);
    } else {
      camera.zoom(e.deltaY);
    }
    handlers.onViewChange();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isFirstPerson()) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) {
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const baseStep = Math.max(0.35, Math.min(25, camera.getDistance() * 0.06));
    const step = e.shiftKey ? baseStep * 2.5 : baseStep;
    let handled = true;
    switch (e.key.toLowerCase()) {
      case 'w':
      case 'arrowup':
        camera.walk(step, 0, 0);
        break;
      case 's':
      case 'arrowdown':
        camera.walk(-step, 0, 0);
        break;
      case 'd':
      case 'arrowright':
        camera.walk(0, step, 0);
        break;
      case 'a':
      case 'arrowleft':
        camera.walk(0, -step, 0);
        break;
      case 'e':
      case 'pageup':
        camera.walk(0, 0, step);
        break;
      case 'q':
      case 'pagedown':
        camera.walk(0, 0, -step);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      handlers.onViewChange();
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && pointers.size === 0) handlers.onHover?.(null);
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerleave', onPointerLeave);
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
  }
  // The browser must not scroll or zoom the page under a finger on the canvas.
  canvas.style.touchAction = 'none';
  canvas.style.cursor = idleCursor();

  return () => {
    settlePair(false);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('lostpointercapture', onPointerCancel);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
    }
  };
}
