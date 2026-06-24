'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useCanvasResize } from '@/src/hooks/useCanvasResize';
import { useWebGPUAvailable } from '@/src/hooks/useWebGPUAvailable';
import { WebGPUEngine, buildQuadtree } from '@/src/lib/webgpu/webgpuEngine';
import type { RenderMode } from '@/src/types/network';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopologyCanvasNode {
  id: string;
  x: number;
  y: number;
  r?: number;
  label?: string;
  color?: string;
  /** Lower importance = removed first during adaptive quality */
  importance?: number;
}

export interface TopologyCanvasEdge {
  id: string;
  source: string;
  target: string;
  color?: string;
  dashed?: boolean;
  weight?: number;
}

export interface TopologyCanvasProps {
  nodes: TopologyCanvasNode[];
  edges?: TopologyCanvasEdge[];
  /** Draw callback for Canvas 2D fallback */
  drawFn?: (ctx: CanvasRenderingContext2D) => void;
  className?: string;
  debug?: boolean;
  /** Called when render mode changes */
  onRenderModeChange?: (mode: RenderMode) => void;
  /** Adaptive quality: max frame budget in ms */
  frameBudgetMs?: number;
  /** Current layout simulation running (show spinner) */
  isSimulating?: boolean;
}

// ---------------------------------------------------------------------------
// Canvas 2D rendering (fallback path)
// ---------------------------------------------------------------------------

function renderCanvas2D(
  ctx: CanvasRenderingContext2D,
  nodes: TopologyCanvasNode[],
  edges: TopologyCanvasEdge[],
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);

  // Draw edges
  if (edges.length > 0) {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    for (const e of edges) {
      const src = nodeMap.get(e.source);
      const tgt = nodeMap.get(e.target);
      if (!src || !tgt) continue;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.stroke();
    }
  }

  // Draw nodes
  for (const n of nodes) {
    const radius = n.r ?? 3;
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = n.color ?? '#0f766e';
    ctx.fill();
  }

  // Draw labels for larger nodes
  ctx.fillStyle = '#171512';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (const n of nodes) {
    if (n.label && (n.r ?? 3) > 4) {
      ctx.fillText(n.label, n.x, n.y - (n.r ?? 3) - 4);
    }
  }
}

// ---------------------------------------------------------------------------
// TopologyCanvas Component
// ---------------------------------------------------------------------------

/**
 * TopologyCanvas provides a unified canvas rendering surface for network
 * topology visualization. It supports three backends:
 *
 *   1. WebGPU (via WebGPUEngine compute + render pipeline) — 10K+ nodes @ 60 FPS
 *   2. WebGL2 (delegated to parent MeshTopologyMap)
 *   3. Canvas 2D (fallback)
 *
 * Automatic backend selection is driven by WebGPU availability (checked via
 * navigator.gpu). When WebGPU is unavailable, the canvas renders with 2D.
 * WebGL2 rendering is handled externally by the MeshTopologyMap component.
 */
