// =============================================================================
// Barnes-Hut N-Body Force Calculation Compute Shader
// =============================================================================
// Each invocation processes one body (node) and computes the net force exerted
// on it by all other bodies using the Barnes-Hut approximation with theta=0.5.
// The quadtree is stored in a flat array of QuadCell structs.
// =============================================================================

// ---- Constants ----
const THETA_SQ: f32 = 0.25;   // theta^2 = 0.5^2
const EPSILON: f32 = 1.0;     // Softening factor to avoid division by zero
const GRAVITY: f32 = 800.0;   // Repulsion constant (configurable)
const DAMPING: f32 = 0.85;    // Velocity damping factor
const ATTRACTION: f32 = 0.005; // Spring attraction constant

// ---- Data Structures ----

/// Represents a single body (node) in the simulation.
/// Packed as vec4<f32> for efficient GPU loads.
struct Body {
    pos: vec2<f32>,       // (x, y) position
    vel: vec2<f32>,       // (vx, vy) velocity
}

/// Represents a node in the Barnes-Hut quadtree.
/// children: indices of 4 child cells (-1 if leaf)
/// centerOfMass: accumulated center of mass (x, y)
/// totalMass: total mass in this cell
/// bounds: (minX, minY, maxX, maxY) of the cell
struct QuadCell {
    children: vec4<i32>,           // indices of NW, NE, SW, SE children
    centerOfMass: vec2<f32>,
    totalMass: f32,
    padding0: f32,
    bounds: vec4<f32>,             // (minX, minY, maxX, maxY)
}

// =============================================================================
// Storage Buffers (binding layout)
// =============================================================================
// @group(0) @binding(0) var<storage, read> bodiesIn: array<Body>;
// @group(0) @binding(1) var<storage, read_write> forcesOut: array<vec2<f32>>;
// @group(0) @binding(2) var<storage, read> quadtree: array<QuadCell>;
// @group(0) @binding(3) var<storage, read> bodyCellMap: array<i32>;
// @group(0) @binding(4) var<uniforms> simulationParams: SimulationParams;

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

// =============================================================================
// Barnes-Hut Force Calculation (Compute Shader Entry Point)
// =============================================================================
// Each workgroup item computes the force on one body by traversing the
// quadtree. Uses the Barnes-Hut opening criterion:
//   s/d < theta  --> treat cell as a single body at its center of mass
// where s = cell width, d = distance from body to cell center of mass.
// =============================================================================

fn bodyBodyForce(posA: vec2<f32>, posB: vec2<f32>, massB: f32) -> vec2<f32> {
    var delta = posB - posA;
    let distSq = dot(delta, delta) + EPSILON;
    let forceMag = params.repulsion * massB / distSq;
    let invDist = 1.0 / sqrt(distSq);
    return delta * invDist * forceMag;
}

fn traverseQuadtree(cellIdx: i32, bodyPos: vec2<f32>, bodyIdx: u32) -> vec2<f32> {
    var force = vec2<f32>(0.0, 0.0);

    // Stack-based traversal (max depth = 12, so 48 entries is plenty)
    var stack: array<i32, 64>;
    var stackSize: u32 = 0u;

    // Push root
    stack[stackSize] = cellIdx;
    stackSize += 1u;

    loop {
        if stackSize == 0u { break; }
        stackSize -= 1u;
        let idx = stack[stackSize];

        if idx < 0i { continue; }

        let cell = quadtree[idx];

        // Skip empty cells or self-containing cells with single body
        if cell.totalMass <= 0.0 { continue; }

        // Calculate distance to center of mass
        let delta = cell.centerOfMass - bodyPos;
        let distSq = dot(delta, delta) + EPSILON;

        // Cell size (use width, which is maxX - minX)
        let cellWidth = cell.bounds.z - cell.bounds.x;

        // Barnes-Hut opening criterion: s/d < theta
        // Equivalent to s^2 / d^2 < theta^2
        let sOverDSq = (cellWidth * cellWidth) / distSq;

        if sOverDSq < THETA_SQ || cell.children.x < 0i {
            // Treat as single body at center of mass
            force += bodyBodyForce(bodyPos, cell.centerOfMass, cell.totalMass);
        } else {
            // Open the cell - push children onto stack
            if cell.children.w >= 0i {
                stack[stackSize] = cell.children.w; stackSize += 1u;
            }
            if cell.children.z >= 0i {
                stack[stackSize] = cell.children.z; stackSize += 1u;
            }
            if cell.children.y >= 0i {
                stack[stackSize] = cell.children.y; stackSize += 1u;
            }
            if cell.children.x >= 0i {
                stack[stackSize] = cell.children.x; stackSize += 1u;
            }
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

    // Compute repulsive forces via Barnes-Hut tree traversal
    var totalForce = vec2<f32>(0.0);

    if rootCellIdx >= 0i {
        totalForce = traverseQuadtree(rootCellIdx, body.pos, bodyIdx);
    }

    // Add center gravity
    totalForce -= body.pos * params.centerGravity;

    forcesOut[bodyIdx] = totalForce;
}

// =============================================================================
// Velocity/Position Integration (Compute Shader Entry Point)
// =============================================================================
// Updates velocity and position for each body using the computed forces.
// Applies damping and max displacement clamping.
// =============================================================================

@group(0) @binding(0) var<storage, read> forcesIn: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> bodiesRW: array<Body>;
@group(0) @binding(4) var<uniform> intParams: SimulationParams;

@compute @workgroup_size(256)
fn integrate(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let bodyIdx = globalId.x;
    if bodyIdx >= intParams.numBodies { return; }

    let force = forcesIn[bodyIdx];
    var body = bodiesRW[bodyIdx];

    // Update velocity with damping
    body.vel = (body.vel + force) * intParams.damping;

    // Clamp displacement
    let speed = length(body.vel);
    if speed > intParams.maxDisplacement {
        body.vel = (body.vel / speed) * intParams.maxDisplacement;
    }

    // Update position
    body.pos += body.vel;

    bodiesRW[bodyIdx] = body;
}
