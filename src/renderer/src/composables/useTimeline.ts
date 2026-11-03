// Canvas timeline composable.
//
// Draws event markers and a playhead on a <canvas> element.
// Emits a seek time when the user clicks.
// Shows a tooltip when the user hovers near an event marker.
//
// Coordinate model:
//   x = (timestamp / duration) * canvas.width  (logical pixels)
// The canvas width is read from its CSS layout width (no DPR scaling).

import { ref, watch, type Ref } from 'vue'
import type { TimelineEvent } from '@shared/ipc.types'
import { TIMELINE_COLORS } from '@shared/constants'

// How many logical pixels away from a marker triggers the hover tooltip.
const HOVER_THRESHOLD_PX = 6

export interface UseTimelineReturn {
  tooltipText: Ref<string | null>
  tooltipX: Ref<number>
  draw: () => void
  onClick: (e: MouseEvent) => void
  onMouseMove: (e: MouseEvent) => void
  onMouseLeave: () => void
}

export function useTimeline(
  canvasRef: Ref<HTMLCanvasElement | null>,
  events: Ref<TimelineEvent[]>,
  currentTime: Ref<number>,
  duration: Ref<number>,
  onSeek: (time: number) => void
): UseTimelineReturn {
  const tooltipText = ref<string | null>(null)
  const tooltipX = ref(0)

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  function draw(): void {
    const canvas = canvasRef.value
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const w = canvas.offsetWidth
    const h = canvas.offsetHeight
    if (w === 0 || h === 0) return
    canvas.width = w
    canvas.height = h

    const dur = duration.value
    const LABEL_H = 14 // pixels reserved at bottom for time labels
    const barH = h - LABEL_H

    // Background
    ctx.fillStyle = '#111111'
    ctx.fillRect(0, 0, w, barH)
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, barH, w, LABEL_H)

    // Timeline track
    ctx.fillStyle = '#2a2a2a'
    ctx.fillRect(0, barH / 2 - 1, w, 2)

    if (dur <= 0) return

    // Time tick marks + labels — every 30s, or every 60s for long matches
    const tickInterval = dur > 300 ? 60 : 30
    ctx.font = '9px monospace'
    ctx.textAlign = 'center'
    for (let t = tickInterval; t < dur; t += tickInterval) {
      const x = Math.round((t / dur) * w)
      ctx.fillStyle = '#333333'
      ctx.fillRect(x, 0, 1, barH)
      ctx.fillStyle = '#555555'
      ctx.fillText(fmtSecs(t), x, h - 2)
    }

    // Event markers
    for (const ev of events.value) {
      const x = Math.round((ev.timestamp / dur) * w)
      ctx.fillStyle = TIMELINE_COLORS[ev.type] ?? '#888888'
      // A pull has dozens of boss casts: keep them short so deaths and phases stand out
      if (ev.type === 'boss-ability') ctx.fillRect(x, 0, 2, Math.round(barH * 0.4))
      else ctx.fillRect(x - 1, 0, 3, barH)
    }

    // Playhead
    const px = Math.round((currentTime.value / dur) * w)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.fillRect(px - 1, 0, 2, barH)
  }

  // ---------------------------------------------------------------------------
  // Watch and redraw
  // ---------------------------------------------------------------------------

  watch([events, currentTime, duration], () => {
    draw()
  })

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  function timeFromX(e: MouseEvent): number {
    const canvas = canvasRef.value
    if (canvas === null || duration.value <= 0) return 0
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
    return (x / rect.width) * duration.value
  }

  function onClick(e: MouseEvent): void {
    if (duration.value <= 0) return
    onSeek(timeFromX(e))
  }

  function onMouseMove(e: MouseEvent): void {
    const canvas = canvasRef.value
    if (canvas === null || duration.value <= 0) {
      tooltipText.value = null
      return
    }

    const rect = canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const hoverTime = (mouseX / rect.width) * duration.value
    const pxPerSec = rect.width / duration.value
    const timeTolerance = HOVER_THRESHOLD_PX / pxPerSec

    const hit = events.value.find((ev) => Math.abs(ev.timestamp - hoverTime) <= timeTolerance)

    if (hit !== undefined) {
      tooltipText.value = formatTooltip(hit)
      tooltipX.value = mouseX
    } else {
      tooltipText.value = null
    }
  }

  function onMouseLeave(): void {
    tooltipText.value = null
  }

  return { tooltipText, tooltipX, draw, onClick, onMouseMove, onMouseLeave }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmtSecs(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatTooltip(ev: TimelineEvent): string {
  const time = fmtSecs(ev.timestamp)
  if (ev.text !== undefined) return `${ev.text} (${time})`
  if (ev.spellName !== undefined) return `${ev.spellName} (${time})`
  if (ev.unit !== undefined) return `${ev.unit} (${time})`
  return `${ev.type} (${time})`
}
