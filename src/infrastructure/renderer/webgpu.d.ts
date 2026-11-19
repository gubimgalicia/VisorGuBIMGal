// Minimal W3C WebGPU ambient declarations so the project compiles without external @webgpu/types.

type GPUFlagsConstant = number;
type GPUSize32 = number;
type GPUSize64 = number;
type GPUIndex32 = number;
type GPUSignedOffset32 = number;

type GPUTextureFormat = 'bgra8unorm' | 'rgba8unorm' | 'depth32float' | 'rg32uint' | 'rgba32uint';
type GPUCompareFunction =
  | 'never'
  | 'less'
  | 'equal'
  | 'less-equal'
  | 'greater'
  | 'not-equal'
  | 'greater-equal'
  | 'always';
type GPUVertexFormat = 'float32x3' | 'uint32' | 'uint16x4' | 'snorm16x2';
type GPUIndexFormat = 'uint16' | 'uint32';

declare const GPUBufferUsage: {
  readonly MAP_READ: GPUFlagsConstant;
  readonly MAP_WRITE: GPUFlagsConstant;
  readonly COPY_SRC: GPUFlagsConstant;
  readonly COPY_DST: GPUFlagsConstant;
  readonly INDEX: GPUFlagsConstant;
  readonly VERTEX: GPUFlagsConstant;
  readonly UNIFORM: GPUFlagsConstant;
  readonly STORAGE: GPUFlagsConstant;
  readonly INDIRECT: GPUFlagsConstant;
  readonly QUERY_RESOLVE: GPUFlagsConstant;
};

declare const GPUTextureUsage: {
  readonly COPY_SRC: GPUFlagsConstant;
  readonly COPY_DST: GPUFlagsConstant;
  readonly TEXTURE_BINDING: GPUFlagsConstant;
  readonly STORAGE_BINDING: GPUFlagsConstant;
  readonly RENDER_ATTACHMENT: GPUFlagsConstant;
};

declare const GPUShaderStage: {
  readonly VERTEX: GPUFlagsConstant;
  readonly FRAGMENT: GPUFlagsConstant;
  readonly COMPUTE: GPUFlagsConstant;
};

declare const GPUMapMode: {
  readonly READ: GPUFlagsConstant;
  readonly WRITE: GPUFlagsConstant;
};

