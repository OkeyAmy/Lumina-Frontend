import { computeAggregation } from '@/src/lib/aggregators'
import type { AnalyticsWorkerMessage } from '@/src/types/network'

self.onmessage = (e: MessageEvent<AnalyticsWorkerMessage>) => {
  const msg = e.data

  if (msg.type === 'aggregate') {
    const { data, config, correlationId } = msg.payload
    const result = computeAggregation(data, config)

    const response: AnalyticsWorkerMessage = {
      type: 'result',
      payload: { result, correlationId },
    }

    self.postMessage(response)
  }
}
