// src/lib/pdf-report.ts
//
// npm i html2canvas-pro jspdf
//
// One portrait A4 page, always light, never black boxes.
import html2canvas from 'html2canvas-pro'
import { jsPDF } from 'jspdf'

/**
 * Layout width (px) each report section is captured at.
 * ~1000px wide x ~1400px tall (both sections stacked) is almost exactly the
 * A4 portrait ratio (1 : 1.41), so everything fits one page with good size.
 * VIEWPORT_WIDTH is above Tailwind's lg breakpoint (1024px) so the two-column
 * and five-card layouts are used, which keeps the sections short.
 */
const PAGE_WIDTH = 1000
const VIEWPORT_WIDTH = 1100
const CAPTURE_SCALE = 3 // ~ 400 dpi at the final size: crisp when printed
const GAP_PX = 20 // space between the two sections (CSS px)

/* ------------------------------------------------------------------ */
/* Colour helpers                                                       */
/* ------------------------------------------------------------------ */

type RGBA = { r: number; g: number; b: number; a: number }

const probe = document.createElement('canvas').getContext('2d')

/** Resolve ANY css colour (oklch, color-mix, color(srgb ...), rgb ...) to RGBA. */
function parseColor(value: string): RGBA | null {
  if (!probe || !value || value === 'transparent') return null
  const SENTINEL = '#010203'
  probe.fillStyle = SENTINEL
  probe.fillStyle = value
  const out = probe.fillStyle as string
  // Unparsable colour leaves fillStyle unchanged. Do NOT treat that as black.
  if (out.toLowerCase() === SENTINEL && value.replace(/\s/g, '').toLowerCase() !== SENTINEL) {
    return null
  }
  if (out.startsWith('#')) {
    const h = out.slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    }
  }
  const m = out.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const [r, g, b, a] = m[1].split(',').map((s) => parseFloat(s))
  return { r, g, b, a: a === undefined ? 1 : a }
}

const luminance = ({ r, g, b }: RGBA) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

/* ------------------------------------------------------------------ */
/* Clone preparation                                                    */
/* ------------------------------------------------------------------ */

/** Print-safe overrides, injected into the CLONED document only. */
const CAPTURE_CSS = `
  .truncate {
    overflow: visible !important;
    text-overflow: clip !important;
    white-space: normal !important;
  }
  /* Slimmer bars / value columns so labels get more room in the 2-column layout */
  .sm\\:w-44 { width: 100px !important; }
  .sm\\:w-36 { width: 90px !important; }
  .w-28      { width: 90px !important; }
  .w-24      { width: 90px !important; }
  .w-32      { width: 112px !important; }

  * { text-rendering: geometricPrecision; box-shadow: none !important; }
`

/** Delete every `@media (prefers-color-scheme: dark)` rule (Tailwind v4 default dark mode). */
function stripDarkMediaRules(doc: Document) {
  type Grouping = CSSStyleSheet | CSSGroupingRule
  const purge = (container: Grouping) => {
    const rules = container.cssRules
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i] as CSSRule & {
        conditionText?: string
        media?: MediaList
        cssRules?: CSSRuleList
      }
      const cond = rule.conditionText ?? rule.media?.mediaText ?? ''
      if (/prefers-color-scheme:\s*dark/i.test(cond)) {
        container.deleteRule(i)
        continue
      }
      if (rule.cssRules && rule.cssRules.length > 0) purge(rule as unknown as CSSGroupingRule)
    }
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      purge(sheet)
    } catch {
      /* cross-origin sheet */
    }
  }
}

/**
 * Safety net: whatever the cause, make sure nothing dark survives in the capture.
 *   dark visible backgrounds -> light grey, near-white text -> near-black,
 *   dark borders -> light grey. Intended mid-luminance colours are untouched.
 */
