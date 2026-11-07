/** Citation styles. `note` styles number their citations as footnotes; `in-text` ones put them in the text. */
export const CITATION_STYLES = [
  { id: 'turabian', label: 'Turabian 9th / Chicago 17th (notes)', kind: 'note' },
  { id: 'chicago18', label: 'Chicago 18th (notes)', kind: 'note' },
  { id: 'sbl', label: 'SBL Handbook 2nd ed. (notes)', kind: 'note' },
  { id: 'apa', label: 'APA 7th (author–date)', kind: 'in-text' },
];
export const DEFAULT_STYLE = 'turabian';
export const styleInfo = (id) => CITATION_STYLES.find((s) => s.id === id) ?? CITATION_STYLES[0];

/** What a locator number refers to (CSL locator labels). */
export const LOCATOR_LABELS = [
  ['page', 'Page'], ['chapter', 'Chapter'], ['section', 'Section'], ['paragraph', 'Paragraph'], ['verse', 'Verse'],
  ['volume', 'Volume'], ['column', 'Column'], ['line', 'Line'], ['note', 'Note'], ['part', 'Part'],
];
