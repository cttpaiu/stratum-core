import { useState, useEffect, useRef, useMemo, memo } from 'react'
import * as am5 from '@amcharts/amcharts5'
import * as am5map from '@amcharts/amcharts5/map'
import am5themes_Animated from '@amcharts/amcharts5/themes/Animated'
import am5geodata_worldIndiaLow from '@amcharts/amcharts5-geodata/worldIndiaLow'
import {
  Globe,
  Compass,
  Sun,
  Moon,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Sparkles,
  Flame,
} from 'lucide-react'

export interface BilateralPair {
  countryA: string
  countryB: string
  total: number
  top10: number
  top1: number
  share: number
  isIndia: boolean
  originalRank?: number
}

export interface CountryItem {
  code: string
  name: string
  value: number
  rank?: number
  isIndia?: boolean
  sharePct?: number
  topRate?: number
}

interface GeographicalCollabMapProps {
  mode: 'bilateral' | 'countries'
  bilateralPairs?: BilateralPair[]
  countries?: CountryItem[]
  filterIndiaOnly?: boolean
  hoveredIndex?: number | null
  onHoverIndex?: (index: number | null) => void
}

// Stable, shared default-array identities. Using `= []` directly as a default
// parameter value allocates a brand-new array on every render, which breaks
// memoization downstream (nodes/nodeLookup/countryLookup) and forces the
// map-creation effect to tear down and rebuild the amCharts root on every
// hover-driven re-render of the parent. Module-level constants never change
// identity, so passing them through keeps memoization stable across renders.
const EMPTY_PAIRS: BilateralPair[] = []
const EMPTY_COUNTRIES: CountryItem[] = []

// Global Country Coordinates Database (Longitude, Latitude, Name)
const COUNTRY_COORDS: Record<string, { lon: number; lat: number; name: string }> = {
  US: { lon: -95.7, lat: 37.1, name: 'United States' },
  CN: { lon: 104.2, lat: 35.8, name: 'China' },
  IN: { lon: 78.9, lat: 20.6, name: 'India' },
  GB: { lon: -3.4, lat: 55.4, name: 'United Kingdom' },
  DE: { lon: 10.4, lat: 51.2, name: 'Germany' },
  FR: { lon: 2.2, lat: 46.2, name: 'France' },
  JP: { lon: 138.2, lat: 36.2, name: 'Japan' },
  CA: { lon: -106.3, lat: 56.1, name: 'Canada' },
  AU: { lon: 133.8, lat: -25.3, name: 'Australia' },
  KR: { lon: 127.8, lat: 35.9, name: 'South Korea' },
  SG: { lon: 103.8, lat: 1.35, name: 'Singapore' },
  IT: { lon: 12.6, lat: 41.9, name: 'Italy' },
  ES: { lon: -3.7, lat: 40.5, name: 'Spain' },
  NL: { lon: 5.3, lat: 52.1, name: 'Netherlands' },
  SE: { lon: 18.6, lat: 60.1, name: 'Sweden' },
  CH: { lon: 8.2, lat: 46.8, name: 'Switzerland' },
  BR: { lon: -51.9, lat: -14.2, name: 'Brazil' },
  SA: { lon: 45.1, lat: 23.9, name: 'Saudi Arabia' },
  AE: { lon: 53.8, lat: 23.4, name: 'United Arab Emirates' },
  IR: { lon: 53.7, lat: 32.4, name: 'Iran' },
  RU: { lon: 105.3, lat: 61.5, name: 'Russia' },
  NO: { lon: 8.5, lat: 60.5, name: 'Norway' },
  DK: { lon: 9.5, lat: 56.3, name: 'Denmark' },
  FI: { lon: 25.7, lat: 61.9, name: 'Finland' },
  PL: { lon: 19.1, lat: 51.9, name: 'Poland' },
  IL: { lon: 34.8, lat: 31.0, name: 'Israel' },
  ZA: { lon: 22.9, lat: -30.6, name: 'South Africa' },
  MX: { lon: -102.5, lat: 23.6, name: 'Mexico' },
  TR: { lon: 35.2, lat: 38.9, name: 'Turkey' },
  EG: { lon: 30.8, lat: 26.8, name: 'Egypt' },
  TW: { lon: 120.9, lat: 23.7, name: 'Taiwan' },
  NZ: { lon: 174.9, lat: -40.9, name: 'New Zealand' },
  AR: { lon: -63.6, lat: -38.4, name: 'Argentina' },
  CL: { lon: -71.5, lat: -35.7, name: 'Chile' },
  PT: { lon: -8.2, lat: 39.4, name: 'Portugal' },
  GR: { lon: 21.8, lat: 39.1, name: 'Greece' },
  AT: { lon: 14.5, lat: 47.5, name: 'Austria' },
  BE: { lon: 4.5, lat: 50.5, name: 'Belgium' },
  IE: { lon: -8.2, lat: 53.4, name: 'Ireland' },
  MY: { lon: 101.9, lat: 4.2, name: 'Malaysia' },
  ID: { lon: 113.9, lat: -0.8, name: 'Indonesia' },
  TH: { lon: 100.9, lat: 15.9, name: 'Thailand' },
  VN: { lon: 108.3, lat: 14.1, name: 'Vietnam' },
  PK: { lon: 69.3, lat: 30.4, name: 'Pakistan' },
  BD: { lon: 90.4, lat: 23.7, name: 'Bangladesh' },
  NG: { lon: 8.7, lat: 9.1, name: 'Nigeria' },
  KE: { lon: 37.9, lat: -0.02, name: 'Kenya' },
  CO: { lon: -74.3, lat: 4.6, name: 'Colombia' },
  CZ: { lon: 15.5, lat: 49.8, name: 'Czech Republic' },
  HU: { lon: 19.5, lat: 47.2, name: 'Hungary' },
  RO: { lon: 24.9, lat: 45.9, name: 'Romania' },
  UA: { lon: 31.2, lat: 48.4, name: 'Ukraine' },
  HK: { lon: 114.17, lat: 22.3, name: 'Hong Kong' },
  PH: { lon: 121.0, lat: 14.6, name: 'Philippines' },
  QA: { lon: 51.5, lat: 25.3, name: 'Qatar' },
  KW: { lon: 47.98, lat: 29.37, name: 'Kuwait' },
}

