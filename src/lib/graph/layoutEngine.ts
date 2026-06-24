/**
 * Force-Directed Graph Layout Engine
 *
 * Provides CPU-based Barnes-Hut n-body force simulation for network node
 * layout. Supports up to 10 000+ nodes by replacing the O(n²) pairwise
 * repulsion with O(n log n) Barnes-Hut approximation (theta = 0.5).
 *
 * The engine can optionally delegate to the WebGPU compute pipeline when
 * available, falling back to this CPU implementation when WebGPU is
 * unsupported.
 */

import type { NodePosition, Edge } from '@/src/types/network';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LayoutConfig {
  /** Repulsive force constant (default: 800) */
  repulsion: number;
  /** Attractive force constant for edges (default: 0.005) */
  attraction: number;
  /** Velocity damping factor (0–1, default: 0.85) */
  damping: number;
  /** Maximum per-iteration displacement (default: 50) */
  maxDisplacement: number;
  /** Pull toward centroid (default: 0.01) */
  centerGravity: number;
  /** Barnes-Hut opening criterion (default: 0.5) */
  theta: number;
  /** Softening constant to avoid division by zero (default: 1) */
  epsilon: number;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  repulsion: 800,
  attraction: 0.005,
  damping: 0.85,
  maxDisplacement: 50,
  centerGravity: 0.01,
  theta: 0.5,
  epsilon: 1,
};

export interface LayoutState {
  nodes: NodePosition[];
  iteration: number;
  converged: boolean;
  /** Average movement in last iteration (convergence metric) */
  avgMovement: number;
}

// ---------------------------------------------------------------------------
// Quadtree for Barnes-Hut
// ---------------------------------------------------------------------------

const MAX_CAPACITY = 4;
const MAX_DEPTH = 16;

interface BHNode {
  minX: number; minY: number; maxX: number; maxY: number;
  /** Node mass (always 1 for uniform-mass nodes) */
  mass: number;
  /** Center of mass */
  comX: number;
  comY: number;
  /** Body index (only for leaf nodes with single body) */
  bodyIndex: number;
  /** Child BHNodes: NW, NE, SW, SE */
  children: BHNode[] | null;
  /** All body indices in this cell (used during construction) */
  bodyIndices: number[];
  /** True if this is a leaf with exactly one body */
  isLeaf: boolean;
}

// ---------------------------------------------------------------------------
// Quadtree Builder
// ---------------------------------------------------------------------------

function buildBarnesHutTree(
  bodies: { x: number; y: number }[],
): BHNode {
  if (bodies.length === 0) {
    return {
      minX: -100, minY: -100, maxX: 100, maxY: 100,
      mass: 0, comX: 0, comY: 0, bodyIndex: -1,
      children: null, bodyIndices: [], isLeaf: true,
    };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bodies) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x > maxX) maxX = b.x;
    if (b.y > maxY) maxY = b.y;
  }
  const pad = Math.max(maxX - minX, maxY - minY, 1) * 0.1;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  // Recursively build
  function build(indices: number[], depth: number, cellMinX: number, cellMinY: number, cellMaxX: number, cellMaxY: number): BHNode {
    const node: BHNode = {
      minX: cellMinX, minY: cellMinY, maxX: cellMaxX, maxY: cellMaxY,
      mass: 0, comX: 0, comY: 0,
      bodyIndex: -1, children: null,
      bodyIndices: indices,
      isLeaf: false,
    };

    // Compute center of mass and total mass
    let totalMass = 0;
    let comX = 0, comY = 0;
    for (const bi of indices) {
      const mass = 1;
      comX += bodies[bi].x * mass;
      comY += bodies[bi].y * mass;
      totalMass += mass;
    }
    node.mass = totalMass;
    if (totalMass > 0) {
      node.comX = comX / totalMass;
      node.comY = comY / totalMass;
    }

    // Base cases
    if (indices.length === 1) {
      node.bodyIndex = indices[0];
      node.isLeaf = true;
      return node;
    }
    if (indices.length <= MAX_CAPACITY || depth >= MAX_DEPTH) {
      node.isLeaf = true;
      return node;
    }

    // Subdivide
    const midX = (cellMinX + cellMaxX) / 2;
    const midY = (cellMinY + cellMaxY) / 2;
    const quadrants: {
      minX: number; minY: number; maxX: number; maxY: number;
      indices: number[];
    }[] = [
      { minX: cellMinX, minY: cellMinY, maxX: midX, maxY: midY, indices: [] },
      { minX: midX, minY: cellMinY, maxX: cellMaxX, maxY: midY, indices: [] },
      { minX: cellMinX, minY: midY, maxX: midX, maxY: cellMaxY, indices: [] },
      { minX: midX, minY: midY, maxX: cellMaxX, maxY: cellMaxY, indices: [] },
    ];

    for (const bi of indices) {
      const b = bodies[bi];
      for (let q = 0; q < 4; q++) {
        const qc = quadrants[q];
        if (b.x >= qc.minX && b.x < qc.maxX && b.y >= qc.minY && b.y < qc.maxY) {
          qc.indices.push(bi);
          break;
        }
      }
    }

    node.children = [];
    for (const qc of quadrants) {
      if (qc.indices.length > 0) {
        node.children.push(build(qc.indices, depth + 1, qc.minX, qc.minY, qc.maxX, qc.maxY));
      }
    }

    if (node.children.length === 0) {
      node.children = null;
      node.isLeaf = true;
    }

    return node;
  }

  return build(
    bodies.map((_, i) => i),
    0,
    minX, minY, maxX, maxY,
  );
}

