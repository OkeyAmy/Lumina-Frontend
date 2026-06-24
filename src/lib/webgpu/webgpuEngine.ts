/**
 * WebGPU Engine — manages GPU device, pipeline, and buffer lifecycle for
 * network graph force-directed layout computation.
 *
 * Implements Barnes-Hut n-body simulation on the GPU via WGSL compute shaders,
 * with double-buffering for position/velocity arrays and staging buffers for
 * readback.
 *
 * Public API:
 *   init()          — request GPUAdapter, create device + compute pipelines
 *   setNodeData()   — upload initial positions to GPU
 *   step()          — dispatch one frame of simulation, return positions
 *   destroy()       — release GPU resources
 *   isAvailable()   — true if WebGPU initialized successfully
 *   isDisposed()    — true after destroy() is called
 */

import type { NodePosition } from '@/src/types/network';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKGROUP_SIZE = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulationParams {
  numBodies: number;
  numCells: number;
  repulsion: number;
  attraction: number;
  damping: number;
  maxDisplacement: number;
  centerGravity: number;
}

export interface BodyData {
  posX: number;
  posY: number;
  velX: number;
  velY: number;
}

export interface QuadCellData {
  /** NW child index (-1 if leaf) */
  childNW: number;
  /** NE child index (-1 if leaf) */
  childNE: number;
  /** SW child index (-1 if leaf) */
  childSW: number;
  /** SE child index (-1 if leaf) */
  childSE: number;
  /** Center of mass X */
  comX: number;
  /** Center of mass Y */
  comY: number;
  /** Total mass in this cell */
  totalMass: number;
  /** Unused padding for alignment */
  _padding: number;
  /** Bounds: minX */
  minX: number;
  /** Bounds: minY */
  minY: number;
  /** Bounds: maxX */
  maxX: number;
  /** Bounds: maxY */
  maxY: number;
}

export interface QuadtreeData {
  cells: QuadCellData[];
  bodyCellMap: Int32Array; // maps body index → root cell index for that body
}

export interface SimulationState {
  positions: Float32Array;
  velocities: Float32Array;
}

const DEFAULT_SIM_PARAMS: SimulationParams = {
  numBodies: 0,
  numCells: 0,
  repulsion: 800,
  attraction: 0.005,
  damping: 0.85,
  maxDisplacement: 50,
  centerGravity: 0.01,
};

// ---------------------------------------------------------------------------
// Shader source (inlined for environments where WGSL imports aren't available)
// ---------------------------------------------------------------------------

const INLINE_WGSL = `
const THETA_SQ: f32 = 0.25;
const EPSILON: f32 = 1.0;

struct Body {
    pos: vec2<f32>,
    vel: vec2<f32>,
}

struct QuadCell {
    children: vec4<i32>,
    centerOfMass: vec2<f32>,
    totalMass: f32,
    padding0: f32,
    bounds: vec4<f32>,
}

struct SimulationParams {
    numBodies: u32,
    numCells: u32,
    repulsion: f32,
    attraction: f32,
    damping: f32,
    maxDisplacement: f32,
    centerGravity: f32,
}

@group(0) @binding(0) var<storage, read> bodiesIn: array<Body>;
@group(0) @binding(1) var<storage, read_write> forcesOut: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> quadtree: array<QuadCell>;
@group(0) @binding(3) var<storage, read> bodyCellMap: array<i32>;
@group(0) @binding(4) var<uniform> params: SimulationParams;

fn bodyBodyForce(posA: vec2<f32>, posB: vec2<f32>, massB: f32) -> vec2<f32> {
    var delta = posB - posA;
    let distSq = dot(delta, delta) + EPSILON;
    let forceMag = params.repulsion * massB / distSq;
    let invDist = 1.0 / sqrt(distSq);
    return delta * invDist * forceMag;
}

fn traverseQuadtree(cellIdx: i32, bodyPos: vec2<f32>, bodyIdx: u32) -> vec2<f32> {
    var force = vec2<f32>(0.0);
    var stack: array<i32, 64>;
    var stackSize: u32 = 0u;
    stack[stackSize] = cellIdx;
    stackSize += 1u;
    loop {
        if stackSize == 0u { break; }
        stackSize -= 1u;
        let idx = stack[stackSize];
        if idx < 0i { continue; }
        let cell = quadtree[idx];
        if cell.totalMass <= 0.0 { continue; }
        let delta = cell.centerOfMass - bodyPos;
        let distSq = dot(delta, delta) + EPSILON;
        let cellWidth = cell.bounds.z - cell.bounds.x;
        let sOverDSq = (cellWidth * cellWidth) / distSq;
        if sOverDSq < THETA_SQ || cell.children.x < 0i {
            force += bodyBodyForce(bodyPos, cell.centerOfMass, cell.totalMass);
        } else {
            if cell.children.w >= 0i { stack[stackSize] = cell.children.w; stackSize += 1u; }
            if cell.children.z >= 0i { stack[stackSize] = cell.children.z; stackSize += 1u; }
            if cell.children.y >= 0i { stack[stackSize] = cell.children.y; stackSize += 1u; }
            if cell.children.x >= 0i { stack[stackSize] = cell.children.x; stackSize += 1u; }
        }
    }
    return force;
}

@compute @workgroup_size(256)
fn barnesHut(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let bodyIdx = globalId.x;
    if bodyIdx >= params.numBodies { return; }
    let body = bodiesIn[bodyIdx];
    let rootCellIdx = bodyCellMap[bodyIdx];
    var totalForce = vec2<f32>(0.0);
    if rootCellIdx >= 0i {
        totalForce = traverseQuadtree(rootCellIdx, body.pos, bodyIdx);
    }
    totalForce -= body.pos * params.centerGravity;
    forcesOut[bodyIdx] = totalForce;
}

@group(0) @binding(0) var<storage, read> forcesIn: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> bodiesRW: array<Body>;
@group(0) @binding(4) var<uniform> intParams: SimulationParams;

@compute @workgroup_size(256)
fn integrate(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let bodyIdx = globalId.x;
    if bodyIdx >= intParams.numBodies { return; }
    let force = forcesIn[bodyIdx];
    var body = bodiesRW[bodyIdx];
    body.vel = (body.vel + force) * intParams.damping;
    let speed = length(body.vel);
    if speed > intParams.maxDisplacement {
        body.vel = (body.vel / speed) * intParams.maxDisplacement;
    }
    body.pos += body.vel;
    bodiesRW[bodyIdx] = body;
}
`;

