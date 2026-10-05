// src/lib/insights-charts.tsx
//
// Zero-dependency chart primitives for the Scientometric Insights page.
//  - BarLineChart : stacked/plain columns + line series on a left and/or right axis
//  - HBarChart    : ranked horizontal bars (optionally stacked) with a real value axis
//  - Panel, PanelHeader, Seg, Kpi, KpiGrid, Note, ChartCard, Legend : black-theme UI blocks
//
// Every axis uses a "nice number" scale (1 / 2 / 5 x 10^k steps), always includes zero,
// and always starts bars at zero, so bar lengths are honest.
import { useEffect, useId, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode } from 'react'

/* ------------------------------------------------------------------ */
/* Theme (plain hex only: safe for html2canvas / PDF export)            */
/* ------------------------------------------------------------------ */

export const T = {
  bg: '#09090b',
  panel: '#111113',
  raised: '#18181b',
  inset: '#0c0c0e',
  border: '#27272a',
  grid: '#27272a',
  axis: '#52525b',
  text: '#fafafa',
  soft: '#d4d4d8',
  muted: '#a1a1aa',
  dim: '#71717a',
  bar: '#d4d4d8',
  slate: '#3f3f46',
  amber: '#fbbf24', // Top 1%
  sky: '#38bdf8', //   Top 10%
  emerald: '#34d399',
  orange: '#fb923c', // India
  rose: '#fb7185',
  violet: '#a78bfa',
} as const

export const MONO =
  'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
export const SANS =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

