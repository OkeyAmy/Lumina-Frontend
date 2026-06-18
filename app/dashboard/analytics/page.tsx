'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnalyticsTimeSeries } from '@/src/components/charts/AnalyticsTimeSeries'
import { useNetworkAnalytics } from '@/src/hooks/useNetworkAnalytics'
import type { AnalyticsDataPoint, AggregatedResult, RollupGranularity } from '@/src/types/network'

function generateMockData(): AnalyticsDataPoint[] {
  const now = Date.now()
  const points: AnalyticsDataPoint[] = []
  for (let i = 0; i < 500_000; i++) {
    const timestamp = now - i * 60_000
    points.push({
      timestamp,
      latency: Math.random() * 200 + 10,
      throughput: Math.random() * 1000 + 100,
      packetLoss: Math.random() * 0.05,
    })
  }
  return points
}

export default function AnalyticsPage() {
  const { aggregate, workerAvailable } = useNetworkAnalytics()
  const [result, setResult] = useState<AggregatedResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [granularity, setGranularity] = useState<RollupGranularity>('hourly')

  const runAggregation = useCallback(async () => {
    setLoading(true)
    try {
      const now = Date.now()
      const data = generateMockData()
      const config = {
        granularity,
        startTime: now - 365 * 86_400_000,
        endTime: now,
      }
      const res = await aggregate(data, config)
      setResult(res)
    } finally {
      setLoading(false)
    }
  }, [aggregate, granularity])

  useEffect(() => {
    runAggregation()
  }, [runAggregation])

  return (
    <main className="min-h-screen bg-[#f7f4ee] text-[#171512]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-[#d8d0c1] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[#6f5f48]">
              Network Analytics
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-[#171512] sm:text-4xl">
              Year-long connection performance
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {workerAvailable === true && (
              <span className="rounded-md bg-[#eef7f2] px-2.5 py-1 text-xs font-semibold text-[#0f766e]">
                Worker active
              </span>
            )}
            {workerAvailable === false && (
              <span className="rounded-md bg-[#fef3e2] px-2.5 py-1 text-xs font-semibold text-[#9a3412]">
                Main thread fallback
              </span>
            )}
          </div>
        </header>

        <div className="flex flex-wrap gap-3 py-5">
          {(['hourly', 'daily', 'weekly'] as const).map((g) => (
            <button
              key={g}
              className={`rounded-md border px-4 py-2 text-sm font-semibold transition ${
                granularity === g
                  ? 'border-[#0f766e] bg-[#0f766e] text-white'
                  : 'border-[#cfc4b1] bg-white text-[#3e3830] hover:border-[#0f766e] hover:text-[#0f766e]'
              }`}
              onClick={() => setGranularity(g)}
              type="button"
            >
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </button>
          ))}
          <button
            className="ml-auto rounded-md bg-[#0f766e] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#115e59] disabled:opacity-50"
            disabled={loading}
            onClick={runAggregation}
            type="button"
          >
            {loading ? 'Computing…' : 'Recompute'}
          </button>
        </div>

        <AnalyticsTimeSeries data={result} loading={loading} />
      </div>
    </main>
  )
}