export function TopologyCanvas({
  nodes,
  edges = [],
  drawFn,
  className = '',
  debug = false,
  onRenderModeChange,
  frameBudgetMs = 14,
  isSimulating = false,
}: TopologyCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderMode, setRenderMode] = useState<RenderMode>('canvas2d');
  const [qualityLevel, setQualityLevel] = useState(1); // 1 = full, 0.75 = medium, 0.5 = low
  const webgpuState = useWebGPUAvailable();
  const webgpuAvailable = webgpuState.isAvailable;
  const webgpuChecking = webgpuState.checking;
  const engineRef = useRef<WebGPUEngine | null>(null);
  const animFrameRef = useRef<number>(0);
  const lastFrameTimeRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);

  // ---- Adaptive quality logic ----
  const adaptiveNodes = useCallback(
    (allNodes: TopologyCanvasNode[], quality: number): TopologyCanvasNode[] => {
      if (quality >= 1) return allNodes;
      // Sort by importance (descending) and take the top fraction
      const sorted = [...allNodes].sort((a, b) => (b.importance ?? 50) - (a.importance ?? 50));
      const count = Math.max(1, Math.floor(allNodes.length * quality));
      return sorted.slice(0, count);
    },
    [],
  );

  // ---- Initialise WebGPU engine ----
  useEffect(() => {
    if (!webgpuAvailable) return;

    const engine = new WebGPUEngine();
    engineRef.current = engine;

    async function initEngine() {
      const ok = await engine.init();
      if (ok) {
        setRenderMode('webgpu');
        onRenderModeChange?.('webgpu');
      }
    }

    initEngine();

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [webgpuAvailable, onRenderModeChange]);

  // ---- Canvas 2D rendering loop (fallback) ----
  const fallbackDrawFn = useCallback(() => {
    if (renderMode !== 'canvas2d') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (drawFn) {
      drawFn(ctx);
    } else {
      const rect = canvas.getBoundingClientRect();
      const displayedNodes = qualityLevel < 1 ? adaptiveNodes(nodes, qualityLevel) : nodes;
      renderCanvas2D(ctx, displayedNodes, edges, rect.width, rect.height);
    }
  }, [renderMode, drawFn, nodes, edges, qualityLevel, adaptiveNodes]);

  useCanvasResize(canvasRef, fallbackDrawFn);

  // ---- WebGPU rendering loop ----
  useEffect(() => {
    if (renderMode !== 'webgpu' || !engineRef.current) return;

    const engine = engineRef.current;
    let running = true;

    async function renderLoop() {
      if (!running) return;

      const frameStart = performance.now();

      try {
        const state = await engine.step();
        if (state && running) {
          // Update node positions from WebGPU buffer
          // (Positions are already in the buffer; Canvas 2D reads them for rendering)
          const dpr = window.devicePixelRatio || 1;
          const canvas = canvasRef.current;
          if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              const rect = canvas.getBoundingClientRect();
              const posNodes: TopologyCanvasNode[] = [];
              for (let i = 0; i < nodes.length; i++) {
                if (i * 2 + 1 < state.positions.length) {
                  posNodes.push({
                    ...nodes[i],
                    x: state.positions[i * 2],
                    y: state.positions[i * 2 + 1],
                  });
                }
              }
              const displayedNodes = qualityLevel < 1 ? adaptiveNodes(posNodes, qualityLevel) : posNodes;
              renderCanvas2D(ctx, displayedNodes, edges, rect.width, rect.height);
            }
          }
        }
      } catch (err) {
        // WebGPU step failed — fall back to Canvas 2D
        console.warn('[TopologyCanvas] WebGPU step failed, falling back to Canvas 2D:', err);
        setRenderMode('canvas2d');
        onRenderModeChange?.('canvas2d');
        return;
      }

      // Adaptive quality: compute rolling frame time average
      const frameDuration = performance.now() - frameStart;
      frameTimesRef.current.push(frameDuration);
      if (frameTimesRef.current.length > 30) frameTimesRef.current.shift();

      const avgFrameTime = frameTimesRef.current.reduce((s, t) => s + t, 0) / frameTimesRef.current.length;
      if (avgFrameTime > frameBudgetMs) {
        // Reduce quality
        setQualityLevel((prev) => Math.max(0.25, prev - 0.25));
      } else if (avgFrameTime < frameBudgetMs * 0.5 && qualityLevel < 1) {
        // Increase quality if we have headroom
        setQualityLevel((prev) => Math.min(1, prev + 0.25));
      }

      animFrameRef.current = requestAnimationFrame(renderLoop);
    }

    // Upload initial node data
    const engineNodes: import('@/src/types/network').NodePosition[] = nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      label: n.label,
      color: n.color,
    }));
    const quadtree = buildQuadtree(engineNodes);
    engine.setNodeData(engineNodes, quadtree);

    animFrameRef.current = requestAnimationFrame(renderLoop);
    lastFrameTimeRef.current = performance.now();

    return () => {
      running = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [renderMode, nodes, edges, frameBudgetMs, qualityLevel, onRenderModeChange, adaptiveNodes]);

  // ---- Render ----
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        className={className}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      {/* Debug overlay */}
      {debug && (
        <div
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            background: 'rgba(0,0,0,0.7)',
            color: '#0f0',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 4,
            fontFamily: 'monospace',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span>mode: {renderMode}</span>
          <span>quality: {Math.round(qualityLevel * 100)}%</span>
          <span>nodes: {nodes.length}</span>
          {webgpuChecking && <span>checking WebGPU...</span>}
        </div>
      )}
      {/* Render mode badge */}
      {renderMode !== 'webgpu' && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/50 px-2 py-1 text-xs text-white">
          {renderMode === 'webgl2' ? 'WebGL2' : '2D Canvas'}
        </div>
      )}
      {/* WebGPU quality badge */}
      {renderMode === 'webgpu' && qualityLevel < 1 && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-amber-600/80 px-2 py-1 text-xs text-white">
          Quality: {Math.round(qualityLevel * 100)}%
        </div>
      )}
      {/* Simulation running indicator */}
      {isSimulating && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/50 px-2 py-1 text-xs text-white">
          Simulating...
        </div>
      )}
    </div>
  );
}