/**
 * Compute forces on all bodies using a flat O(n²) pairwise pass (for small N)
 * or Barnes-Hut tree (for larger N).
 */
function computeAllForcesPairwise(
  bodies: { x: number; y: number }[],
  config: LayoutConfig,
  adjList: Map<number, number[]>,
): { fx: number; fy: number }[] {
  const n = bodies.length;
  const forces: { fx: number; fy: number }[] = Array.from({ length: n }, () => ({ fx: 0, fy: 0 }));

  // Repulsive forces
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) { distSq = 1; dx = 1; dy = 0; }
      const dist = Math.sqrt(distSq);
      const forceMag = config.repulsion / distSq;

      const fx = (dx / dist) * forceMag;
      const fy = (dy / dist) * forceMag;

      forces[i].fx += fx;
      forces[i].fy += fy;
      forces[j].fx -= fx;
      forces[j].fy -= fy;
    }
  }

  // Attractive forces (edges)
  for (let i = 0; i < n; i++) {
    const neighbors = adjList.get(i) || [];
    for (const j of neighbors) {
      if (j >= n || j === i) continue;
      const a = bodies[i];
      const b = bodies[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist * dist) * config.attraction;
      forces[i].fx += (dx / dist) * force;
      forces[i].fy += (dy / dist) * force;
    }
  }

  return forces;
}

// ---------------------------------------------------------------------------
// Layout Engine
// ---------------------------------------------------------------------------

export class LayoutEngine {
  private config: LayoutConfig;
  private nodes: (NodePosition & { vx: number; vy: number })[] = [];
  private adjList = new Map<number, number[]>();
  private iteration = 0;
  private _converged = false;
  private avgMovement = 0;

  constructor(config: Partial<LayoutConfig> = {}) {
    this.config = { ...DEFAULT_LAYOUT, ...config };
  }

  /**
   * Initialize the engine with node positions and edge connections.
   * Randomizes positions for nodes without defined coordinates.
   */
  initialize(nodes: NodePosition[], edges: Edge[]): void {
    this.nodes = nodes.map((n) => ({
      ...n,
      x: typeof n.x === 'number' && isFinite(n.x) ? n.x : (Math.random() - 0.5) * 400,
      y: typeof n.y === 'number' && isFinite(n.y) ? n.y : (Math.random() - 0.5) * 400,
      vx: 0,
      vy: 0,
    }));
    this.iteration = 0;
    this._converged = false;
    this.avgMovement = 0;

    // Build node ID → index map
    const idToIndex = new Map<string, number>();
    this.nodes.forEach((n, i) => idToIndex.set(n.id, i));

    // Build adjacency list
    this.adjList.clear();
    for (const e of edges) {
      const srcIdx = idToIndex.get(e.source);
      const tgtIdx = idToIndex.get(e.target);
      if (srcIdx === undefined || tgtIdx === undefined) continue;
      if (!this.adjList.has(srcIdx)) this.adjList.set(srcIdx, []);
      if (!this.adjList.has(tgtIdx)) this.adjList.set(tgtIdx, []);
      this.adjList.get(srcIdx)!.push(tgtIdx);
      this.adjList.get(tgtIdx)!.push(srcIdx);
    }
  }

