export const RENDERER_WGSL = /* wgsl */ `
struct SceneUniforms {
  proj: mat4x4<f32>,
  view: mat4x4<f32>,
  // Section planes relative to the eye: a point p is kept when dot(xyz, p) <= w.
  sections: array<vec4<f32>, 6>,
};

// 48 bytes. quantMin and quantMax are the grid of a q16 batch's positions (docs/05 section 3).
struct BatchGpuData {
  offsetX: f32,
  offsetY: f32,
  offsetZ: f32,
  packedMeta: u32,
  quantMin: vec3<f32>,
  quantMax: vec3<f32>,
};

struct RecordGpuData {
  expressId: u32,
  modelNumericId: u32,
  rgba: u32,
  stateFlags: u32,
};

@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(0) @binding(1) var<storage, read> batches: array<BatchGpuData>;
@group(0) @binding(2) var<storage, read> records: array<RecordGpuData>;

// stateFlags bits:
// bit 0 (1u): Transparent
// bit 1 (2u): Degraded
// bit 2 (4u): HiddenByDefault
// bit 3 (8u): CurrentlyVisible
// bit 4 (16u): CurrentlySelected
// bit 5 (32u): Ghost, drawn faint by vs_ghost only and never picked

struct ColorVaryings {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) viewNormal: vec3<f32>,
  @location(2) worldUpZ: f32,
  @location(3) relPos: vec3<f32>,
};

fn sectioned(relPos: vec3<f32>) -> bool {
  for (var i = 0u; i < 6u; i++) {
    let plane = scene.sections[i];
    if (dot(plane.xyz, relPos) > plane.w) {
      return true;
    }
  }
  return false;
}

const GHOST_COLOR = vec4<f32>(0.70, 0.76, 0.84, 0.12);

fn shade(
  pos: vec3<f32>,
  normal: vec3<f32>,
  localRecordIdx: u32,
  batchIdx: u32,
  ghostPass: bool
) -> ColorVaryings {
  var out: ColorVaryings;
  let batch = batches[batchIdx];
  let modelVisible = (batch.packedMeta & 0x80000000u) != 0u;
  let recordBase = batch.packedMeta & 0x7fffffffu;
  let rec = records[recordBase + localRecordIdx];
  let isGhost = (rec.stateFlags & 32u) != 0u;
  let isVisible = modelVisible && ((rec.stateFlags & 8u) != 0u) && (isGhost == ghostPass);

  if (!isVisible) {
    out.clipPos = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.color = vec4<f32>(0.0);
    out.viewNormal = vec3<f32>(0.0, 0.0, 1.0);
    out.worldUpZ = 0.0;
    out.relPos = vec3<f32>(0.0);
    return out;
  }

  let relPos = vec3<f32>(batch.offsetX + pos.x, batch.offsetY + pos.y, batch.offsetZ + pos.z);
  let viewPos = scene.view * vec4<f32>(relPos, 1.0);
  out.clipPos = scene.proj * viewPos;
  out.viewNormal = (scene.view * vec4<f32>(normal, 0.0)).xyz;
  out.worldUpZ = normal.z;
  out.relPos = relPos;

  let isSelected = (rec.stateFlags & 16u) != 0u;
  if (ghostPass) {
    out.color = GHOST_COLOR;
  } else if (isSelected) {
    out.color = vec4<f32>(0.22, 0.58, 0.96, 1.0);
  } else {
    let r = f32((rec.rgba >> 24u) & 0xffu) / 255.0;
    let g = f32((rec.rgba >> 16u) & 0xffu) / 255.0;
    let b = f32((rec.rgba >> 8u) & 0xffu) / 255.0;
    let a = f32(rec.rgba & 0xffu) / 255.0;
    out.color = vec4<f32>(r, g, b, a);
  }
  return out;
}

@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) localRecordIdx: u32,
  @builtin(instance_index) batchIdx: u32
) -> ColorVaryings {
  return shade(pos, normal, localRecordIdx, batchIdx, false);
}

@vertex
fn vs_ghost(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) localRecordIdx: u32,
  @builtin(instance_index) batchIdx: u32
) -> ColorVaryings {
  return shade(pos, normal, localRecordIdx, batchIdx, true);
}

// q16 batches: x, y, z on the batch's grid with the record index fourth, and an octahedral
// normal read as snorm16x2. No sign(): sign(0) is 0, and the fold needs +1 or -1.
fn q16Position(q: vec4<u32>, batchIdx: u32) -> vec3<f32> {
  let batch = batches[batchIdx];
  return batch.quantMin + vec3<f32>(q.xyz) / 65535.0 * (batch.quantMax - batch.quantMin);
}

fn octNormal(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let signs = vec2<f32>(select(-1.0, 1.0, n.x >= 0.0), select(-1.0, 1.0, n.y >= 0.0));
    n = vec3<f32>((vec2<f32>(1.0) - abs(n.yx)) * signs, n.z);
  }
  return normalize(n);
}

@vertex
fn vs_main_q16(
  @location(0) q: vec4<u32>,
  @location(1) oct: vec2<f32>,
  @builtin(instance_index) batchIdx: u32
) -> ColorVaryings {
  return shade(q16Position(q, batchIdx), octNormal(oct), q.w, batchIdx, false);
}

@vertex
fn vs_ghost_q16(
  @location(0) q: vec4<u32>,
  @location(1) oct: vec2<f32>,
  @builtin(instance_index) batchIdx: u32
) -> ColorVaryings {
  return shade(q16Position(q, batchIdx), octNormal(oct), q.w, batchIdx, true);
}

// A13: instances of a shared shape. Each batch's block starts with its index in batches[] (kept
// current by the renderer: docs/05 section 3) and holds one entry per instance, in draw order: the
// matrix rows (shape to batch-local), the inverse-transpose rows for normals, and the record.
struct InstanceGpu {
  row0: vec4<f32>,
  row1: vec4<f32>,
  row2: vec4<f32>,
  n0: vec3<f32>,
  n1: vec3<f32>,
  n2: vec3<f32>,
  record: u32,
};

struct InstanceBlock {
  batchIdx: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  items: array<InstanceGpu>,
};

// The shape's grid, for q16 shapes.
struct ShapeGrid {
  gridMin: vec3<f32>,
  pad0: u32,
  gridMax: vec3<f32>,
  pad1: u32,
};

@group(1) @binding(0) var<storage, read> instanceBlock: InstanceBlock;
@group(1) @binding(1) var<uniform> shapeGrid: ShapeGrid;

fn placedPosition(local: vec3<f32>, it: InstanceGpu) -> vec3<f32> {
  let p = vec4<f32>(local, 1.0);
  return vec3<f32>(dot(it.row0, p), dot(it.row1, p), dot(it.row2, p));
}

// Normalised after the inverse transpose: a shape scaled from mm to m would otherwise come out
// 1000 long, saturating worldUpZ and bending the interpolation (docs/09 section 2).
fn placedNormal(local: vec3<f32>, it: InstanceGpu) -> vec3<f32> {
  return normalize(vec3<f32>(dot(it.n0, local), dot(it.n1, local), dot(it.n2, local)));
}

fn shapeQ16Position(q: vec4<u32>) -> vec3<f32> {
  return shapeGrid.gridMin + vec3<f32>(q.xyz) / 65535.0 * (shapeGrid.gridMax - shapeGrid.gridMin);
}

@vertex
fn vs_main_inst(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>, @builtin(instance_index) ii: u32) -> ColorVaryings {
  let it = instanceBlock.items[ii];
  return shade(placedPosition(pos, it), placedNormal(normal, it), it.record, instanceBlock.batchIdx, false);
}

@vertex
fn vs_ghost_inst(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>, @builtin(instance_index) ii: u32) -> ColorVaryings {
  let it = instanceBlock.items[ii];
  return shade(placedPosition(pos, it), placedNormal(normal, it), it.record, instanceBlock.batchIdx, true);
}

@vertex
fn vs_main_inst_q16(@location(0) q: vec4<u32>, @location(1) oct: vec2<f32>, @builtin(instance_index) ii: u32) -> ColorVaryings {
  let it = instanceBlock.items[ii];
  return shade(placedPosition(shapeQ16Position(q), it), placedNormal(octNormal(oct), it), it.record, instanceBlock.batchIdx, false);
}

@vertex
fn vs_ghost_inst_q16(@location(0) q: vec4<u32>, @location(1) oct: vec2<f32>, @builtin(instance_index) ii: u32) -> ColorVaryings {
  let it = instanceBlock.items[ii];
  return shade(placedPosition(shapeQ16Position(q), it), placedNormal(octNormal(oct), it), it.record, instanceBlock.batchIdx, true);
}

@fragment
fn fs_main(in: ColorVaryings) -> @location(0) vec4<f32> {
  if (sectioned(in.relPos)) {
    discard;
  }
  let nLen = length(in.viewNormal);
  let vNorm = select(vec3<f32>(0.0, 0.0, 1.0), in.viewNormal / nLen, nLen > 1e-5);

  let keyDir = normalize(vec3<f32>(0.45, 0.65, 0.60));
  let fillDir = normalize(vec3<f32>(-0.55, -0.25, 0.80));

  let skyAmb = mix(0.34, 0.48, clamp(in.worldUpZ * 0.5 + 0.5, 0.0, 1.0));
  let diffKey = abs(dot(vNorm, keyDir)) * 0.46;
  let diffFill = abs(dot(vNorm, fillDir)) * 0.16;

  let lighting = clamp(skyAmb + diffKey + diffFill, 0.0, 1.15);
  let litRgb = clamp(in.color.rgb * lighting, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(litRgb, in.color.a);
}

struct PickVaryings {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) @interpolate(flat) pickId: vec2<u32>,
  @location(1) relPos: vec3<f32>,
};

@vertex
fn vs_pick(
  @location(0) pos: vec3<f32>,
  @location(1) _normal: vec3<f32>,
  @location(2) localRecordIdx: u32,
  @builtin(instance_index) batchIdx: u32
) -> PickVaryings {
  return pickVertex(pos, localRecordIdx, batchIdx);
}

@vertex
fn vs_pick_q16(
  @location(0) q: vec4<u32>,
  @location(1) _oct: vec2<f32>,
  @builtin(instance_index) batchIdx: u32
) -> PickVaryings {
  return pickVertex(q16Position(q, batchIdx), q.w, batchIdx);
}

@vertex
fn vs_pick_inst(@location(0) pos: vec3<f32>, @location(1) _normal: vec3<f32>, @builtin(instance_index) ii: u32) -> PickVaryings {
  let it = instanceBlock.items[ii];
  return pickVertex(placedPosition(pos, it), it.record, instanceBlock.batchIdx);
}

@vertex
fn vs_pick_inst_q16(@location(0) q: vec4<u32>, @location(1) _oct: vec2<f32>, @builtin(instance_index) ii: u32) -> PickVaryings {
  let it = instanceBlock.items[ii];
  return pickVertex(placedPosition(shapeQ16Position(q), it), it.record, instanceBlock.batchIdx);
}

fn pickVertex(pos: vec3<f32>, localRecordIdx: u32, batchIdx: u32) -> PickVaryings {
  var out: PickVaryings;
  let batch = batches[batchIdx];
  let modelVisible = (batch.packedMeta & 0x80000000u) != 0u;
  let recordBase = batch.packedMeta & 0x7fffffffu;
  let rec = records[recordBase + localRecordIdx];
  let isVisible = modelVisible && ((rec.stateFlags & 8u) != 0u) && ((rec.stateFlags & 32u) == 0u);

  if (!isVisible) {
    out.clipPos = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.pickId = vec2<u32>(0u, 0u);
    out.relPos = vec3<f32>(0.0);
    return out;
  }

  let relPos = vec3<f32>(batch.offsetX + pos.x, batch.offsetY + pos.y, batch.offsetZ + pos.z);
  let viewPos = scene.view * vec4<f32>(relPos, 1.0);
  out.clipPos = scene.proj * viewPos;
  out.pickId = vec2<u32>(rec.modelNumericId, rec.expressId);
  out.relPos = relPos;
  return out;
}

@fragment
fn fs_pick(in: PickVaryings) -> @location(0) vec4<u32> {
  if (sectioned(in.relPos)) {
    discard;
  }
  return vec4<u32>(in.pickId.x, in.pickId.y, bitcast<u32>(in.clipPos.z), 1u);
}
`;
