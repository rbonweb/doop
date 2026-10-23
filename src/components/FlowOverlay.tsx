import { useEffect, useMemo, useState } from 'react'
import { arrowBetween, gotoEdges, gotoTargets } from '../../shared/gotoLinks'
import { canvasPages, pageFrames } from '../../shared/pages'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { api, type SyncFlow } from '../lib/api'
import { isSyncedFrame } from '../lib/sync'
import { cn } from '../lib/utils'

/* the data-goto scan of a frame, remembered until its HTML changes */
const scanned = new Map<string, { html: string; targets: string[] }>()
function targetsOf(frame: Frame): string[] {
  const hit = scanned.get(frame.id)
  if (hit?.html === frame.html) return hit.targets
  const targets = gotoTargets(frame.html)
  scanned.set(frame.id, { html: frame.html, targets })
  return targets
}

/** A prototype link between two frames of the page, drawn as an arrow. */
interface LinkArrow {
  key: string
  path: string
  /** the link leaves a selected frame, so it is drawn heavier */
  emphasis: boolean
  bounds: [number, number][]
}

/**
 * Prototype links (data-goto) are drawn as dashed arrows between the frames of the page: out of each selected frame,
 * or out of every frame when nothing is selected and the link arrows are switched on (K).
 *
 * The information architecture of a synced app, drawn on the canvas: when a
 * design-synced frame is selected, every same-app link hotspot on it gets a
 * connector to the frame it navigates to, weighted with how often real users
 * took that path. Selection-scoped on purpose — always-on connectors would
 * turn a synced canvas into spaghetti. Purely presentational overlay in world
 * coordinates; pointer events pass through.
 */

interface Connector {
  /** hotspot outline on the source frame, world coords */
  box: { x: number; y: number; w: number; h: number }
  path: string
  label: string | null
  count: number
  /** label anchor */
  mx: number
  my: number
}