function getCoords(code: string): { lon: number; lat: number; name: string } {
  const upper = code.toUpperCase().trim()
  if (COUNTRY_COORDS[upper]) {
    return COUNTRY_COORDS[upper]
  }
  // Deterministic fallback for unlisted country codes
  let hash = 0
  for (let i = 0; i < upper.length; i++) hash = (hash * 31 + upper.charCodeAt(i)) & 0xffffffff
  const pseudoLon = (Math.abs(hash) % 320) - 160
  const pseudoLat = (Math.abs(hash >> 5) % 100) - 50
  return { lon: pseudoLon, lat: pseudoLat, name: upper }
}

function GeographicalCollabMapImpl({
  mode,
  bilateralPairs = EMPTY_PAIRS,
  countries = EMPTY_COUNTRIES,
  filterIndiaOnly = false,
  hoveredIndex = null,
  onHoverIndex,
}: GeographicalCollabMapProps) {
  const chartDivRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<am5map.MapChart | null>(null)
  const lineSeriesRef = useRef<am5map.MapLineSeries | null>(null)
  const [mapTheme, setMapTheme] = useState<'light' | 'dark'>('light')
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(null)
  const isLight = mapTheme === 'light'

  // Filter pairs
  const activePairs = useMemo(() => {
    let list = bilateralPairs
    if (filterIndiaOnly) {
      list = list.filter((p) => p.isIndia)
    }
    return list
  }, [bilateralPairs, filterIndiaOnly])

  // Process unique nodes involved in collaboration
  const nodes = useMemo(() => {
    const nodeMap = new Map<
      string,
      {
        code: string
        lon: number
        lat: number
        name: string
        isIndia: boolean
        total: number
        top1: number
        top10: number
        partners: Set<string>
      }
    >()

    activePairs.forEach((p) => {
      const codeA = p.countryA.toUpperCase().trim()
      const codeB = p.countryB.toUpperCase().trim()
      const coordA = getCoords(codeA)
      const coordB = getCoords(codeB)

      if (!nodeMap.has(codeA)) {
        nodeMap.set(codeA, {
          code: codeA,
          lon: coordA.lon,
          lat: coordA.lat,
          name: coordA.name,
          isIndia: codeA === 'IN',
          total: 0,
          top1: 0,
          top10: 0,
          partners: new Set(),
        })
      }
      if (!nodeMap.has(codeB)) {
        nodeMap.set(codeB, {
          code: codeB,
          lon: coordB.lon,
          lat: coordB.lat,
          name: coordB.name,
          isIndia: codeB === 'IN',
          total: 0,
          top1: 0,
          top10: 0,
          partners: new Set(),
        })
      }

      const nA = nodeMap.get(codeA)!
      const nB = nodeMap.get(codeB)!
      nA.total += p.total
      nA.top1 += p.top1
      nA.top10 += p.top10
      nA.partners.add(codeB)

      nB.total += p.total
      nB.top1 += p.top1
      nB.top10 += p.top10
      nB.partners.add(codeA)
    })

    const maxNodeTotal = Array.from(nodeMap.values()).reduce((m, n) => Math.max(m, n.total), 1)

    return Array.from(nodeMap.values()).map((n) => ({
      ...n,
      radius: Math.max(Math.min((n.total / maxNodeTotal) * 12 + 4, 15), 5),
    }))
  }, [activePairs])

  // Lookup Maps for instant O(1) hover access from polygon or node
  const nodeLookup = useMemo(() => {
    const map = new Map<string, (typeof nodes)[0]>()
    nodes.forEach((n) => {
      map.set(n.code.toUpperCase(), n)
    })
    return map
  }, [nodes])

  const countryLookup = useMemo(() => {
    const map = new Map<string, CountryItem>()
    countries.forEach((c) => {
      map.set(c.code.toUpperCase().trim(), c)
    })
    return map
  }, [countries])

  // Initialize and update amCharts 5 map
  useEffect(() => {
    if (!chartDivRef.current) return

    // 1. Create root element
    const root = am5.Root.new(chartDivRef.current)
    root.setThemes([am5themes_Animated.new(root)])

    // 2. Create Map Chart with Natural Earth projection
    const chart = root.container.children.push(
      am5map.MapChart.new(root, {
        panX: 'translateX',
        panY: 'translateY',
        projection: am5map.geoNaturalEarth1(),
        minZoomLevel: 0.9,
        maxZoomLevel: 25,
        wheelSensitivity: 0.7,
      }),
    )
    chartRef.current = chart

    // 3. Create World Polygon Series using @amcharts/amcharts5-geodata/worldIndiaLow
    const polygonSeries = chart.series.push(
      am5map.MapPolygonSeries.new(root, {
        geoJSON: am5geodata_worldIndiaLow,
        exclude: ['AQ'], // Antarctica excluded for clean focus
      }),
    )

    // Base polygon styling: subtle and clean with country name
    polygonSeries.mapPolygons.template.setAll({
      tooltipText: '{name}',
      interactive: true,
      fill: isLight ? am5.color(0xf4f4f5) : am5.color(0x18181b),
      stroke: isLight ? am5.color(0xe4e4e7) : am5.color(0x27272a),
      strokeWidth: 0.7,
    })

    // Custom Tooltip for country polygons
    const polygonTooltip = am5.Tooltip.new(root, {
      labelText: '{tooltipText}',
      getFillFromSprite: false,
      autoTextColor: false,
    })
    polygonTooltip.get('background')?.setAll({
      fill: isLight ? am5.color(0xffffff) : am5.color(0x18181b),
      fillOpacity: 0.95,
      stroke: isLight ? am5.color(0xe4e4e7) : am5.color(0x3f3f46),
      strokeWidth: 1,
      shadowColor: am5.color(0x000000),
      shadowBlur: 6,
      shadowOpacity: 0.15,
    })
    polygonTooltip.label.setAll({
      fill: isLight ? am5.color(0x18181b) : am5.color(0xf4f4f5),
      fontFamily: 'monospace',
      fontSize: 11,
    })
    polygonSeries.set('tooltip', polygonTooltip)

    // Highlight countries that have active collaborations with a distinctive palette
    polygonSeries.mapPolygons.template.adapters.add('fill', (_fill, target) => {
      const dataItem = target.dataItem
      if (dataItem) {
        const ctx = dataItem.dataContext as any
        const code = (ctx?.id || '').toUpperCase()
        if (code === 'IN') {
          return isLight ? am5.color(0xffedd5) : am5.color(0x431407) // India Saffron Tint
        }
        if (mode === 'bilateral' && nodeLookup.has(code)) {
          return isLight ? am5.color(0xe0f2fe) : am5.color(0x0c253d) // Active partner sky blue tint
        }
        if (mode === 'countries' && countryLookup.has(code)) {
          return isLight ? am5.color(0xe0f2fe) : am5.color(0x0c253d)
        }
      }
      return isLight ? am5.color(0xf4f4f5) : am5.color(0x18181b)
    })

    polygonSeries.mapPolygons.template.adapters.add('stroke', (_stroke, target) => {
      const dataItem = target.dataItem
      if (dataItem) {
        const ctx = dataItem.dataContext as any
        const code = (ctx?.id || '').toUpperCase()
        if (code === 'IN') {
          return am5.color(0xf97316)
        }
        if (mode === 'bilateral' && nodeLookup.has(code)) {
          return isLight ? am5.color(0x7dd3fc) : am5.color(0x0284c7)
        }
        if (mode === 'countries' && countryLookup.has(code)) {
          return isLight ? am5.color(0x7dd3fc) : am5.color(0x0284c7)
        }
      }
      return isLight ? am5.color(0xe4e4e7) : am5.color(0x27272a)
    })

    // Hover visual state: Luminous amber glow on polygon
    polygonSeries.mapPolygons.template.states.create('hover', {
      fill: isLight ? am5.color(0xfef08a) : am5.color(0x854d0e),
      stroke: am5.color(0xf59e0b),
      strokeWidth: 1.5,
    })

    // 4. Create Line Series for Bilateral Co-authorship Corridors
    // NOTE: interactive: false so lines never show tooltips or block pointing over country bulbs
    if (mode === 'bilateral') {
      const lineSeries = chart.series.push(
        am5map.MapLineSeries.new(root, {
          lineType: 'curved',
        }),
      )
      lineSeriesRef.current = lineSeries

      lineSeries.mapLines.template.setAll({
        interactive: false, // Absolutely no tooltip or mouse capture on flight lines!
      })

      // Dynamic line color and width
      lineSeries.mapLines.template.adapters.add('stroke', (stroke, target) => {
        const dataItem = target.dataItem
        if (dataItem) {
          const ctx = dataItem.dataContext as any
          if (ctx?.isIndia) {
            return am5.color(0xf97316) // Vibrant Saffron / Orange for India corridors
          }
          return isLight ? am5.color(0x0284c7) : am5.color(0x38bdf8) // Blue for global corridors
        }
        return stroke
      })

      lineSeries.mapLines.template.adapters.add('strokeWidth', (strokeWidth, target) => {
        const dataItem = target.dataItem
        if (dataItem) {
          const ctx = dataItem.dataContext as any
          return ctx?.width || strokeWidth
        }
        return strokeWidth
      })

      lineSeries.mapLines.template.adapters.add('strokeOpacity', (opacity, target) => {
        const dataItem = target.dataItem
        if (dataItem) {
          const ctx = dataItem.dataContext as any
          return ctx?.isIndia ? 0.9 : isLight ? 0.65 : 0.5
        }
        return opacity
      })

      lineSeries.mapLines.template.states.create('hover', {
        strokeWidth: 4.5,
        strokeOpacity: 1,
        stroke: am5.color(0xf59e0b),
      })

      lineSeries.mapLines.template.states.create('dimmed', {
        strokeOpacity: 0.12,
      })

      // Populate line data
      const maxCollab = activePairs.reduce((m, p) => Math.max(m, p.total), 1)
      const lineData = activePairs.map((p, idx) => {
        const coordA = getCoords(p.countryA)
        const coordB = getCoords(p.countryB)
        const top1Pct = ((p.top1 / Math.max(p.total, 1)) * 100).toFixed(1)
        const top10Pct = ((p.top10 / Math.max(p.total, 1)) * 100).toFixed(1)
        const width = Math.max((p.total / maxCollab) * 3.8 + 1.2, 1.4)

        return {
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [coordA.lon, coordA.lat],
              [coordB.lon, coordB.lat],
            ],
          },
          title: `${coordA.name} (${p.countryA}) ⟷ ${coordB.name} (${p.countryB})`,
          countryA: p.countryA.toUpperCase().trim(),
          countryB: p.countryB.toUpperCase().trim(),
          total: p.total.toLocaleString(),
          top1: p.top1.toLocaleString(),
          top1Pct,
          top10: p.top10.toLocaleString(),
          top10Pct,
          share: p.share.toFixed(2),
          isIndia: p.isIndia,
          width,
          pairIndex: idx,
        }
      })

      lineSeries.data.setAll(lineData)

      // 5. Create Point Series for Country Center Bulbs (rendered ON TOP of lines)
      const pointSeries = chart.series.push(
        am5map.MapPointSeries.new(root, {}),
      )

      // Dedicated High-Contrast Tooltip for Country Bulbs
      const bulbTooltip = am5.Tooltip.new(root, {
        labelText: '{tooltipText}',
        getFillFromSprite: false,
        autoTextColor: false,
      })
      bulbTooltip.get('background')?.setAll({
        fill: isLight ? am5.color(0xffffff) : am5.color(0x18181b),
        fillOpacity: 0.98,
        stroke: isLight ? am5.color(0xe4e4e7) : am5.color(0x3f3f46),
        strokeWidth: 1.2,
        shadowColor: am5.color(0x000000),
        shadowBlur: 10,
        shadowOpacity: 0.25,
      })
      bulbTooltip.label.setAll({
        fill: isLight ? am5.color(0x18181b) : am5.color(0xf4f4f5),
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.45,
      })
      pointSeries.set('tooltip', bulbTooltip)

      pointSeries.bullets.push((bRoot, _series, dataItem) => {
        const ctx = dataItem.dataContext as any
        const isIndia = ctx?.isIndia

        const container = am5.Container.new(bRoot, {
          interactive: true,
          cursorOverStyle: 'pointer',
          tooltipText:
            '[bold font-size: 13px]{name} ({code})[/]\n' +
            '[#10b981]Total Joint Papers:[/] [bold]{total}[/]\n' +
            'Partner Nations: [bold]{partnerCount}[/] ({partnersList})\n' +
            '[#f59e0b]Top 1% Elite Papers:[/] [bold]{top1}[/] ({top1Pct}%)\n' +
            '[#0284c7]Top 10% Impact Papers:[/] [bold]{top10}[/] ({top10Pct}%)',
        })

        // Generous invisible hit zone (radius 22px = 44px wide target) to make pointing effortless
        container.children.push(
          am5.Circle.new(bRoot, {
            radius: 22,
            fill: am5.color(0x000000),
            fillOpacity: 0.001,
          }),
        )

        // Pulsing radar glow beacon for all country center bulbs
        const pulse = container.children.push(
          am5.Circle.new(bRoot, {
            radius: (ctx?.radius || 7) + 2,
            fill: isIndia ? am5.color(0xf97316) : am5.color(0x0284c7),
            opacity: 0.5,
          }),
        )
        pulse.animate({
          key: 'radius',
          to: (ctx?.radius || 7) + (isIndia ? 16 : 12),
          duration: isIndia ? 1600 : 2200,
          loops: Infinity,
          easing: am5.ease.out(am5.ease.cubic),
        })
        pulse.animate({
          key: 'opacity',
          to: 0,
          duration: isIndia ? 1600 : 2200,
          loops: Infinity,
          easing: am5.ease.out(am5.ease.cubic),
        })

        // Outer glow halo ring
        container.children.push(
          am5.Circle.new(bRoot, {
            radius: (ctx?.radius || 7) + 3,
            fill: isIndia ? am5.color(0xf97316) : am5.color(0x0284c7),
            opacity: 0.3,
          }),
        )

        // Main luminous Center Bulb
        const bulb = container.children.push(
          am5.Circle.new(bRoot, {
            radius: ctx?.radius || 7,
            fill: isIndia
              ? am5.color(0xea580c)
              : isLight
                ? am5.color(0x0284c7)
                : am5.color(0x38bdf8),
            stroke: am5.color(0xffffff),
            strokeWidth: 2,
            shadowColor: am5.color(0x000000),
            shadowBlur: 6,
            shadowOpacity: 0.35,
          }),
        )

        // Pointer hover effects on the center bulb
        container.events.on('pointerover', () => {
          bulb.animate({ key: 'scale', to: 1.35, duration: 150 })
          if (ctx?.code) {
            setHoveredCountryCode(ctx.code.toUpperCase())
          }
        })

        container.events.on('pointerout', () => {
          bulb.animate({ key: 'scale', to: 1.0, duration: 150 })
          setHoveredCountryCode(null)
        })

        // Country ISO code badge below bulb
        container.children.push(
          am5.Label.new(bRoot, {
            text: '{code}',
            populateText: true,
            fontWeight: 'bold',
            fontSize: 9,
            fontFamily: 'monospace',
            fill: isLight ? am5.color(0x18181b) : am5.color(0xf4f4f5),
            centerX: am5.p50,
            centerY: am5.p0,
            dy: (ctx?.radius || 7) + 4,
          }),
        )

        return am5.Bullet.new(bRoot, {
          sprite: container,
        })
      })

      // Populate Point Data with formatted metrics and partners summary
      const pointData = nodes.map((n) => {
        const top1Pct = ((n.top1 / Math.max(n.total, 1)) * 100).toFixed(1)
        const top10Pct = ((n.top10 / Math.max(n.total, 1)) * 100).toFixed(1)
        const partnersList = Array.from(n.partners).slice(0, 5).join(', ')
        const morePartners = n.partners.size > 5 ? ` +${n.partners.size - 5} more` : ''

        return {
          geometry: {
            type: 'Point' as const,
            coordinates: [n.lon, n.lat],
          },
          code: n.code,
          name: n.name,
          total: n.total.toLocaleString(),
          top1: n.top1.toLocaleString(),
          top1Pct,
          top10: n.top10.toLocaleString(),
          top10Pct,
          partnerCount: n.partners.size,
          partnersList: `${partnersList}${morePartners}`,
          isIndia: n.isIndia,
          radius: n.radius,
        }
      })

      pointSeries.data.setAll(pointData)
    } else if (mode === 'countries') {
      // Countries Output Bubble Series
      const pointSeries = chart.series.push(
        am5map.MapPointSeries.new(root, {}),
      )

      const bulbTooltip = am5.Tooltip.new(root, {
        labelText: '{tooltipText}',
        getFillFromSprite: false,
        autoTextColor: false,
      })
      bulbTooltip.get('background')?.setAll({
        fill: isLight ? am5.color(0xffffff) : am5.color(0x18181b),
        fillOpacity: 0.98,
        stroke: isLight ? am5.color(0xe4e4e7) : am5.color(0x3f3f46),
        strokeWidth: 1.2,
        shadowColor: am5.color(0x000000),
        shadowBlur: 10,
        shadowOpacity: 0.25,
      })
      bulbTooltip.label.setAll({
        fill: isLight ? am5.color(0x18181b) : am5.color(0xf4f4f5),
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.45,
      })
      pointSeries.set('tooltip', bulbTooltip)

      const maxVal = countries.reduce((m, c) => Math.max(m, c.value), 1)

      pointSeries.bullets.push((bRoot, _series, dataItem) => {
        const ctx = dataItem.dataContext as any
        const isIndia = ctx?.isIndia

        const container = am5.Container.new(bRoot, {
          interactive: true,
          cursorOverStyle: 'pointer',
          tooltipText:
            '[bold font-size: 13px]{name} ({code})[/]\n' +
            'Total Publications: [bold]{value}[/]\n' +
            'Global Share: [bold]{share}%[/]',
        })

        // Generous invisible hit zone
        container.children.push(
          am5.Circle.new(bRoot, {
            radius: 22,
            fill: am5.color(0x000000),
            fillOpacity: 0.001,
          }),
        )

        container.events.on('pointerover', () => {
          if (ctx?.code) {
            setHoveredCountryCode(ctx.code.toUpperCase())
          }
        })
        container.events.on('pointerout', () => {
          setHoveredCountryCode(null)
        })

        container.children.push(
          am5.Circle.new(bRoot, {
            radius: (ctx?.radius || 7) + 3,
            fill: isIndia ? am5.color(0xf97316) : am5.color(0x0284c7),
            opacity: 0.3,
          }),
        )

        const bulb = container.children.push(
          am5.Circle.new(bRoot, {
            radius: ctx?.radius || 7,
            fill: isIndia
              ? am5.color(0xea580c)
              : isLight
                ? am5.color(0x0284c7)
                : am5.color(0x38bdf8),
            stroke: am5.color(0xffffff),
            strokeWidth: 2,
            shadowColor: am5.color(0x000000),
            shadowBlur: 6,
            shadowOpacity: 0.35,
          }),
        )

        container.events.on('pointerover', () => {
          bulb.animate({ key: 'scale', to: 1.35, duration: 150 })
        })
        container.events.on('pointerout', () => {
          bulb.animate({ key: 'scale', to: 1.0, duration: 150 })
        })

        container.children.push(
          am5.Label.new(bRoot, {
            text: '{code}',
            populateText: true,
            fontWeight: 'bold',
            fontSize: 9,
            fontFamily: 'monospace',
            fill: isLight ? am5.color(0x18181b) : am5.color(0xf4f4f5),
            centerX: am5.p50,
            centerY: am5.p0,
            dy: (ctx?.radius || 7) + 4,
          }),
        )

        return am5.Bullet.new(bRoot, {
          sprite: container,
        })
      })

      const countryData = countries.map((c) => {
        const coord = getCoords(c.code)
        const radius = Math.max(Math.min((c.value / maxVal) * 16 + 5, 20), 5)
        return {
          geometry: {
            type: 'Point' as const,
            coordinates: [coord.lon, coord.lat],
          },
          code: c.code,
          name: c.name || coord.name,
          value: c.value.toLocaleString(),
          share: (c.sharePct ?? (c.value / maxVal) * 100).toFixed(1),
          isIndia: c.isIndia || c.code.toUpperCase() === 'IN',
          radius,
        }
      })

      pointSeries.data.setAll(countryData)
    }

    // Set initial animation
    chart.appear(800, 100)

    // Cleanup on unmount or re-render
    return () => {
      chartRef.current = null
      lineSeriesRef.current = null
      root.dispose()
    }
  }, [mode, activePairs, nodes, nodeLookup, countries, countryLookup, isLight, onHoverIndex])

  // Reactive Effect: Highlight corridors connected to hovered country OR hovered pair
  useEffect(() => {
    if (!lineSeriesRef.current) return
    const dataItems = lineSeriesRef.current.dataItems
    dataItems.forEach((di, idx) => {
      const mapLine = di.get('mapLine')
      if (!mapLine) return
      const ctx = di.dataContext as any
      const isCorridorHovered =
        hoveredIndex !== null && hoveredIndex !== undefined && idx === hoveredIndex
      const isCountryConnected =
        hoveredCountryCode !== null &&
        hoveredCountryCode !== undefined &&
        (ctx?.countryA === hoveredCountryCode || ctx?.countryB === hoveredCountryCode)

      if (hoveredIndex === null && hoveredCountryCode === null) {
        mapLine.states.applyAnimate('default')
      } else if (isCorridorHovered || isCountryConnected) {
        mapLine.states.applyAnimate('hover')
      } else {
        mapLine.states.applyAnimate('dimmed')
      }
    })
  }, [hoveredIndex, hoveredCountryCode])

  // Custom Zoom Handlers
  const handleZoomIn = () => {
    if (chartRef.current) chartRef.current.zoomIn()
  }

  const handleZoomOut = () => {
    if (chartRef.current) chartRef.current.zoomOut()
  }

  const handleResetZoom = () => {
    if (chartRef.current) chartRef.current.goHome()
  }

  // Active hover pair object (from corridor list/hover)
  const activePair =
    hoveredIndex !== null && hoveredIndex !== undefined && activePairs[hoveredIndex]
      ? activePairs[hoveredIndex]
      : null

  // Active hover country object (from map polygon or node pin hover)
  const activeHoverCountry = hoveredCountryCode ? nodeLookup.get(hoveredCountryCode) : null

  return (
    <div
      className={`relative w-full rounded border transition-colors duration-200 overflow-hidden shadow-xs select-none font-mono ${
        isLight
          ? 'bg-white border-zinc-200 text-zinc-900'
          : 'bg-zinc-950 border-zinc-800 text-zinc-100'
      }`}
    >
      {/* Header Info Strip */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b text-xs transition-colors duration-200 ${
          isLight
            ? 'bg-zinc-50/80 border-zinc-200 text-zinc-700'
            : 'bg-zinc-900/90 border-zinc-800 text-zinc-200'
        }`}
      >
        <div className="flex items-center gap-2">
          <div
            className={`w-6 h-6 rounded flex items-center justify-center border ${
              isLight
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-emerald-950/40 text-emerald-400 border-emerald-800/40'
            }`}
          >
            <Compass className="h-3.5 w-3.5" />
          </div>
          <div>
            <span
              className={`font-bold uppercase tracking-tight text-[11px] block ${
                isLight ? 'text-zinc-900' : 'text-zinc-100'
              }`}
            >
              {mode === 'bilateral'
                ? 'Global Bilateral Collaboration Network Map'
                : 'Global Scientometric Research Output Map'}
            </span>
            <span className="text-[10px] text-zinc-400">
              {mode === 'bilateral'
                ? 'Interactive cross-border co-authorship arcs & country scientometrics (Hover any country)'
                : 'Geographic national publication volume distribution'}
            </span>
          </div>
        </div>

        {/* Legend & Controls */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-3 text-[10px]">
            {mode === 'bilateral' ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-1 rounded-full bg-orange-500 shadow-[0_0_8px_#f97316]" />
                  <span className="text-orange-600 dark:text-orange-400 font-bold">India Corridor</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-2.5 h-1 rounded-full ${
                      isLight ? 'bg-sky-600' : 'bg-sky-400'
                    }`}
                  />
                  <span className={isLight ? 'text-zinc-600' : 'text-zinc-300'}>Global Corridor</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  <span className="text-amber-600 dark:text-amber-400">Top 1% Elite</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-orange-500" />
                  <span className="text-orange-600 dark:text-orange-400 font-bold">India Output</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-sky-500" />
                  <span className={isLight ? 'text-zinc-600' : 'text-zinc-300'}>National Output</span>
                </div>
              </>
            )}
          </div>

          {/* Theme Toggle Button: Light vs Dark Map */}
          <div
            className={`flex items-center rounded border p-0.5 text-[10px] font-mono shadow-2xs ${
              isLight
                ? 'bg-zinc-200/70 border-zinc-300'
                : 'bg-zinc-900 border-zinc-800'
            }`}
          >
            <button
              type="button"
              onClick={() => setMapTheme('light')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition cursor-pointer ${
                isLight
                  ? 'bg-white text-zinc-900 font-bold shadow-2xs'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Clean White / Light Map Theme"
            >
              <Sun className="h-2.5 w-2.5 text-amber-500" />
              <span>Light</span>
            </button>
            <button
              type="button"
              onClick={() => setMapTheme('dark')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition cursor-pointer ${
                !isLight
                  ? 'bg-zinc-800 text-zinc-100 font-bold shadow-2xs'
                  : 'text-zinc-500 hover:text-zinc-800'
              }`}
              title="Dark Night Map Theme"
            >
              <Moon className="h-2.5 w-2.5 text-sky-400" />
              <span>Dark</span>
            </button>
          </div>
        </div>
      </div>

      {/* amCharts Map Canvas Container */}
      <div
        className={`relative w-full aspect-[2/1] min-h-[420px] max-h-[600px] transition-colors duration-200 overflow-hidden ${
          isLight ? 'bg-white' : 'bg-zinc-950'
        }`}
      >
        <div ref={chartDivRef} className="w-full h-full" />

        {/* Floating Zoom & Map Navigation Controls */}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xs p-1 rounded-md border border-zinc-200 dark:border-zinc-800 shadow-md">
          <button
            type="button"
            onClick={handleZoomIn}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 transition cursor-pointer"
            title="Zoom In (+)"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 transition cursor-pointer"
            title="Zoom Out (-)"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <div className="w-[1px] h-3 bg-zinc-200 dark:bg-zinc-700 my-auto" />
          <button
            type="button"
            onClick={handleResetZoom}
            className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-[10px] font-mono transition cursor-pointer"
            title="Reset to Initial View"
          >
            <RotateCcw className="h-3 w-3" />
            <span className="hidden sm:inline">Reset</span>
          </button>
        </div>

        {/* FLOATING HUD TOOLTIP: Active Hovered Bilateral Pair */}
        {activePair && (
          <div
            className={`absolute top-4 right-4 z-30 p-3 rounded-lg border shadow-xl backdrop-blur-md max-w-xs text-xs font-mono animate-fadeIn ${
              isLight
                ? 'bg-white/95 border-zinc-200 text-zinc-900 shadow-zinc-300/50'
                : 'bg-zinc-900/95 border-zinc-700 text-zinc-100'
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-1.5 mb-2 ${
                isLight ? 'border-zinc-200' : 'border-zinc-800'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    activePair.countryA === 'IN'
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  {activePair.countryA}
                </span>
                <span className="text-zinc-400 text-[10px]">⟷</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    activePair.countryB === 'IN'
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  {activePair.countryB}
                </span>
              </div>
              {activePair.isIndia && (
                <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-orange-100 dark:bg-orange-950/60 text-orange-700 dark:text-orange-300 border border-orange-300 dark:border-orange-800">
                  India Pair
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Total Joint Publications:</span>
                <strong
                  className={
                    activePair.isIndia
                      ? 'text-orange-600 dark:text-orange-400 font-bold'
                      : 'text-zinc-900 dark:text-zinc-100 font-bold'
                  }
                >
                  {activePair.total.toLocaleString()} papers
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                  <Flame className="h-3 w-3 text-amber-500" />
                  Top 1% Elite:
                </span>
                <span className="text-amber-600 dark:text-amber-400 font-bold">
                  {activePair.top1.toLocaleString()} (
                  {((activePair.top1 / Math.max(activePair.total, 1)) * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-sky-500" />
                  Top 10% Impact:
                </span>
                <span className="text-sky-600 dark:text-sky-400 font-bold">
                  {activePair.top10.toLocaleString()} (
                  {((activePair.top10 / Math.max(activePair.total, 1)) * 100).toFixed(1)}%)
                </span>
              </div>
              <div
                className={`flex items-center justify-between pt-1 border-t text-[10px] ${
                  isLight ? 'border-zinc-100 text-zinc-500' : 'border-zinc-800 text-zinc-400'
                }`}
              >
                <span>Global Corridor Share:</span>
                <span className="font-bold text-zinc-800 dark:text-zinc-200">
                  {activePair.share.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        )}

        {/* FLOATING HUD TOOLTIP: Active Hovered Country Details */}
        {!activePair && activeHoverCountry && (
          <div
            className={`absolute top-4 right-4 z-30 p-3 rounded-lg border shadow-xl backdrop-blur-md max-w-xs text-xs font-mono animate-fadeIn ${
              isLight
                ? 'bg-white/95 border-zinc-200 text-zinc-900 shadow-zinc-300/50'
                : 'bg-zinc-900/95 border-zinc-700 text-zinc-100'
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-1.5 mb-2 ${
                isLight ? 'border-zinc-200' : 'border-zinc-800'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    activeHoverCountry.isIndia
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  {activeHoverCountry.code}
                </span>
                <div>
                  <span
                    className={`font-bold text-xs block ${
                      activeHoverCountry.isIndia
                        ? 'text-orange-600 dark:text-orange-400'
                        : 'text-zinc-900 dark:text-zinc-100'
                    }`}
                  >
                    {activeHoverCountry.name}
                  </span>
                  <span className="text-[10px] text-zinc-400">
                    {activeHoverCountry.partners.size} Active Partner Nations
                  </span>
                </div>
              </div>
              {activeHoverCountry.isIndia && (
                <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-orange-100 dark:bg-orange-950/60 text-orange-700 dark:text-orange-300 border border-orange-300 dark:border-orange-800">
                  India Hub
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Total Joint Publications:</span>
                <strong
                  className={
                    activeHoverCountry.isIndia
                      ? 'text-orange-600 dark:text-orange-400 font-bold'
                      : 'text-zinc-900 dark:text-zinc-100 font-bold'
                  }
                >
                  {activeHoverCountry.total.toLocaleString()} papers
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                  <Flame className="h-3 w-3 text-amber-500" />
                  Top 1% Elite:
                </span>
                <span className="text-amber-600 dark:text-amber-400 font-bold">
                  {activeHoverCountry.top1.toLocaleString()} (
                  {((activeHoverCountry.top1 / Math.max(activeHoverCountry.total, 1)) * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-sky-500" />
                  Top 10% Impact:
                </span>
                <span className="text-sky-600 dark:text-sky-400 font-bold">
                  {activeHoverCountry.top10.toLocaleString()} (
                  {((activeHoverCountry.top10 / Math.max(activeHoverCountry.total, 1)) * 100).toFixed(1)}%)
                </span>
              </div>
              <div
                className={`pt-1.5 border-t text-[10px] flex items-center justify-between ${
                  isLight ? 'border-zinc-100 text-zinc-500' : 'border-zinc-800 text-zinc-400'
                }`}
              >
                <span>Partner Corridors:</span>
                <span className="font-bold text-zinc-700 dark:text-zinc-300 truncate max-w-[140px]" title={Array.from(activeHoverCountry.partners).join(', ')}>
                  {Array.from(activeHoverCountry.partners).slice(0, 5).join(', ')}
                  {activeHoverCountry.partners.size > 5 ? ` +${activeHoverCountry.partners.size - 5}` : ''}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Projection Info Watermark */}
        <div
          className={`absolute bottom-2 right-3 flex items-center gap-1.5 text-[9px] font-mono pointer-events-none select-none ${
            isLight ? 'text-zinc-400' : 'text-zinc-500'
          }`}
        >
          <Globe className="h-3 w-3" />
          <span>amCharts 5 Natural Earth Geodesic Network</span>
        </div>
      </div>
    </div>
  )
}

// Memoized so that a parent re-render with referentially-unchanged props
// (e.g. hovering an unrelated part of the page) never re-invokes this
// component, let alone the map-creation effect inside it.
export const GeographicalCollabMap = memo(GeographicalCollabMapImpl)