interface GPUColorDict {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface GPUBufferDescriptor {
  label?: string;
  size: GPUSize64;
  usage: GPUFlagsConstant;
  mappedAtCreation?: boolean;
}

interface GPUBuffer {
  readonly size: GPUSize64;
  getMappedRange(offset?: GPUSize64, size?: GPUSize64): ArrayBuffer;
  mapAsync(mode: GPUFlagsConstant, offset?: GPUSize64, size?: GPUSize64): Promise<void>;
  unmap(): void;
  destroy(): void;
}

interface GPUExtent3DDict {
  width: GPUSize32;
  height?: GPUSize32;
  depthOrArrayLayers?: GPUSize32;
}

interface GPUTextureDescriptor {
  label?: string;
  size: GPUExtent3DDict;
  format: GPUTextureFormat;
  usage: GPUFlagsConstant;
  sampleCount?: GPUSize32;
}

interface GPUTextureView {
  readonly label?: string;
}

interface GPUTexture {
  createView(): GPUTextureView;
  destroy(): void;
}

interface GPUShaderModuleDescriptor {
  label?: string;
  code: string;
}

interface GPUShaderModule {
  readonly label?: string;
}

interface GPUBindGroupLayoutEntry {
  binding: GPUIndex32;
  visibility: GPUFlagsConstant;
  buffer?: {
    type?: 'uniform' | 'storage' | 'read-only-storage';
  };
}

interface GPUBindGroupLayoutDescriptor {
  label?: string;
  entries: Iterable<GPUBindGroupLayoutEntry>;
}

interface GPUBindGroupLayout {
  readonly label?: string;
}

interface GPUBindGroupEntry {
  binding: GPUIndex32;
  resource: {
    buffer: GPUBuffer;
    offset?: GPUSize64;
    size?: GPUSize64;
  };
}

interface GPUBindGroupDescriptor {
  label?: string;
  layout: GPUBindGroupLayout;
  entries: Iterable<GPUBindGroupEntry>;
}

interface GPUBindGroup {
  readonly label?: string;
}

interface GPUPipelineLayoutDescriptor {
  label?: string;
  bindGroupLayouts: Iterable<GPUBindGroupLayout>;
}

interface GPUPipelineLayout {
  readonly label?: string;
}

interface GPUVertexAttribute {
  format: GPUVertexFormat;
  offset: GPUSize64;
  shaderLocation: GPUIndex32;
}

interface GPUVertexBufferLayout {
  arrayStride: GPUSize64;
  stepMode?: 'vertex' | 'instance';
  attributes: Iterable<GPUVertexAttribute>;
}

interface GPUBlendComponent {
  operation?: 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
  srcFactor?:
    | 'zero'
    | 'one'
    | 'src'
    | 'one-minus-src'
    | 'src-alpha'
    | 'one-minus-src-alpha'
    | 'dst'
    | 'one-minus-dst'
    | 'dst-alpha'
    | 'one-minus-dst-alpha';
  dstFactor?:
    | 'zero'
    | 'one'
    | 'src'
    | 'one-minus-src'
    | 'src-alpha'
    | 'one-minus-src-alpha'
    | 'dst'
    | 'one-minus-dst'
    | 'dst-alpha'
    | 'one-minus-dst-alpha';
}

interface GPUColorTargetState {
  format: GPUTextureFormat;
  blend?: {
    color: GPUBlendComponent;
    alpha: GPUBlendComponent;
  };
  writeMask?: GPUFlagsConstant;
}

interface GPURenderPipelineDescriptor {
  label?: string;
  layout: GPUPipelineLayout | 'auto';
  vertex: {
    module: GPUShaderModule;
    entryPoint: string;
    buffers?: Iterable<GPUVertexBufferLayout>;
  };
  fragment?: {
    module: GPUShaderModule;
    entryPoint: string;
    targets: Iterable<GPUColorTargetState>;
  };
  primitive?: {
    topology?: 'triangle-list' | 'line-list' | 'point-list';
    cullMode?: 'none' | 'front' | 'back';
    frontFace?: 'ccw' | 'cw';
  };
  depthStencil?: {
    format: GPUTextureFormat;
    depthWriteEnabled: boolean;
    depthCompare: GPUCompareFunction;
  };
}

interface GPURenderPipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPURenderPassColorAttachment {
  view: GPUTextureView;
  clearValue?: GPUColorDict;
  loadOp: 'load' | 'clear';
  storeOp: 'store' | 'discard';
}

interface GPURenderPassDepthStencilAttachment {
  view: GPUTextureView;
  depthClearValue?: number;
  depthLoadOp?: 'load' | 'clear';
  depthStoreOp?: 'store' | 'discard';
}

interface GPURenderPassDescriptor {
  label?: string;
  colorAttachments: Iterable<GPURenderPassColorAttachment>;
  depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: GPUIndex32, bindGroup: GPUBindGroup): void;
  setVertexBuffer(slot: GPUIndex32, buffer: GPUBuffer, offset?: GPUSize64, size?: GPUSize64): void;
  setIndexBuffer(
    buffer: GPUBuffer,
    indexFormat: GPUIndexFormat,
    offset?: GPUSize64,
    size?: GPUSize64
  ): void;
  setScissorRect(
    x: GPUIndex32,
    y: GPUIndex32,
    width: GPUIndex32,
    height: GPUIndex32
  ): void;
  drawIndexed(
    indexCount: GPUSize32,
    instanceCount?: GPUSize32,
    firstIndex?: GPUSize32,
    baseVertex?: GPUSignedOffset32,
    firstInstance?: GPUSize32
  ): void;
  end(): void;
}

interface GPUImageCopyTexture {
  texture: GPUTexture;
  mipLevel?: GPUIndex32;
  origin?: { x?: GPUIndex32; y?: GPUIndex32; z?: GPUIndex32 };
}

interface GPUImageCopyBuffer {
  buffer: GPUBuffer;
  offset?: GPUSize64;
  bytesPerRow?: GPUSize32;
  rowsPerImage?: GPUSize32;
}

interface GPUCommandBuffer {
  readonly label?: string;
}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
  copyTextureToBuffer(
    source: GPUImageCopyTexture,
    destination: GPUImageCopyBuffer,
    copySize: GPUExtent3DDict
  ): void;
  finish(): GPUCommandBuffer;
}

interface GPUQueue {
  submit(commandBuffers: Iterable<GPUCommandBuffer>): void;
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: GPUSize64,
    data: BufferSource | ArrayBufferLike,
    dataOffset?: GPUSize64,
    size?: GPUSize64
  ): void;
  onSubmittedWorkDone(): Promise<void>;
}

interface GPUDeviceLostInfo {
  readonly reason: 'unknown' | 'destroyed';
  readonly message: string;
}

interface GPUDevice {
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
  createCommandEncoder(): GPUCommandEncoder;
  destroy(): void;
}

interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>;
}

interface GPUCanvasConfiguration {
  device: GPUDevice;
  format: GPUTextureFormat;
  alphaMode?: 'opaque' | 'premultiplied';
}

interface GPUCanvasContext {
  configure(configuration: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface Navigator {
  readonly gpu?: GPU;
}