/* ------------------------------------------------------------------ */
/* Number + scale helpers                                               */
/* ------------------------------------------------------------------ */

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
export const fmtSigned = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`

const trim = (n: number, d = 1) => String(Number(n.toFixed(d)))

export function fmtCompact(n: number, decimals = 0): string {
  const a = Math.abs(n)
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e4) return `${trim(n / 1e3)}k`
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals })
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range))
  const f = range / Math.pow(10, exp)
  let nf: number
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return nf * Math.pow(10, exp)
}

export interface Scale {
  min: number
  max: number
  step: number
  ticks: number[]
  decimals: number
}

/** Round [minV, maxV] out to clean tick values (about `target` ticks). */
export function niceScale(minV: number, maxV: number, target = 5): Scale {
  const lo = Number.isFinite(minV) ? minV : 0
  let hi = Number.isFinite(maxV) ? maxV : 1
  if (hi <= lo) hi = lo + 1
  const range = niceNum(hi - lo, false)
  const step = niceNum(range / (target - 1), true)
  const min = Math.floor(lo / step + 1e-9) * step
  const max = Math.ceil(hi / step - 1e-9) * step
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)))
  const ticks: number[] = []
  for (let i = 0; ; i++) {
    const v = min + i * step
    if (v > max + step * 1e-6) break
    ticks.push(Number(v.toFixed(decimals)))
  }
  return { min: Number(min.toFixed(decimals)), max: Number(max.toFixed(decimals)), step, ticks, decimals }
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(Math.max(280, Math.floor(el.clientWidth || 800)))
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, h, w / 2))
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}

/* ------------------------------------------------------------------ */
/* Small UI blocks                                                      */
/* ------------------------------------------------------------------ */

export function Empty({ text = 'No data available for this view.' }: { text?: string }) {
  return (
    <div style={{ padding: '40px 0', textAlign: 'center', fontFamily: MONO, fontSize: 12, color: T.dim }}>
      {text}
    </div>
  )
}

export function Legend({
  items,
}: {
  items: { name: string; color: string; line?: boolean; dashed?: boolean }[]
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 14,
        marginBottom: 8,
        fontFamily: MONO,
        fontSize: 11,
        color: T.muted,
        lineHeight: 1.4,
      }}
    >
      {items.map((i) => (
        <span key={i.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {i.line ? (
            <span
              style={{ width: 16, height: 0, borderTop: `2px ${i.dashed ? 'dashed' : 'solid'} ${i.color}` }}
            />
          ) : (
            <span style={{ width: 10, height: 10, borderRadius: 2, background: i.color }} />
          )}
          {i.name}
        </span>
      ))}
    </div>
  )
}

export function Panel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: T.bg,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: 20,
        color: T.text,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {children}
    </div>
  )
}

export function PanelHeader({
  icon,
  title,
  subtitle,
  right,
}: {
  icon: ReactNode
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingBottom: 14,
        borderBottom: `1px solid ${T.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div
          style={{
            width: 32,
            height: 32,
            flexShrink: 0,
            borderRadius: 8,
            background: T.raised,
            border: `1px solid ${T.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: T.soft,
          }}
        >
          {icon}
        </div>
        <div>
          <div
            style={{
              fontFamily: MONO,
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              lineHeight: 1.4,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: T.dim, lineHeight: 1.4 }}>{subtitle}</div>
          )}
        </div>
      </div>
      {right && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{right}</div>}
    </div>
  )
}

export function ChartCard({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: T.inset,
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: '14px 14px 10px',
      }}
    >
      {children}
    </div>
  )
}

/** Segmented control on a black background. */
export function Seg<K extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: K; label: ReactNode; accent?: string }[]
  value: K
  onChange: (id: K) => void
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        background: T.raised,
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              fontFamily: MONO,
              fontSize: 11,
              padding: '4px 10px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: on ? (o.accent ?? T.text) : 'transparent',
              color: on ? T.bg : T.muted,
              fontWeight: on ? 700 : 500,
              lineHeight: 1.4,
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

type Tone = 'default' | 'orange' | 'emerald' | 'amber' | 'sky'
const TONE: Record<Tone, { c: string; b: string; bg: string }> = {
  default: { c: '#fafafa', b: '#27272a', bg: '#111113' },
  orange: { c: '#fdba74', b: '#7c2d12', bg: '#1a0f08' },
  emerald: { c: '#6ee7b7', b: '#065f46', bg: '#06150f' },
  amber: { c: '#fcd34d', b: '#78350f', bg: '#171004' },
  sky: { c: '#7dd3fc', b: '#075985', bg: '#07131b' },
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))',
        gap: 10,
      }}
    >
      {children}
    </div>
  )
}

export function Kpi({
  label,
  value,
  note,
  tone = 'default',
  icon,
  small,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  tone?: Tone
  icon?: ReactNode
  small?: boolean
}) {
  const t = TONE[tone]
  return (
    <div
      style={{
        background: t.bg,
        border: `1px solid ${t.b}`,
        borderRadius: 10,
        padding: '12px 14px',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          fontFamily: MONO,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: tone === 'default' ? T.muted : t.c,
          lineHeight: 1.4,
        }}
      >
        <span>{label}</span>
        {icon}
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontWeight: 800,
          fontSize: small ? 13 : 20,
          color: t.c,
          margin: '6px 0 3px',
          lineHeight: 1.3,
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
      {note && <div style={{ fontFamily: MONO, fontSize: 10, color: T.dim, lineHeight: 1.45 }}>{note}</div>}
    </div>
  )
}

export function Note({
  title,
  children,
  formula,
}: {
  title: string
  children: ReactNode
  formula?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: '12px 14px',
      }}
    >
      <div style={{ flex: '1 1 360px', minWidth: 0 }}>
        <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 11, color: T.soft, lineHeight: 1.5 }}>
          {title}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: T.dim, lineHeight: 1.6, marginTop: 2 }}>
          {children}
        </div>
      </div>
      {formula && (
        <div
          style={{
            background: T.raised,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            padding: '8px 12px',
            fontFamily: MONO,
            fontSize: 11,
            color: T.text,
            lineHeight: 1.5,
          }}
        >
          {formula}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* BarLineChart                                                         */
/* ------------------------------------------------------------------ */

export interface Series {
  name: string
  color: string
  values: (number | null)[]
  /** per-point colour override (bars only), e.g. highlight India */
  pointColors?: (string | undefined)[]
  axis?: 'left' | 'right'
  dashed?: boolean
  format?: (n: number) => string
}

interface BarLineProps {
  labels: string[]
  titles?: string[]
  subLabels?: string[]
  /** stacked from first (bottom) to last (top); all values are drawn from zero */
  bars?: Series[]
  lines?: Series[]
  height?: number
  leftFormat?: (n: number) => string
  rightFormat?: (n: number) => string
  rightDomain?: [number, number]
  leftTitle?: string
  rightTitle?: string
  showTotals?: boolean
  totalFormat?: (n: number) => string
  emptyText?: string
}

export function BarLineChart(p: BarLineProps) {
  const { labels, titles, subLabels, bars = [], lines = [], height = 300 } = p
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const n = labels.length

  if (n === 0) return <Empty text={p.emptyText} />

  const hasBars = bars.length > 0
  const rightLines = lines.filter((l) => l.axis === 'right')
  const leftLines = lines.filter((l) => l.axis !== 'right')
  const hasRight = rightLines.length > 0

  const totals = labels.map((_, i) => bars.reduce((s, b) => s + Math.max(b.values[i] ?? 0, 0), 0))
  const nums = (arr: Series[]) =>
    arr.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)))

  const lNums = [...(hasBars ? totals : []), ...nums(leftLines)]
  const L = niceScale(Math.min(0, ...lNums), Math.max(0, ...lNums))
  const rNums = nums(rightLines)
  const R = p.rightDomain
    ? niceScale(p.rightDomain[0], p.rightDomain[1])
    : niceScale(Math.min(0, ...rNums), Math.max(0, ...rNums))

  const m = {
    l: 58,
    r: hasRight ? 58 : 16,
    t: p.leftTitle || p.rightTitle ? 26 : 14,
    b: subLabels ? 50 : 30,
  }
  const plotW = Math.max(width - m.l - m.r, 40)
  const plotH = Math.max(height - m.t - m.b, 40)
  const yL = (v: number) => m.t + plotH - ((v - L.min) / (L.max - L.min)) * plotH
  const yR = (v: number) => m.t + plotH - ((v - R.min) / (R.max - R.min)) * plotH
  const slot = plotW / n
  const xc = (i: number) => m.l + slot * (i + 0.5)
  const barW = Math.max(4, Math.min(slot * 0.62, 48))
  const lf = p.leftFormat ?? ((v: number) => fmtCompact(v, L.decimals))
  const rf = p.rightFormat ?? ((v: number) => fmtCompact(v, R.decimals))
  const step = Math.max(1, Math.ceil(36 / slot))

  const colorsUsed = Array.from(
    new Set(bars.flatMap((b) => [b.color, ...((b.pointColors ?? []).filter(Boolean) as string[])])),
  )
  const gid = (c: string) => `g${uid}${c.replace('#', '')}`

  const linePath = (s: Series) => {
    const yf = s.axis === 'right' ? yR : yL
    let d = ''
    let pen = false
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${xc(i).toFixed(1)},${yf(v).toFixed(1)} `
      pen = true
    })
    return d
  }

  const onMove = (e: RMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - m.l
    if (x < 0 || x > plotW) return setHover(null)
    setHover(Math.min(n - 1, Math.max(0, Math.floor(x / slot))))
  }

  const legend = [
    ...bars.map((b) => ({ name: b.name, color: b.color })),
    ...lines.map((l) => ({ name: l.name, color: l.color, line: true, dashed: l.dashed })),
  ]

  const zeroRDiffers = hasRight && R.min < 0 && Math.abs(yR(0) - yL(0)) > 2

  return (
    <div ref={ref} style={{ width: '100%' }}>
      {legend.length > 1 && <Legend items={legend} />}
      <div style={{ position: 'relative' }}>
        <svg
          width={width}
          height={height}
          style={{ display: 'block' }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          role="img"
        >
          <defs>
            {colorsUsed.map((c) => (
              <linearGradient key={c} id={gid(c)} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c} stopOpacity="1" />
                <stop offset="100%" stopColor={c} stopOpacity="0.55" />
              </linearGradient>
            ))}
          </defs>

          {p.leftTitle && (
            <text x={4} y={12} fill={T.dim} fontSize={10} fontFamily={MONO}>
              {p.leftTitle}
            </text>
          )}
          {p.rightTitle && (
            <text x={width - 4} y={12} fill={T.dim} fontSize={10} fontFamily={MONO} textAnchor="end">
              {p.rightTitle}
            </text>
          )}

          {/* left gridlines + labels */}
          {L.ticks.map((t) => (
            <g key={`l${t}`}>
              <line
                x1={m.l}
                x2={m.l + plotW}
                y1={yL(t)}
                y2={yL(t)}
                stroke={t === 0 ? T.axis : T.grid}
                strokeDasharray={t === 0 ? undefined : '3 4'}
              />
              <text
                x={m.l - 8}
                y={yL(t)}
                dy="0.32em"
                textAnchor="end"
                fill={T.muted}
                fontSize={10}
                fontFamily={MONO}
              >
                {lf(t)}
              </text>
            </g>
          ))}

          {/* right axis */}
          {hasRight && (
            <g>
              <line x1={m.l + plotW} x2={m.l + plotW} y1={m.t} y2={m.t + plotH} stroke={T.grid} />
              {R.ticks.map((t) => (
                <g key={`r${t}`}>
                  <line
                    x1={m.l + plotW}
                    x2={m.l + plotW + 4}
                    y1={yR(t)}
                    y2={yR(t)}
                    stroke={rightLines[0].color}
                    strokeOpacity={0.7}
                  />
                  <text
                    x={m.l + plotW + 8}
                    y={yR(t)}
                    dy="0.32em"
                    fill={rightLines[0].color}
                    fontSize={10}
                    fontFamily={MONO}
                  >
                    {rf(t)}
                  </text>
                </g>
              ))}
              {zeroRDiffers && (
                <line
                  x1={m.l}
                  x2={m.l + plotW}
                  y1={yR(0)}
                  y2={yR(0)}
                  stroke={rightLines[0].color}
                  strokeOpacity={0.45}
                  strokeDasharray="5 4"
                />
              )}
            </g>
          )}

          {hover !== null && (
            <rect x={m.l + slot * hover} y={m.t} width={slot} height={plotH} fill="rgba(255,255,255,0.05)" />
          )}

          {/* stacked bars */}
          {labels.map((_, i) => {
            let cum = 0
            const segs = bars
              .map((b, bi) => {
                const v = Math.max(b.values[i] ?? 0, 0)
                const y1 = yL(cum)
                cum += v
                return { bi, v, y1, y2: yL(cum), color: b.pointColors?.[i] ?? b.color }
              })
              .filter((s) => s.v > 0 && s.y1 - s.y2 > 0.4)
            return segs.map((s, k) => (
              <path
                key={`${i}-${s.bi}`}
                d={roundedTop(xc(i) - barW / 2, s.y2, barW, s.y1 - s.y2, k === segs.length - 1 ? 3 : 0)}
                fill={`url(#${gid(s.color)})`}
                stroke={T.bg}
                strokeWidth={0.75}
                opacity={hover === null || hover === i ? 1 : 0.55}
              />
            ))
          })}

          {/* totals above bars */}
          {p.showTotals &&
            slot >= 26 &&
            totals.map((tv, i) =>
              tv > 0 ? (
                <text
                  key={`t${i}`}
                  x={xc(i)}
                  y={yL(tv) - 5}
                  textAnchor="middle"
                  fill={hover === i ? T.text : T.soft}
                  fontSize={10}
                  fontWeight={hover === i ? 700 : 500}
                  fontFamily={MONO}
                >
                  {(p.totalFormat ?? fmtInt)(tv)}
                </text>
              ) : null,
            )}

          {/* lines */}
          {lines.map((s) => (
            <g key={s.name}>
              <path
                d={linePath(s)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dashed ? '6 4' : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {n <= 40 &&
                s.values.map((v, i) =>
                  v === null || !Number.isFinite(v) ? null : (
                    <circle
                      key={i}
                      cx={xc(i)}
                      cy={(s.axis === 'right' ? yR : yL)(v)}
                      r={hover === i ? 4.5 : 3}
                      fill={s.color}
                      stroke={T.bg}
                      strokeWidth={1.5}
                    />
                  ),
                )}
            </g>
          ))}

          {/* x labels */}
          {labels.map((lab, i) =>
            i % step === 0 ? (
              <g key={`x${i}`}>
                <text
                  x={xc(i)}
                  y={m.t + plotH + 16}
                  textAnchor="middle"
                  fill={hover === i ? T.text : T.muted}
                  fontSize={10}
                  fontWeight={hover === i ? 700 : 400}
                  fontFamily={MONO}
                >
                  {lab}
                </text>
                {subLabels && (
                  <text
                    x={xc(i)}
                    y={m.t + plotH + 31}
                    textAnchor="middle"
                    fill={T.dim}
                    fontSize={9}
                    fontFamily={MONO}
                  >
                    {subLabels[i]}
                  </text>
                )}
              </g>
            ) : null,
          )}
        </svg>

        {hover !== null && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: Math.min(Math.max(xc(hover), 120), Math.max(width - 120, 120)),
              transform: 'translateX(-50%)',
              pointerEvents: 'none',
              zIndex: 20,
              background: T.raised,
              border: '1px solid #3f3f46',
              borderRadius: 8,
              padding: '8px 10px',
              fontFamily: MONO,
              fontSize: 11,
              color: T.text,
              whiteSpace: 'nowrap',
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{titles?.[hover] ?? labels[hover]}</div>
            {bars.map((b) => (
              <div key={b.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 18 }}>
                <span style={{ color: T.muted }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: b.pointColors?.[hover] ?? b.color,
                      marginRight: 6,
                    }}
                  />
                  {b.name}
                </span>
                <b>{(b.format ?? fmtInt)(b.values[hover] ?? 0)}</b>
              </div>
            ))}
            {bars.length > 1 && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 18,
                  borderTop: `1px solid ${T.border}`,
                  marginTop: 3,
                  paddingTop: 3,
                }}
              >
                <span style={{ color: T.muted }}>Total</span>
                <b>{fmtInt(totals[hover])}</b>
              </div>
            )}
            {lines.map((s) => {
              const v = s.values[hover]
              const f = s.format ?? (s.axis === 'right' ? rf : lf)
              return (
                <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 18 }}>
                  <span style={{ color: T.muted }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 12,
                        height: 0,
                        borderTop: `2px solid ${s.color}`,
                        marginRight: 6,
                        verticalAlign: 'middle',
                      }}
                    />
                    {s.name}
                  </span>
                  <b style={{ color: s.color }}>{v === null || v === undefined ? '-' : f(v)}</b>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* HBarChart                                                            */
/* ------------------------------------------------------------------ */

export interface HRow {
  key: string
  rank: number
  label: ReactNode
  title?: string
  segments: { value: number; color: string; name?: string }[]
  right: ReactNode
  highlight?: boolean
}

interface HProps {
  rows: HRow[]
  labelWidth?: number
  valueWidth?: number
  rowHeight?: number
  axisFormat?: (n: number) => string
  axisTitle?: string
  legend?: { name: string; color: string }[]
  emptyText?: string
}

export function HBarChart({
  rows,
  labelWidth = 230,
  valueWidth = 124,
  rowHeight = 36,
  axisFormat,
  axisTitle,
  legend,
  emptyText,
}: HProps) {
  const [hover, setHover] = useState<string | null>(null)
  if (rows.length === 0) return <Empty text={emptyText} />

  const totals = rows.map((r) => r.segments.reduce((s, x) => s + Math.max(x.value, 0), 0))
  const S = niceScale(0, Math.max(...totals, 0))
  const GAP = 14
  const cols = `${labelWidth}px minmax(0, 1fr) ${valueWidth}px`
  const AXIS_H = 26
  const fmt = axisFormat ?? ((v: number) => fmtCompact(v, S.decimals))

  return (
    <div>
      {legend && legend.length > 0 && <Legend items={legend} />}
      <div style={{ position: 'relative' }}>
        {/* vertical gridlines, aligned to the plot column */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: AXIS_H,
            left: labelWidth + GAP,
            right: valueWidth + GAP,
            pointerEvents: 'none',
          }}
        >
          {S.ticks.map((t) => (
            <div
              key={t}
              style={{
                position: 'absolute',
                left: `${(t / S.max) * 100}%`,
                top: 0,
                bottom: 0,
                borderLeft: `1px ${t === 0 ? 'solid' : 'dashed'} ${t === 0 ? T.axis : T.grid}`,
              }}
            />
          ))}
        </div>

        {rows.map((r, i) => {
          const total = totals[i]
          const hi = r.highlight
          return (
            <div
              key={r.key}
              title={r.title}
              onMouseEnter={() => setHover(r.key)}
              onMouseLeave={() => setHover(null)}
              style={{
                position: 'relative',
                display: 'grid',
                gridTemplateColumns: cols,
                columnGap: GAP,
                alignItems: 'center',
                minHeight: rowHeight,
                borderRadius: 8,
                background: hi ? '#1a0f08' : hover === r.key ? T.raised : 'transparent',
                boxShadow: hi ? 'inset 0 0 0 1px #7c2d12' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8, minWidth: 0 }}>
                <span
                  style={{
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: MONO,
                    fontSize: 10,
                    fontWeight: 700,
                    background: hi ? T.orange : T.border,
                    color: hi ? T.bg : T.soft,
                  }}
                >
                  {r.rank}
                </span>
                <div style={{ minWidth: 0, fontSize: 12, lineHeight: 1.3, color: hi ? '#fdba74' : T.text }}>
                  {r.label}
                </div>
              </div>

              <div style={{ position: 'relative', height: rowHeight }}>
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: `${Math.max((total / S.max) * 100, total > 0 ? 0.8 : 0)}%`,
                    height: 14,
                    display: 'flex',
                    borderRadius: 4,
                    overflow: 'hidden',
                  }}
                >
                  {r.segments
                    .filter((s) => s.value > 0)
                    .map((s, k) => (
                      <div
                        key={k}
                        title={s.name ? `${s.name}: ${fmtInt(s.value)}` : undefined}
                        style={{ flex: `${s.value} 0 0`, background: s.color, minWidth: 2 }}
                      />
                    ))}
                </div>
              </div>

              <div
                style={{
                  paddingRight: 8,
                  textAlign: 'right',
                  fontFamily: MONO,
                  fontSize: 12,
                  lineHeight: 1.35,
                  color: hi ? '#fdba74' : T.text,
                }}
              >
                {r.right}
              </div>
            </div>
          )
        })}

        {/* value axis */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            columnGap: GAP,
            height: AXIS_H,
            alignItems: 'center',
          }}
        >
          <div
            style={{
              textAlign: 'right',
              paddingRight: 8,
              fontFamily: MONO,
              fontSize: 9,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              color: T.dim,
            }}
          >
            {axisTitle}
          </div>
          <div style={{ position: 'relative', height: '100%' }}>
            {S.ticks.map((t) => (
              <span
                key={t}
                style={{
                  position: 'absolute',
                  left: `${(t / S.max) * 100}%`,
                  top: 7,
                  transform: 'translateX(-50%)',
                  fontFamily: MONO,
                  fontSize: 10,
                  color: T.muted,
                  whiteSpace: 'nowrap',
                }}
              >
                {fmt(t)}
              </span>
            ))}
          </div>
          <div />
        </div>
      </div>
    </div>
  )
}