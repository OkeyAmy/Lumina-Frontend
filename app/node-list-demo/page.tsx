/**
 * Node List Demo Page
 *
 * Demonstrates the NodeCard and NodeList components with XSS-safe
 * rendering of on-chain node data. Includes mock nodes with a
 * variety of metadata fields.
 */

'use client'

import { useMemo } from 'react'
import { NodeList } from '@/src/components/network/NodeList'
import { NodeCard } from '@/src/components/network/NodeCard'
import type { NodePosition } from '@/src/types/network'

// ---------------------------------------------------------------------------
// Mock node data simulating on-chain Soroban contract queries
// ---------------------------------------------------------------------------

const MOCK_NODES: NodePosition[] = [
  {
    id: 'node-001-nyc-edge',
    x: 120,
    y: 80,
    label: 'NYC Edge Router',
    color: '#0f766e',
    metadata: {
      description: 'Primary edge router for NYC metro area',
      location: 'New York, US',
      ownerName: 'Alice Johnson',
      firmwareVersion: 'v2.4.1',
      hardwareModel: 'Lumina LR-200',
      ipAddress: '10.0.1.1',
      uptime: '142d 7h',
    },
  },
  {
    id: 'node-002-sfo-edge',
    x: 45,
    y: 120,
    label: '<b>SFO</b> Edge Router',
    color: '#0d9488',
    metadata: {
      description: 'West coast relay node for <i>Pacific</i> traffic',
      location: 'San Francisco, US',
      ownerName: 'Bob Chen',
      firmwareVersion: 'v2.3.8',
      hardwareModel: 'Lumina LR-150',
      ipAddress: '10.0.2.1',
      uptime: '89d 3h',
    },
  },
  {
    id: 'node-003-lon-edge',
    x: 210,
    y: 60,
    label: 'London Edge Router',
    color: '#0f766e',
    metadata: {
      description: 'European gateway node',
      location: 'London, UK',
      ownerName: 'Charlie Patel',
      firmwareVersion: 'v2.4.1',
      hardwareModel: 'Lumina LR-200',
      uptime: '201d 12h',
    },
  },
  {
    id: 'node-004-tky-relay',
    x: 350,
    y: 100,
    label: '<b>Tokyo</b> Relay',
    color: '#ca8a04',
    metadata: {
      description: 'Asian-Pacific relay for cross-region traffic',
      location: 'Tokyo, JP',
      ownerName: 'Diana Tanaka',
      firmwareVersion: 'v2.4.0',
      hardwareModel: 'Lumina LR-300',
      ipAddress: '10.0.4.1',
      uptime: '56d 18h',
    },
  },
  {
    id: 'node-005-syd-edge',
    x: 380,
    y: 200,
    label: 'Sydney Edge',
    color: '#0f766e',
    metadata: {
      location: 'Sydney, AU',
      ownerName: 'Eve Wilson',
      hardwareModel: 'Lumina LR-150',
    },
  },
  {
    id: 'node-006-fra-core',
    x: 200,
    y: 45,
    label: 'Frankfurt Core',
    color: '#7c3aed',
    metadata: {
      description: '<b>Core</b> routing node for central Europe',
      location: 'Frankfurt, DE',
      ownerName: 'Frank Müller',
      firmwareVersion: 'v2.5.0-beta1',
      hardwareModel: 'Lumina LR-500',
      ipAddress: '10.0.6.1',
      uptime: '320d 1h',
    },
  },
  {
    id: 'node-007-minimal',
    x: 250,
    y: 150,
    label: 'Minimal Node',
    color: '#94a3b8',
    metadata: {},
  },
]

export default function NodeListDemoPage() {
  const nodes = useMemo(() => MOCK_NODES, [])

  return (
    <div className="min-h-screen bg-[#f7f4ee] p-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-[#1a1410]">
            Node List Demo
          </h1>
          <p className="mt-2 text-[#6f5f48]">
            Demonstrates XSS-safe rendering of on-chain node data via{' '}
            <code className="rounded bg-[#ece5d8] px-1 py-0.5 text-xs">
              sanitizeNodeString
            </code>
            . Node labels use DOMPurify with a restrictive allowlist
            (<b>b</b>, <i>i</i>, <a>a</a>).
          </p>
        </div>

        {/* Single NodeCard showcase */}
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold text-[#1a1410]">
            Single NodeCard
          </h2>
          <div className="max-w-md">
            <NodeCard
              node={nodes[0]}
              onClick={(n) => console.log('Clicked:', n.id)}
            />
          </div>
        </div>

        {/* NodeList with search and sort */}
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold text-[#1a1410]">
            NodeList (Searchable)
          </h2>
          <NodeList
            nodes={nodes}
            onNodeClick={(n) => console.log('Clicked:', n.id)}
          />
        </div>

        {/* Security info */}
        <div className="rounded-lg border border-[#d8d0c1] bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-[#1a1410]">
            XSS Protection Details
          </h2>
          <ul className="space-y-2 text-sm text-[#6f5f48]">
            <li className="flex items-start gap-2">
              <span className="mt-1 text-[#0f766e]">&#10003;</span>
              <span>
                <strong>DOMPurify</strong> with isomorphic-dompurify for SSR
                compatibility
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 text-[#0f766e]">&#10003;</span>
              <span>
                Only <code className="rounded bg-[#ece5d8] px-1 text-xs">&lt;b&gt;</code>,{' '}
                <code className="rounded bg-[#ece5d8] px-1 text-xs">&lt;i&gt;</code>,{' '}
                <code className="rounded bg-[#ece5d8] px-1 text-xs">&lt;a&gt;</code>{' '}
                tags survive sanitization
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 text-[#0f766e]">&#10003;</span>
              <span>
                Anchor tags get <code className="rounded bg-[#ece5d8] px-1 text-xs">rel=&quot;nofollow noopener noreferrer&quot;</code>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 text-[#0f766e]">&#10003;</span>
              <span>
                Unicode NFC normalization defeats homoglyph attacks
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 text-[#0f766e]">&#10003;</span>
              <span>
                Danger-pattern detector logs console warnings for monitoring
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 text-[#0f766e]">&#10003;</span>
              <span>
                Content-Security-Policy headers block inline script execution
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
