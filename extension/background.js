// The shortcut, the right-click menu, and clips the popup hands over (an area screenshot outlives the popup).
import { clip, getToken } from './clip.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'page', title: 'Clip this page to Selah', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'area', title: 'Screenshot an area to Selah', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'selection', title: 'Save selection to Selah', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'link', title: 'Save link to Selah', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'image', title: 'Save image to Selah', contexts: ['image'] });
  });
});

async function defaults() {
  const { notebook } = await chrome.storage.local.get('notebook');
  return { notebook_id: notebook || undefined };
}

/** A tick (or a ! with the reason as the tooltip) on the toolbar button. */
async function flash(ok, message) {
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d4f' : '#c93a32' });
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  await chrome.action.setTitle({ title: message });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Clip to Selah' });
  }, ok ? 2500 : 8000);
}

async function quickClip(kind, tab, extra = {}) {
  if (!(await getToken())) {
    await flash(false, 'Open the Selah Clipper and connect it first.');
    return;
  }
  try {
    const r = await clip(kind, tab, { ...(await defaults()), ...extra });
    if (r) await flash(true, `Saved “${r.title}” to Selah`);
  } catch (e) {
    await flash(false, e.message);
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'clip' || !tab) return;
  // The selected text if there is some, otherwise the page.
  let hasSelection = false;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !getSelection().isCollapsed });
    hasSelection = !!r?.result;
  } catch { /* a page extensions can't touch */ }
  quickClip(hasSelection ? 'selection' : 'article', tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'image') quickClip('image', tab, { srcUrl: info.srcUrl });
  else if (info.menuItemId === 'link') quickClip('link', tab, { linkUrl: info.linkUrl, linkText: info.selectionText || '' });
  else quickClip(info.menuItemId === 'page' ? 'article' : info.menuItemId, tab);
});

// From the popup: { action: 'clip', kind, tabId, opts }.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.action !== 'clip') return false;
  chrome.tabs.get(msg.tabId).then((tab) => clip(msg.kind, tab, msg.opts))
    .then((r) => { reply({ ok: true, result: r }); if (r && msg.kind === 'area') flash(true, `Saved “${r.title}” to Selah`); })
    .catch((e) => { reply({ ok: false, error: e.message }); if (msg.kind === 'area') flash(false, e.message); });
  return true; // reply comes later
});
