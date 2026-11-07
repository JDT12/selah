// Loaded on demand (import()), so citeproc and the style files stay out of the main bundle.
import CSL from 'citeproc';
import locale from './csl/locales-en-US.xml?raw';
import turabian from './csl/chicago-notes-bibliography-17th-edition.csl?raw';
import chicago18 from './csl/chicago-notes-bibliography.csl?raw';
import sbl from './csl/society-of-biblical-literature-fullnote-bibliography.csl?raw';
import apa from './csl/apa.csl?raw';

const STYLES = { turabian, chicago18, sbl, apa };

/**
 * Formats the citations of one note. `items` maps source id -> CSL-JSON; `clusters` are the citations in order:
 * [{ id, items: [{ id, locator, label, prefix, suffix }], noteIndex }]. Returns the formatted text of each
 * cluster (HTML) and the bibliography entries (HTML), in the style's order.
 */
export function format(styleId, items, clusters) {
  const sys = {
    retrieveLocale: () => locale,
    retrieveItem: (id) => items[id] ?? { id, type: 'document', title: '[source missing; refresh sources in Settings → Zotero]' },
  };
  const engine = new CSL.Engine(sys, STYLES[styleId] ?? STYLES.turabian);
  const citations = clusters.map((c) => ({
    citationID: c.id,
    citationItems: c.items.map((i) => ({
      id: i.id,
      ...(i.locator ? { locator: i.locator, label: i.label || 'page' } : {}),
      ...(i.prefix ? { prefix: i.prefix } : {}),
      ...(i.suffix ? { suffix: i.suffix } : {}),
    })),
    properties: { noteIndex: c.noteIndex },
  }));
  const text = {};
  for (const [id, , str] of engine.rebuildProcessorState(citations, 'html')) text[id] = str;
  const bib = clusters.length ? engine.makeBibliography() : null;
  return { text, bibliography: bib ? bib[1].map((s) => s.trim()) : [] };
}
