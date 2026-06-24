/**
 * Unit tests for LayoutEngine (Barnes-Hut force-directed layout).
 *
 * Uses the project's lightweight test pattern — no Jest, no test runner.
 * Run with: npx tsx src/lib/graph/__tests__/layoutEngine.test.ts
 */

import { LayoutEngine } from '@/src/lib/graph/layoutEngine';
import type { NodePosition, Edge } from '@/src/types/network';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface FailedTest {
  name: string;
  reason: string;
}

const failures: FailedTest[] = [];

function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failures.push({ name, reason: detail || 'assertion failed' });
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNodes(count: number, seed = 42): NodePosition[] {
  const nodes: NodePosition[] = [];
  for (let i = 0; i < count; i++) {
    const x = ((seed + i * 17) * 2654435761) % 1000 - 500;
    const y = ((seed + i * 31) * 2654435761) % 1000 - 500;
    nodes.push({
      id: `node-${i}`,
      x: x / 10,
      y: y / 10,
      label: `N${i}`,
    });
  }
  return nodes;
}

function makeChainEdges(nodeCount: number): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < nodeCount - 1; i++) {
    edges.push({
      id: `edge-${i}-${i + 1}`,
      source: `node-${i}`,
      target: `node-${i + 1}`,
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  // --- Initialization ---
  console.log('LayoutEngine: initialization');
  {
    const engine = new LayoutEngine();
    assert('starts with iteration 0', engine.currentIteration === 0);
    assert('starts not converged', engine.converged === false);
  }

  {
    const engine = new LayoutEngine({ repulsion: 500, damping: 0.9 });
    const state = engine.step();
    assert('empty engine converges instantly', state.converged === true);
    assert('empty engine iterates once', state.iteration === 1);
  }

  // --- Empty / single node ---
  console.log('LayoutEngine: empty / single node');
  {
    const engine = new LayoutEngine();
    engine.initialize([], []);
    const state = engine.step();
    assert('zero nodes converges', state.converged === true);
    assert('zero nodes returns empty array', state.nodes.length === 0);
  }

  {
    const engine = new LayoutEngine();
    engine.initialize([{ id: 'a', x: 0, y: 0 }], []);
    const state = engine.step();
    assert('single node converges', state.converged === true);
    assert('single node preserved', state.nodes.length === 1);
    assert('node id preserved', state.nodes[0].id === 'a');
  }

  // --- Pairwise forces (N < 200) ---
  console.log('LayoutEngine: pairwise forces');
  {
    const engine = new LayoutEngine({ repulsion: 400 });
    const nodes: NodePosition[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 },
    ];
    engine.initialize(nodes, []);
    const state = engine.step();
    assert('two nodes repel', state.nodes[0].x < 0 && state.nodes[1].x > 10);
  }

  {
    const engine = new LayoutEngine({ repulsion: 100, attraction: 0.1 });
    const nodes: NodePosition[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 0 },
    ];
    const edges: Edge[] = [{ id: 'e1', source: 'a', target: 'b' }];
    engine.initialize(nodes, edges);
    const state = engine.step();
    const dist = Math.sqrt(
      (state.nodes[0].x - state.nodes[1].x) ** 2 +
      (state.nodes[0].y - state.nodes[1].y) ** 2,
    );
    assert('edge attraction pulls nodes closer', dist < 100);
  }

  // --- Barnes-Hut forces (N >= 200) ---
  console.log('LayoutEngine: Barnes-Hut forces');
  {
    const nodes = makeNodes(200, 1);
    const edges = makeChainEdges(200);
    const engine = new LayoutEngine();
    engine.initialize(nodes, edges);
    const state = engine.step();

    assert('200 nodes preserved', state.nodes.length === 200);
    let allFinite = true;
    for (const n of state.nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || isNaN(n.x) || isNaN(n.y)) {
        allFinite = false;
        break;
      }
    }
    assert('all coordinates finite', allFinite);
    assert('some movement occurred', state.avgMovement > 0);
  }

  {
    const nodes = makeNodes(50);
    const engine = new LayoutEngine({ maxDisplacement: 10 });
    engine.initialize(nodes, []);

    for (let i = 0; i < 10; i++) {
      const state = engine.step();
      assert(`iteration ${i + 1} avgMovement is defined`, state.avgMovement !== undefined);
      assert(
        `iteration ${i + 1} avgMovement is finite`,
        Number.isFinite(state.avgMovement),
      );
    }
  }

  // --- Run method ---
  console.log('LayoutEngine: run method');
  {
    const nodes = makeNodes(20);
    const engine = new LayoutEngine({ maxDisplacement: 5 });
    engine.initialize(nodes, []);
    const updates: number[] = [];
    const state = engine.run(50, (s) => updates.push(s.iteration));
    assert('iterations within limit', state.iteration <= 50);
    assert('some iterations executed', updates.length > 0);
    assert('first iteration is 1', updates[0] === 1);
  }

  // --- Centroid gravity ---
  console.log('LayoutEngine: centroid gravity');
  {
    const engine = new LayoutEngine({
      repulsion: 0,
      centerGravity: 1,
      damping: 0.5,
    });
    const nodes: NodePosition[] = [
      { id: 'a', x: 100, y: 0 },
      { id: 'b', x: -100, y: 0 },
    ];
    engine.initialize(nodes, []);
    const state = engine.step();
    assert('node a moves toward center', Math.abs(state.nodes[0].x) < 100);
    assert('node b moves toward center', Math.abs(state.nodes[1].x) < 100);
  }

  // --- Max displacement clamping ---
  console.log('LayoutEngine: max displacement clamping');
  {
    const engine = new LayoutEngine({
      repulsion: 100000,
      maxDisplacement: 5,
      damping: 1,
    });
    const nodes: NodePosition[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
    ];
    engine.initialize(nodes, []);

    const state = engine.step();
    for (const n of state.nodes) {
      const originalNode = nodes.find((orig) => orig.id === n.id)!;
      const dist = Math.sqrt((n.x - originalNode.x) ** 2 + (n.y - originalNode.y) ** 2);
      assert(
        `node ${n.id} displacement <= 6`,
        dist <= 6,
        `got dist=${dist.toFixed(2)}`,
      );
    }
  }

  // --- Config update ---
  console.log('LayoutEngine: config update');
  {
    const engine = new LayoutEngine({ repulsion: 100 });
    engine.initialize(makeNodes(5), []);
    engine.step();
    engine.updateConfig({ repulsion: 10000 });
    const state2 = engine.step();
    assert('config update takes effect', state2.avgMovement > 0);
  }

  // --- Random initialization ---
  console.log('LayoutEngine: random initialization');
  {
    const engine = new LayoutEngine();
    const nodes: NodePosition[] = [
      { id: 'a', x: NaN, y: NaN },
      { id: 'b', x: Infinity, y: -Infinity },
    ];
    engine.initialize(nodes, []);
    const state = engine.step();
    let allOk = true;
    for (const n of state.nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) allOk = false;
    }
    assert('invalid coords replaced with randoms', allOk);
  }

  // --- Performance: 10 iterations on 1000 nodes ---
  console.log('LayoutEngine: performance (1000 nodes × 10 iterations)');
  {
    const nodes = makeNodes(1000, 7);
    const edges = makeChainEdges(1000);
    const engine = new LayoutEngine();
    engine.initialize(nodes, edges);

    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      engine.step();
    }
    const duration = performance.now() - start;
    console.log(`  Duration: ${duration.toFixed(0)}ms`);
    assert(
      'completes in under 10s',
      duration < 10000,
      `took ${duration.toFixed(0)}ms`,
    );
  }

  // --- Report ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} test failure(s):`);
    for (const f of failures) console.error(` - ${f.name}: ${f.reason}`);
    process.exit(1);
  }
  console.log('\nAll LayoutEngine assertions passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
