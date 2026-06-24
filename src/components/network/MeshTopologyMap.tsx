'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  NodePosition,
  Edge,
  TopologyData,
  Viewport,
  RenderMode,
  MeshTopologyConfig,
  PickResult,
} from '@/src/types/network'
import { DEFAULT_MESH_CONFIG } from '@/src/types/network'
import { SpatialIndex } from '@/src/lib/spatialIndex'
import {
  useMeshLayout,
  type LayoutConfig,
} from '@/src/hooks/useMeshLayout'

interface MeshTopologyMapProps {
  data: TopologyData
  config?: Partial<MeshTopologyConfig>
  layoutConfig?: Partial<LayoutConfig>
  onNodeClick?: (node: NodePosition | null) => void
  onNodeHover?: (node: NodePosition | null) => void
  onRenderModeChange?: (mode: RenderMode) => void
  width?: number
  height?: number
  className?: string
}

const VERTEX_SHADER_SRC = `#version 300 es
in vec2 a_position;
uniform vec2 u_translation;
uniform float u_zoom;
uniform vec2 u_resolution;
void main() {
  vec2 pos = (a_position * u_zoom) + u_translation;
  vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
}
`

const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}
`

const POINT_VERTEX_SRC = `#version 300 es
in vec2 a_position;
in float a_size;
in vec4 a_color;
uniform vec2 u_translation;
uniform float u_zoom;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  vec2 pos = (a_position * u_zoom) + u_translation;
  vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
  gl_PointSize = a_size * u_zoom;
  v_color = a_color;
}
`

const POINT_FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 outColor;
void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  if (dot(coord, coord) > 0.25) discard;
  outColor = v_color;
}
`

function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
    1,
  ]
}

function nodeIndexToPickColor(index: number): [number, number, number, number] {
  return [
    ((index >> 0) & 0xff) / 255,
    ((index >> 8) & 0xff) / 255,
    ((index >> 16) & 0xff) / 255,
    1,
  ]
}

function pickColorToNodeIndex(r: number, g: number, b: number): number {
  return (r << 0) | (g << 8) | (b << 16)
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Shader compile error:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  if (!prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('Program link error:', gl.getProgramInfoLog(prog))
    gl.deleteProgram(prog)
    return null
  }
  return prog
}

interface GLResources {
  gl: WebGL2RenderingContext
  lineProg: WebGLProgram
  pointProg: WebGLProgram
  lineVAO: WebGLVertexArrayObject
  lineBuffer: WebGLBuffer
  pointVAO: WebGLVertexArrayObject
  pointPosBuffer: WebGLBuffer
  pointSizeBuffer: WebGLBuffer
  pointColorBuffer: WebGLBuffer
  linePosLoc: number
  lineTransLoc: WebGLUniformLocation | null
  lineZoomLoc: WebGLUniformLocation | null
  lineResLoc: WebGLUniformLocation | null
  lineColorLoc: WebGLUniformLocation | null
  pointPosLoc: number
  pointSizeLoc: number
  pointColorLoc: number
  pointTransLoc: WebGLUniformLocation | null
  pointZoomLoc: WebGLUniformLocation | null
  pointResLoc: WebGLUniformLocation | null
}

