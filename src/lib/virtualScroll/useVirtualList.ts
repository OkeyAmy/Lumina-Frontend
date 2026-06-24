'use client'

import { RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

interface UseVirtualListOptions {
  totalCount: number
  estimatedRowHeight: number
  overscanScreens?: number
  maxRenderedItems?: number
  preserveKey?: string
}

interface VirtualItem {
  index: number
  offsetTop: number
  height: number
}

interface VirtualRange {
  start: number
  end: number
  paddingTop: number
  paddingBottom: number
  totalHeight: number
  virtualItems: VirtualItem[]
}

const savedScrollPositions = new Map<string, number>()

export function useVirtualList<T>(
  items: readonly T[],
  {
    totalCount,
    estimatedRowHeight,
    overscanScreens = 3,
    maxRenderedItems = 100,
    preserveKey,
  }: UseVirtualListOptions,
): VirtualRange & {
  containerRef: RefObject<HTMLDivElement | null>
  topSentinelRef: RefObject<HTMLDivElement | null>
  bottomSentinelRef: RefObject<HTMLDivElement | null>
  visibleItems: readonly T[]
  measureElement: (index: number, element: HTMLElement | null) => void
} {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const topSentinelRef = useRef<HTMLDivElement | null>(null)
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null)
  const heightsRef = useRef(new Map<number, number>())
  const [scrollState, setScrollState] = useState({ scrollTop: 0, viewportHeight: 0 })

  const getHeight = useCallback(
    (index: number) => heightsRef.current.get(index) ?? estimatedRowHeight,
    [estimatedRowHeight],
  )

  const getOffsetTop = useCallback(
    (index: number) => {
      let offset = 0
      for (let i = 0; i < index; i += 1) offset += getHeight(i)
      return offset
    },
    [getHeight],
  )

  const totalHeight = useMemo(() => {
    let measuredDelta = 0
    heightsRef.current.forEach((height) => {
      measuredDelta += height - estimatedRowHeight
    })
    return Math.max(0, totalCount * estimatedRowHeight + measuredDelta)
  }, [estimatedRowHeight, totalCount, scrollState])

  const range = useMemo(() => {
    const { scrollTop, viewportHeight } = scrollState
    const overscanPixels = viewportHeight * overscanScreens
    const requestedStart = Math.max(0, Math.floor((scrollTop - overscanPixels) / estimatedRowHeight))
    const requestedEnd = Math.min(
      totalCount,
      Math.ceil((scrollTop + viewportHeight + overscanPixels) / estimatedRowHeight),
    )
    const visibleCenter = Math.max(0, Math.floor((scrollTop + viewportHeight / 2) / estimatedRowHeight))
    const requestedCount = Math.max(1, requestedEnd - requestedStart)
    const cappedCount = Math.min(maxRenderedItems, requestedCount, totalCount)
    const start = requestedCount > maxRenderedItems
      ? Math.max(0, Math.min(totalCount - cappedCount, visibleCenter - Math.floor(cappedCount / 2)))
      : requestedStart
    const end = Math.min(totalCount, start + cappedCount)
    const paddingTop = getOffsetTop(start)
    const virtualItems = Array.from({ length: end - start }, (_, position) => {
      const index = start + position
      return { index, offsetTop: getOffsetTop(index), height: getHeight(index) }
    })
    const renderedHeight = virtualItems.reduce((sum, item) => sum + item.height, 0)

    return {
      start,
      end,
      paddingTop,
      paddingBottom: Math.max(0, totalHeight - paddingTop - renderedHeight),
      totalHeight,
      virtualItems,
    }
  }, [estimatedRowHeight, getHeight, getOffsetTop, maxRenderedItems, overscanScreens, scrollState, totalCount, totalHeight])

  const updateScrollState = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const next = { scrollTop: container.scrollTop, viewportHeight: container.clientHeight }
    if (preserveKey) savedScrollPositions.set(preserveKey, next.scrollTop)
    setScrollState((previous) => (
      previous.scrollTop === next.scrollTop && previous.viewportHeight === next.viewportHeight ? previous : next
    ))
  }, [preserveKey])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (preserveKey) container.scrollTop = savedScrollPositions.get(preserveKey) ?? container.scrollTop
    updateScrollState()
  }, [preserveKey, updateScrollState])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new IntersectionObserver(updateScrollState, { root: container })
    if (topSentinelRef.current) observer.observe(topSentinelRef.current)
    if (bottomSentinelRef.current) observer.observe(bottomSentinelRef.current)
    container.addEventListener('scroll', updateScrollState, { passive: true })
    const resizeObserver = new ResizeObserver(updateScrollState)
    resizeObserver.observe(container)
    return () => {
      container.removeEventListener('scroll', updateScrollState)
      observer.disconnect()
      resizeObserver.disconnect()
    }
  }, [updateScrollState])

  const measureElement = useCallback((index: number, element: HTMLElement | null) => {
    if (!element) return
    const nextHeight = element.getBoundingClientRect().height
    if (nextHeight > 0 && heightsRef.current.get(index) !== nextHeight) {
      heightsRef.current.set(index, nextHeight)
      updateScrollState()
    }
  }, [updateScrollState])

  return {
    ...range,
    containerRef,
    topSentinelRef,
    bottomSentinelRef,
    visibleItems: items.slice(range.start, range.end),
    measureElement,
  }
}
