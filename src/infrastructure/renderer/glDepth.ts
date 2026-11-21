/**
 * Reverse-Z only pays with a float depth buffer that stores depth as the projection gives it.
 * WebGL's default buffer has 24 fixed-point bits, and its -1..1 depth range turns the tiny
 * values reverse-Z keeps for far points into numbers near -1, where floats are coarse: a strip
 * 0.1 m above another vanished at 5 km. So the scene draws into its own DEPTH_COMPONENT32F
 * buffer, and either EXT_clip_control keeps depth in 0..1, or, without it, the fragment
 * shader writes the depth itself (FRAG_DEPTH), which costs early depth testing.
 */
export type DepthMode = 'clip-control' | 'frag-depth';

interface ClipControl {
  readonly LOWER_LEFT_EXT: number;
  readonly ZERO_TO_ONE_EXT: number;
  clipControlEXT(origin: number, depth: number): void;
}

/** Turns clip control on for the whole context when the browser has it. */
export function chooseDepthMode(gl: WebGL2RenderingContext): DepthMode {
  const clip = gl.getExtension('EXT_clip_control') as ClipControl | null;
  if (!clip) return 'frag-depth';
  clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.ZERO_TO_ONE_EXT);
  return 'clip-control';
}

/** The shader for a mode: FRAG_DEPTH is defined right after the version line. */
export function withDepthMode(source: string, mode: DepthMode): string {
  if (mode === 'clip-control') return source;
  const end = source.indexOf('\n') + 1;
  return `${source.slice(0, end)}#define FRAG_DEPTH\n${source.slice(end)}`;
}
