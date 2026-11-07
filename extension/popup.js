import { SERVER, VERSION } from './config.js';
import { api, getToken, pageInfo } from './clip.js';

const $ = (id) => document.getElementById(id);
const HINTS = {
  article: 'The readable text and pictures, without menus and ads.',
  selection: 'The text you selected, as a quote with a link back.',
  bookmark: 'The link, with the page’s description and picture.',
  screenshot: 'What you can see of the page, as a picture.',
  area: 'Drag over part of the page after you press Save.',
};
let kind = 'article';
let tab = null;
let appendTo = null;
let dest = 'notes'; // or 'bank': the selected text into the sermon bank
let page = null; // pageInfo: title, url and the selection

function setDest(d) {
  dest = d;
  for (const b of document.querySelectorAll('.dest button')) b.setAttribute('aria-selected', String(b.dataset.dest === d));
  $('notes-box').hidden = d !== 'notes';
  $('bank-box').hidden = d !== 'bank';
  const noSelection = d === 'bank' && !page?.selection;
  $('bank-hint').textContent = noSelection
    ? 'Select the text you want to keep on the page, then open the clipper again.'
    : 'The text you selected, kept with a link to this page.';
  $('bank-hint').classList.toggle('warn', noSelection);
  $('save').disabled = noSelection;
  $('save').textContent = d === 'bank' ? 'Add to bank' : 'Save';
  $('status').textContent = '';
  chrome.storage.local.set({ dest: d });
}

function setKind(k) {
  kind = k;
  for (const b of document.querySelectorAll('.kinds button')) b.setAttribute('aria-checked', String(b.dataset.kind === k));
  $('kind-hint').textContent = HINTS[k];
}

async function showPair() {
  $('pair').hidden = false;
  $('clip').hidden = true;
  $('disconnect').hidden = true;
  $('code').focus();
}

async function showClip() {
  $('pair').hidden = true;
  $('clip').hidden = false;
  $('disconnect').hidden = false;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [info, server, saved] = await Promise.all([
    pageInfo(tab.id),
    api('/api/clip/info').catch((e) => { $('status').textContent = e.message; return null; }),
    chrome.storage.local.get(['notebook', 'dest', 'bankKind']),
  ]);
  page = info;
  $('title').value = info?.title || tab.title || '';
  const selection = !!info?.selection;
  document.querySelector('[data-kind="selection"]').disabled = !selection;
  if (!info) for (const k of ['article', 'selection', 'area']) document.querySelector(`[data-kind="${k}"]`).disabled = true;
  setKind(selection ? 'selection' : info ? 'article' : 'bookmark');
  if (saved.bankKind) $('bank-kind').value = saved.bankKind;
  // A Selah from before the sermon bank clips doesn't send its sermons.
  const bank = !!server?.sermons;
  document.querySelector('[data-dest="bank"]').disabled = !bank;
  setDest(bank && saved.dest === 'bank' ? 'bank' : 'notes');
  if (!server) return;
  if (server.version !== VERSION) $('update').hidden = false;
  const pick = saved.notebook && server.notebooks.some((n) => n.id === saved.notebook) ? saved.notebook : server.inboxId;
  $('notebook').replaceChildren(...server.notebooks.map((n) => new Option(n.name, n.id, false, n.id === pick)));
  $('tag-list').replaceChildren(...server.tags.map((t) => new Option(t)));
  if (bank) {
    $('bank-sermon').append(...server.sermons.map((x) => new Option(`${x.title || 'Untitled sermon'}${x.status === 'ready' ? ' (ready)' : ''}`, x.id)));
    $('topic-list').replaceChildren(...server.bankTopics.map((t) => new Option(t)));
  }
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-error').textContent = '';
  try {
    const r = await fetch(`${SERVER}/api/clip/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('code').value, name: `Edge (${navigator.userAgentData?.platform || 'Windows'})` }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Selah said ${r.status}`);
    await chrome.storage.local.set({ token: data.token });
    showClip();
  } catch (err) {
    $('pair-error').textContent = err.message === 'Failed to fetch' ? `Can’t reach Selah at ${SERVER}.` : err.message;
  }
});

for (const b of document.querySelectorAll('.kinds button')) b.addEventListener('click', () => setKind(b.dataset.kind));
for (const b of document.querySelectorAll('.dest button')) b.addEventListener('click', () => setDest(b.dataset.dest));
$('bank-kind').addEventListener('change', () => chrome.storage.local.set({ bankKind: $('bank-kind').value }));

async function saveToBank() {
  $('save').disabled = true;
  $('status').textContent = 'Saving…';
  try {
    const r = await api('/api/clip/bank', {
      method: 'POST',
      body: {
        html: page.selection, url: page.url || tab.url, page_title: page.title || tab.title,
        kind: $('bank-kind').value, title: $('bank-title').value.trim(), topics: $('bank-topics').value,
        passage: $('bank-passage').value.trim(), sermon_id: Number($('bank-sermon').value) || undefined,
      },
    });
    $('status').textContent = r.sermon ? `Added to the bank for “${r.sermon}”` : 'Added to the sermon bank';
  } catch (e) {
    $('status').textContent = e.message;
  }
  $('save').disabled = false;
}

$('append').addEventListener('change', () => {
  $('append-box').hidden = !$('append').checked;
  $('notebook').disabled = $('append').checked;
  if ($('append').checked) { $('note-search').focus(); search(); } else appendTo = null;
});
let searchTimer = null;
async function search() {
  const notes = await api(`/api/clip/notes?q=${encodeURIComponent($('note-search').value)}`).catch(() => []);
  $('note-results').replaceChildren(...notes.map((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = n.title || 'Untitled';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(n.id === appendTo));
    b.addEventListener('click', () => {
      appendTo = n.id;
      for (const x of $('note-results').children) x.setAttribute('aria-selected', String(x === b));
    });
    return b;
  }));
}
$('note-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 150); });

$('save').addEventListener('click', async () => {
  if (dest === 'bank') { saveToBank(); return; }
  if ($('append').checked && !appendTo) { $('status').textContent = 'Pick the note to add it to.'; return; }
  const notebook = Number($('notebook').value) || undefined;
  if (notebook) chrome.storage.local.set({ notebook });
  const opts = {
    title: $('title').value.trim(),
    notebook_id: notebook,
    tags: $('tags').value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
    comment: $('comment').value,
    append_to: $('append').checked ? appendTo : undefined,
  };
  $('save').disabled = true;
  $('status').textContent = 'Saving…';
  const send = chrome.runtime.sendMessage({ action: 'clip', kind, tabId: tab.id, opts });
  if (kind === 'area') { window.close(); return; } // you pick the area on the page; the button shows a tick when it's saved
  const r = await send;
  $('save').disabled = false;
  if (!r?.ok) { $('status').textContent = r?.error || 'Something went wrong.'; return; }
  const where = r.result.appended ? 'Added to the note' : `Saved to ${$('notebook').selectedOptions[0]?.text ?? 'Selah'}`;
  $('status').replaceChildren(`${where} · `, Object.assign(document.createElement('a'), {
    href: `${SERVER}/#note/${r.result.id}`, textContent: 'Open', target: '_blank',
  }));
});

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove('token');
  showPair();
});

(await getToken()) ? showClip() : showPair();
