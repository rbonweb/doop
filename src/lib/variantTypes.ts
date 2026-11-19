import type { VariantOp } from '../../shared/componentSchemas'
import type { ComponentDef } from '../../shared/components'

export type { VariantOp }

/** A variant prop of a main as the variants endpoint reads it: an enum, or a boolean that shows on the instance root. */
export interface VariantProp {
  name: string
  type: 'enum' | 'boolean'
  options: string[]
  default?: string
  description?: string
}

/** A style rule under one combination of variant values (`element` null is the main root). `custom` rules are hand-written. */
export interface VariantRule {
  selector: string
  when: Record<string, string>
  element?: string | null
  declarations: Record<string, string>
  custom?: true
}

export interface VariantsRead {
  props: VariantProp[]
  rules: VariantRule[]
}

export interface VariantsEdit {
  ops: VariantOp[]
  expectedRev?: number
  /** report what would change (the instances rewritten) and write nothing */
  dryRun?: boolean
}

export interface VariantsEditResult extends VariantsRead {
  component: ComponentDef
  instances_updated: number
  frames_updated: number
}
