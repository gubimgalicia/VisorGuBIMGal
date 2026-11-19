import type { ElementRef, ModelBounds, ModelId } from '../../domain/models/ModelRecord';
import {
  MESH_RECORD_WORDS,
  MeshField,
  findBatchError,
  vertexCountOf,
  type GeometryBatch,
  type VertexFormat
} from '../../domain/kernel/GeometryBatch';
import {
  MAX_SECTION_PLANES,
  type CameraPose,
  type CameraProjection,
  type ElementDisplay,
  type NavigationMode,
  type PointerMode,
  type RendererEventHandlers,
  type RendererPort,
  type SectionPlane,
  type ViewPreset
} from '../../domain/kernel/RendererPort';
import type { Ray, Vec3 } from '../../domain/measure/geometry';
import { Camera, resolveOrbitPivot, type SurfacePickSample } from './Camera';
import { attachCanvasInput } from './canvasInput';
import { canvasPoint, canvasRay } from './canvasView';
import { boxMayShow, markBatchesInView, pixelWindow } from './frustum';
import { chooseDepthMode, withDepthMode, type DepthMode } from './glDepth';
import { waitForSync } from './glSync';
import { groupIndices } from './indexGroups';
import { SECTION_FLOATS, keptSectionPlanes, writeSectionPlanes } from './sectionPlanes';
import {
  FLAG_SELECTED,
  displayFlags,
  effectiveRgba,
  refreshDisplayFlags,
  setColors,
  setDisplay,
  type DisplayState
} from './recordDisplay';
import type { RendererDebugStats } from './WebGpuRenderer';

const RECORD_TEX_WIDTH = 2048;
/** Geometry uploaded per frame; a batch is never split, so one always goes. */
const UPLOAD_BYTES_PER_FRAME = 2 * 1024 * 1024;

interface GlBatchEntry {
  origin: readonly [number, number, number];
  /** The kernel's box, absolute: origin plus its least and greatest position. */
  min: Vec3;
  max: Vec3;
  /** Set each frame by markBatchesInView. */
  inView: boolean;
  recordOffsetInModel: number;
  recordCount: number;
  opaqueIndexCount: number;
  /** The first of the opaque indices, which belong to closed meshes: see `groupIndices`. */
  closedIndexCount: number;
  transparentIndexCount: number;
  vertexFormat: VertexFormat;
  /** The grid of q16 positions, relative to origin; unused in f32. */
  quantMin: Vec3;
  quantMax: Vec3;
  /** gl.UNSIGNED_SHORT or gl.UNSIGNED_INT, and its size in bytes. */
  indexType: number;
  indexBytes: number;
  /** q16 only: its own vertex array, with no record index attribute (docs/09 section 2). */
  vao: WebGLVertexArrayObject | null;
  positionBuffer: WebGLBuffer;
  normalBuffer: WebGLBuffer;
  /** f32 only: a q16 position carries its record index. */
  recordIndexBuffer: WebGLBuffer | null;
  opaqueIndexBuffer: WebGLBuffer | null;
  transparentIndexBuffer: WebGLBuffer | null;
  gpuBytes: number;
}

interface ModelEntry extends DisplayState {
  modelId: ModelId;
  numericId: number;
  visible: boolean;
  batches: GlBatchEntry[];
  /** Maps expressId -> list of record indices (0..recordCount-1) within this model. */
  expressIdToRecords: Map<number, number[]>;
  /** Starting record index in the global GPU record buffer. */
  recordBaseOffset: number;
  /** The kernel's 'complete' bounds, set by finishModel; not valid while the model streams. */
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    valid: boolean;
  };
}

interface PreInitOp {
  kind: 'batch';
  batch: GeometryBatch;
}

interface ProgramUniforms {
  u_proj: WebGLUniformLocation | null;
  u_view: WebGLUniformLocation | null;
  u_batchOffset: WebGLUniformLocation | null;
  u_recordBase: WebGLUniformLocation | null;
  u_modelVisible: WebGLUniformLocation | null;
  u_recordTexture: WebGLUniformLocation | null;
  /** Main program only. */
  u_ghostPass: WebGLUniformLocation | null;
  u_sections: WebGLUniformLocation | null;
  /** q16 programs only. */
  u_quantMin: WebGLUniformLocation | null;
  u_quantMax: WebGLUniformLocation | null;
}

/** A linked program and where its uniforms are. */
interface ProgramInfo {
  program: WebGLProgram;
  uniforms: ProgramUniforms;
}

const F32_ATTRIBUTES = `layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in uint a_recordIdx;`;

// q16: x, y, z on the batch's grid and the record index as four u16, and an octahedral normal
// read as normalized shorts. No sign(): sign(0) is 0, and the fold needs +1 or -1.
const Q16_ATTRIBUTES = `layout(location = 0) in uvec4 a_q;
layout(location = 1) in vec2 a_oct;
uniform vec3 u_quantMin;
uniform vec3 u_quantMax;

vec3 octNormal(vec2 e) {
  vec3 n = vec3(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    vec2 signs = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    n.xy = (vec2(1.0) - abs(n.yx)) * signs;
  }
  return normalize(n);
}`;

const Q16_DECODE = `void main() {
  vec3 a_position = u_quantMin + vec3(a_q.xyz) / 65535.0 * (u_quantMax - u_quantMin);
  vec3 a_normal = octNormal(a_oct);
  uint a_recordIdx = a_q.w;`;

/** The q16 variant of a vertex shader written for f32 attributes. */
function q16Variant(source: string): string {
  if (!source.includes(F32_ATTRIBUTES) || !source.includes('void main() {')) {
    throw new Error('vertex shader without the f32 attribute block');
  }
  return source.replace(F32_ATTRIBUTES, Q16_ATTRIBUTES).replace('void main() {', Q16_DECODE);
}

// Section planes relative to the eye: a point p is kept when dot(xyz, p) <= w.
const SECTION_GLSL = `uniform vec4 u_sections[${MAX_SECTION_PLANES}];

bool sectioned(vec3 relPos) {
  for (int i = 0; i < ${MAX_SECTION_PLANES}; i++) {
    if (dot(u_sections[i].xyz, relPos) > u_sections[i].w) return true;
  }
  return false;
}`;

// Depth, see glDepth.ts. With clip control, clip z is already reverse-Z in 0..w. Without it,
// clipping needs -w..w, so z is remapped for that alone and the fragment writes the depth.
const DEPTH_VS_OUT = `#ifdef FRAG_DEPTH
out vec2 v_clipZW;
#endif`;
const DEPTH_VS_MAIN = `#ifdef FRAG_DEPTH
  v_clipZW = clipPos.zw;
  clipPos.z = clipPos.z * 2.0 - clipPos.w;
#endif`;
const DEPTH_FS_IN = `#ifdef FRAG_DEPTH
in vec2 v_clipZW;
#endif`;
const DEPTH_FS_MAIN = `#ifdef FRAG_DEPTH
  gl_FragDepth = v_clipZW.x / v_clipZW.y;
#endif`;

const VS_MAIN = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in uint a_recordIdx;

uniform mat4 u_proj;
uniform mat4 u_view;
uniform vec3 u_batchOffset;
uniform uint u_recordBase;
uniform bool u_modelVisible;
uniform usampler2D u_recordTexture;
// The ghost pass draws only ghosts (bit 32u), faint; the other passes draw everything else.
uniform bool u_ghostPass;

out vec4 v_color;
out vec3 v_viewNormal;
out float v_worldUpZ;
out vec3 v_relPos;
${DEPTH_VS_OUT}

