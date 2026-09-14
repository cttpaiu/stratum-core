// src/lib/pdf-report.ts
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { CheckDBData } from '../routes/check-db'

export function generateDatabaseHealthPDF(data: CheckDBData, dbName: string, projectName: string) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  })

  const total = data.total || 1
  const dbPath = data.db_path || dbName || 'database'
  const dateStr = new Date().toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  // Color Constants
  const COLOR_PRIMARY = [15, 23, 42] // Slate 900
  const COLOR_MUTED = [100, 116, 139] // Slate 500
  const COLOR_EMERALD = [5, 150, 105]
  const COLOR_AMBER = [217, 119, 6]
  const COLOR_ROSE = [220, 38, 38]
  const COLOR_BORDER = [226, 232, 240]

  let currentY = 18

  // 1. Report Title Header Banner
  doc.setFillColor(15, 23, 42)
  doc.rect(14, currentY, 182, 22, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(255, 255, 255)
  doc.text('STRATUM CORE — DATABASE HEALTH & COMPLETENESS REPORT', 18, currentY + 9)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(203, 213, 225)
  doc.text('OpenAlex Relational Integrity, Entity Normalization & Bibliometric Quality Audit', 18, currentY + 16)

  currentY += 27

  // 2. Metadata Information Block
  autoTable(doc, {
    startY: currentY,
    margin: { left: 14, right: 14 },
    theme: 'plain',
    styles: {
      fontSize: 8,
      cellPadding: 2,
      textColor: COLOR_PRIMARY as [number, number, number],
      font: 'helvetica',
    },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 28, textColor: COLOR_MUTED as [number, number, number] },
      1: { cellWidth: 63 },
      2: { fontStyle: 'bold', cellWidth: 28, textColor: COLOR_MUTED as [number, number, number] },
      3: { cellWidth: 63 },
    },
    body: [
      [
        'Target Database:',
        dbName || 'Primary Database',
        'Active Project:',
        projectName || 'default',
      ],
      [
        'Database Path:',
        dbPath,
        'Audit Date:',
        dateStr,
      ],
      [
        'Corpus Scale:',
        `${data.total.toLocaleString()} papers (${data.year_min} – ${data.year_max})`,
        'Linkage Scope:',
        'OpenAlex Relational Tables + Junction Graph',
      ],
    ],
  })

  // @ts-ignore
  currentY = doc.lastAutoTable.finalY + 6

  // Helper function for section headings
  const addSectionHeader = (title: string, subtitle?: string) => {
    // Check for page overflow
    if (currentY > 260) {
      doc.addPage()
      currentY = 20
    }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10.5)
    doc.setTextColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2])
    doc.text(title, 14, currentY)

    if (subtitle) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2])
      doc.text(subtitle, 14, currentY + 4.5)
      currentY += 7.5
    } else {
      currentY += 5
    }
  }

  // 3. Section 1: Relational & Corpus Overview
  addSectionHeader('1. Relational & Corpus Overview', 'Core volume metrics across papers, normalized entities, and contribution linkages')

  const authorOrcidPct = ((data.authors_with_orcid / (data.author_count || 1)) * 100).toFixed(1)
  const instRorPct = ((data.institutions_with_ror / (data.inst_count || 1)) * 100).toFixed(1)

  autoTable(doc, {
    startY: currentY,
    margin: { left: 14, right: 14 },
    theme: 'grid',
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
      cellPadding: 2.5,
    },
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [30, 41, 59],
      lineColor: COLOR_BORDER as [number, number, number],
      lineWidth: 0.2,
    },
    head: [['Entity / Table', 'Record Count', 'Linkage & Detail', 'Corpus Significance']],
    body: [
      ['Papers (`papers`)', data.total.toLocaleString(), `Years: ${data.year_min} – ${data.year_max}`, 'Primary bibliographic work records'],
      ['Authors (`authors`)', data.author_count.toLocaleString(), `${data.authors_with_orcid.toLocaleString()} with ORCID (${authorOrcidPct}%)`, 'Unique researcher profiles identified'],
      ['Institutions (`institutions`)', data.inst_count.toLocaleString(), `${data.institutions_with_ror.toLocaleString()} with ROR ID (${instRorPct}%)`, 'Normalized academic & corporate affiliations'],
      ['Countries (`countries`)', data.country_count.toLocaleString(), 'ISO 3166-1 alpha-2 standard', 'Geographic entity normalizations'],
      ['Contributions (`contributions`)', data.contrib_count.toLocaleString(), 'Author-Paper Junction Rows', 'Granular co-authorship & affiliation links'],
    ],
  })

  // @ts-ignore
  currentY = doc.lastAutoTable.finalY + 7

  // 4. Section 2: Data Completeness Audit
  addSectionHeader('2. Data Completeness Audit', 'Evaluation of critical fields against completeness benchmarks (>=80% Optimal, 50-79% Moderate, <50% Sparse)')

  const getStatusText = (pct: number) => {
    if (pct >= 80) return 'Optimal'
    if (pct >= 50) return 'Moderate'
    return 'Sparse'
  }

  const completenessRows = [
    { table: 'Papers', field: 'Abstract Text Present', count: data.with_abstract, denom: total },
    { table: 'Papers', field: 'Country Info Assigned', count: data.with_country, denom: total },
    { table: 'Papers', field: 'Institution Info Assigned', count: data.with_institution, denom: total },
    { table: 'Authors', field: 'ORCID Identifier Assigned', count: data.authors_with_orcid, denom: data.author_count || 1 },
    { table: 'Institutions', field: 'ROR Identifier Assigned', count: data.institutions_with_ror, denom: data.inst_count || 1 },
    { table: 'Contributions', field: 'Rows with Resolved Country', count: data.contrib_with_country, denom: data.contrib_count || 1 },
    { table: 'Contributions', field: 'Rows with Resolved Institution', count: data.contrib_with_institution, denom: data.contrib_count || 1 },
    { table: 'Contributions', field: 'Rows with Raw Affiliation String', count: data.contrib_with_raw_affiliation, denom: data.contrib_count || 1 },
  ]

  autoTable(doc, {
    startY: currentY,
    margin: { left: 14, right: 14 },
    theme: 'grid',
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
      cellPadding: 2.5,
    },
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [30, 41, 59],
      lineColor: COLOR_BORDER as [number, number, number],
      lineWidth: 0.2,
    },
    columnStyles: {
      0: { cellWidth: 28, fontStyle: 'bold' },
      1: { cellWidth: 64 },
      2: { cellWidth: 30, halign: 'right' },
      3: { cellWidth: 32, halign: 'right' },
      4: { cellWidth: 28, halign: 'center', fontStyle: 'bold' },
    },
    head: [['Table', 'Field / Indicator', 'Available Count', 'Completeness %', 'Status']],
    body: completenessRows.map((r) => {
      const pct = (r.count / r.denom) * 100
      return [
        r.table,
        r.field,
        r.count.toLocaleString(),
        `${pct.toFixed(1)}%`,
        getStatusText(pct),
      ]
    }),
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.column.index === 4) {
        const val = hookData.cell.raw as string
        if (val === 'Optimal') hookData.cell.styles.textColor = COLOR_EMERALD as [number, number, number]
        else if (val === 'Moderate') hookData.cell.styles.textColor = COLOR_AMBER as [number, number, number]
        else if (val === 'Sparse') hookData.cell.styles.textColor = COLOR_ROSE as [number, number, number]
      }
    },
  })

  // @ts-ignore
  currentY = doc.lastAutoTable.finalY + 7

  // 5. Section 3: Institution & Country Coverage
  addSectionHeader('3. Institution & Country Attribution Coverage', 'Full = every co-author resolved | Partial = some authors missing | Zero = no authors resolved')

  const instFull = Math.max(0, total - data.zero_total - data.partial_total)
  const countryFull = Math.max(0, total - data.zero_country_total - data.partial_country_total)

  autoTable(doc, {
    startY: currentY,
    margin: { left: 14, right: 14 },
    theme: 'grid',
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
      cellPadding: 2.5,
    },
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [30, 41, 59],
      lineColor: COLOR_BORDER as [number, number, number],
      lineWidth: 0.2,
    },
    columnStyles: {
      0: { cellWidth: 38, fontStyle: 'bold' },
      1: { cellWidth: 50 },
      2: { cellWidth: 30, halign: 'right' },
      3: { cellWidth: 28, halign: 'right' },
      4: { cellWidth: 36 },
    },
    head: [['Attribution Type', 'Resolution Level', 'Papers Count', 'Share %', 'Coverage Definition']],
    body: [
      ['Institution Attribution', 'Full (Every Author Matched)', instFull.toLocaleString(), `${((instFull / total) * 100).toFixed(1)}%`, 'All co-authors mapped to institutions'],
      ['Institution Attribution', 'Partial (Some Missing)', data.partial_total.toLocaleString(), `${((data.partial_total / total) * 100).toFixed(1)}%`, 'At least 1 matched, but >=1 unassigned'],
      ['Institution Attribution', 'Zero (No Authors Matched)', data.zero_total.toLocaleString(), `${((data.zero_total / total) * 100).toFixed(1)}%`, 'No co-authors mapped to institutions'],
      ['Country Attribution', 'Full (Every Author Matched)', countryFull.toLocaleString(), `${((countryFull / total) * 100).toFixed(1)}%`, 'All co-authors mapped to countries'],
      ['Country Attribution', 'Partial (Some Missing)', data.partial_country_total.toLocaleString(), `${((data.partial_country_total / total) * 100).toFixed(1)}%`, 'At least 1 matched, but >=1 unassigned'],
      ['Country Attribution', 'Zero (No Authors Matched)', data.zero_country_total.toLocaleString(), `${((data.zero_country_total / total) * 100).toFixed(1)}%`, 'No co-authors mapped to countries'],
    ],
  })

  // @ts-ignore
  currentY = doc.lastAutoTable.finalY + 5

  // Sub-table: Zero-Institution Recovery Breakdown
  autoTable(doc, {
    startY: currentY,
    margin: { left: 14, right: 14 },
    theme: 'grid',
    headStyles: {
      fillColor: [71, 85, 105],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.5,
      cellPadding: 2,
    },
    styles: {
      fontSize: 7.5,
      cellPadding: 2,
      textColor: [30, 41, 59],
      lineColor: COLOR_BORDER as [number, number, number],
      lineWidth: 0.2,
    },
    head: [['Zero-Institution Recovery Metric', 'Value', 'Basis / Proportion', 'Recovery Potential']],
    body: [
      ['Imputable Rows (with raw affiliation text)', data.rows_imputable.toLocaleString(), data.contribs_for_zero ? `${((data.rows_imputable / data.contribs_for_zero) * 100).toFixed(1)}% of zero-contribs` : '—', 'Recoverable via Regex / LLM / WoS matching'],
      ['Dead-End Rows (no affiliation text present)', data.rows_dead.toLocaleString(), data.contribs_for_zero ? `${((data.rows_dead / data.contribs_for_zero) * 100).toFixed(1)}% of zero-contribs` : '—', 'Requires external cross-referencing'],
      ['Papers with DOI Handle', data.papers_with_doi.toLocaleString(), data.zero_total ? `${((data.papers_with_doi / data.zero_total) * 100).toFixed(1)}% of zero-papers` : '—', 'Can be enriched via Crossref metadata'],
      ['Papers Imputable (>=1 raw text row)', data.papers_imputable.toLocaleString(), data.zero_total ? `${((data.papers_imputable / data.zero_total) * 100).toFixed(1)}% of zero-papers` : '—', 'High likelihood of partial/full recovery'],
    ],
  })

  // @ts-ignore
  currentY = doc.lastAutoTable.finalY + 7

  // 6. Section 4: Research Quality & Reach
  addSectionHeader('4. Research Quality & Reach Metrics', 'Field-normalized citation impact, international reach, and open access distribution')

  const avgCit = data.avg_citations != null ? Number(data.avg_citations).toFixed(1) : '—'
  const avgFwci = data.avg_fwci != null ? Number(data.avg_fwci).toFixed(2) : '—'

  autoTable(doc, {
    startY: currentY,
    margin: { left: 14, right: 14 },
    theme: 'grid',
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
      cellPadding: 2.5,
    },
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [30, 41, 59],
      lineColor: COLOR_BORDER as [number, number, number],
      lineWidth: 0.2,
    },
    columnStyles: {
      0: { cellWidth: 60, fontStyle: 'bold' },
      1: { cellWidth: 32, halign: 'right' },
      2: { cellWidth: 30, halign: 'right' },
      3: { cellWidth: 60 },
    },
    head: [['Quality & Impact Indicator', 'Papers Count', 'Share %', 'Benchmark / Scope']],
    body: [
      ['Open Access (OA) Published', data.oa_count.toLocaleString(), `${((data.oa_count / total) * 100).toFixed(1)}%`, 'Free public accessibility'],
      ['International Collaboration', data.international_count.toLocaleString(), `${((data.international_count / total) * 100).toFixed(1)}%`, 'Co-authors spanning >= 2 countries'],
      ['Core Journal Publication', data.core_journal_count.toLocaleString(), `${((data.core_journal_count / total) * 100).toFixed(1)}%`, 'Indexed in curated core scientific journals'],
      ['Top 10% Cited Papers (Field-Normalized)', data.top10_count.toLocaleString(), `${((data.top10_count / total) * 100).toFixed(1)}%`, 'Citation volume in top 10th percentile'],
      ['Top 1% Cited Papers (Field-Normalized)', data.top1_count.toLocaleString(), `${((data.top1_count / total) * 100).toFixed(1)}%`, 'Citation volume in top 1st percentile'],
      ['Average Citations per Paper', avgCit, '—', 'Mean raw citation count per paper'],
      ['Average Field-Weighted Impact (FWCI)', avgFwci, '—', 'World average benchmark = 1.00'],
    ],
  })

  // @ts-ignore
  currentY = doc.lastAutoTable.finalY + 5

  // OA Breakdown sub-table if available
  if (data.oa_status_breakdown && data.oa_status_breakdown.length > 0) {
    autoTable(doc, {
      startY: currentY,
      margin: { left: 14, right: 14 },
      theme: 'grid',
      headStyles: {
        fillColor: [71, 85, 105],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 7.5,
        cellPadding: 2,
      },
      styles: {
        fontSize: 7.5,
        cellPadding: 2,
        textColor: [30, 41, 59],
        lineColor: COLOR_BORDER as [number, number, number],
        lineWidth: 0.2,
      },
      columnStyles: {
        0: { cellWidth: 50, fontStyle: 'bold' },
        1: { cellWidth: 35, halign: 'right' },
        2: { cellWidth: 35, halign: 'right' },
        3: { cellWidth: 62 },
      },
      head: [['Open Access Category', 'Count', 'Proportion %', 'Category Definition']],
      body: data.oa_status_breakdown.map(([status, n]) => {
        const desc =
          status === 'gold' ? 'Published in a fully open-access journal' :
          status === 'hybrid' ? 'Published in a subscription journal with an open license' :
          status === 'green' ? 'Toll-access paper self-archived in an open repository' :
          status === 'bronze' ? 'Free to read on publisher page without formal license' :
          status === 'closed' ? 'Restricted access behind a subscription paywall' : 'Open access category'
        return [
          status.toUpperCase(),
          n.toLocaleString(),
          `${((n / total) * 100).toFixed(1)}%`,
          desc,
        ]
      }),
    })

    // @ts-ignore
    currentY = doc.lastAutoTable.finalY + 7
  }

  // 7. Section 5: Top Primary Research Topics
  if (data.top_topics && data.top_topics.length > 0) {
    addSectionHeader('5. Primary Research Topics Distribution', 'Top academic topics classified by OpenAlex topic models')

    autoTable(doc, {
      startY: currentY,
      margin: { left: 14, right: 14 },
      theme: 'grid',
      headStyles: {
        fillColor: [30, 41, 59],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 8,
        cellPadding: 2.5,
      },
      styles: {
        fontSize: 8,
        cellPadding: 2,
        textColor: [30, 41, 59],
        lineColor: COLOR_BORDER as [number, number, number],
        lineWidth: 0.2,
      },
      columnStyles: {
        0: { cellWidth: 16, halign: 'center' },
        1: { cellWidth: 110, fontStyle: 'bold' },
        2: { cellWidth: 28, halign: 'right' },
        3: { cellWidth: 28, halign: 'right' },
      },
      head: [['Rank', 'Topic Name', 'Papers Count', '% Share']],
      body: data.top_topics.slice(0, 15).map((t, idx) => [
        `#${idx + 1}`,
        t.name,
        t.count.toLocaleString(),
        `${((t.count / total) * 100).toFixed(1)}%`,
      ]),
    })

    // @ts-ignore
    currentY = doc.lastAutoTable.finalY + 7
  }

  // 8. Footer & Page Numbers via didDrawPage
  const pageCount = (doc as any).internal.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2])

    // Top subtle bar on pages 2+
    if (i > 1) {
      doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2])
      doc.setLineWidth(0.2)
      doc.line(14, 12, 196, 12)
      doc.text(`Stratum Core — OpenAlex Database Health Audit: ${dbName}`, 14, 9.5)
      doc.text(dateStr, 196, 9.5, { align: 'right' })
    }

    // Bottom footer line
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2])
    doc.setLineWidth(0.2)
    doc.line(14, 287, 196, 287)

    doc.text('Stratum Core Database Health Verification Report · Powered by OpenAlex CLI', 14, 292)
    doc.text(`Page ${i} of ${pageCount}`, 196, 292, { align: 'right' })
  }

  // Save the generated PDF
  const safeName = (dbName || 'database').replace(/\.[^/.]+$/, '')
  doc.save(`${safeName}_health_report.pdf`)
}