// ---------------------------------------------------------------------------
// Quadtree Builder (CPU-side, used to prepare data for GPU)
// ---------------------------------------------------------------------------

/**
 * A quadtree node used during construction.
 * After the tree is built, we flatten it into QuadCellData[].
 */
interface BuilderCell {
  minX: number; minY: number; maxX: number; maxY: number;
  bodyIndices: number[];
  /** Child indices in the flat cells array (-1 = empty) */
  childNW: number;
  childNE: number;
  childSW: number;
  childSE: number;
  /** Set to true when this cell is a leaf (no subdivided children) */
  isLeaf: boolean;
}

function computeCellData(
  bc: BuilderCell,
  nodes: NodePosition[],
): { comX: number; comY: number; totalMass: number } {
  let comX = 0, comY = 0, totalMass = 0;
  for (const bi of bc.bodyIndices) {
    const node = nodes[bi];
    const mass = 1;
    comX += node.x * mass;
    comY += node.y * mass;
    totalMass += mass;
  }
  return {
    comX: totalMass > 0 ? comX / totalMass : (bc.minX + bc.maxX) / 2,
    comY: totalMass > 0 ? comY / totalMass : (bc.minY + bc.maxY) / 2,
    totalMass,
  };
}

function buildQuadtreeRecursive(
  nodes: NodePosition[],
  bodyIndices: number[],
  minX: number, minY: number, maxX: number, maxY: number,
  depth: number,
  maxDepth: number,
  maxCapacity: number,
  flat: QuadCellData[],
): number {
  // Create cell entry
  const cell: BuilderCell = {
    minX, minY, maxX, maxY,
    bodyIndices: [...bodyIndices],
    childNW: -1,
    childNE: -1,
    childSW: -1,
    childSE: -1,
    isLeaf: true,
  };

  const { comX, comY, totalMass } = computeCellData(cell, nodes);

  // Save our index before pushing (this is where we'll be in the flat array)
  const myIndex = flat.length;

  // Push a placeholder — we'll fill in children after recursion
  flat.push({
    childNW: -1, childNE: -1, childSW: -1, childSE: -1,
    comX, comY, totalMass,
    _padding: 0,
    minX, minY, maxX, maxY,
  });

  // Base cases: not enough bodies or max depth reached
  if (bodyIndices.length <= maxCapacity || depth >= maxDepth) {
    return myIndex; // leaf — children stay -1
  }

  // Subdivide
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  const quadrants: { bodyIndices: number[]; minX: number; minY: number; maxX: number; maxY: number }[] = [
    { bodyIndices: [], minX, minY, maxX: midX, maxY: midY },
    { bodyIndices: [], minX: midX, minY, maxX, maxY: midY },
    { bodyIndices: [], minX, minY: midY, maxX: midX, maxY },
    { bodyIndices: [], minX: midX, minY: midY, maxX, maxY },
  ];

  for (const bi of bodyIndices) {
    const node = nodes[bi];
    for (let q = 0; q < 4; q++) {
      const qc = quadrants[q];
      if (node.x >= qc.minX && node.x < qc.maxX && node.y >= qc.minY && node.y < qc.maxY) {
        qc.bodyIndices.push(bi);
        break;
      }
    }
  }

  // Recurse into non-empty quadrants
  const childIndices = [-1, -1, -1, -1];
  for (let q = 0; q < 4; q++) {
    if (quadrants[q].bodyIndices.length > 0) {
      childIndices[q] = buildQuadtreeRecursive(
        nodes,
        quadrants[q].bodyIndices,
        quadrants[q].minX, quadrants[q].minY,
        quadrants[q].maxX, quadrants[q].maxY,
        depth + 1,
        maxDepth,
        maxCapacity,
        flat,
      );
    }
  }

  // Update our entry with child indices
  flat[myIndex] = {
    childNW: childIndices[0],
    childNE: childIndices[1],
    childSW: childIndices[2],
    childSE: childIndices[3],
    comX, comY, totalMass,
    _padding: 0,
    minX, minY, maxX, maxY,
  };

  return myIndex;
}

