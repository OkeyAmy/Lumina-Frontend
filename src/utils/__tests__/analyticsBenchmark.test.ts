import { computeAggregation } from '../../lib/aggregators'
import type { AnalyticsDataPoint } from '@/src/types/network'

function generateData(size: number): AnalyticsDataPoint[] {
  const now = Date.now()
  const points: AnalyticsDataPoint[] = []
  for (let i = 0; i < size; i++) {
    points.push({
      timestamp: now - i * 60_000,
      latency: Math.random() * 200 + 10,
      throughput: Math.random() * 1000 + 100,
      packetLoss: Math.random() * 0.05,
    })
  }
  return points
}

function measure<T>(label: string, fn: () => T): T {
  const start = performance.now()
  const result = fn()
  const elapsed = (performance.now() - start).toFixed(2)
  console.log(`  ${label}: ${elapsed}ms`)
  return result
}

const sizes = [1_000, 10_000, 100_000, 500_000]

console.log('=== Analytics Aggregation Benchmark ===')
console.log()

for (const size of sizes) {
  console.log(`Data size: ${size.toLocaleString()} points`)

  const data = measure('  generate', () => generateData(size))
  const config = {
    granularity: 'hourly' as const,
    startTime: Date.now() - 365 * 86_400_000,
    endTime: Date.now(),
  }

  measure('  aggregate (hourly)', () => computeAggregation(data, config))
  console.log()
}

console.log('Benchmark complete.')
