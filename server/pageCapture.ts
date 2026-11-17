/** What an imported page becomes before it is stored: passive HTML. Both functions here run inside the page (`page.evaluate`), so each is self-contained and may use only what the page has. */

export interface DocumentSnapshot {
  /** the document's base URL before its own `<base>` tags are removed */
  baseUrl: string
  /** absolute URLs of the stylesheets the page links, in order */
  sheets: string[]
  title: string
  height: number
  html: string
}

/** Strips a document down to passive HTML and reads it out. Scripts, frames, objects, `meta http-equiv`, inline handlers, `srcdoc`, `ping` and `javascript:` URLs would otherwise run again inside the canvas iframe, and `link` and `base` tags are removed after their stylesheets and base URL are read. Mutates the live document. */
export function snapshotDocument(maxHeight: number): DocumentSnapshot {
  for (const el of document.querySelectorAll(
    'script, noscript, iframe, frame, frameset, object, embed, applet, portal, fencedframe',
  ))
    el.remove()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[http-equiv]')) meta.remove()

  /* A snapshot is passive HTML. Inline handlers and executable URL
     schemes would otherwise run again inside the canvas iframe. */
  const executableUrlAttributes = new Set(['action', 'formaction', 'href', 'poster', 'src', 'xlink:href'])
  for (const el of document.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'ping') el.removeAttribute(attr.name)
      else if (executableUrlAttributes.has(name) && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  }
  const sheets: string[] = []
  for (const l of document.querySelectorAll<HTMLLinkElement>('link')) {
    if (l.relList.contains('stylesheet') && l.href && !l.disabled && (!l.media || window.matchMedia(l.media).matches)) {
      sheets.push(l.href)
    }
    l.remove()
  }
  const baseUrl = document.baseURI
  for (const base of document.querySelectorAll('base')) base.remove()
  return {
    baseUrl,
    sheets,
    title: document.title,
    height: Math.min(Math.max(document.documentElement.scrollHeight, 400), maxHeight),
    html: document.documentElement.outerHTML,
  }
}