function forceLight(clonedEl: HTMLElement, doc: Document) {
  const win = doc.defaultView
  if (!win) return
  const els: HTMLElement[] = [clonedEl, ...Array.from(clonedEl.querySelectorAll<HTMLElement>('*'))]

  for (const el of els) {
    const cs = win.getComputedStyle(el)

    const bg = parseColor(cs.backgroundColor)
    if (bg && bg.a > 0.05 && luminance(bg) < 0.3) {
      el.style.setProperty('background-color', '#fafafa', 'important')
    }

    const fg = parseColor(cs.color)
    if (fg && luminance(fg) > 0.78) {
      el.style.setProperty('color', '#18181b', 'important')
    }

    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const prop = `border${side}Color` as 'borderTopColor'
      const bc = parseColor(cs[prop])
      if (bc && bc.a > 0.05 && luminance(bc) < 0.3) {
        el.style.setProperty(`border-${side.toLowerCase()}-color`, '#e4e4e7', 'important')
      }
    }
  }
}

function prepareClone(doc: Document, clonedEl: HTMLElement) {
  // 1. Light theme, both class-based and media-based
  doc.querySelectorAll('.dark').forEach((n) => n.classList.remove('dark'))
  doc.documentElement.removeAttribute('data-theme')
  doc.documentElement.style.colorScheme = 'light'
  doc.body.style.background = '#ffffff'
  stripDarkMediaRules(doc)

  // 2. Print-safe CSS
  const style = doc.createElement('style')
  style.textContent = CAPTURE_CSS
  doc.head.appendChild(style)

  // 3. Fixed page width
  clonedEl.style.width = `${PAGE_WIDTH}px`
  clonedEl.style.maxWidth = 'none'
  clonedEl.style.background = '#ffffff'

  // 4. Safety net
  forceLight(clonedEl, doc)
}

/* ------------------------------------------------------------------ */
/* Public API (signature unchanged)                                     */
/* ------------------------------------------------------------------ */

/**
 * Captures every element in `pages` and stacks them, top to bottom, on ONE
 * portrait A4 page, scaled uniformly to fit.
 */
export async function generateDatabaseHealthPDF(
  pages: HTMLElement[],
  dbName: string,
  projectName: string,
): Promise<void> {
  if ('fonts' in document) await document.fonts.ready
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  // 1. Capture each section
  const canvases: HTMLCanvasElement[] = []
  for (const el of pages) {
    canvases.push(
      await html2canvas(el, {
        scale: CAPTURE_SCALE,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: VIEWPORT_WIDTH,
        scrollX: -window.scrollX,
        scrollY: -window.scrollY,
        onclone: (doc, clonedEl) => prepareClone(doc, clonedEl as HTMLElement),
      }),
    )
  }

  // 2. One A4 portrait page
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const PW = 210
  const PH = 297
  const margin = 8
  const footerH = 12
  const availW = PW - margin * 2
  const availH = PH - margin * 2 - footerH

  // 3. One uniform scale so both sections fit the page together
  const gap = GAP_PX * CAPTURE_SCALE
  const maxW = Math.max(...canvases.map((c) => c.width))
  const totalH = canvases.reduce((s, c) => s + c.height, 0) + gap * (canvases.length - 1)
  const ratio = Math.min(availW / maxW, availH / totalH)

  let y = margin
  for (const canvas of canvases) {
    const w = canvas.width * ratio
    const h = canvas.height * ratio
    const x = margin + (availW - w) / 2
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, w, h, undefined, 'FAST')
    y += h + gap * ratio
  }

  // 4. Footer as real PDF text
  pdf.setDrawColor(226, 232, 240)
  pdf.setLineWidth(0.3)
  pdf.line(margin, PH - 11, PW - margin, PH - 11)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(8)
  pdf.setTextColor(100, 116, 139)
  pdf.text(`Stratum Core - Database Health Audit: ${dbName} (${projectName})`, margin, PH - 6)
  pdf.text('Page 1 of 1', PW - margin, PH - 6, { align: 'right' })

  const safeName = (dbName || 'database').replace(/[^\w.-]+/g, '_')
  pdf.save(`${safeName}_health_report_${Date.now()}.pdf`)
}