export function FlowOverlay() {
  const canvas = useStore((s) => s.canvas)
  const selectedId = useStore((s) => s.selectedId)
  const [flow, setFlow] = useState<SyncFlow | null>(null)

  const selected = canvas?.frames.find((f) => f.id === selectedId)
  const selectedIsSynced = !!selected && isSyncedFrame(selected.html)

  /* fetch lazily, on the first selection of a synced frame (and refresh on
     later selections — sync updates land while the canvas is open) */
  useEffect(() => {
    if (!canvas || !selectedIsSynced) return
    let stale = false
    api
      .syncFlow(canvas.id)
      .then((f) => !stale && setFlow(f))
      .catch(() => !stale && setFlow(null))
    return () => {
      stale = true
    }
    /* canvas.frames churn constantly (streams, cursors); refetch only on
       canvas/selection change */
  }, [canvas?.id, selectedId, selectedIsSynced]) // eslint-disable-line react-hooks/exhaustive-deps

  const connectors = useMemo<Connector[]>(() => {
    if (!canvas || !selected || !selectedIsSynced || !flow) return []
    const frameById = new Map(canvas.frames.map((f) => [f.id, f]))
    const countFor = new Map(flow.edges.filter((e) => e.fromFrameId === selected.id).map((e) => [e.toFrameId, e.count]))
    const out: Connector[] = []
    for (const link of flow.links) {
      if (link.fromFrameId !== selected.id) continue
      const target = frameById.get(link.toFrameId)
      if (!target || target.id === selected.id) continue
      /* hotspot coordinates are in the snapshot's own pixels; clamp into the
         frame so a since-resized frame degrades gracefully */
      const bx = selected.x + Math.min(link.x, selected.width - 8)
      const by = selected.y + Math.min(link.y, selected.height - 8)
      const bw = Math.min(link.width, selected.width - (bx - selected.x))
      const bh = Math.min(link.height, selected.height - (by - selected.y))
      const targetLeft = target.x + target.width / 2 >= bx
      const sx = targetLeft ? bx + bw : bx
      const sy = by + bh / 2
      const tx = targetLeft ? target.x : target.x + target.width
      const ty = target.y + Math.min(120, target.height / 2)
      const bend = Math.max(60, Math.abs(tx - sx) / 3) * (targetLeft ? 1 : -1)
      out.push({
        box: { x: bx, y: by, w: bw, h: bh },
        path: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`,
        label: link.label,
        count: countFor.get(target.id) ?? 0,
        mx: (sx + tx) / 2,
        my: (sy + ty) / 2 - 10,
      })
    }
    return out
  }, [canvas, selected, selectedIsSynced, flow])

  const activePageId = useStore((s) => s.activePageId)
  const selectedIds = useStore((s) => s.selectedIds)
  const showAll = useStore((s) => s.flowLinksVisible)
  const arrows = useMemo<LinkArrow[]>(() => {
    if (!canvas || (!selectedIds.length && !showAll)) return []
    const page = canvasPages(canvas).find((p) => p.id === activePageId) ?? canvasPages(canvas)[0]
    if (!page) return []
    const onPage = pageFrames(canvas, page.id)
    const sources = selectedIds.length ? onPage.filter((f) => selectedIds.includes(f.id)) : onPage
    const edges = gotoEdges(canvas, sources, targetsOf)
    const perSource = new Map<string, number>()
    for (const e of edges) perSource.set(e.from.id, (perSource.get(e.from.id) ?? 0) + 1)
    const used = new Map<string, number>()
    return edges.map((e) => {
      const slot = used.get(e.from.id) ?? 0
      used.set(e.from.id, slot + 1)
      const a = arrowBetween(e.from, e.to, slot, perSource.get(e.from.id) ?? 1)
      return {
        key: `${e.from.id}>${e.to.id}`,
        path: a.path,
        emphasis: selectedIds.length > 0,
        bounds: [
          [a.start.x, a.start.y],
          [a.end.x, a.end.y],
        ],
      }
    })
  }, [canvas, activePageId, selectedIds, showAll])

  if (!connectors.length && !arrows.length) return null

  /* one SVG spanning everything it draws, placed in world space */
  const pad = 80
  const xs = [
    ...connectors.flatMap((c) => [c.box.x, c.box.x + c.box.w, c.mx]),
    ...arrows.flatMap((a) => a.bounds.map(([x]) => x)),
  ]
  const ys = [
    ...connectors.flatMap((c) => [c.box.y, c.box.y + c.box.h, c.my]),
    ...arrows.flatMap((a) => a.bounds.map(([, y]) => y)),
  ]
  for (const f of canvas!.frames) {
    xs.push(f.x, f.x + f.width)
    ys.push(f.y, f.y + f.height)
  }
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  const w = Math.max(...xs) - minX + pad * 2
  const h = Math.max(...ys) - minY + pad * 2

  return (
    <svg
      /* pointer events pass through: this is a read-only overlay above the
         frames (z-6) that must never intercept a drag or a right-click */
      className="pointer-events-none absolute z-[6] overflow-visible text-accent-ink"
      style={{ left: minX, top: minY, width: w, height: h }}
      viewBox={`${minX} ${minY} ${w} ${h}`}
    >
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </marker>
      </defs>
      {arrows.map((a) => (
        <path
          key={a.key}
          d={a.path}
          data-goto-arrow=""
          className={cn(
            'fill-none stroke-current [stroke-dasharray:6_4]',
            a.emphasis ? 'opacity-90 [stroke-width:2.2]' : 'opacity-55 [stroke-width:1.8]',
          )}
          markerEnd="url(#flow-arrow)"
        />
      ))}
      {connectors.map((c, i) => (
        <g key={i}>
          <rect
            x={c.box.x}
            y={c.box.y}
            width={c.box.w}
            height={c.box.h}
            rx={4}
            className="fill-brand/[0.08] stroke-current [stroke-dasharray:4_3] [stroke-width:1.5]"
          />
          <path
            d={c.path}
            className="fill-none stroke-current opacity-75 [stroke-width:2]"
            markerEnd="url(#flow-arrow)"
          />
          {c.count > 0 && (
            <text
              x={c.mx}
              y={c.my}
              className="fill-current text-[13px] font-semibold [paint-order:stroke] [stroke-width:4] stroke-surface"
              textAnchor="middle"
            >
              {c.count}×
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}
