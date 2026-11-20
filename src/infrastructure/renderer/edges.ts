/**
 * C17: edges drawn from the depth buffer, after the opaque geometry and before the transparent.
 *
 * Reverse-Z depth is affine across a plane in screen space, in perspective (it follows 1 / z) and
 * in orthographic projection (it follows z). Its second difference between a pixel and its two
 * neighbours is therefore zero on a flat face, and not zero where two faces meet at a crease or
 * one face stands in front of another. A pixel is an edge when that difference, in either
 * direction, passes the tangent change `EDGE_TANGENT` of the surface's slope per pixel, scaled by
 * how much depth a pixel spans (`edgeDepthScale`); and on the outline, where a neighbour is
 * background. A 90 degree corner changes the tangent by 2 or more; the facets of a 16-sided pipe
 * seen from the front by about 0.4, so they stay unmarked.
 *
 * The threshold never drops below `EDGE_DEPTH_STEPS` float steps of the pixel's depth. The
 * orthographic depth range reaches the camera's far plane (50 km or more), so one step there is
 * millimetres, and a face seen at a slant would otherwise hatch with rounding noise. In
 * perspective the slope term is about a thousand times larger, so the floor never applies.
 */

/** Float steps of depth the second difference must pass, whatever the slope term says. */
export const EDGE_DEPTH_STEPS = 4;

/** Smallest change in the tangent of the surface's slope that draws an edge. */
export const EDGE_TANGENT = 0.5;
/** Opacity of the black edge drawn over the surface. */
export const EDGE_ALPHA = 0.55;

/**
 * How the edge threshold scales with depth: in perspective it is relative to the pixel's own
 * depth (`relative`), times the angle a pixel spans; in orthographic projection it is the depth a
 * pixel's width spans on a 45 degree surface.
 */
export interface EdgeDepthScale {
  scale: number;
  relative: boolean;
}

/** Fragment shader of the WebGL2 edge pass: `u_depth` is the scene's depth texture. */
export const EDGE_FRAGMENT_GLSL = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_depth;
uniform float u_limit;
uniform int u_relative;
uniform float u_alpha;
out vec4 outColor;

float depthAt(ivec2 p, ivec2 size) {
  return texelFetch(u_depth, clamp(p, ivec2(0), size - 1), 0).r;
}

void main() {
  ivec2 size = textureSize(u_depth, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = depthAt(p, size);
  if (c <= 0.0) discard;
  float l = depthAt(p + ivec2(-1, 0), size);
  float r = depthAt(p + ivec2(1, 0), size);
  float d = depthAt(p + ivec2(0, -1), size);
  float u = depthAt(p + ivec2(0, 1), size);
  bool outline = l <= 0.0 || r <= 0.0 || d <= 0.0 || u <= 0.0;
  float limit = max(u_limit * (u_relative == 1 ? c : 1.0), c * ${EDGE_DEPTH_STEPS}.0 * 1.1920929e-7);
  float bend = max(abs(l + r - 2.0 * c), abs(d + u - 2.0 * c));
  if (!outline && bend <= limit) discard;
  outColor = vec4(0.0, 0.0, 0.0, u_alpha);
}
`;

/** Vertex shader of the WebGL2 edge pass: one triangle covering the screen. */
export const EDGE_VERTEX_GLSL = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** The WebGPU edge pass, the same test as `EDGE_FRAGMENT_GLSL`. */
export const EDGE_WGSL = /* wgsl */ `
struct EdgeParams {
  limit: f32,
  relative: f32,
  alpha: f32,
  pad: f32,
};

@group(0) @binding(0) var edgeDepth: texture_depth_2d;
@group(0) @binding(1) var<uniform> edge: EdgeParams;

@vertex
fn vs_edge(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}

fn depthAt(p: vec2<i32>, size: vec2<i32>) -> f32 {
  return textureLoad(edgeDepth, clamp(p, vec2<i32>(0), size - 1), 0);
}

@fragment
fn fs_edge(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(edgeDepth));
  let p = vec2<i32>(position.xy);
  let c = depthAt(p, size);
  if (c <= 0.0) { discard; }
  let l = depthAt(p + vec2<i32>(-1, 0), size);
  let r = depthAt(p + vec2<i32>(1, 0), size);
  let d = depthAt(p + vec2<i32>(0, -1), size);
  let u = depthAt(p + vec2<i32>(0, 1), size);
  let outline = l <= 0.0 || r <= 0.0 || d <= 0.0 || u <= 0.0;
  let limit = max(select(edge.limit, edge.limit * c, edge.relative > 0.5), c * ${EDGE_DEPTH_STEPS}.0 * 1.1920929e-7);
  let bend = max(abs(l + r - 2.0 * c), abs(d + u - 2.0 * c));
  if (!outline && bend <= limit) { discard; }
  return vec4<f32>(0.0, 0.0, 0.0, edge.alpha);
}
`;