void main() {
  int recIdx = int(u_recordBase + a_recordIdx);
  ivec2 texCoord = ivec2(recIdx % ${RECORD_TEX_WIDTH}, recIdx / ${RECORD_TEX_WIDTH});
  uvec4 rec = texelFetch(u_recordTexture, texCoord, 0);

  uint stateFlags = rec.w;
  bool isGhost = (stateFlags & 32u) != 0u;
  bool isVisible = u_modelVisible && ((stateFlags & 8u) != 0u) && (isGhost == u_ghostPass);

  if (!isVisible) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_viewNormal = vec3(0.0, 0.0, 1.0);
    v_worldUpZ = 0.0;
    v_relPos = vec3(0.0);
    return;
  }

  vec3 relPos = u_batchOffset + a_position;
  vec4 viewPos = u_view * vec4(relPos, 1.0);
  vec4 clipPos = u_proj * viewPos;
  ${DEPTH_VS_MAIN}
  gl_Position = clipPos;
  v_relPos = relPos;

  v_viewNormal = (u_view * vec4(a_normal, 0.0)).xyz;
  v_worldUpZ = a_normal.z;

  bool isSelected = (stateFlags & 16u) != 0u;
  if (u_ghostPass) {
    v_color = vec4(0.70, 0.76, 0.84, 0.12);
  } else if (isSelected) {
    v_color = vec4(0.22, 0.58, 0.96, 1.0);
  } else {
    uint rgba = rec.z;
    float r = float((rgba >> 24u) & 0xffu) / 255.0;
    float g = float((rgba >> 16u) & 0xffu) / 255.0;
    float b = float((rgba >> 8u) & 0xffu) / 255.0;
    float a = float(rgba & 0xffu) / 255.0;
    v_color = vec4(r, g, b, a);
  }
}
`;

const FS_MAIN = `#version 300 es
precision highp float;

in vec4 v_color;
in vec3 v_viewNormal;
in float v_worldUpZ;
in vec3 v_relPos;
${DEPTH_FS_IN}

${SECTION_GLSL}

out vec4 fragColor;

void main() {
  if (sectioned(v_relPos)) discard;
  ${DEPTH_FS_MAIN}
  float nLen = length(v_viewNormal);
  vec3 vNorm = (nLen > 1e-5) ? (v_viewNormal / nLen) : vec3(0.0, 0.0, 1.0);

  vec3 keyDir = normalize(vec3(0.45, 0.65, 0.60));
  vec3 fillDir = normalize(vec3(-0.55, -0.25, 0.80));

  float skyAmb = mix(0.34, 0.48, clamp(v_worldUpZ * 0.5 + 0.5, 0.0, 1.0));
  float diffKey = abs(dot(vNorm, keyDir)) * 0.46;
  float diffFill = abs(dot(vNorm, fillDir)) * 0.16;

  float lighting = clamp(skyAmb + diffKey + diffFill, 0.0, 1.15);
  vec3 litRgb = clamp(v_color.rgb * lighting, vec3(0.0), vec3(1.0));
  fragColor = vec4(litRgb, v_color.a);
}
`;

const VS_PICK = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in uint a_recordIdx;

uniform mat4 u_proj;
uniform mat4 u_view;
uniform vec3 u_batchOffset;
uniform uint u_recordBase;
uniform bool u_modelVisible;
uniform usampler2D u_recordTexture;

flat out uvec2 v_pickId;
out vec3 v_relPos;
${DEPTH_VS_OUT}

void main() {
  int recIdx = int(u_recordBase + a_recordIdx);
  ivec2 texCoord = ivec2(recIdx % ${RECORD_TEX_WIDTH}, recIdx / ${RECORD_TEX_WIDTH});
  uvec4 rec = texelFetch(u_recordTexture, texCoord, 0);

  uint stateFlags = rec.w;
  bool isVisible = u_modelVisible && ((stateFlags & 8u) != 0u) && ((stateFlags & 32u) == 0u);

  if (!isVisible) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_pickId = uvec2(0u, 0u);
    v_relPos = vec3(0.0);
    return;
  }

  vec3 relPos = u_batchOffset + a_position;
  vec4 viewPos = u_view * vec4(relPos, 1.0);
  vec4 clipPos = u_proj * viewPos;
  ${DEPTH_VS_MAIN}
  gl_Position = clipPos;
  v_relPos = relPos;

  // rec.y is modelNumericId, rec.x is expressId
  v_pickId = uvec2(rec.y, rec.x);
}
`;