export function buildQuadtree(
  nodes: NodePosition[],
): QuadtreeData {
  const n = nodes.length;

  // Compute bounding box with 10% padding
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  if (n === 0) {
    minX = -1000; minY = -1000; maxX = 1000; maxY = 1000;
  } else {
    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
    }
  }
  const pad = Math.max(maxX - minX, maxY - minY, 1) * 0.1;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const flat: QuadCellData[] = [];
  const allIndices = nodes.map((_, i) => i);

  buildQuadtreeRecursive(
    nodes, allIndices,
    minX, minY, maxX, maxY,
    0, 12, 8,
    flat,
  );

  // Every body maps to the root cell (index 0)
  const bodyCellMap = new Int32Array(n);
  bodyCellMap.fill(0);

  return { cells: flat, bodyCellMap };
}

// ---------------------------------------------------------------------------
// WebGPU Engine
// ---------------------------------------------------------------------------

export class WebGPUEngine {
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private barnesHutPipeline: GPUComputePipeline | null = null;
  private integratePipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Double-buffered body storage
  private bodyBufferA: GPUBuffer | null = null;
  private bodyBufferB: GPUBuffer | null = null;
  private forceBuffer: GPUBuffer | null = null;
  private quadTreeBuffer: GPUBuffer | null = null;
  private bodyCellMapBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer | null = null;

  // Staging buffer for readback
  private stagingBuffer: GPUBuffer | null = null;

  private simParams: SimulationParams = { ...DEFAULT_SIM_PARAMS };
  private numBodies = 0;
  private numCells = 0;
  private _available = false;
  private _disposed = false;