function initWebGL(canvas: HTMLCanvasElement): GLResources | null {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: false,
  })
  if (!gl) return null

  const lineProg = createProgram(gl, VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC)
  const pointProg = createProgram(gl, POINT_VERTEX_SRC, POINT_FRAGMENT_SRC)
  if (!lineProg || !pointProg) return null

  const lineVAO = gl.createVertexArray()
  if (!lineVAO) return null
  const lineBuffer = gl.createBuffer()
  if (!lineBuffer) return null
  const pointVAO = gl.createVertexArray()
  if (!pointVAO) return null
  const pointPosBuffer = gl.createBuffer()
  if (!pointPosBuffer) return null
  const pointSizeBuffer = gl.createBuffer()
  if (!pointSizeBuffer) return null
  const pointColorBuffer = gl.createBuffer()
  if (!pointColorBuffer) return null

  gl.useProgram(lineProg)
  const linePosLoc = gl.getAttribLocation(lineProg, 'a_position')
  const lineTransLoc = gl.getUniformLocation(lineProg, 'u_translation')
  const lineZoomLoc = gl.getUniformLocation(lineProg, 'u_zoom')
  const lineResLoc = gl.getUniformLocation(lineProg, 'u_resolution')
  const lineColorLoc = gl.getUniformLocation(lineProg, 'u_color')

  gl.useProgram(pointProg)
  const pointPosLoc = gl.getAttribLocation(pointProg, 'a_position')
  const pointSizeLoc = gl.getAttribLocation(pointProg, 'a_size')
  const pointColorLoc = gl.getAttribLocation(pointProg, 'a_color')
  const pointTransLoc = gl.getUniformLocation(pointProg, 'u_translation')
  const pointZoomLoc = gl.getUniformLocation(pointProg, 'u_zoom')
  const pointResLoc = gl.getUniformLocation(pointProg, 'u_resolution')

  return {
    gl,
    lineProg,
    pointProg,
    lineVAO,
    lineBuffer,
    pointVAO,
    pointPosBuffer,
    pointSizeBuffer,
    pointColorBuffer,
    linePosLoc,
    lineTransLoc,
    lineZoomLoc,
    lineResLoc,
    lineColorLoc,
    pointPosLoc,
    pointSizeLoc,
    pointColorLoc,
    pointTransLoc,
    pointZoomLoc,
    pointResLoc,
  }
}

