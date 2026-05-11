import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseCaseTitle } from '../lib/casePrefix'

interface PeerProjection {
  document_id: string
  template_value: string
  status?: string
  data?: { title?: string }
}

interface EdgeItem {
  document_id: string
  template_value: string
  peer?: PeerProjection | null
}

interface Props {
  selfId: string
  selfTitle: string
  selfTemplate: string
  incoming: EdgeItem[]
  outgoing: EdgeItem[]
}

// Layout constants in SVG user units.
const NODE_W = 120
const NODE_H = 34
const COL_GAP = 80
const ROW_GAP = 10
const PAD = 12

// Color buckets per template kind — keyed off template_value prefix.
// Returns the Tailwind-equivalent hex pair (fill, stroke). Kept inline rather
// than as classes because SVG attributes are easier to drive with literal hex.
function nodeColors(templateValue: string, isSelf: boolean): { fill: string; stroke: string; text: string } {
  if (isSelf) return { fill: '#2B579A', stroke: '#1E3F6F', text: '#FFFFFF' } // primary
  switch (templateValue) {
    case 'CASE_RECORD':
      return { fill: '#E4ECF6', stroke: '#5B9BD5', text: '#2B579A' } // primary/10 + light + DEFAULT
    case 'JOURNEY_ENTRY':
      return { fill: '#FBE6D5', stroke: '#ED7D31', text: '#B4581F' } // accent/10 + accent
    case 'FIRESIDE':
      return { fill: '#E0F0E8', stroke: '#2E8B57', text: '#1F6240' } // success
    case 'FLAG_RECORD':
      return { fill: '#FBE6D5', stroke: '#ED7D31', text: '#B4581F' } // accent
    default:
      return { fill: '#F3F4F6', stroke: '#D1D5DB', text: '#374151' } // gray
  }
}

function shortLabel(title: string | undefined, fallbackId: string): string {
  const parsed = parseCaseTitle(title)
  if (parsed.caseNumber !== null) return `CASE-${parsed.caseNumber}`
  if (title) return title.length > 14 ? title.slice(0, 13) + '…' : title
  return fallbackId.slice(0, 8)
}

interface HoverState {
  nodeX: number
  nodeY: number
  title: string
  template: string
  status?: string
}

const TOOLTIP_W = 280
const TOOLTIP_H = 60
const TOOLTIP_GAP = 8