  get isAvailable(): boolean {
    return this._available;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Check whether the browser supports WebGPU (navigator.gpu).
   * Call this before init() to determine if WebGPU is viable.
   */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  /**
   * Initialize the WebGPU device, pipeline, and resources.
   * Returns true on success, false on failure (fallback to CPU/WebGL2).
   */
  async init(): Promise<boolean> {
    if (this._disposed) return false;
    if (this._available) return true;

    try {
      if (!WebGPUEngine.isSupported()) {
        console.debug('[WebGPU] navigator.gpu not available — fallback to CPU/WebGL2');
        return false;
      }

      this.adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });
      if (!this.adapter) {
        console.debug('[WebGPU] No GPU adapter found — fallback to CPU/WebGL2');
        return false;
      }

      this.device = await this.adapter.requestDevice({
        requiredFeatures: [],
        requiredLimits: {
          maxStorageBufferBindingSize: 256 * 1024 * 1024,
          maxBufferSize: 256 * 1024 * 1024,
          maxComputeWorkgroupStorageSize: 32 * 1024,
          maxComputeInvocationsPerWorkgroup: WORKGROUP_SIZE,
          maxComputeWorkgroupSizeX: WORKGROUP_SIZE,
        },
      });

      this.device.addEventListener('uncapturederror', (ev) => {
        console.error('[WebGPU] Uncaptured device error:', (ev as GPUUncapturedErrorEvent).error);
      });

      await this.createPipelines();
      this._available = true;
      console.debug('[WebGPU] Initialized successfully');
      return true;
    } catch (err) {
      console.warn('[WebGPU] Initialization failed — fallback to CPU/WebGL2:', err);
      this.destroy();
      return false;
    }
  }

  /**
   * Upload node position data to GPU buffers for simulation.
   */
  setNodeData(nodes: NodePosition[], quadtree: QuadtreeData): void {
    if (!this._available || !this.device) return;

    this.numBodies = nodes.length;
    this.numCells = quadtree.cells.length;
    this.simParams.numBodies = this.numBodies;
    this.simParams.numCells = this.numCells;

    this.releaseBuffers();

    const device = this.device;

    // Create body buffer (two copies for double-buffering)
    const bodyData = new Float32Array(this.numBodies * 4); // posX, posY, velX, velY
    for (let i = 0; i < this.numBodies; i++) {
      bodyData[i * 4] = nodes[i].x;
      bodyData[i * 4 + 1] = nodes[i].y;
      bodyData[i * 4 + 2] = 0;
      bodyData[i * 4 + 3] = 0;
    }

    this.bodyBufferA = this.createStorageBuffer(bodyData, 'BodyBuffer A');
    this.bodyBufferB = this.createStorageBuffer(bodyData, 'BodyBuffer B');

    // Force buffer
    this.forceBuffer = this.createStorageBuffer(
      new Float32Array(this.numBodies * 2),
      'ForceBuffer',
    );

    // Quadtree buffer
    const quadData = new Float32Array(this.numCells * 12);
    for (let i = 0; i < this.numCells; i++) {
      const c = quadtree.cells[i];
      const offset = i * 12;
      quadData[offset] = c.childNW;
      quadData[offset + 1] = c.childNE;
      quadData[offset + 2] = c.childSW;
      quadData[offset + 3] = c.childSE;
      quadData[offset + 4] = c.comX;
      quadData[offset + 5] = c.comY;
      quadData[offset + 6] = c.totalMass;
      quadData[offset + 7] = 0;
      quadData[offset + 8] = c.minX;
      quadData[offset + 9] = c.minY;
      quadData[offset + 10] = c.maxX;
      quadData[offset + 11] = c.maxY;
    }
    this.quadTreeBuffer = this.createStorageBuffer(quadData, 'QuadTreeBuffer');

    // Body-cell map buffer
    const cellMapData = new Int32Array(quadtree.bodyCellMap);
    this.bodyCellMapBuffer = this.createStorageBuffer(cellMapData, 'BodyCellMapBuffer');

    // Params uniform buffer
    const paramsData = new Float32Array(7);
    paramsData[0] = this.simParams.numBodies;
    paramsData[1] = this.simParams.numCells;
    paramsData[2] = this.simParams.repulsion;
    paramsData[3] = this.simParams.attraction;
    paramsData[4] = this.simParams.damping;
    paramsData[5] = this.simParams.maxDisplacement;
    paramsData[6] = this.simParams.centerGravity;
    this.paramsBuffer = this.createUniformBuffer(paramsData, 'ParamsBuffer');

    // Staging buffer for readback
    this.stagingBuffer = device.createBuffer({
      size: bodyData.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: 'StagingBuffer',
    });
  }

  /**
   * Execute one simulation step.
   * Returns the updated body positions or null if unavailable.
   */
  async step(): Promise<SimulationState | null> {
    if (!this._available || !this.device || !this.barnesHutPipeline || !this.integratePipeline) {
      return null;
    }
    if (this.numBodies === 0) return null;

    const device = this.device;
    const commandEncoder = device.createCommandEncoder({ label: 'SimStep' });

    // ---- Pass 1: Barnes-Hut force calculation ----
    const bhBindGroup = this.createBarnesHutBindGroup();
    if (!bhBindGroup) return null;

    const bhPass = commandEncoder.beginComputePass({ label: 'BarnesHut' });
    bhPass.setPipeline(this.barnesHutPipeline);
    bhPass.setBindGroup(0, bhBindGroup);
    const workgroupCount = Math.ceil(this.numBodies / WORKGROUP_SIZE);
    bhPass.dispatchWorkgroups(workgroupCount);
    bhPass.end();

    // ---- Pass 2: Integration ----
    const intBindGroup = this.createIntegrateBindGroup();
    if (!intBindGroup) return null;

    const intPass = commandEncoder.beginComputePass({ label: 'Integrate' });
    intPass.setPipeline(this.integratePipeline);
    intPass.setBindGroup(0, intBindGroup);
    intPass.dispatchWorkgroups(workgroupCount);
    intPass.end();

    // ---- Copy result to staging buffer ----
    commandEncoder.copyBufferToBuffer(
      this.bodyBufferB!,
      0,
      this.stagingBuffer!,
      0,
      this.numBodies * 4 * Float32Array.BYTES_PER_ELEMENT,
    );

    device.queue.submit([commandEncoder.finish()]);

    // Read back positions
    await this.stagingBuffer!.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(this.stagingBuffer!.getMappedRange());
    const positions = new Float32Array(this.numBodies * 2);
    const velocities = new Float32Array(this.numBodies * 2);
    for (let i = 0; i < this.numBodies; i++) {
      positions[i * 2] = mapped[i * 4];
      positions[i * 2 + 1] = mapped[i * 4 + 1];
      velocities[i * 2] = mapped[i * 4 + 2];
      velocities[i * 2 + 1] = mapped[i * 4 + 3];
    }
    this.stagingBuffer!.unmap();

    // Swap buffers: B → A for next iteration
    const temp = this.bodyBufferA;
    this.bodyBufferA = this.bodyBufferB;
    this.bodyBufferB = temp;

    return { positions, velocities };
  }

  /**
   * Release all WebGPU resources.
   */
  destroy(): void {
    this.releaseBuffers();
    this.barnesHutPipeline = null;
    this.integratePipeline = null;
    this.bindGroupLayout = null;
    this.device?.destroy();
    this.device = null;
    this.adapter = null;
    this._available = false;
    this._disposed = true;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private async createPipelines(): Promise<void> {
    if (!this.device) return;

    const device = this.device;
    const shaderModule = device.createShaderModule({
      code: INLINE_WGSL,
      label: 'GraphShaders',
    });

    // Bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'ComputeBindGroupLayout',
      entries: [
        // binding 0: bodies (read-only for BH, read-write for integrate)
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        // binding 1: forces (read-write for BH, read-only for integrate)
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        // binding 2: quadtree (read-only)
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        // binding 3: body-cell map (read-only)
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        // binding 4: uniform params
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'ComputePipelineLayout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Barnes-Hut pipeline
    this.barnesHutPipeline = device.createComputePipeline({
      label: 'BarnesHutPipeline',
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: 'barnesHut',
        constants: {},
      },
    });

    // Integration pipeline
    this.integratePipeline = device.createComputePipeline({
      label: 'IntegratePipeline',
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: 'integrate',
        constants: {},
      },
    });
  }

  private createStorageBuffer(data: Float32Array | Int32Array, label: string): GPUBuffer {
    const device = this.device!;
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
      label,
    });
    if (data instanceof Float32Array) {
      new Float32Array(buffer.getMappedRange()).set(data);
    } else {
      new Int32Array(buffer.getMappedRange()).set(data);
    }
    buffer.unmap();
    return buffer;
  }

  private createUniformBuffer(data: Float32Array, label: string): GPUBuffer {
    const device = this.device!;
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
      label,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }

  private createBarnesHutBindGroup(): GPUBindGroup | null {
    if (!this.device || !this.bindGroupLayout) return null;
    return this.device.createBindGroup({
      label: 'BarnesHutBindGroup',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bodyBufferA! } },
        { binding: 1, resource: { buffer: this.forceBuffer! } },
        { binding: 2, resource: { buffer: this.quadTreeBuffer! } },
        { binding: 3, resource: { buffer: this.bodyCellMapBuffer! } },
        { binding: 4, resource: { buffer: this.paramsBuffer! } },
      ],
    });
  }

  private createIntegrateBindGroup(): GPUBindGroup | null {
    if (!this.device || !this.bindGroupLayout) return null;
    return this.device.createBindGroup({
      label: 'IntegrateBindGroup',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.forceBuffer! } },
        { binding: 1, resource: { buffer: this.bodyBufferB! } },
        { binding: 2, resource: { buffer: this.quadTreeBuffer! } },
        { binding: 3, resource: { buffer: this.bodyCellMapBuffer! } },
        { binding: 4, resource: { buffer: this.paramsBuffer! } },
      ],
    });
  }

  private releaseBuffers(): void {
    this.bodyBufferA?.destroy();
    this.bodyBufferB?.destroy();
    this.forceBuffer?.destroy();
    this.quadTreeBuffer?.destroy();
    this.bodyCellMapBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.stagingBuffer?.destroy();
    this.bodyBufferA = null;
    this.bodyBufferB = null;
    this.forceBuffer = null;
    this.quadTreeBuffer = null;
    this.bodyCellMapBuffer = null;
    this.paramsBuffer = null;
    this.stagingBuffer = null;
  }
}