const FS_PICK = `#version 300 es
precision highp float;
precision highp int;

flat in uvec2 v_pickId;
in vec3 v_relPos;
${DEPTH_FS_IN}

${SECTION_GLSL}

out uvec4 fragPick;

void main() {
  if (sectioned(v_relPos)) discard;
  ${DEPTH_FS_MAIN}
#ifdef FRAG_DEPTH
  float pickDepth = v_clipZW.x / v_clipZW.y;
#else
  float pickDepth = gl_FragCoord.z;
#endif
  fragPick = uvec4(v_pickId.x, v_pickId.y, floatBitsToUint(pickDepth), 1u);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('No se pudo crear el objeto shader WebGL2');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Error al compilar shader WebGL2: ${info}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error('No se pudo crear el programa WebGL2');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Error al enlazar programa WebGL2: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export class WebGl2Renderer implements RendererPort {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;

  private mainProgram: WebGLProgram | null = null;
  private mainUniforms!: ProgramUniforms;
  private mainQ16: ProgramInfo | null = null;
  private pickQ16: ProgramInfo | null = null;
  /** The program last bound with useProgram, to skip rebinding it. */
  private boundProgram: WebGLProgram | null = null;

  private pickProgram: WebGLProgram | null = null;
  private pickUniforms!: ProgramUniforms;

  private recordTexture: WebGLTexture | null = null;
  private recordTexHeight = 0;
  private recordCpuWords = new Uint32Array(RECORD_TEX_WIDTH * 1 * 4);
  private recordLayoutDirty = true;
  /** Records in the record texture, and the first of them not uploaded yet. */
  private recordTotal = 0;
  private recordAppendFrom = 0;
  /** The table's last model: its new records go on the end without moving any other model. */
  private recordTail: ModelEntry | null = null;

  private pickFramebuffer: WebGLFramebuffer | null = null;
  private pickColorTexture: WebGLTexture | null = null;
  private pickDepthRenderbuffer: WebGLRenderbuffer | null = null;

  /** The scene draws here for its float depth buffer, then is copied to the canvas. */
  private sceneFramebuffer: WebGLFramebuffer | null = null;
  private sceneColorRenderbuffer: WebGLRenderbuffer | null = null;
  private sceneDepthRenderbuffer: WebGLRenderbuffer | null = null;
  /** Size the framebuffers above were allocated at; a new context starts with none. */
  private framebufferSize: [number, number] = [0, 0];
  /** Kept for checks through the dev hook. */
  private depthMode: DepthMode = 'frag-depth';

  private readonly camera = new Camera();
  /** Projection, view, then the section planes relative to the eye. */
  private readonly sceneUniformData = new Float32Array(32 + SECTION_FLOATS);
  private sectionPlanes: SectionPlane[] = [];

  private models: Map<ModelId, ModelEntry> = new Map();
  private numToModelId: Map<number, ModelId> = new Map();
  private nextModelNumericId = 1;

  private preInitQueue: PreInitOp[] = [];
  /** Batches waiting for a frame: uploading each as it arrives can hold the GPU process up. */
  private uploadQueue: GeometryBatch[] = [];
  private pendingFinishBounds: Map<ModelId, ModelBounds | undefined> = new Map();

  private selectedRef: ElementRef | null = null;
  private handlers: RendererEventHandlers = {};
  private hasFramedInitialModel = false;

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cleanupListeners: (() => void) | null = null;
  private deviceLostBanner: HTMLDivElement | null = null;
  private isDestroyed = false;
  private isPicking = false;
  private pickQueue: Promise<unknown> = Promise.resolve();
  private pointerMode: PointerMode = 'select';
  private navigationMode: NavigationMode = 'orbit';
  private initGeneration = 0;

  // Telemetry for verification and performance checks
  private renderCount = 0;
  private lastFrameCpuMs = 0;
  private drawnBatches = 0;
  private pickedBatches = 0;

  setHandlers(handlers: RendererEventHandlers): void {
    this.handlers = handlers;
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    const gen = ++this.initGeneration;
    this.releaseGlResourcesAndListeners();
    this.isDestroyed = false;
    this.canvas = canvas;

    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false,
        // The scene has its own depth buffer.
        depth: false,
        stencil: false,
        antialias: false,
        powerPreference: 'high-performance'
      });
    } catch {
      gl = null;
    }

    if (!gl) {
      this.releaseGlResourcesAndListeners();
      throw new Error(
        'WebGL2 no está disponible en este navegador o equipo. Por favor, utiliza un navegador compatible con aceleración gráfica habilitada.'
      );
    }

    if (this.isDestroyed || gen !== this.initGeneration) {
      return;
    }

    this.gl = gl;

    try {
      this.createProgramsAndBuffers(gl);
      this.setupListeners(canvas);
      this.syncCanvasSize();

      const onContextLost = (e: Event) => {
        e.preventDefault();
        const msg =
          'Se perdió el contexto gráfico WebGL2. Recarga la página para restaurar el visor 3D.';
        console.error(msg);
        this.showDeviceLostBanner(msg);
      };
      canvas.addEventListener('webglcontextlost', onContextLost);
      const prevCleanup = this.cleanupListeners;
      this.cleanupListeners = () => {
        prevCleanup?.();
        canvas.removeEventListener('webglcontextlost', onContextLost);
      };

      if (import.meta.env.DEV && typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__gubim_dev__ = {
          renderer: this,
          findBatchError
        };
      }

      // Drain queued operations
      if (this.preInitQueue.length > 0) {
        const queued = this.preInitQueue.splice(0, this.preInitQueue.length);
        for (const op of queued) {
          if (op.kind === 'batch' && this.models.has(op.batch.modelId)) {
            this.uploadBatchInternal(op.batch);
          }
        }
      }

      if (this.pendingFinishBounds.size > 0) {
        const entries = Array.from(this.pendingFinishBounds.entries());
        this.pendingFinishBounds.clear();
        for (const [modelId, bounds] of entries) {
          this.finishModel(modelId, bounds);
        }
      }

      this.requestRender();
    } catch (err) {
      this.releaseGlResourcesAndListeners();
      throw err;
    }
  }

  private createProgramsAndBuffers(gl: WebGL2RenderingContext): void {
    const mode = chooseDepthMode(gl);
    this.depthMode = mode;
    this.boundProgram = null;
    this.mainProgram = createProgram(gl, withDepthMode(VS_MAIN, mode), withDepthMode(FS_MAIN, mode));
    this.mainUniforms = {
      u_proj: gl.getUniformLocation(this.mainProgram, 'u_proj'),
      u_view: gl.getUniformLocation(this.mainProgram, 'u_view'),
      u_batchOffset: gl.getUniformLocation(this.mainProgram, 'u_batchOffset'),
      u_recordBase: gl.getUniformLocation(this.mainProgram, 'u_recordBase'),
      u_modelVisible: gl.getUniformLocation(this.mainProgram, 'u_modelVisible'),
      u_recordTexture: gl.getUniformLocation(this.mainProgram, 'u_recordTexture'),
      u_ghostPass: gl.getUniformLocation(this.mainProgram, 'u_ghostPass'),
      u_sections: gl.getUniformLocation(this.mainProgram, 'u_sections'),
      u_quantMin: null,
      u_quantMax: null
    };
    const q16Program = (vs: string, fs: string): ProgramInfo => {
      const program = createProgram(gl, withDepthMode(q16Variant(vs), mode), withDepthMode(fs, mode));
      const at = (name: string) => gl.getUniformLocation(program, name);
      return {
        program,
        uniforms: {
          u_proj: at('u_proj'),
          u_view: at('u_view'),
          u_batchOffset: at('u_batchOffset'),
          u_recordBase: at('u_recordBase'),
          u_modelVisible: at('u_modelVisible'),
          u_recordTexture: at('u_recordTexture'),
          u_ghostPass: at('u_ghostPass'),
          u_sections: at('u_sections'),
          u_quantMin: at('u_quantMin'),
          u_quantMax: at('u_quantMax')
        }
      };
    };
    this.mainQ16 = q16Program(VS_MAIN, FS_MAIN);
    this.pickQ16 = q16Program(VS_PICK, FS_PICK);

    this.pickProgram = createProgram(gl, withDepthMode(VS_PICK, mode), withDepthMode(FS_PICK, mode));
    this.pickUniforms = {
      u_proj: gl.getUniformLocation(this.pickProgram, 'u_proj'),
      u_view: gl.getUniformLocation(this.pickProgram, 'u_view'),
      u_batchOffset: gl.getUniformLocation(this.pickProgram, 'u_batchOffset'),
      u_recordBase: gl.getUniformLocation(this.pickProgram, 'u_recordBase'),
      u_modelVisible: gl.getUniformLocation(this.pickProgram, 'u_modelVisible'),
      u_recordTexture: gl.getUniformLocation(this.pickProgram, 'u_recordTexture'),
      u_ghostPass: null,
      u_sections: gl.getUniformLocation(this.pickProgram, 'u_sections'),
      u_quantMin: null,
      u_quantMax: null
    };

    this.recordTexHeight = 1;
    this.recordTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.recordTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32UI,
      RECORD_TEX_WIDTH,
      this.recordTexHeight,
      0,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      null
    );

    this.pickFramebuffer = gl.createFramebuffer();
    this.pickColorTexture = gl.createTexture();
    this.pickDepthRenderbuffer = gl.createRenderbuffer();
    this.sceneFramebuffer = gl.createFramebuffer();
    this.sceneColorRenderbuffer = gl.createRenderbuffer();
    this.sceneDepthRenderbuffer = gl.createRenderbuffer();
    this.framebufferSize = [0, 0];

    // Enable vertex attribute arrays once on the active context
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enableVertexAttribArray(2);

    this.recordLayoutDirty = true;
  }

  private syncCanvasSize(): void {
    if (!this.canvas || !this.gl) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor((rect.width || this.canvas.clientWidth || 800) * dpr));
    const height = Math.max(1, Math.floor((rect.height || this.canvas.clientHeight || 600) * dpr));

    const [allocatedWidth, allocatedHeight] = this.framebufferSize;
    if (
      this.canvas.width === width &&
      this.canvas.height === height &&
      allocatedWidth === width &&
      allocatedHeight === height
    ) {
      return;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    this.camera.setAspect(width / height);
    this.framebufferSize = [width, height];

    const gl = this.gl;
    if (this.sceneFramebuffer && this.sceneColorRenderbuffer && this.sceneDepthRenderbuffer) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneColorRenderbuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneDepthRenderbuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        this.sceneColorRenderbuffer
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        this.sceneDepthRenderbuffer
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    if (this.pickFramebuffer && this.pickColorTexture && this.pickDepthRenderbuffer) {
      gl.bindTexture(gl.TEXTURE_2D, this.pickColorTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32UI,
        width,
        height,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        null
      );

      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepthRenderbuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.pickColorTexture,
        0
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        this.pickDepthRenderbuffer
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    this.requestRender();
  }

  private setupListeners(canvas: HTMLCanvasElement): void {
    const onResize = () => {
      this.syncCanvasSize();
    };

    window.addEventListener('resize', onResize);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.syncCanvasSize();
      });
      this.resizeObserver.observe(canvas);
      if (canvas.parentElement) {
        this.resizeObserver.observe(canvas.parentElement);
      }
    }

    const stopInput = attachCanvasInput(canvas, this.camera, {
      onViewChange: () => this.requestRender(),
      onHover: (at) => {
        if (this.pointerMode === 'measure') this.handlers.onPointerMove?.(at);
      },
      idleCursor: () => this.idleCursor(),
      getNavigationMode: () => this.navigationMode,
      getOrbitPivot: (cssX, cssY) => this.pickOrbitPivot(cssX, cssY),
      onClick: (cssX, cssY) => {
        if (this.pointerMode === 'measure') {
          this.handlers.onPoint?.(cssX, cssY);
          return;
        }
        void this.pick(cssX, cssY).then((hit) => {
          this.setSelection(hit);
          this.handlers.onSelect?.(hit);
        });
      }
    });

    this.cleanupListeners = () => {
      window.removeEventListener('resize', onResize);
      stopInput();
    };
  }

  private showDeviceLostBanner(message: string): void {
    const parent = this.canvas?.parentElement;
    if (!parent) return;
    if (this.deviceLostBanner) {
      this.deviceLostBanner.textContent = message;
      return;
    }
    const div = document.createElement('div');
    div.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(15,23,42,0.95);border:1px solid #ef4444;padding:20px;border-radius:8px;color:#f8fafc;font-size:13px;max-width:420px;text-align:center;z-index:40;';
    div.textContent = message;
    parent.appendChild(div);
    this.deviceLostBanner = div;
  }

  private getOrCreateModel(modelId: ModelId): ModelEntry {
    let model = this.models.get(modelId);
    if (!model) {
      const numericId = this.nextModelNumericId++;
      model = {
        modelId,
        numericId,
        visible: true,
        batches: [],
        recordWords: [],
        baseRgba: [],
        colorOverrides: new Map(),
        expressIdToRecords: new Map(),
        displayEntries: new Map(),
        displayOthers: 'default',
        displayMayGhost: false,
        recordBaseOffset: 0,
        bounds: {
          minX: Infinity,
          minY: Infinity,
          minZ: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
          maxZ: -Infinity,
          valid: false
        }
      };
      this.models.set(modelId, model);
      this.numToModelId.set(numericId, modelId);
    }
    return model;
  }

  addModel(modelId: ModelId): void {
    this.getOrCreateModel(modelId);
  }

  addBatch(batch: GeometryBatch): void {
    this.getOrCreateModel(batch.modelId);
    if (!this.gl) {
      this.preInitQueue.push({ kind: 'batch', batch });
      return;
    }
    this.uploadQueue.push(batch);
    this.requestRender();
  }

  /** Uploads queued batches up to the frame's budget, and asks for another frame if some are left. */
  private uploadQueuedBatches(): void {
    let bytes = 0;
    while (this.uploadQueue.length > 0 && bytes < UPLOAD_BYTES_PER_FRAME) {
      const batch = this.uploadQueue.shift()!;
      this.uploadBatchInternal(batch);
      bytes += batch.positions.byteLength + batch.normals.byteLength + batch.indices.byteLength;
    }
    if (this.uploadQueue.length > 0) this.requestRender();
  }

  private uploadBatchInternal(batch: GeometryBatch): void {
    if (!this.gl) return;
    const model = this.getOrCreateModel(batch.modelId);
    const { positions, normals, indices, meshTable, origin } = batch;

    const q16 = batch.vertexFormat === 'q16';
    const vertexCount = vertexCountOf(batch.vertexFormat, positions);
    const recordCount = meshTable.length / MESH_RECORD_WORDS;
    if (vertexCount === 0 || indices.length === 0 || recordCount === 0) {
      return;
    }

    const recordOffsetInModel = model.recordWords.length / 4;
    // f32 vertices need their record index beside them; q16 ones carry it.
    const localRecordIndexArray = q16 ? null : new Uint32Array(vertexCount);

    const ox = origin[0];
    const oy = origin[1];
    const oz = origin[2];

    for (let r = 0; r < recordCount; r++) {
      const base = r * MESH_RECORD_WORDS;
      const expressId = meshTable[base + MeshField.expressId] >>> 0;
      const firstVertex = meshTable[base + MeshField.firstVertex] >>> 0;
      const vCount = meshTable[base + MeshField.vertexCount] >>> 0;
      const rgba = meshTable[base + MeshField.rgba] >>> 0;
      const rawFlags = meshTable[base + MeshField.flags] >>> 0;

      localRecordIndexArray?.fill(r, firstVertex, firstVertex + vCount);

      const isSelected =
        this.selectedRef !== null &&
        this.selectedRef.modelId === model.modelId &&
        this.selectedRef.expressId === expressId;

      const stateFlags =
        ((rawFlags & 0x7) |
          displayFlags(model, expressId, rawFlags) |
          (isSelected ? FLAG_SELECTED : 0)) >>>
        0;

      const recIdxInModel = recordOffsetInModel + r;
      model.baseRgba!.push(rgba);
      model.recordWords.push(expressId, model.numericId >>> 0, effectiveRgba(model, expressId, rgba), stateFlags);

      let list = model.expressIdToRecords.get(expressId);
      if (!list) {
        list = [];
        model.expressIdToRecords.set(expressId, list);
      }
      list.push(recIdxInModel);
    }

    const gl = this.gl;
    // Uploads must not touch a q16 batch's vertex array.
    gl.bindVertexArray(null);

    const posByteLen = Math.max(4, positions.byteLength);
    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) throw new Error('Error al crear buffer de posiciones WebGL2');
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const normByteLen = Math.max(4, normals.byteLength);
    const normalBuffer = gl.createBuffer();
    if (!normalBuffer) throw new Error('Error al crear buffer de normales WebGL2');
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

    let recordIndexBuffer: WebGLBuffer | null = null;
    let recIdxByteLen = 0;
    let vao: WebGLVertexArrayObject | null = null;
    if (localRecordIndexArray) {
      recIdxByteLen = Math.max(4, localRecordIndexArray.byteLength);
      recordIndexBuffer = gl.createBuffer();
      if (!recordIndexBuffer) throw new Error('Error al crear buffer de índices de registro WebGL2');
      gl.bindBuffer(gl.ARRAY_BUFFER, recordIndexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, localRecordIndexArray, gl.STATIC_DRAW);
    } else {
      // Its own vertex array: integer positions with the record index, normalized normals, and
      // no attribute 2, so nothing points at a record buffer it does not have.
      vao = gl.createVertexArray();
      if (!vao) throw new Error('Error al crear vertex array WebGL2');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_SHORT, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.SHORT, true, 0, 0);
      gl.bindVertexArray(null);
    }

    const groups = groupIndices(indices, meshTable);
    const indexBuffer = (values: Uint32Array | Uint16Array, what: string): WebGLBuffer | null => {
      if (values.length === 0) return null;
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error(`Error al crear buffer de índices ${what} WebGL2`);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, values, gl.STATIC_DRAW);
      return buffer;
    };
    const opaqueIndexBuffer = indexBuffer(groups.opaque, 'opacos');
    const transparentIndexBuffer = indexBuffer(groups.transparent, 'transparentes');
    const indexGpuBytes = groups.opaque.byteLength + groups.transparent.byteLength;

    const gpuBytes = posByteLen + normByteLen + recIdxByteLen + indexGpuBytes;

    const { min, max } = batch.box;
    const grid = batch.quantBox ?? batch.box;
    const u16 = indices instanceof Uint16Array;
    model.batches.push({
      origin: [ox, oy, oz],
      min: [ox + min[0], oy + min[1], oz + min[2]],
      max: [ox + max[0], oy + max[1], oz + max[2]],
      inView: true,
      vertexFormat: batch.vertexFormat,
      quantMin: [grid.min[0], grid.min[1], grid.min[2]],
      quantMax: [grid.max[0], grid.max[1], grid.max[2]],
      indexType: u16 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
      indexBytes: u16 ? 2 : 4,
      vao,
      recordOffsetInModel,
      recordCount,
      opaqueIndexCount: groups.opaque.length,
      closedIndexCount: groups.closedCount,
      transparentIndexCount: groups.transparent.length,
      positionBuffer,
      normalBuffer,
      recordIndexBuffer,
      opaqueIndexBuffer,
      transparentIndexBuffer,
      gpuBytes
    });

    // Records of the table's last model are appended; anything else moves models, so rebuild.
    if (
      !this.recordLayoutDirty &&
      model === this.recordTail &&
      model.recordBaseOffset + recordOffsetInModel === this.recordTotal
    ) {
      this.recordTotal += recordCount;
    } else {
      this.recordLayoutDirty = true;
    }
  }

  finishModel(modelId: ModelId, bounds: ModelBounds | undefined): void {
    if (!this.gl) {
      this.pendingFinishBounds.set(modelId, bounds);
      return;
    }

    const model = this.models.get(modelId);
    if (model && bounds) {
      model.bounds.minX = bounds.min.x;
      model.bounds.minY = bounds.min.y;
      model.bounds.minZ = bounds.min.z;
      model.bounds.maxX = bounds.max.x;
      model.bounds.maxY = bounds.max.y;
      model.bounds.maxZ = bounds.max.z;
      model.bounds.valid = true;
    }

    if (!this.hasFramedInitialModel && model && model.visible && model.bounds.valid) {
      this.hasFramedInitialModel = true;
      this.fitToView();
    } else {
      this.requestRender();
    }
  }

  removeModel(modelId: ModelId): void {
    this.preInitQueue = this.preInitQueue.filter(
      (op) => !(op.kind === 'batch' && op.batch.modelId === modelId)
    );
    this.uploadQueue = this.uploadQueue.filter((batch) => batch.modelId !== modelId);
    this.pendingFinishBounds.delete(modelId);

    const model = this.models.get(modelId);
    if (!model) return;

    if (this.gl) {
      for (const b of model.batches) {
        this.gl.deleteBuffer(b.positionBuffer);
        this.gl.deleteBuffer(b.normalBuffer);
        if (b.recordIndexBuffer) this.gl.deleteBuffer(b.recordIndexBuffer);
        if (b.vao) this.gl.deleteVertexArray(b.vao);
        if (b.opaqueIndexBuffer) this.gl.deleteBuffer(b.opaqueIndexBuffer);
        if (b.transparentIndexBuffer) this.gl.deleteBuffer(b.transparentIndexBuffer);
      }
    }
    model.batches.length = 0;

    this.numToModelId.delete(model.numericId);
    this.models.delete(modelId);

    if (this.selectedRef?.modelId === modelId) {
      this.selectedRef = null;
    }

    if (this.models.size === 0) {
      this.hasFramedInitialModel = false;
    }

    this.recordLayoutDirty = true;
    this.requestRender();
  }

  setModelVisibility(modelId: ModelId, visible: boolean): void {
    const model = this.models.get(modelId);
    if (!model) return;
    if (model.visible === visible) return;
    model.visible = visible;
    this.requestRender();
  }

  setElementVisibility(refs: readonly ElementRef[], visible: boolean): void {
    let anyChanged = false;
    for (const ref of refs) {
      const model = this.models.get(ref.modelId);
      if (!model) continue;
      model.displayEntries.set(ref.expressId, visible ? 'visible' : 'hidden');
      const recIndices = model.expressIdToRecords.get(ref.expressId);
      if (!recIndices || recIndices.length === 0) continue;

      for (const rIdx of recIndices) {
        if (refreshDisplayFlags(model, rIdx)) {
          this.writeSingleRecordStateToGpu(model.recordBaseOffset + rIdx, model, rIdx);
          anyChanged = true;
        }
      }
    }

    if (anyChanged) {
      this.requestRender();
    }
  }

  setElementDisplay(
    modelId: ModelId,
    others: ElementDisplay,
    entries: ReadonlyMap<number, ElementDisplay>
  ): void {
    const model = this.models.get(modelId);
    if (!model) return;
    setDisplay(model, others, entries);

    let anyChanged = false;
    const recordCount = model.recordWords.length / 4;
    for (let rIdx = 0; rIdx < recordCount; rIdx++) {
      if (refreshDisplayFlags(model, rIdx)) anyChanged = true;
    }
    // One upload of the whole table next frame, not one write per record.
    if (anyChanged) {
      this.recordLayoutDirty = true;
      this.requestRender();
    }
  }

  setElementColors(modelId: ModelId, colors: ReadonlyMap<number, number>): void {
    const model = this.models.get(modelId);
    if (!model) return;
    if (setColors(model, colors)) {
      this.recordLayoutDirty = true;
      this.requestRender();
    }
  }

  setSectionPlanes(planes: readonly SectionPlane[]): void {
    this.sectionPlanes = keptSectionPlanes(planes);
    this.requestRender();
  }

  /** Whether any record may be a ghost, so the ghost pass has something to draw. */
  private mayHaveGhosts(): boolean {
    for (const model of this.models.values()) {
      if (model.visible && model.displayMayGhost) return true;
    }
    return false;
  }

  setSelection(ref: ElementRef | null): void {
    const prev = this.selectedRef;
    if (
      prev === ref ||
      (prev !== null &&
        ref !== null &&
        prev.modelId === ref.modelId &&
        prev.expressId === ref.expressId)
    ) {
      return;
    }

    this.selectedRef = ref
      ? { modelId: ref.modelId, expressId: ref.expressId, globalId: ref.globalId }
      : null;

    if (prev) {
      this.updateElementSelectionFlag(prev.modelId, prev.expressId, false);
    }
    if (ref) {
      this.updateElementSelectionFlag(ref.modelId, ref.expressId, true);
    }

    this.requestRender();
  }

  private updateElementSelectionFlag(modelId: ModelId, expressId: number, selected: boolean): void {
    const model = this.models.get(modelId);
    if (!model) return;
    const recIndices = model.expressIdToRecords.get(expressId);
    if (!recIndices) return;

    for (const rIdx of recIndices) {
      const wordIdx = rIdx * 4 + 3;
      const prevFlags = model.recordWords[wordIdx];
      const nextFlags = selected
        ? ((prevFlags | FLAG_SELECTED) >>> 0)
        : ((prevFlags & ~FLAG_SELECTED) >>> 0);
      if (prevFlags !== nextFlags) {
        model.recordWords[wordIdx] = nextFlags;
        this.writeSingleRecordStateToGpu(model.recordBaseOffset + rIdx, model, rIdx);
      }
    }
  }

  private writeSingleRecordStateToGpu(
    globalRecordIndex: number,
    model: ModelEntry,
    modelRecordIndex: number
  ): void {
    if (!this.gl || !this.recordTexture || this.recordLayoutDirty) return;
    const cpuBase = globalRecordIndex * 4;
    const modelBase = modelRecordIndex * 4;
    if (cpuBase + 4 > this.recordCpuWords.length) return;

    this.recordCpuWords[cpuBase] = model.recordWords[modelBase];
    this.recordCpuWords[cpuBase + 1] = model.recordWords[modelBase + 1];
    this.recordCpuWords[cpuBase + 2] = model.recordWords[modelBase + 2];
    this.recordCpuWords[cpuBase + 3] = model.recordWords[modelBase + 3];

    const x = globalRecordIndex % RECORD_TEX_WIDTH;
    const y = Math.floor(globalRecordIndex / RECORD_TEX_WIDTH);
    const singleTexel = this.recordCpuWords.subarray(cpuBase, cpuBase + 4);

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.recordTexture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      x,
      y,
      1,
      1,
      this.gl.RGBA_INTEGER,
      this.gl.UNSIGNED_INT,
      singleTexel
    );
  }

  private computeVisibleBounds(): ModelBounds | null {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let found = false;

    for (const model of this.models.values()) {
      if (!model.visible || !model.bounds.valid) continue;
      if (model.bounds.minX < minX) minX = model.bounds.minX;
      if (model.bounds.minY < minY) minY = model.bounds.minY;
      if (model.bounds.minZ < minZ) minZ = model.bounds.minZ;
      if (model.bounds.maxX > maxX) maxX = model.bounds.maxX;
      if (model.bounds.maxY > maxY) maxY = model.bounds.maxY;
      if (model.bounds.maxZ > maxZ) maxZ = model.bounds.maxZ;
      found = true;
    }

    if (!found) {
      for (const model of this.models.values()) {
        if (!model.bounds.valid) continue;
        if (model.bounds.minX < minX) minX = model.bounds.minX;
        if (model.bounds.minY < minY) minY = model.bounds.minY;
        if (model.bounds.minZ < minZ) minZ = model.bounds.minZ;
        if (model.bounds.maxX > maxX) maxX = model.bounds.maxX;
        if (model.bounds.maxY > maxY) maxY = model.bounds.maxY;
        if (model.bounds.maxZ > maxZ) maxZ = model.bounds.maxZ;
        found = true;
      }
    }

    if (!found) return null;
    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ }
    };
  }

  setViewPreset(preset: ViewPreset): void {
    const bounds = this.computeVisibleBounds();
    this.camera.setPreset(preset, bounds);
    this.requestRender();
  }

  fitToView(): void {
    const bounds = this.computeVisibleBounds();
    if (bounds) {
      this.camera.fitToBounds(bounds);
    }
    this.requestRender();
  }

  fitToBounds(bounds: ModelBounds, keepAngles = false): void {
    this.camera.fitToBounds(bounds, keepAngles);
    this.requestRender();
  }

  getCameraPose(): CameraPose {
    return this.camera.getPose();
  }

  setCameraPose(pose: CameraPose): void {
    this.camera.setPose(pose);
    this.requestRender();
  }

  getProjection(): CameraProjection {
    return this.camera.getProjection();
  }

  setProjection(projection: CameraProjection): void {
    if (this.camera.getProjection() === projection) return;
    this.camera.setProjection(projection);
    this.requestRender();
  }

  getNavigationMode(): NavigationMode {
    return this.navigationMode;
  }

  setNavigationMode(mode: NavigationMode): void {
    if (mode !== 'orbit' && mode !== 'first-person') return;
    this.navigationMode = mode;
    if (this.canvas) this.canvas.style.cursor = this.idleCursor();
  }

  private requestRender(): void {
    if (this.isDestroyed || !this.gl || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.renderFrame();
    });
  }

  private updateGpuSceneTables(): number {
    if (!this.gl) return 0;

    // 1. Upload records appended to the last model, or rebuild the texture if models moved
    if (!this.recordLayoutDirty && this.recordAppendFrom < this.recordTotal) {
      const tail = this.recordTail;
      if (!tail || !this.recordTexture || this.recordTotal > RECORD_TEX_WIDTH * this.recordTexHeight) {
        this.recordLayoutDirty = true;
      } else {
        const from = this.recordAppendFrom;
        const words = tail.recordWords;
        const dstStart = tail.recordBaseOffset * 4;
        for (let i = (from - tail.recordBaseOffset) * 4; i < words.length; i++) {
          this.recordCpuWords[dstStart + i] = words[i];
        }
        // Whole rows from the one holding the first new record.
        const firstRow = Math.floor(from / RECORD_TEX_WIDTH);
        const rows = Math.ceil(this.recordTotal / RECORD_TEX_WIDTH) - firstRow;
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.recordTexture);
        this.gl.texSubImage2D(
          this.gl.TEXTURE_2D,
          0,
          0,
          firstRow,
          RECORD_TEX_WIDTH,
          rows,
          this.gl.RGBA_INTEGER,
          this.gl.UNSIGNED_INT,
          this.recordCpuWords.subarray(firstRow * RECORD_TEX_WIDTH * 4, (firstRow + rows) * RECORD_TEX_WIDTH * 4)
        );
        this.recordAppendFrom = this.recordTotal;
      }
    }

    if (this.recordLayoutDirty) {
      let totalRecords = 0;
      let tail: ModelEntry | null = null;
      for (const model of this.models.values()) {
        model.recordBaseOffset = totalRecords;
        totalRecords += model.recordWords.length / 4;
        tail = model;
      }

      const requiredHeight = Math.max(1, Math.ceil(totalRecords / RECORD_TEX_WIDTH));
      if (requiredHeight > this.recordTexHeight || !this.recordTexture) {
        if (this.recordTexture) {
          this.gl.deleteTexture(this.recordTexture);
        }
        this.recordTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.recordTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

        // Doubled, so a streaming model appends for most batches instead of rebuilding.
        const maxHeight = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
        this.recordTexHeight = Math.max(requiredHeight, Math.min(this.recordTexHeight * 2, maxHeight));
        this.recordCpuWords = new Uint32Array(RECORD_TEX_WIDTH * this.recordTexHeight * 4);
        this.gl.texImage2D(
          this.gl.TEXTURE_2D,
          0,
          this.gl.RGBA32UI,
          RECORD_TEX_WIDTH,
          this.recordTexHeight,
          0,
          this.gl.RGBA_INTEGER,
          this.gl.UNSIGNED_INT,
          null
        );
      } else if (this.recordCpuWords.length < RECORD_TEX_WIDTH * this.recordTexHeight * 4) {
        this.recordCpuWords = new Uint32Array(RECORD_TEX_WIDTH * this.recordTexHeight * 4);
      }

      for (const model of this.models.values()) {
        const dstStart = model.recordBaseOffset * 4;
        const words = model.recordWords;
        for (let i = 0; i < words.length; i++) {
          this.recordCpuWords[dstStart + i] = words[i];
        }
      }

      if (totalRecords > 0 && this.recordTexture) {
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.recordTexture);
        this.gl.texSubImage2D(
          this.gl.TEXTURE_2D,
          0,
          0,
          0,
          RECORD_TEX_WIDTH,
          requiredHeight,
          this.gl.RGBA_INTEGER,
          this.gl.UNSIGNED_INT,
          this.recordCpuWords.subarray(0, RECORD_TEX_WIDTH * requiredHeight * 4)
        );
      }
      this.recordTotal = totalRecords;
      this.recordAppendFrom = totalRecords;
      this.recordTail = tail;
      this.recordLayoutDirty = false;
    }

    // 2. Write camera projection + rotation-only view matrix, and the sections for this eye
    this.camera.writeUniforms(this.sceneUniformData);
    writeSectionPlanes(this.sectionPlanes, this.camera.getEye(), this.sceneUniformData, 32);

    let totalBatches = 0;
    for (const model of this.models.values()) {
      totalBatches += model.batches.length;
    }
    return totalBatches;
  }

  renderFrame(): void {
    if (this.isDestroyed || !this.gl || !this.mainProgram || !this.canvas) {
      return;
    }

    const t0 = performance.now();
    this.uploadQueuedBatches();
    this.updateGpuSceneTables();
    this.drawnBatches = markBatchesInView(this.models.values(), this.camera.frustum(), this.camera.getEye());

    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
    gl.viewport(0, 0, width, height);
    // A pick that failed half way may have left it on, and it limits clears and the copy.
    gl.disable(gl.SCISSOR_TEST);

    // The transparent pass ends with depth writes off, and clearing obeys the depth mask,
    // so turn writes back on first or the next frame keeps this one's depth and draws nothing.
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    gl.clearColor(0.06, 0.07, 0.09, 1.0);
    gl.clearDepth(0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GREATER);
    gl.disable(gl.CULL_FACE);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.recordTexture);
    const mainPrograms = this.programs('main');
    for (const info of mainPrograms) this.setFrameUniforms(gl, info, 0);

    const eye = this.camera.getEye();

    // Pass 1: Opaque geometry
    let hasTransparent = false;

    for (const model of this.models.values()) {
      if (!model.visible) continue;

      for (const batch of model.batches) {
        if (!batch.inView) continue;
        if (batch.transparentIndexCount > 0) {
          hasTransparent = true;
        }
        if (batch.opaqueIndexCount > 0 && batch.opaqueIndexBuffer) {
          this.bindBatch(gl, model, batch, eye, 'main');
          this.drawOpaque(gl, batch);
        }
      }
    }

    // Pass 2: Transparent geometry
    if (hasTransparent) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      for (const model of this.models.values()) {
        if (!model.visible) continue;

        for (const batch of model.batches) {
          if (batch.inView && batch.transparentIndexCount > 0 && batch.transparentIndexBuffer) {
            this.bindBatch(gl, model, batch, eye, 'main');
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.transparentIndexBuffer);
            gl.drawElements(gl.TRIANGLES, batch.transparentIndexCount, batch.indexType, 0);
          }
        }
      }
    }

    // Pass 3: Ghosts, faint over everything else, whether their element is opaque or not
    if (this.mayHaveGhosts()) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const info of mainPrograms) this.setGhostPass(gl, info, 1);

      for (const model of this.models.values()) {
        if (!model.visible) continue;

        for (const batch of model.batches) {
          if (!batch.inView) continue;
          this.bindBatch(gl, model, batch, eye, 'main');
          if (batch.opaqueIndexCount > 0 && batch.opaqueIndexBuffer) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.opaqueIndexBuffer);
            gl.drawElements(gl.TRIANGLES, batch.opaqueIndexCount, batch.indexType, 0);
          }
          if (batch.transparentIndexCount > 0 && batch.transparentIndexBuffer) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.transparentIndexBuffer);
            gl.drawElements(gl.TRIANGLES, batch.transparentIndexCount, batch.indexType, 0);
          }
        }
      }
      for (const info of mainPrograms) this.setGhostPass(gl, info, 0);
    }
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.renderCount++;
    this.lastFrameCpuMs = performance.now() - t0;
    this.handlers.onFrame?.();
  }

  /** One at a time, in order: each waits for the last to read back. */
  pick(cssX: number, cssY: number): Promise<ElementRef | null> {
    const result = this.pickQueue.then(() => this.pickOnce(cssX, cssY).ref);
    this.pickQueue = result.catch(() => null);
    return result;
  }

  private pickOrbitPivot(cssX: number, cssY: number): Vec3 | null {
    if (!this.canvas || !this.gl) return null;
    const rect = this.canvas.getBoundingClientRect();
    const width = this.canvas.clientWidth || rect.width;
    const height = this.canvas.clientHeight || rect.height;
    if (!width || !height) return null;
    const ndcX = (2 * cssX) / width - 1;
    const ndcY = 1 - (2 * cssY) / height;
    const hit = this.pickOnce(cssX, cssY);
    return resolveOrbitPivot(
      this.camera,
      ndcX,
      ndcY,
      hit.sample,
      this.models.values(),
      this.sectionPlanes
    );
  }

  setPointerMode(mode: PointerMode): void {
    this.pointerMode = mode;
    if (this.canvas) this.canvas.style.cursor = this.idleCursor();
  }

  private idleCursor(): string {
    return this.pointerMode === 'measure' ? 'crosshair' : 'grab';
  }

  rayAt(x: number, y: number): Ray | null {
    return this.canvas && this.gl ? canvasRay(this.camera, this.canvas, x, y) : null;
  }

  project(point: Vec3): { x: number; y: number } | null {
    return this.canvas && this.gl ? canvasPoint(this.camera, this.canvas, point) : null;
  }

  /** The f32 and q16 programs of a kind: main draws, pick picks. */
  private programs(kind: 'main' | 'pick'): ProgramInfo[] {
    const list: ProgramInfo[] = [];
    if (kind === 'main' && this.mainProgram) list.push({ program: this.mainProgram, uniforms: this.mainUniforms });
    if (kind === 'pick' && this.pickProgram) list.push({ program: this.pickProgram, uniforms: this.pickUniforms });
    const q16 = kind === 'main' ? this.mainQ16 : this.pickQ16;
    if (q16) list.push(q16);
    return list;
  }

  private useProgram(gl: WebGL2RenderingContext, program: WebGLProgram): void {
    if (this.boundProgram === program) return;
    gl.useProgram(program);
    this.boundProgram = program;
  }

  /** Camera, sections, the record texture's unit and, in a main program, the ghost pass. */
  private setFrameUniforms(gl: WebGL2RenderingContext, info: ProgramInfo, ghostPass: number | null): void {
    this.useProgram(gl, info.program);
    gl.uniformMatrix4fv(info.uniforms.u_proj, false, this.sceneUniformData.subarray(0, 16));
    gl.uniformMatrix4fv(info.uniforms.u_view, false, this.sceneUniformData.subarray(16, 32));
    gl.uniform4fv(info.uniforms.u_sections, this.sceneUniformData.subarray(32));
    gl.uniform1i(info.uniforms.u_recordTexture, 0);
    if (ghostPass !== null) gl.uniform1i(info.uniforms.u_ghostPass, ghostPass);
  }

  private setGhostPass(gl: WebGL2RenderingContext, info: ProgramInfo, ghostPass: number): void {
    this.useProgram(gl, info.program);
    gl.uniform1i(info.uniforms.u_ghostPass, ghostPass);
  }

  /**
   * Binds the program of a batch's format and sets its per-batch uniforms and vertex inputs: a
   * q16 batch its own vertex array, an f32 batch the default one with three attributes.
   */
  private bindBatch(
    gl: WebGL2RenderingContext,
    model: ModelEntry,
    batch: GlBatchEntry,
    eye: Vec3,
    kind: 'main' | 'pick'
  ): void {
    const q16 = batch.vertexFormat === 'q16';
    const info = q16
      ? kind === 'main'
        ? this.mainQ16
        : this.pickQ16
      : kind === 'main'
        ? { program: this.mainProgram, uniforms: this.mainUniforms }
        : { program: this.pickProgram, uniforms: this.pickUniforms };
    if (!info?.program) return;
    this.useProgram(gl, info.program);
    const u = info.uniforms;
    gl.uniform1i(u.u_modelVisible, 1);
    gl.uniform3f(u.u_batchOffset, batch.origin[0] - eye[0], batch.origin[1] - eye[1], batch.origin[2] - eye[2]);
    gl.uniform1ui(u.u_recordBase, model.recordBaseOffset + batch.recordOffsetInModel);
    if (q16) {
      gl.uniform3f(u.u_quantMin, batch.quantMin[0], batch.quantMin[1], batch.quantMin[2]);
      gl.uniform3f(u.u_quantMax, batch.quantMax[0], batch.quantMax[1], batch.quantMax[2]);
      gl.bindVertexArray(batch.vao);
      return;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.positionBuffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.normalBuffer);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.recordIndexBuffer);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);
  }

  /**
   * Draws a batch's opaque indices, its vertex attributes already set: those of closed meshes
   * without their back faces, which never show from outside them, and the rest whole. A section
   * plane may open a closed mesh up, so while one is set every index is drawn whole. Leaves face
   * culling off.
   */
  private drawOpaque(gl: WebGL2RenderingContext, batch: GlBatchEntry): void {
    if (batch.opaqueIndexCount === 0 || !batch.opaqueIndexBuffer) return;
    const culled = this.sectionPlanes.length === 0 ? batch.closedIndexCount : 0;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.opaqueIndexBuffer);
    if (culled > 0) {
      gl.enable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, culled, batch.indexType, 0);
      gl.disable(gl.CULL_FACE);
    }
    if (batch.opaqueIndexCount > culled) {
      gl.drawElements(gl.TRIANGLES, batch.opaqueIndexCount - culled, batch.indexType, culled * batch.indexBytes);
    }
  }

  private pickOnce(
    cssX: number,
    cssY: number
  ): { ref: ElementRef | null; sample: SurfacePickSample } {
    if (
      this.isDestroyed ||
      this.isPicking ||
      !this.gl ||
      !this.canvas ||
      !this.pickProgram ||
      !this.pickFramebuffer
    ) {
      return { ref: null, sample: { hit: null } };
    }

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
    const px = Math.max(0, Math.min(this.canvas.width - 1, Math.floor(cssX * scaleX)));
    const py = Math.max(0, Math.min(this.canvas.height - 1, Math.floor(cssY * scaleY)));
    const glPy = this.canvas.height - 1 - py;

    this.isPicking = true;
    try {
      this.updateGpuSceneTables();

      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(px, glPy, 1, 1);

      // Clearing obeys the depth mask, which the transparent pass leaves off.
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
      gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([0.0]));

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.GREATER);
      gl.disable(gl.CULL_FACE);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.recordTexture);
      for (const info of this.programs('pick')) this.setFrameUniforms(gl, info, null);

      const eye = this.camera.getEye();
      // Only batches whose box reaches the pixel can draw in it.
      const pixelView = this.camera.frustum(pixelWindow(px, py, this.canvas.width, this.canvas.height));
      this.pickedBatches = 0;

      for (const model of this.models.values()) {
        if (!model.visible) continue;

        for (const batch of model.batches) {
          if (!boxMayShow(pixelView, batch.min, batch.max, eye)) continue;
          this.pickedBatches++;
          this.bindBatch(gl, model, batch, eye, 'pick');

          // Picking culls what drawing culls, so a click finds what shows.
          this.drawOpaque(gl, batch);
          if (batch.transparentIndexCount > 0 && batch.transparentIndexBuffer) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.transparentIndexBuffer);
            gl.drawElements(gl.TRIANGLES, batch.transparentIndexCount, batch.indexType, 0);
          }
        }
      }
      gl.bindVertexArray(null);

      const pixel = new Uint32Array(4);
      gl.readPixels(px, glPy, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, pixel);

      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const modelNum = pixel[0];
      const expressId = pixel[1];
      const depth = new Float32Array(pixel.buffer)[2];

      if (modelNum === 0 || expressId === 0) {
        return { ref: null, sample: { hit: false } };
      }

      const modelId = this.numToModelId.get(modelNum);
      if (!modelId) return { ref: null, sample: { hit: false } };

      return { ref: { modelId, expressId }, sample: { hit: true, depth } };
    } catch (err) {
      console.warn('Pick error in WebGL2:', err);
      return { ref: null, sample: { hit: null } };
    } finally {
      this.isPicking = false;
    }
  }

  orbitCamera(dx: number, dy: number): void {
    this.camera.orbit(dx, dy);
    this.renderFrame();
  }

  async waitForGpuIdle(): Promise<void> {
    const gl = this.gl;
    if (!gl) return;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (sync) await waitForSync(gl, sync, 2000);
  }

  getDebugStats(): RendererDebugStats {
    let batchCount = 0;
    let recordCount = 0;
    let liveGpuBuffers = 0;
    let allocatedGpuBytes = 0;

    for (const model of this.models.values()) {
      batchCount += model.batches.length;
      recordCount += model.recordWords.length / 4;
      for (const b of model.batches) {
        liveGpuBuffers += b.recordIndexBuffer ? 3 : 2;
        if (b.opaqueIndexBuffer) liveGpuBuffers++;
        if (b.transparentIndexBuffer) liveGpuBuffers++;
        allocatedGpuBytes += b.gpuBytes;
      }
    }

    return {
      modelCount: this.models.size,
      batchCount,
      recordCount,
      liveGpuBuffers,
      allocatedGpuBytes,
      renderCount: this.renderCount,
      lastFrameCpuMs: this.lastFrameCpuMs,
      drawnBatches: this.drawnBatches,
      pickedBatches: this.pickedBatches
    };
  }

  private releaseGlResourcesAndListeners(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.cleanupListeners) {
      this.cleanupListeners();
      this.cleanupListeners = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.deviceLostBanner) {
      this.deviceLostBanner.remove();
      this.deviceLostBanner = null;
    }

    if (this.gl) {
      for (const model of this.models.values()) {
        for (const b of model.batches) {
          this.gl.deleteBuffer(b.positionBuffer);
          this.gl.deleteBuffer(b.normalBuffer);
          if (b.recordIndexBuffer) this.gl.deleteBuffer(b.recordIndexBuffer);
          if (b.vao) this.gl.deleteVertexArray(b.vao);
          if (b.opaqueIndexBuffer) this.gl.deleteBuffer(b.opaqueIndexBuffer);
          if (b.transparentIndexBuffer) this.gl.deleteBuffer(b.transparentIndexBuffer);
        }
        model.batches.length = 0;
        model.recordWords.length = 0;
        model.expressIdToRecords.clear();
      }

      if (this.mainProgram) {
        this.gl.deleteProgram(this.mainProgram);
        this.mainProgram = null;
      }
      if (this.pickProgram) {
        this.gl.deleteProgram(this.pickProgram);
        this.pickProgram = null;
      }
      for (const info of [this.mainQ16, this.pickQ16]) if (info) this.gl.deleteProgram(info.program);
      this.mainQ16 = null;
      this.pickQ16 = null;
      this.boundProgram = null;
      if (this.recordTexture) {
        this.gl.deleteTexture(this.recordTexture);
        this.recordTexture = null;
      }
      if (this.pickFramebuffer) {
        this.gl.deleteFramebuffer(this.pickFramebuffer);
        this.pickFramebuffer = null;
      }
      if (this.pickColorTexture) {
        this.gl.deleteTexture(this.pickColorTexture);
        this.pickColorTexture = null;
      }
      if (this.pickDepthRenderbuffer) {
        this.gl.deleteRenderbuffer(this.pickDepthRenderbuffer);
        this.pickDepthRenderbuffer = null;
      }
      if (this.sceneFramebuffer) {
        this.gl.deleteFramebuffer(this.sceneFramebuffer);
        this.sceneFramebuffer = null;
      }
      if (this.sceneColorRenderbuffer) {
        this.gl.deleteRenderbuffer(this.sceneColorRenderbuffer);
        this.sceneColorRenderbuffer = null;
      }
      if (this.sceneDepthRenderbuffer) {
        this.gl.deleteRenderbuffer(this.sceneDepthRenderbuffer);
        this.sceneDepthRenderbuffer = null;
      }
    }
    this.framebufferSize = [0, 0];

    this.gl = null;
  }

  destroy(): void {
    this.isDestroyed = true;
    this.initGeneration++;
    this.preInitQueue.length = 0;
    this.uploadQueue.length = 0;
    this.pendingFinishBounds.clear();
    this.hasFramedInitialModel = false;
    this.releaseGlResourcesAndListeners();
    this.models.clear();
    this.numToModelId.clear();
  }
}
