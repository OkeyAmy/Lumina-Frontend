import type {
  AnalyticsDataPoint,
  AggregatedResult,
  AggregationConfig,
  RollupBucket,
} from '@/src/types/network'

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const k = (p / 100) * (sorted.length - 1)
  const i = Math.floor(k)
  const f = k - i
  if (i + 1 < sorted.length) {
    return sorted[i] + f * (sorted[i + 1] - sorted[i])
  }
  return sorted[sorted.length - 1]
}

export function computeAggregation(
  data: AnalyticsDataPoint[],
  config: AggregationConfig,
): AggregatedResult {
  const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp)

  const bucketSizeMs =
    config.granularity === 'hourly'
      ? 3_600_000
      : config.granularity === 'daily'
        ? 86_400_000
        : 604_800_000

  const buckets: RollupBucket[] = []
  let bucketStart = config.startTime

  while (bucketStart < config.endTime) {
    const bucketEnd = Math.min(bucketStart + bucketSizeMs, config.endTime)
    const points = sorted.filter(
      (p) => p.timestamp >= bucketStart && p.timestamp < bucketEnd,
    )

    if (points.length > 0) {
      const latencies = points.map((p) => p.latency).sort((a, b) => a - b)
      const throughputs = points.map((p) => p.throughput)
      const packetLosses = points.map((p) => p.packetLoss)

      const sumLat = latencies.reduce((a, b) => a + b, 0)
      const sumThr = throughputs.reduce((a, b) => a + b, 0)
      const sumPl = packetLosses.reduce((a, b) => a + b, 0)

      buckets.push({
        bucketStart,
        bucketEnd,
        count: points.length,
        avgLatency: sumLat / points.length,
        p50Latency: percentile(latencies, 50),
        p95Latency: percentile(latencies, 95),
        p99Latency: percentile(latencies, 99),
        avgThroughput: sumThr / points.length,
        avgPacketLoss: sumPl / points.length,
        minLatency: latencies[0],
        maxLatency: latencies[latencies.length - 1],
      })
    }

    bucketStart = bucketEnd
  }

  const allLatencies = sorted.map((p) => p.latency).sort((a, b) => a - b)
  const allThroughputs = sorted.map((p) => p.throughput)
  const allPacketLosses = sorted.map((p) => p.packetLoss)

  const sumAllLat = allLatencies.reduce((a, b) => a + b, 0)
  const sumAllThr = allThroughputs.reduce((a, b) => a + b, 0)
  const sumAllPl = allPacketLosses.reduce((a, b) => a + b, 0)

  return {
    buckets,
    overall: {
      totalDataPoints: sorted.length,
      avgLatency: sorted.length > 0 ? sumAllLat / sorted.length : 0,
      p50Latency: percentile(allLatencies, 50),
      p95Latency: percentile(allLatencies, 95),
      p99Latency: percentile(allLatencies, 99),
      avgThroughput: sorted.length > 0 ? sumAllThr / sorted.length : 0,
      avgPacketLoss: sorted.length > 0 ? sumAllPl / sorted.length : 0,
      minLatency: allLatencies.length > 0 ? allLatencies[0] : 0,
      maxLatency: allLatencies.length > 0 ? allLatencies[allLatencies.length - 1] : 0,
    },
  }
}
