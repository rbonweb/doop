import type { ExportIssue } from './issues.ts'

export type ReactStyling = 'modules' | 'tailwind'

/** What an export did, for `export-report.json` and for the surfaces to show. Every string in it is data, never code. */
export interface ExportReport {
  styling: ReactStyling
  /** every component the export reached: generated (`file`) or imported from the team's package (`importedFrom`, `exportName`) */
  components: { id: string; name: string; file?: string; importedFrom?: string; exportName?: string }[]
  pages: { frameId: string; name: string; file: string }[]
  /** every converter issue, tagged with the file it concerns */
  issues: (ExportIssue & { file: string })[]
  /** instances exported with their markup inlined because of deep part overrides */
  inlined: { file: string; component: string; reason: string }[]
}

export function emptyReport(styling: ReactStyling): ExportReport {
  return { styling, components: [], pages: [], issues: [], inlined: [] }
}

/** Issues are sorted by file, then in the order found, so two runs write the same report. */
export function sortReport(report: ExportReport): ExportReport {
  const byFile = <T extends { file: string }>(items: T[]): T[] =>
    items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (a.item.file < b.item.file ? -1 : a.item.file > b.item.file ? 1 : a.index - b.index))
      .map(({ item }) => item)
  return {
    ...report,
    components: [...report.components].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1,
    ),
    issues: byFile(report.issues),
    inlined: byFile(report.inlined),
  }
}