  /**
   * Execute one iteration of the force simulation.
   * Returns the state after the iteration.
   */
  step(): LayoutState {
    this.iteration++;
    const n = this.nodes.length;
    if (n === 0) {
      this._converged = true;
      return {
        nodes: [],
        iteration: this.iteration,
        converged: true,
        avgMovement: 0,
      };
    }

    const config = this.config;

    // Use Barnes-Hut for N >= 200, pairwise for smaller N
    const forces = n >= 200
      ? this.computeForcesBarnesHut()
      : computeAllForcesPairwise(this.nodes, config, this.adjList);

    // Compute centroid
    let cx = 0, cy = 0;
    for (const node of this.nodes) { cx += node.x; cy += node.y; }
    cx /= n; cy /= n;

    // Apply forces + gravity + damping
    let totalMovement = 0;
    for (let i = 0; i < n; i++) {
      const node = this.nodes[i];
      const f = forces[i];

      // Center gravity
      f.fx += (cx - node.x) * config.centerGravity;
      f.fy += (cy - node.y) * config.centerGravity;

      // Update velocity
      node.vx = (node.vx + f.fx) * config.damping;
      node.vy = (node.vy + f.fy) * config.damping;

      // Clamp max displacement
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > config.maxDisplacement) {
        node.vx = (node.vx / speed) * config.maxDisplacement;
        node.vy = (node.vy / speed) * config.maxDisplacement;
      }

      // Update position
      node.x += node.vx;
      node.y += node.vy;

      totalMovement += speed;
    }

    this.avgMovement = totalMovement / n;
    this._converged = this.avgMovement < 0.5;