export function RelationshipGraph({
  selfId,
  selfTitle,
  selfTemplate,
  incoming,
  outgoing,
}: Props) {
  const navigate = useNavigate()
  const [hover, setHover] = useState<HoverState | null>(null)
  if (incoming.length === 0 && outgoing.length === 0) return null

  const maxRows = Math.max(incoming.length, outgoing.length, 1)
  const height = PAD * 2 + maxRows * (NODE_H + ROW_GAP) - ROW_GAP
  const width = PAD * 2 + NODE_W * 3 + COL_GAP * 2

  const selfX = (width - NODE_W) / 2
  const selfY = (height - NODE_H) / 2
  const leftX = selfX - COL_GAP - NODE_W
  const rightX = selfX + NODE_W + COL_GAP

  function colY(idx: number, total: number): number {
    const colHeight = total * (NODE_H + ROW_GAP) - ROW_GAP
    const startY = (height - colHeight) / 2
    return startY + idx * (NODE_H + ROW_GAP)
  }

  const selfColors = nodeColors(selfTemplate, true)
  const selfLabel = shortLabel(selfTitle, selfId)

  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-surface p-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        Neighborhood
      </h3>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full"
        style={{ maxHeight: `${Math.max(height, 120)}px` }}
        role="img"
        aria-label="Relationship neighborhood"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#9CA3AF" />
          </marker>
        </defs>

        {/* Edges first so nodes overlay them */}
        {incoming.map((e, i) => {
          const y = colY(i, incoming.length)
          const x1 = leftX + NODE_W
          const y1 = y + NODE_H / 2
          const x2 = selfX
          const y2 = selfY + NODE_H / 2
          return (
            <line
              key={`in-${e.document_id}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#9CA3AF"
              strokeWidth="1.2"
              markerEnd="url(#arrow)"
            />
          )
        })}
        {outgoing.map((e, i) => {
          const y = colY(i, outgoing.length)
          const x1 = selfX + NODE_W
          const y1 = selfY + NODE_H / 2
          const x2 = rightX
          const y2 = y + NODE_H / 2
          return (
            <line
              key={`out-${e.document_id}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#9CA3AF"
              strokeWidth="1.2"
              markerEnd="url(#arrow)"
            />
          )
        })}

        {/* Incoming peer nodes */}
        {incoming.map((e, i) => {
          const peer = e.peer
          if (!peer) return null
          const y = colY(i, incoming.length)
          const c = nodeColors(peer.template_value, false)
          const label = shortLabel(peer.data?.title, peer.document_id)
          const fullTitle = peer.data?.title || peer.document_id
          const inactive = peer.status === 'inactive'
          return (
            <g
              key={`in-node-${peer.document_id}`}
              onClick={() => navigate(`/doc/${peer.document_id}`)}
              onMouseEnter={() =>
                setHover({
                  nodeX: leftX,
                  nodeY: y,
                  title: fullTitle,
                  template: peer.template_value,
                  status: peer.status,
                })
              }
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
              opacity={inactive ? 0.45 : 1}
            >
              <title>{fullTitle}</title>
              <rect
                x={leftX}
                y={y}
                width={NODE_W}
                height={NODE_H}
                rx="6"
                ry="6"
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth="1.2"
              />
              <text
                x={leftX + NODE_W / 2}
                y={y + NODE_H / 2 + 4}
                textAnchor="middle"
                fontSize="12"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
                fill={c.text}
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* Outgoing peer nodes */}
        {outgoing.map((e, i) => {
          const peer = e.peer
          if (!peer) return null
          const y = colY(i, outgoing.length)
          const c = nodeColors(peer.template_value, false)
          const label = shortLabel(peer.data?.title, peer.document_id)
          const fullTitle = peer.data?.title || peer.document_id
          const inactive = peer.status === 'inactive'
          return (
            <g
              key={`out-node-${peer.document_id}`}
              onClick={() => navigate(`/doc/${peer.document_id}`)}
              onMouseEnter={() =>
                setHover({
                  nodeX: rightX,
                  nodeY: y,
                  title: fullTitle,
                  template: peer.template_value,
                  status: peer.status,
                })
              }
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
              opacity={inactive ? 0.45 : 1}
            >
              <title>{fullTitle}</title>
              <rect
                x={rightX}
                y={y}
                width={NODE_W}
                height={NODE_H}
                rx="6"
                ry="6"
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth="1.2"
              />
              <text
                x={rightX + NODE_W / 2}
                y={y + NODE_H / 2 + 4}
                textAnchor="middle"
                fontSize="12"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
                fill={c.text}
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* Self node (last so it sits on top) */}
        <g
          onMouseEnter={() =>
            setHover({
              nodeX: selfX,
              nodeY: selfY,
              title: selfTitle,
              template: selfTemplate,
            })
          }
          onMouseLeave={() => setHover(null)}
        >
          <title>{selfTitle}</title>
          <rect
            x={selfX}
            y={selfY}
            width={NODE_W}
            height={NODE_H}
            rx="6"
            ry="6"
            fill={selfColors.fill}
            stroke={selfColors.stroke}
            strokeWidth="2"
          />
          <text
            x={selfX + NODE_W / 2}
            y={selfY + NODE_H / 2 + 4}
            textAnchor="middle"
            fontSize="13"
            fontWeight="600"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fill={selfColors.text}
          >
            {selfLabel}
          </text>
        </g>

        {/* Column labels */}
        {incoming.length > 0 && (
          <text
            x={leftX + NODE_W / 2}
            y={PAD - 2}
            textAnchor="middle"
            fontSize="9"
            fontWeight="600"
            fill="#999999"
            letterSpacing="0.05em"
          >
            INCOMING
          </text>
        )}
        {outgoing.length > 0 && (
          <text
            x={rightX + NODE_W / 2}
            y={PAD - 2}
            textAnchor="middle"
            fontSize="9"
            fontWeight="600"
            fill="#999999"
            letterSpacing="0.05em"
          >
            OUTGOING
          </text>
        )}

        {/* Custom tooltip — renders above the hovered node (or below if no
            room). Uses foreignObject so the title can wrap and inherit the
            app's typography / design tokens. */}
        {hover && (() => {
          const tipX = Math.max(
            PAD,
            Math.min(width - TOOLTIP_W - PAD, hover.nodeX + NODE_W / 2 - TOOLTIP_W / 2),
          )
          const above = hover.nodeY - TOOLTIP_GAP - TOOLTIP_H >= 0
          const rawY = above
            ? hover.nodeY - TOOLTIP_GAP - TOOLTIP_H
            : hover.nodeY + NODE_H + TOOLTIP_GAP
          const tipY = Math.max(0, Math.min(height - TOOLTIP_H, rawY))
          return (
            <foreignObject
              x={tipX}
              y={tipY}
              width={TOOLTIP_W}
              height={TOOLTIP_H}
              pointerEvents="none"
            >
              <div
                className="pointer-events-none rounded-md border border-gray-200 bg-surface px-3 py-2 text-xs leading-snug shadow-lg"
                style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
              >
                <div className="line-clamp-2 font-medium text-text">{hover.title}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                  {hover.template}
                  {hover.status === 'inactive' && ' · inactive'}
                </div>
              </div>
            </foreignObject>
          )
        })()}
      </svg>
    </div>
  )
}
