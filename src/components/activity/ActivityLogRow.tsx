import { memo } from 'react'
import type { ActivityLogEvent } from '@/src/hooks/useActivityLogSubscription'

interface ActivityLogRowProps {
  event: ActivityLogEvent
  index: number
  measureElement: (index: number, element: HTMLElement | null) => void
}

export const ActivityLogRow = memo(function ActivityLogRow({ event, index, measureElement }: ActivityLogRowProps) {
  return (
    <li
      ref={(element) => measureElement(index, element)}
      className="grid grid-cols-[5.5rem_5rem_1fr] gap-3 border-b border-[#ece5d8] px-3 py-1 text-xs leading-5 text-[#3e3830]"
      data-testid="activity-log-row"
    >
      <time className="font-mono text-[#6f5f48]" dateTime={event.timestamp}>
        {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
      <span className="font-semibold text-[#171512]">{event.nodeId}</span>
      <span className={event.level === 'error' ? 'text-[#9a3412]' : event.level === 'warning' ? 'text-[#d97706]' : ''}>
        {event.message}
      </span>
    </li>
  )
})
