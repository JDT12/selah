/**
 * Opening a page in a tab of its own (11.0): a rail page ({ section }) or a Utility page ({ section: 'attachments' |
 * 'tags' | 'media' } or { view: 'templates' | 'trash' }). App.jsx listens for 'noteapp:open-tab'.
 */
export const openPageTab = (page, { pinned = false } = {}) => window.dispatchEvent(new CustomEvent('noteapp:open-tab', { detail: { kind: 'page', ...page, pinned } }));

/** Click handlers for something that goes to a page: Ctrl/⌘-click or a middle click opens it in a new tab instead. */
export const pageLinkProps = (page, go) => ({
  onClick: (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); openPageTab(page); } else go(e); },
  onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); openPageTab(page); } },
  onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); }, // no autoscroll on a middle click
});

/** The right-click items for a page link: Open in new tab and Pin as a tab. */
export const pageTabItems = (page) => [
  { label: 'Open in new tab', onClick: () => openPageTab(page) },
  { label: 'Pin as a tab', onClick: () => openPageTab(page, { pinned: true }) },
];