function renderWebGL2(
  ctx: GLResources,
  nodes: NodePosition[],
  edges: Edge[],
  viewport: Viewport,
  config: MeshTopologyConfig,
  lodLevel: 'dots' | 'full',
  picking: boolean,
  pickColors?: Float32Array,
): void {
  const { gl } = ctx
  gl.viewport(0, 0, viewport.width, viewport.height)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const trans = [
    viewport.x * viewport.zoom + viewport.width / 2,
    viewport.y * viewport.zoom + viewport.height / 2,
  ]

  if (!picking && edges.length > 0 && lodLevel !== 'dots') {
    gl.useProgram(ctx.lineProg)
    gl.bindVertexArray(ctx.lineVAO)
    gl.uniform2f(ctx.lineTransLoc, trans[0], trans[1])
    gl.uniform1f(ctx.lineZoomLoc, viewport.zoom)
    gl.uniform2f(ctx.lineResLoc, viewport.width, viewport.height)
    const color = hexToRgba(config.colorEdgeDefault)
    gl.uniform4f(ctx.lineColorLoc, color[0], color[1], color[2], color[3])

    const edgePositions: number[] = []
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))
    for (const e of edges) {
      const src = nodeMap.get(e.source)
      const tgt = nodeMap.get(e.target)
      if (src && tgt) {
        edgePositions.push(src.x, src.y, tgt.x, tgt.y)
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, ctx.lineBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgePositions), gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(ctx.linePosLoc)
    gl.vertexAttribPointer(ctx.linePosLoc, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.LINES, 0, edgePositions.length / 2)
  }

  gl.useProgram(ctx.pointProg)
  gl.bindVertexArray(ctx.pointVAO)

  gl.uniform2f(ctx.pointTransLoc, trans[0], trans[1])
  gl.uniform1f(ctx.pointZoomLoc, viewport.zoom)
  gl.uniform2f(ctx.pointResLoc, viewport.width, viewport.height)

  const positions = new Float32Array(nodes.length * 2)
  const sizes = new Float32Array(nodes.length)
  const colors = picking && pickColors ? pickColors : new Float32Array(nodes.length * 4)

  for (let i = 0; i < nodes.length; i++) {
    positions[i * 2] = nodes[i].x
    positions[i * 2 + 1] = nodes[i].y
    sizes[i] = lodLevel === 'dots' ? config.lodDotRadius : (nodes[i].r ?? config.nodeRadius)

    if (!picking || !pickColors) {
      const c = hexToRgba(nodes[i].color || config.colorNodeDefault)
      colors[i * 4] = c[0]
      colors[i * 4 + 1] = c[1]
      colors[i * 4 + 2] = c[2]
      colors[i * 4 + 3] = c[3]
    }
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, ctx.pointPosBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(ctx.pointPosLoc)
  gl.vertexAttribPointer(ctx.pointPosLoc, 2, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, ctx.pointSizeBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, sizes, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(ctx.pointSizeLoc)
  gl.vertexAttribPointer(ctx.pointSizeLoc, 1, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, ctx.pointColorBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(ctx.pointColorLoc)
  gl.vertexAttribPointer(ctx.pointColorLoc, 4, gl.FLOAT, false, 0, 0)

  gl.drawArrays(gl.POINTS, 0, nodes.length)
}

function renderCanvas2D(
  ctx: CanvasRenderingContext2D,
  nodes: NodePosition[],
  edges: Edge[],
  viewport: Viewport,
  config: MeshTopologyConfig,
  lodLevel: 'dots' | 'full',
  selectedNodeId: string | null,
): void {
  const canvas = ctx.canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  ctx.save()
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.scale(viewport.zoom, viewport.zoom)
  ctx.translate(viewport.x, viewport.y)

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  if (lodLevel !== 'dots') {
    ctx.strokeStyle = config.colorEdgeDefault
    ctx.lineWidth = config.edgeWidth
    for (const e of edges) {
      const src = nodeMap.get(e.source)
      const tgt = nodeMap.get(e.target)
      if (!src || !tgt) continue
      ctx.beginPath()
      ctx.moveTo(src.x, src.y)
      ctx.lineTo(tgt.x, tgt.y)
      ctx.stroke()
    }
  }

  for (const n of nodes) {
    const radius = lodLevel === 'dots'
      ? config.lodDotRadius
      : (n.r ?? config.nodeRadius)

    const isSelected = n.id === selectedNodeId
    ctx.beginPath()
    ctx.arc(n.x, n.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = isSelected
      ? config.colorSelected
      : (n.color || config.colorNodeDefault)
    ctx.fill()

    if (lodLevel !== 'dots' && viewport.zoom > 1 && n.label) {
      ctx.fillStyle = '#171512'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(n.label, n.x, n.y - radius - 4)
    }
  }

  ctx.restore()
}

function getLodLevel(zoom: number, config: MeshTopologyConfig): 'dots' | 'full' {
  return zoom < config.lodNodeThreshold ? 'dots' : 'full'
}

export function MeshTopologyMap({
  data,
  config: configProp,
  layoutConfig,
  onNodeClick,
  onNodeHover,
  onRenderModeChange,
  width: propWidth,
  height: propHeight,
  className = '',
}: MeshTopologyMapProps) {
  const cfg = useMemo(
    () => ({ ...DEFAULT_MESH_CONFIG, ...configProp }),
    [configProp],
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pickCanvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<GLResources | null>(null)
  const renderModeRef = useRef<RenderMode>('canvas2d')
  const animFrameRef = useRef<number>(0)
  const spatialIndexRef = useRef<SpatialIndex | null>(null)

  const screenSize = useMemo(() => {
    if (propWidth && propHeight) return { w: propWidth, h: propHeight }
    return { w: 800, h: 600 }
  }, [propWidth, propHeight])

  const [viewport, setViewport] = useState<Viewport>(() => ({
    x: 0, y: 0, zoom: 1, width: screenSize.w, height: screenSize.h,
  }))
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [effectiveRenderMode, setEffectiveRenderMode] = useState<RenderMode>('canvas2d')

  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const dragViewport = useRef({ x: 0, y: 0 })
  const lastPinchDist = useRef(0)

  // ---- Adaptive quality state ----
  const [qualityLevel, setQualityLevel] = useState(1)
  const frameTimesRef = useRef<number[]>([])

  // ---- Adaptive Quality Helper (defined before use in render) ----
  const getAdaptiveQualityNodes = useCallback(
    (allNodes: NodePosition[], quality: number): NodePosition[] => {
      if (quality >= 1) return allNodes
      const currentEdges = data.edges
      const sorted = [...allNodes].sort((a, b) => {
        const aScore =
          (a.label ? 30 : 0) +
          (a.r ? a.r * 2 : 0) +
          (currentEdges.filter((e) => e.source === a.id || e.target === a.id).length * 5)
        const bScore =
          (b.label ? 30 : 0) +
          (b.r ? b.r * 2 : 0) +
          (currentEdges.filter((e) => e.source === b.id || e.target === b.id).length * 5)
        return bScore - aScore
      })
      const count = Math.max(1, Math.floor(allNodes.length * quality))
      return sorted.slice(0, count)
    },
    [data.edges],
  )

  const layout = useMeshLayout(layoutConfig)

  const nodes = useMemo(
    () => (layout.nodes.length > 0 ? layout.nodes : data.nodes),
    [layout.nodes, data.nodes],
  )
  const edges = data.edges

  useEffect(() => {
    if (data.nodes.length > 0 && data.edges.length > 0 && cfg.physicsEnabled) {
      layout.runSimulation(data)
    }
  }, [data, cfg.physicsEnabled, layout])

  useEffect(() => {
    if (spatialIndexRef.current) {
      spatialIndexRef.current.rebuild(nodes)
    } else {
      spatialIndexRef.current = new SpatialIndex(nodes)
    }
  }, [nodes])

  const viewportRef = useRef(viewport)
  useEffect(() => { viewportRef.current = viewport }, [viewport])

  useEffect(() => {
    const canvas = canvasRef.current
    const pickCanvas = pickCanvasRef.current
    if (!canvas) return

    const w = screenSize.w
    const h = screenSize.h
    canvas.width = w * (window.devicePixelRatio || 1)
    canvas.height = h * (window.devicePixelRatio || 1)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    if (pickCanvas) {
      pickCanvas.width = w
      pickCanvas.height = h
      pickCanvas.style.width = `${w}px`
      pickCanvas.style.height = `${h}px`
    }

    const glCtx = initWebGL(canvas)
    if (glCtx) {
      glRef.current = glCtx
      renderModeRef.current = 'webgl2'
      onRenderModeChange?.('webgl2')
      requestAnimationFrame(() => setEffectiveRenderMode('webgl2'))
    } else {
      const ctx2d = canvas.getContext('2d')
      if (ctx2d) {
        ctx2d.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1)
        renderModeRef.current = 'canvas2d'
        onRenderModeChange?.('canvas2d')
        requestAnimationFrame(() => setEffectiveRenderMode('canvas2d'))
      }
    }

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [screenSize.w, screenSize.h, onRenderModeChange])

  const renderCallbackRef = useRef<() => void>(() => {})

  const render = useCallback(() => {
    const frameStart = performance.now()
    const canvas = canvasRef.current
    if (!canvas) return
    const currentViewport = viewportRef.current
    const si = spatialIndexRef.current
    const visibleNodes = si ? si.queryViewport(currentViewport) : nodes

    // Adaptive quality: reduce visible nodes when frame budget exceeded
    let renderNodes = visibleNodes
    if (cfg.adaptiveQualityEnabled) {
      renderNodes = getAdaptiveQualityNodes(visibleNodes, qualityLevel)
    }

    const lod = getLodLevel(currentViewport.zoom, cfg)

    const gl = glRef.current
    if (gl && renderModeRef.current === 'webgl2') {
      renderWebGL2(gl, renderNodes, edges, currentViewport, cfg, lod, false)
    } else {
      const ctx2d = canvas.getContext('2d')
      if (ctx2d) {
        ctx2d.setTransform(
          window.devicePixelRatio || 1,
          0, 0,
          window.devicePixelRatio || 1,
          0, 0,
        )
        renderCanvas2D(ctx2d, renderNodes, edges, currentViewport, cfg, lod, selectedNodeId)
      }
    }

    // Adaptive quality: track frame times and adjust quality
    if (cfg.adaptiveQualityEnabled) {
      const frameDuration = performance.now() - frameStart
      frameTimesRef.current.push(frameDuration)
      if (frameTimesRef.current.length > 30) frameTimesRef.current.shift()

      const avgFrameTime =
        frameTimesRef.current.reduce((s, t) => s + t, 0) /
        frameTimesRef.current.length
      if (avgFrameTime > cfg.adaptiveQualityThreshold) {
        setQualityLevel((prev) =>
          Math.max(0.25, prev - cfg.adaptiveQualityReduceFraction),
        )
      } else if (avgFrameTime < cfg.adaptiveQualityThreshold * 0.5 && qualityLevel < 1) {
        setQualityLevel((prev) =>
          Math.min(1, prev + cfg.adaptiveQualityReduceFraction),
        )
      }
    }

    animFrameRef.current = requestAnimationFrame(() => renderCallbackRef.current())
  }, [nodes, edges, cfg, selectedNodeId, qualityLevel, getAdaptiveQualityNodes])

  useEffect(() => { renderCallbackRef.current = render }, [render])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(() => renderCallbackRef.current())
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [render])

  const performPick = useCallback((clientX: number, clientY: number): PickResult => {
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect) return { nodeId: null, x: clientX, y: clientY }

    const x = clientX - rect.left
    const y = clientY - rect.top
    const currentViewport = viewportRef.current
    const si = spatialIndexRef.current
    const visibleNodes = si ? si.queryViewport(currentViewport) : nodes

    const gl = glRef.current
    if (gl && renderModeRef.current === 'webgl2') {
      const pickCanvas = pickCanvasRef.current
      if (!pickCanvas) return { nodeId: null, x: clientX, y: clientY }
      const pickGl = pickCanvas.getContext('webgl2', {
        antialias: false, alpha: false,
      })
      if (!pickGl) return { nodeId: null, x: clientX, y: clientY }

      const fakeGL = initWebGL(pickCanvas)
      if (!fakeGL) return { nodeId: null, x: clientX, y: clientY }

      const pickColors = new Float32Array(visibleNodes.length * 4)
      for (let i = 0; i < visibleNodes.length; i++) {
        const c = nodeIndexToPickColor(i + 1)
        pickColors[i * 4] = c[0]
        pickColors[i * 4 + 1] = c[1]
        pickColors[i * 4 + 2] = c[2]
        pickColors[i * 4 + 3] = c[3]
      }
      renderWebGL2(fakeGL, visibleNodes, [], currentViewport, cfg, 'full', true, pickColors)
      const pixels = new Uint8Array(4)
      fakeGL.gl.readPixels(x, pickCanvas.height - y, 1, 1, fakeGL.gl.RGBA, fakeGL.gl.UNSIGNED_BYTE, pixels)
      const idx = pickColorToNodeIndex(pixels[0], pixels[1], pixels[2])
      const glCanvas = fakeGL.gl.canvas
      if (glCanvas instanceof HTMLCanvasElement) {
        glCanvas.width = 0
      }

      if (idx > 0 && idx <= visibleNodes.length) {
        return { nodeId: visibleNodes[idx - 1].id, x, y }
      }
      return { nodeId: null, x, y }
    }

    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return { nodeId: null, x, y }

    const lod = getLodLevel(currentViewport.zoom, cfg)
    const worldX = (x - currentViewport.width / 2) / currentViewport.zoom - currentViewport.x
    const worldY = (y - currentViewport.height / 2) / currentViewport.zoom - currentViewport.y

    for (let i = visibleNodes.length - 1; i >= 0; i--) {
      const n = visibleNodes[i]
      const radius = lod === 'dots' ? cfg.lodDotRadius : (n.r ?? cfg.nodeRadius)
      const dx = worldX - n.x
      const dy = worldY - n.y
      if (dx * dx + dy * dy <= radius * radius * 4) {
        return { nodeId: n.id, x, y }
      }
    }
    return { nodeId: null, x, y }
  }, [nodes, cfg])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    setViewport((prev) => {
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9
      const newZoom = Math.max(0.05, Math.min(10, prev.zoom * zoomFactor))
      const worldX = (mx - prev.width / 2) / prev.zoom - prev.x
      const worldY = (my - prev.height / 2) / prev.zoom - prev.y
      const newX = (mx - prev.width / 2) / newZoom - worldX
      const newY = (my - prev.height / 2) / newZoom - worldY
      return { ...prev, zoom: newZoom, x: newX, y: newY }
    })
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true)
      isDraggingRef.current = true
      dragStart.current = { x: e.clientX, y: e.clientY }
      dragViewport.current = { x: viewportRef.current.x, y: viewportRef.current.y }
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      const dx = e.clientX - dragStart.current.x
      const dy = e.clientY - dragStart.current.y
      setViewport((prev) => ({
        ...prev,
        x: dragViewport.current.x + dx / prev.zoom,
        y: dragViewport.current.y + dy / prev.zoom,
      }))
      return
    }

    const result = performPick(e.clientX, e.clientY)
    onNodeHover?.(result.nodeId ? nodes.find((n) => n.id === result.nodeId) ?? null : null)
  }, [performPick, nodes, onNodeHover])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      setIsDragging(false)
      isDraggingRef.current = false
      const dx = Math.abs(e.clientX - dragStart.current.x)
      const dy = Math.abs(e.clientY - dragStart.current.y)
      if (dx < 5 && dy < 5) {
        const result = performPick(e.clientX, e.clientY)
        setSelectedNodeId(result.nodeId)
        onNodeClick?.(result.nodeId ? nodes.find((n) => n.id === result.nodeId) ?? null : null)
      }
    }
  }, [performPick, nodes, onNodeClick])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setIsDragging(true)
      isDraggingRef.current = true
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      dragViewport.current = { x: viewportRef.current.x, y: viewportRef.current.y }
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      lastPinchDist.current = Math.sqrt(dx * dx + dy * dy)
    }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    if (e.touches.length === 1 && isDraggingRef.current) {
      const dx = e.touches[0].clientX - dragStart.current.x
      const dy = e.touches[0].clientY - dragStart.current.y
      setViewport((prev) => ({
        ...prev,
        x: dragViewport.current.x + dx / prev.zoom,
        y: dragViewport.current.y + dy / prev.zoom,
      }))
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (lastPinchDist.current > 0) {
        const factor = dist / lastPinchDist.current
        setViewport((prev) => ({
          ...prev,
          zoom: Math.max(0.05, Math.min(10, prev.zoom * factor)),
        }))
      }
      lastPinchDist.current = dist
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false)
    isDraggingRef.current = false
    lastPinchDist.current = 0
  }, [])

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden ${className}`}
      style={{
        width: screenSize.w,
        height: screenSize.h,
        background: cfg.colorBackground,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
    >
      <canvas
        ref={canvasRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          setIsDragging(false)
          isDraggingRef.current = false
          onNodeHover?.(null)
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ display: 'block', touchAction: 'none' }}
      />
      <canvas ref={pickCanvasRef} style={{ display: 'none' }} />
      {effectiveRenderMode === 'canvas2d' && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/50 px-2 py-1 text-xs text-white">
          2D Canvas
        </div>
      )}
      {effectiveRenderMode === 'webgl2' && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/50 px-2 py-1 text-xs text-white">
          WebGL2
        </div>
      )}
      {layout.isRunning && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/50 px-2 py-1 text-xs text-white">
          Layout: {Math.round(layout.progress * 100)}%
        </div>
      )}
      <div className="pointer-events-none absolute left-2 top-2 text-xs text-gray-500">
        Nodes: {nodes.length} | Edges: {edges.length} | Zoom: {viewport.zoom.toFixed(2)}
      </div>
    </div>
  )
}
