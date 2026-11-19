/** Pure: no node or server imports, since the CLI bundles it. A Storybook's icon props map each option to a component (Primer's `trailingVisual: { HeartIcon: HeartIcon, … }`), and the page only ever shows the component's display name: nothing in argTypes, docgen or story parameters says which package it is imported from. The markup the components render does carry a fingerprint, so the package is read from that. A family not listed here is left for the code mapping to name (`code.props.<p>.component.importFrom`), and the export leaves that prop for the developer. */
const FAMILIES: { package: string; markup: RegExp }[] = [
  /* Primer's Octicons render `<svg class="octicon octicon-heart">`; the component names are `HeartIcon` in @primer/octicons-react */
  { package: '@primer/octicons-react', markup: /<svg\b[^>]*\bclass="(?:[^"]*\s)?octicon(?:\s[^"]*)?"/i },
]

/** The package the icons in this markup come from, when their rendered markup says so. */
export function iconPackageOf(markup: readonly string[]): string | undefined {
  return FAMILIES.find((family) => markup.some((html) => family.markup.test(html)))?.package
}
