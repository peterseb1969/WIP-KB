// FTS snippets come from Postgres ts_headline as HTML with <b>match</b> spans.
// We render them via dangerouslySetInnerHTML, so anything other than <b> must be
// escaped. Strategy: escape everything, then re-allow only <b>...</b>.
export function sanitiseFtsSnippet(html: string): string {
  const escaped = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
}
