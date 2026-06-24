'use client'

import { useEffect, useMemo, useState } from 'react'

export interface ActivityLogEvent {
  id: string
  timestamp: string
  nodeId: string
  level: 'info' | 'warning' | 'error'
  message: string
}

function createMockEvent(index: number): ActivityLogEvent {
  const level = index % 19 === 0 ? 'error' : index % 7 === 0 ? 'warning' : 'info'
  return {
    id: `activity-${index}`,
    timestamp: new Date(Date.now() - index * 60_000).toISOString(),
    nodeId: `node-${(index % 50) + 1}`,
    level,
    message: level === 'error'
      ? `Node ${(index % 50) + 1} reported a multiline synchronization error while reconciling the latest ledger checkpoint. Retry ${index}.`
      : `Node ${(index % 50) + 1} ${level === 'warning' ? 'latency warning' : 'heartbeat accepted'} at checkpoint ${index}.`,
  }
}

export function createActivityLogEvents(count: number): ActivityLogEvent[] {
  return Array.from({ length: count }, (_, index) => createMockEvent(index))
}

export function useActivityLogSubscription(seedCount = 750) {
  const initialEvents = useMemo(() => createActivityLogEvents(seedCount), [seedCount])
  const [events, setEvents] = useState<ActivityLogEvent[]>(initialEvents)

  useEffect(() => {
    setEvents(initialEvents)
  }, [initialEvents])

  return { events, prependEvent: (event: ActivityLogEvent) => setEvents((current) => [event, ...current]) }
}
