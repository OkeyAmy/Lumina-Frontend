'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { computeAggregation } from '@/src/lib/aggregators'
import type {
  AnalyticsDataPoint,
  AggregatedResult,
  AggregationConfig,
  AnalyticsWorkerMessage,
} from '@/src/types/network'

interface PendingRequest {
  resolve: (result: AggregatedResult) => void
  reject: (err: unknown) => void
}

export function useNetworkAnalytics() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map())
  const [workerAvailable, setWorkerAvailable] = useState<boolean | null>(null)
  const corrIdCounter = useRef(0)

  const getWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current

    try {
      const w = new Worker(
        new URL('@/src/workers/analyticsProcessor.worker', import.meta.url),
        { type: 'module' },
      )

      w.onmessage = (e: MessageEvent<AnalyticsWorkerMessage>) => {
        if (e.data.type === 'result') {
          const { result, correlationId } = e.data.payload
          const pending = pendingRef.current.get(correlationId)
          if (pending) {
            pending.resolve(result)
            pendingRef.current.delete(correlationId)
          }
        }
      }

      w.onerror = (err) => {
        const entries = [...pendingRef.current.entries()]
        pendingRef.current.clear()
        for (const [, pending] of entries) {
          pending.reject(err)
        }
      }

      workerRef.current = w
      setWorkerAvailable(true)
      return w
    } catch {
      setWorkerAvailable(false)
      return null
    }
  }, [])

  const aggregate = useCallback(
    async (
      data: AnalyticsDataPoint[],
      config: AggregationConfig,
    ): Promise<AggregatedResult> => {
      const worker = getWorker()

      if (!worker) {
        return computeAggregation(data, config)
      }

      return new Promise<AggregatedResult>((resolve, reject) => {
        const correlationId = `${Date.now()}-${corrIdCounter.current++}`
        pendingRef.current.set(correlationId, { resolve, reject })

        const transferable = new ArrayBuffer(data.length * 32)
        worker.postMessage(
          {
            type: 'aggregate',
            payload: { data, config, correlationId },
          } satisfies AnalyticsWorkerMessage,
          [transferable],
        )
      })
    },
    [getWorker],
  )

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
      pendingRef.current.clear()
    }
  }, [])

  return { aggregate, workerAvailable }
}
