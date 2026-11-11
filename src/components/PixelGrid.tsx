import { pixelGridLines } from '@/lib/pixelGrid'

/** A frame's pixel grid: over its document, under everything drawn on the frame (pins, threads, grips), so the grid
 *  never covers the canvas's own UI. The world is a pure `scale(zoom)` transform, so the layer is laid out `zoom` times
 *  the frame's size and scaled back down by the same factor: inside it one design px is `zoom` screen px, the tile is
 *  `--zoom` px and a line is one screen px thick at every zoom. The Stage fades it in with the zoom through
 *  `--pixel-grid`. */
export function PixelGrid() {
  return (
    <div
      data-pixel-grid="frame"
      className="pointer-events-none absolute left-0 top-0 origin-top-left"
      style={{
        ...pixelGridLines(1),
        width: 'calc(100% * var(--zoom, 1))',
        height: 'calc(100% * var(--zoom, 1))',
        transform: 'scale(calc(1 / var(--zoom, 1)))',
        backgroundSize: 'calc(var(--zoom, 1) * 1px) calc(var(--zoom, 1) * 1px)',
        opacity: 'var(--pixel-grid, 0)',
      }}
    />
  )
}
