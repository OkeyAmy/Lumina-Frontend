import { computeAggregation } from '../aggregators'
import type { AnalyticsDataPoint, AggregationConfig } from '@/src/types/network'

interface FailedTest {
  name: string
  reason: string
}

const failures: FailedTest[] = []

function assert<T>(name: string, expected: T, actual: T) {
  const eq =
    JSON.stringify(expected) === JSON.stringify(actual) ||
    (expected === (actual as unknown))
  if (!eq) {
    failures.push({
      name,
      reason: `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    })
    console.error(`  ✗ ${name}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}

function assertApprox(name: string, expected: number, actual: number, tolerance = 0.01) {
  const diff = Math.abs(expected - actual)
  if (diff > tolerance) {
    failures.push({
      name,
      reason: `expected ~${expected} but got ${actual} (diff ${diff})`,
    })
    console.error(`  ✗ ${name}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}

function run() {
  console.log('aggregators: empty data')
  {
    const config: AggregationConfig = {
      granularity: 'hourly',
      startTime: 0,
      endTime: 3_600_000,
    }
    const result = computeAggregation([], config)
    assert('buckets is empty', 0, result.buckets.length)
    assert('overall total 0', 0, result.overall.totalDataPoints)
  }

  console.log('aggregators: single bucket')
  {
    const now = 1_000_000
    const data: AnalyticsDataPoint[] = [
      { timestamp: now, latency: 50, throughput: 500, packetLoss: 0.01 },
      { timestamp: now + 1000, latency: 100, throughput: 600, packetLoss: 0.02 },
      { timestamp: now + 2000, latency: 75, throughput: 550, packetLoss: 0.015 },
    ]
    const config: AggregationConfig = {
      granularity: 'hourly',
      startTime: now,
      endTime: now + 3_600_000,
    }
    const result = computeAggregation(data, config)
    assert('1 bucket', 1, result.buckets.length)
    assertApprox('avg latency', 75, result.overall.avgLatency, 0.01)
    assertApprox('avg throughput', 550, result.overall.avgThroughput, 0.01)
    assertApprox('avg packet loss', 0.015, result.overall.avgPacketLoss, 0.0001)
    assertApprox('p50 latency', 75, result.overall.p50Latency, 0.01)
    assert('min latency', 50, result.overall.minLatency)
    assert('max latency', 100, result.overall.maxLatency)
  }

  console.log('aggregators: multiple buckets')
  {
    const base = 1_000_000
    const data: AnalyticsDataPoint[] = []
    const hourMs = 3_600_000
    for (let h = 0; h < 3; h++) {
      for (let m = 0; m < 60; m++) {
        data.push({
          timestamp: base + h * hourMs + m * 60_000,
          latency: 50 + h * 25 + Math.random() * 10,
          throughput: 400 + h * 100,
          packetLoss: 0.01 + h * 0.005,
        })
      }
    }
    const config: AggregationConfig = {
      granularity: 'hourly',
      startTime: base,
      endTime: base + 3 * hourMs,
    }
    const result = computeAggregation(data, config)
    assert('3 buckets', 3, result.buckets.length)
    assert('total data points', 180, result.overall.totalDataPoints)
  }

  console.log('aggregators: daily granularity')
  {
    const base = 1_000_000
    const data: AnalyticsDataPoint[] = [
      { timestamp: base, latency: 10, throughput: 100, packetLoss: 0 },
      { timestamp: base + 86_400_000, latency: 20, throughput: 200, packetLoss: 0.01 },
      { timestamp: base + 2 * 86_400_000, latency: 30, throughput: 300, packetLoss: 0.02 },
    ]
    const config: AggregationConfig = {
      granularity: 'daily',
      startTime: base,
      endTime: base + 3 * 86_400_000,
    }
    const result = computeAggregation(data, config)
    assert('3 daily buckets', 3, result.buckets.length)
    assertApprox('overall avg latency', 20, result.overall.avgLatency, 0.01)
  }

  console.log('aggregators: weekly granularity')
  {
    const base = 1_000_000
    const data: AnalyticsDataPoint[] = [
      { timestamp: base, latency: 100, throughput: 1000, packetLoss: 0 },
      { timestamp: base + 604_800_000, latency: 200, throughput: 2000, packetLoss: 0.01 },
    ]
    const config: AggregationConfig = {
      granularity: 'weekly',
      startTime: base,
      endTime: base + 2 * 604_800_000,
    }
    const result = computeAggregation(data, config)
    assert('2 weekly buckets', 2, result.buckets.length)
  }

  console.log('aggregators: percentile calculation')
  {
    const data: AnalyticsDataPoint[] = []
    for (let i = 1; i <= 100; i++) {
      data.push({ timestamp: i * 1000, latency: i, throughput: 500, packetLoss: 0 })
    }
    const config: AggregationConfig = {
      granularity: 'hourly',
      startTime: 1000,
      endTime: 101 * 1000,
    }
    const result = computeAggregation(data, config)
    assertApprox('p50 ~50.5', 50.5, result.overall.p50Latency, 1)
    assertApprox('p95 ~95.5', 95.5, result.overall.p95Latency, 1)
    assertApprox('p99 ~99.5', 99.5, result.overall.p99Latency, 1)
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} test failure(s):`)
    for (const f of failures) console.error(` - ${f.name}: ${f.reason}`)
    process.exit(1)
  }
  console.log('\nAll aggregators assertions passed.')
}

try {
  run()
} catch (err) {
  console.error(err)
  process.exit(1)
}

export {}
