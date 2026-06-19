'use client'

import { useMemo } from 'react'
import { sanitizeNodeString, detectDangerPatterns } from '@/src/utils/sanitizer'
import type { NodePosition } from '@/src/types/network'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fields extracted from NodePosition.metadata for display in the card.
 * All values are optional — the card gracefully handles missing data.
 */
export interface NodeCardMetadata {
  description?: string
  location?: string
  ownerName?: string
  firmwareVersion?: string
  hardwareModel?: string
  ipAddress?: string
  uptime?: string
}

export interface NodeCardProps {
  node: NodePosition
  /** Whether the node is currently selected in the topology view */
  isSelected?: boolean
  /** Called when the user clicks the card (e.g. to focus the node in the map) */
  onClick?: (node: NodePosition) => void
  /** Called when the user dismisses / closes the card */
  onDismiss?: (nodeId: string) => void
  className?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a safe string value from NodePosition.metadata.
 * Returns undefined if the key is not present or the value is not a string.
 */
function metadataString(
  node: NodePosition,
  key: string,
): string | undefined {
  const value = node.metadata?.[key]
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

/**
 * Build a display-ready metadata object with all values sanitized.
 * Runs danger-pattern detection on every raw metadata string (defence-in-depth).
 */
function buildCardMetadata(node: NodePosition): NodeCardMetadata {
  const keys = [
    'description',
    'location',
    'ownerName',
    'firmwareVersion',
    'hardwareModel',
    'ipAddress',
    'uptime',
  ] as const

  const raw: Partial<Record<(typeof keys)[number], string>> = {}
  for (const key of keys) {
    raw[key] = metadataString(node, key)
  }

  // Run danger-pattern detection on all raw values
  for (const key of keys) {
    if (raw[key]) detectDangerPatterns(raw[key]!)
  }

  return {
    description: raw.description ? sanitizeNodeString(raw.description) : undefined,
    location: raw.location ? sanitizeNodeString(raw.location) : undefined,
    ownerName: raw.ownerName ? sanitizeNodeString(raw.ownerName) : undefined,
    firmwareVersion: raw.firmwareVersion ? sanitizeNodeString(raw.firmwareVersion) : undefined,
    hardwareModel: raw.hardwareModel ? sanitizeNodeString(raw.hardwareModel) : undefined,
    ipAddress: raw.ipAddress ? sanitizeNodeString(raw.ipAddress) : undefined,
    uptime: raw.uptime ? sanitizeNodeString(raw.uptime) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-[0.08em] text-[#6f5f48]">
        {label}
      </dt>
      <dd
        className="text-right text-xs text-[#171512]"
        // sanitized value is safe to render as HTML for allowed tags like <b>, <i>, <a>
        dangerouslySetInnerHTML={{ __html: value }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// NodeCard
// ---------------------------------------------------------------------------

/**
 * NodeCard displays detailed information about a single network node.
 *
 * All text fields originating from on-chain data are sanitized via
 * `sanitizeNodeString` before rendering to prevent XSS attacks from
 * malicious node labels, descriptions, or metadata.
 */
export function NodeCard({
  node,
  isSelected = false,
  onClick,
  onDismiss,
  className = '',
}: NodeCardProps) {
  const metadata = useMemo(() => buildCardMetadata(node), [node]);
  const safeLabel = useMemo(() => sanitizeNodeString(node.label ?? node.id), [node.label, node.id]);

  // Run danger-pattern detection on raw label (on-chain data)
  if (node.label) detectDangerPatterns(node.label)

  const hasMetadata = Object.values(metadata).some((v) => v !== undefined)

  return (
    <article
      data-testid="node-card"
      data-node-id={node.id}
      className={`rounded-lg border bg-white shadow-sm transition ${
        isSelected
          ? 'border-[#0f766e] ring-1 ring-[#0f766e]/20'
          : 'border-[#d8d0c1] hover:border-[#cfc4b1]'
      } ${className}`}
      onClick={() => onClick?.(node)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.(node)
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Node: ${node.label ?? node.id}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-[#ece5d8] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* Node color indicator */}
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-full"
              style={{
                backgroundColor: node.color ?? '#0f766e',
              }}
              aria-hidden="true"
            />
            <h3
              className="truncate text-sm font-semibold text-[#171512]"
              // Safe HTML rendering for allowed tags (b, i, a)
              dangerouslySetInnerHTML={{ __html: safeLabel }}
            />
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-[#9b8a6f]">
            {node.id}
          </p>
        </div>

        {onDismiss && (
          <button
            type="button"
            className="shrink-0 rounded p-1 text-[#9b8a6f] transition hover:bg-[#f7f4ee] hover:text-[#171512]"
            onClick={(e) => {
              e.stopPropagation()
              onDismiss(node.id)
            }}
            aria-label={`Close card for node ${node.id}`}
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
            </svg>
          </button>
        )}
      </div>

      {/* Metadata fields */}
      {hasMetadata ? (
        <dl className="divide-y divide-[#f7f4ee] px-4 py-2">
          {metadata.description && (
            <MetadataRow label="Description" value={metadata.description} />
          )}
          {metadata.location && (
            <MetadataRow label="Location" value={metadata.location} />
          )}
          {metadata.ownerName && (
            <MetadataRow label="Owner" value={metadata.ownerName} />
          )}
          {metadata.firmwareVersion && (
            <MetadataRow label="Firmware" value={metadata.firmwareVersion} />
          )}
          {metadata.hardwareModel && (
            <MetadataRow label="Hardware" value={metadata.hardwareModel} />
          )}
          {metadata.ipAddress && (
            <MetadataRow label="IP" value={metadata.ipAddress} />
          )}
          {metadata.uptime && (
            <MetadataRow label="Uptime" value={metadata.uptime} />
          )}
        </dl>
      ) : (
        <div className="px-4 py-3 text-center text-xs text-[#9b8a6f]">
          No additional metadata available.
        </div>
      )}

      {/* Coordinates (non-sensitive, always display) */}
      <div className="border-t border-[#ece5d8] px-4 py-2">
        <div className="flex gap-4 text-[10px] text-[#9b8a6f]">
          <span>x: {node.x.toFixed(0)}</span>
          <span>y: {node.y.toFixed(0)}</span>
          {node.z != null && <span>z: {node.z.toFixed(1)}</span>}
          {node.r != null && <span>r: {node.r.toFixed(1)}</span>}
        </div>
      </div>
    </article>
  )
}