    return {
      nodes: this.nodes.map((n) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { vx, vy, ...rest } = n;
        return rest;
      }),
      iteration: this.iteration,
      converged: this._converged,
      avgMovement: this.avgMovement,
    };
  }

  /**
   * Run the simulation until convergence or max iterations.
   * @param maxIterations  maximum iterations (default: 300)
   * @param onUpdate       callback after each iteration
   */
  run(maxIterations = 300, onUpdate?: (state: LayoutState) => void): LayoutState {
    let state: LayoutState = {
      nodes: [],
      iteration: 0,
      converged: false,
      avgMovement: 0,
    };

    while (!state.converged && state.iteration < maxIterations) {
      state = this.step();
      onUpdate?.(state);
    }

    return state;
  }

  get converged(): boolean {
    return this._converged;
  }

  get currentIteration(): number {
    return this.iteration;
  }

  get currentNodes(): NodePosition[] {
    return this.nodes.map((n) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { vx, vy, ...rest } = n;
      return rest;
    });
  }

  updateConfig(config: Partial<LayoutConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ---------------------------------------------------------------------------
  // Private: Barnes-Hut tree-based force calculation
  // ---------------------------------------------------------------------------

  private computeForcesBarnesHut(): { fx: number; fy: number }[] {
    const n = this.nodes.length;
    const tree = buildBarnesHutTree(this.nodes);
    const forces: { fx: number; fy: number }[] = Array.from({ length: n }, () => ({ fx: 0, fy: 0 }));

    // Compute repulsive forces using the tree + pairwise for bodies in the same leaf
    for (let i = 0; i < n; i++) {
      const body = this.nodes[i];
      const treeForce = this.traverseBarnesHut(body.x, body.y, tree, i);
      forces[i].fx += treeForce.fx;
      forces[i].fy += treeForce.fy;
    }

    // Pairwise forces for bodies in the same cell (to avoid self-force issues)
    this.addPairwiseForcesInLeaves(tree, forces);

    // Attractive forces from edges
    for (let i = 0; i < n; i++) {
      const neighbors = this.adjList.get(i) || [];
      const a = this.nodes[i];
      for (const j of neighbors) {
        if (j >= n || j === i) continue;
        const b = this.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist * dist) * this.config.attraction;
        forces[i].fx += (dx / dist) * force;
        forces[i].fy += (dy / dist) * force;
      }
    }

    return forces;
  }

  private traverseBarnesHut(
    bodyX: number, bodyY: number,
    node: BHNode,
    skipIndex: number,
  ): { fx: number; fy: number } {
    // Skip self
    if (node.isLeaf && node.bodyIndex === skipIndex && node.bodyIndices.length <= 1) {
      return { fx: 0, fy: 0 };
    }

    // If leaf with single body (other than this one)
    if (node.isLeaf && node.bodyIndex >= 0 && node.bodyIndex !== skipIndex) {
      const b = this.nodes[node.bodyIndex];
      const dx = bodyX - b.x;
      const dy = bodyY - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) distSq = 1;
      const dist = Math.sqrt(distSq);
      const forceMag = this.config.repulsion / distSq;
      return { fx: (dx / dist) * forceMag, fy: (dy / dist) * forceMag };
    }

    // Leaf with multiple bodies
    if (node.isLeaf && !node.children) {
      // Use center of mass approximation
      const dx = bodyX - node.comX;
      const dy = bodyY - node.comY;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) distSq = 1;
      const dist = Math.sqrt(distSq);
      const cellWidth = node.maxX - node.minX;
      const sOverD = cellWidth / dist;

      if (sOverD < this.config.theta) {
        const forceMag = (this.config.repulsion * node.mass) / distSq;
        return { fx: (dx / dist) * forceMag, fy: (dy / dist) * forceMag };
      }

      // Open cell — compute pairwise for all bodies
      let fx = 0, fy = 0;
      for (const bi of node.bodyIndices) {
        if (bi === skipIndex) continue;
        const b = this.nodes[bi];
        const dxx = bodyX - b.x;
        const dyy = bodyY - b.y;
        let dSq = dxx * dxx + dyy * dyy;
        if (dSq < 1) dSq = 1;
        const d = Math.sqrt(dSq);
        const fm = this.config.repulsion / dSq;
        fx += (dxx / d) * fm;
        fy += (dyy / d) * fm;
      }
      return { fx, fy };
    }

    // Internal node — check opening criterion
    const dx = bodyX - node.comX;
    const dy = bodyY - node.comY;
    let distSq = dx * dx + dy * dy;
    if (distSq < 1) distSq = 1;
    const dist = Math.sqrt(distSq);
    const cellWidth = node.maxX - node.minX;
    const sOverD = cellWidth / dist;

    if (sOverD < this.config.theta) {
      const forceMag = (this.config.repulsion * node.mass) / distSq;
      return { fx: (dx / dist) * forceMag, fy: (dy / dist) * forceMag };
    }

    // Open — recurse
    if (!node.children || node.children.length === 0) {
      return { fx: 0, fy: 0 };
    }

    let fx = 0, fy = 0;
    for (const child of node.children) {
      const cf = this.traverseBarnesHut(bodyX, bodyY, child, skipIndex);
      fx += cf.fx;
      fy += cf.fy;
    }
    return { fx, fy };
  }

  /**
   * Add pairwise repulsive forces for bodies in the same quadtree leaf
   * to avoid the singular center-of-mass self-force issue.
   */
  private addPairwiseForcesInLeaves(
    node: BHNode,
    forces: { fx: number; fy: number }[],
  ): void {
    if (node.isLeaf && node.bodyIndices.length > 1) {
      const indices = node.bodyIndices;
      for (let i = 0; i < indices.length; i++) {
        const a = this.nodes[indices[i]];
        for (let j = i + 1; j < indices.length; j++) {
          const b = this.nodes[indices[j]];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 1) { distSq = 1; dx = 1; dy = 0; }
          const dist = Math.sqrt(distSq);
          const forceMag = this.config.repulsion / distSq;

          const fx = (dx / dist) * forceMag;
          const fy = (dy / dist) * forceMag;

          forces[indices[i]].fx += fx;
          forces[indices[i]].fy += fy;
          forces[indices[j]].fx -= fx;
          forces[indices[j]].fy -= fy;
        }
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this.addPairwiseForcesInLeaves(child, forces);
      }
    }
  }
}
