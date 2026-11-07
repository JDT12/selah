import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl } from '../api.js';
import { bibleConnected, biblePassage } from '../esv.js';
import { addDays, formatLongDate, formatMoment, fromWallClock, todayStr, wallClock, zoneName } from '../time.js';
import { citationsForWordPress, defaultExcerpt, mediaUploader, noteToBlocks, scriptureNoticeBlocks, splitDevotional } from '../wordpress.js';
import { useDialog } from './Dialogs.jsx';
import Icon from './Icon.jsx';

/** Settings → WordPress: connect with an application password, or disconnect. Resolves to the status. */
export function WordPressConnectDialog({ close }) {
  const [status, setStatus] = useState(null);
  const [editing, setEditing] = useState(false);
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.wordpress().then((s) => {
      setStatus(s);
      setEditing(!s.connected);
      if (s.connected) { setSite(s.site); setUsername(s.username); }
    }).catch((e) => setError(e.message));
  }, []);

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.connectWordpress(site, username, password);
      setStatus(s);
      window.dispatchEvent(new Event('noteapp:wordpress')); // the sidebar shows the site's page
      setEditing(false);
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setStatus(await api.disconnectWordpress());
    window.dispatchEvent(new Event('noteapp:wordpress'));
    setEditing(true);
  };

  const setAutoTag = async (autoTag) => {
    setStatus((s) => ({ ...s, autoTag }));
    try { setStatus(await api.wordpressOptions({ autoTag })); } catch (e) { setError(e.message); }
  };

  if (!status && !error) return <div className="wp-dialog"><h2>WordPress</h2><p className="muted">Loading…</p></div>;

  return (
    <form className="wp-dialog stack-form" onSubmit={connect}>
      <h2>WordPress</h2>
      {status?.connected && !editing && (
        <>
          <p className="wp-connected">
            <Icon name="check" size={16} /> Connected to <strong>{status.name}</strong> as {status.displayName}.
          </p>
          <p className="muted wp-site">{status.site}</p>
          {status.plugin
            ? <p className="muted">Scripture Blog {status.plugin.version ?? '(older than 2.5)'} found{status.plugin.version ? `: scripture references and downloads${status.plugin.devotionals ? ', and devotionals,' : ''} can be sent.` : '. Update it to 2.5.0 or later to send scripture references.'}</p>
            : null}
          {!status.canPublish && <p className="muted">This account can save drafts but not publish.</p>}
          <label className="wp-check wp-option">
            <input type="checkbox" checked={status.autoTag} onChange={(e) => setAutoTag(e.target.checked)} />
            <span>Tag notes with “{status.name}” when they’re posted</span>
          </label>
        </>
      )}
      {editing && (
        <>
          <p className="modal-message">
            In WordPress, open <strong>Users → Profile</strong>, scroll to <strong>Application Passwords</strong>, type a
            name such as “Notes” and choose <strong>Add</strong>. Copy the password it shows into the box below.
          </p>
          <label className="field-label" htmlFor="wp-site">Site address</label>
          <input id="wp-site" className="input" type="url" inputMode="url" autoComplete="url" placeholder="https://example.com"
            value={site} onChange={(e) => setSite(e.target.value)} required autoFocus />
          <label className="field-label" htmlFor="wp-user">WordPress username</label>
          <input id="wp-user" className="input" autoComplete="username" autoCapitalize="off" value={username}
            onChange={(e) => setUsername(e.target.value)} required />
          <label className="field-label" htmlFor="wp-pass">Application password</label>
          <input id="wp-pass" className="input" type="password" autoComplete="off" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
        </>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions spread">
        <span>
          {status?.connected && !editing && <button type="button" className="btn btn-danger-text" onClick={disconnect}>Disconnect</button>}
        </span>
        <span className="modal-actions-group">
          {status?.connected && !editing && <button type="button" className="btn" onClick={() => setEditing(true)}>Change…</button>}
          {editing && status?.connected && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>}
          {editing
            ? <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
            : <button type="button" className="btn btn-primary" onClick={() => close(status)}>Done</button>}
          {editing && !status?.connected && <button type="button" className="btn" onClick={() => close(status)}>Cancel</button>}
        </span>
      </div>
    </form>
  );
}

// ---------- form pieces ----------

/** Checkbox list for a hierarchical taxonomy (categories, content types), children indented. */
function TermChecklist({ terms, selected, onToggle }) {
  const ordered = useMemo(() => {
    const byParent = new Map();
    for (const t of terms) byParent.set(t.parent, [...(byParent.get(t.parent) ?? []), t]);
    const out = [];
    const walk = (parent, depth) => (byParent.get(parent) ?? []).forEach((t) => { out.push({ ...t, depth }); walk(t.id, depth + 1); });
    walk(0, 0);
    // Terms whose parent isn't in the list still show up.
    for (const t of terms) if (!out.some((o) => o.id === t.id)) out.push({ ...t, depth: 0 });
    return out;
  }, [terms]);
  if (!terms.length) return <p className="muted wp-empty">None on the site yet.</p>;
  return (
    <div className={`wp-checklist ${ordered.length > 8 ? 'is-long' : ''}`}>
      {ordered.map((t) => (
        <label key={t.id} className="wp-check" style={{ paddingLeft: 6 + t.depth * 18 }}>
          <input type="checkbox" checked={selected.includes(t.name)} onChange={() => onToggle(t.name)} />
          {t.name}
        </label>
      ))}
    </div>
  );
}

/** Chips plus a text box with suggestions, for tags-like taxonomies. New names are created on the site. */
function TermTokens({ id, terms, names, onChange, placeholder }) {
  const [text, setText] = useState('');
  const known = useMemo(() => new Map(terms.map((t) => [t.name.toLowerCase(), t.name])), [terms]);
  const add = (raw) => {
    const v = raw.trim().replace(/,$/, '').trim();
    if (!v) return;
    const name = known.get(v.toLowerCase()) ?? v;
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) onChange([...names, name]);
    setText('');
  };
  return (
    <div className="wp-tokens">
      {names.map((n) => (
        <span key={n} className={`wp-token ${known.has(n.toLowerCase()) ? '' : 'is-new'}`} title={known.has(n.toLowerCase()) ? n : `${n} (new)`}>
          {n}
          <button type="button" aria-label={`Remove ${n}`} onClick={() => onChange(names.filter((x) => x !== n))}><Icon name="x" size={12} /></button>
        </span>
      ))}
      <input id={id} className="wp-token-input" list={`${id}-list`} value={text} placeholder={names.length ? '' : placeholder}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(text); }
          if (e.key === 'Backspace' && !text && names.length) onChange(names.slice(0, -1));
        }}
        onBlur={() => add(text)} />
      <datalist id={`${id}-list`}>
        {terms.filter((t) => !names.includes(t.name)).map((t) => <option key={t.id} value={t.name} />)}
      </datalist>
    </div>
  );
}

/** Scripture references, checked by the Scripture Blog plugin as you type. */
function ScriptureField({ value, onChange }) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    if (!value.trim()) { setCheck(null); return undefined; }
    const t = setTimeout(() => {
      api.parseScripture(value).then(setCheck).catch((e) => setCheck({ refs: [], errors: [e.message] }));
    }, 450);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <>
      <textarea id="wp-refs" className="input wp-refs" rows={2} value={value} placeholder={'e.g. John 3:16-21\nRomans 5:8'}
        onChange={(e) => onChange(e.target.value)} />
      <p className="muted wp-help">One passage per line. The first is the main passage; it decides where the post sits in Bible order.</p>
      {check?.refs?.length > 0 && (
        <ul className="wp-chips" aria-label="Will be saved as">
          <li className="wp-chips-label">Saved as</li>
          {check.refs.map((r, i) => <li key={r} className={i === 0 ? 'is-primary' : ''}>{r}</li>)}
        </ul>
      )}
      {check?.errors?.map((e) => <p key={e} className="form-error">{e}</p>)}
    </>
  );
}

/** A devotional's own fields: its day, the verse, and where its application comes from. */
function DevotionalFields({ form, set, esv, hasApplication, canPublish, current }) {
  const [fill, setFill] = useState(null);
  const fillFromEsv = async () => {
    setFill('busy');
    try {
      const p = await biblePassage(form.verseRef);
      // Plain text for the site: verse numbers out, paragraphs kept (a blank line starts a new one).
      const text = p.text.replace(/\[\d+\]\s*/g, '').split(/\n\s*\n/).map((para) => para.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
      set({ verseText: text, verseRef: p.reference, verseVersion: p.translation ?? 'ESV' });
      setFill(null);
    } catch (e) {
      setFill(e.message);
    }
  };
  return (
    <>
      <label className="field-label" htmlFor="wp-day">Day</label>
      <input id="wp-day" className="input input-inline" type="date" value={form.day} required
        onChange={(e) => set({ day: e.target.value })} />
      <p className="muted wp-help">
        Readers see it on {form.day ? formatLongDate(form.day) : 'this day'}. One devotional shows per day; if two share a day, the one edited last shows.
      </p>

      <label className="field-label" htmlFor="wp-verse-ref">Verse</label>
      <div className="wp-verse-ref">
        <input id="wp-verse-ref" className="input" value={form.verseRef} placeholder="e.g. Psalm 23:3"
          onChange={(e) => set({ verseRef: e.target.value })} />
        <input className="input wp-verse-version" aria-label="Bible version" value={form.verseVersion} placeholder="ESV"
          onChange={(e) => set({ verseVersion: e.target.value })} />
      </div>
      <textarea id="wp-verse-text" className="input wp-verse-text" rows={4} aria-label="Verse text" value={form.verseText}
        placeholder="The verse, quoted. A blank line starts a new paragraph." onChange={(e) => set({ verseText: e.target.value })} />
      {esv && form.verseRef.trim() && (
        <p className="wp-help">
          <button type="button" className="btn btn-small" onClick={fillFromEsv} disabled={fill === 'busy'}>
            {fill === 'busy' ? 'Looking it up…' : 'Fill in the verse'}
          </button>
        </p>
      )}
      {fill && fill !== 'busy' && <p className="form-error">{fill}</p>}

      <p className="muted wp-help">
        {hasApplication
          ? 'The note’s Application section fills the devotional’s Application box; the rest of the note is the devotional.'
          : 'The whole note is the devotional. Add a heading named “Application” to fill the site’s Application box too.'}
      </p>

      <fieldset className="wp-fieldset">
        <legend className="field-label">When it’s sent</legend>
        <div className="segmented wp-status">
          <button type="button" className={form.status !== 'publish' ? 'is-active' : ''} aria-pressed={form.status !== 'publish'}
            onClick={() => set({ status: 'draft' })}>Save as draft</button>
          <button type="button" className={form.status === 'publish' ? 'is-active' : ''} aria-pressed={form.status === 'publish'}
            disabled={!canPublish} onClick={() => set({ status: 'publish' })}>Publish</button>
        </div>
        {current?.status === 'publish' && form.status !== 'publish' && (
          <p className="muted wp-help">This takes the devotional off the site until it is published again.</p>
        )}
      </fieldset>
    </>
  );
}

// ---------- the posting dialog ----------

/** 'tomorrow at 9:00 AM', 'on Thursday at 9:00 AM', 'on Mon, Nov 3 at 9:00 AM' */
const whenPhrase = (moment) => {
  const s = formatMoment(moment);
  return /^(Today|Tomorrow) /.test(s) ? s[0].toLowerCase() + s.slice(1) : `on ${s}`;
};

const isImage = (a) => /^image\/(png|jpeg|gif|webp|avif)$/.test(a.mime);

/**
 * Post a note to WordPress (or update its post). Resolves to { id, link, status } when sent.
 * getHtml() returns the note's current HTML (after saving pending edits).
 */
export function WordPressPostDialog({ noteId, title, tags, attachments, getHtml, close }) {
  const dialog = useDialog();
  const [load, setLoad] = useState({ state: 'loading' });
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const htmlRef = useRef('');

  const start = async () => {
    setLoad({ state: 'loading' });
    try {
      const status = await api.wordpress();
      if (!status.connected) { setLoad({ state: 'disconnected' }); return; }
      const [schema, existing, html] = await Promise.all([api.wordpressSchema(), api.notePost(noteId), getHtml()]);
      htmlRef.current = html;
      const saved = existing.form ?? {};
      const terms = {};
      for (const t of schema.taxonomies) {
        const names = new Set(t.terms.map((x) => x.name));
        if (saved.terms?.[t.restBase]) terms[t.restBase] = saved.terms[t.restBase].filter((n) => !t.hierarchical || names.has(n));
        // The blog-name tag only marks the note as posted; it isn't a topic.
        else if (t.slug === 'post_tag') terms[t.restBase] = tags.filter((n) => n.toLowerCase() !== schema.name.toLowerCase());
        else terms[t.restBase] = [];
      }
      const has = (id) => attachments.some((a) => a.id === id);
      // The post's references as they are on the site now (they may have been edited there).
      const refs = typeof existing.post?.scripture_refs === 'string'
        ? existing.post.scripture_refs.split(/\s*;\s*/).filter(Boolean).join('\n')
        : (saved.refs ?? '');
      const downloads = (saved.downloads ?? []).filter(has);
      // A devotional (Scripture Blog 2.7+): its verse comes from the site if it was posted as one, else from the note.
      const dev = splitDevotional(html);
      const devPost = existing.post?.kind === 'devotional' ? existing.post : null;
      const kind = schema.fields.devotionals
        ? (existing.post?.kind ?? saved.kind ?? (dev.looksLikeDevotional ? 'devotional' : 'post'))
        : 'post';
      setForm({
        title,
        kind,
        day: devPost?.devotional_date || saved.day || addDays(todayStr(), 1),
        verseRef: devPost ? devPost.verse_reference ?? '' : dev.verse.reference,
        verseText: devPost ? devPost.verse_text ?? '' : dev.verse.text,
        verseVersion: (devPost ? devPost.verse_version : dev.verse.version) || 'ESV',
        status: ['publish', 'future'].includes(existing.post?.status) && schema.canPublish
          ? (kind === 'devotional' ? 'publish' : existing.post.status)
          : 'draft',
        // Wall-clock time in the app's time zone; a new schedule defaults to tomorrow morning.
        when: existing.post?.status === 'future' && existing.post.date ? wallClock(existing.post.date) : `${addDays(todayStr(), 1)}T09:00`,
        refs,
        terms,
        excerpt: saved.excerpt ?? defaultExcerpt(html),
        featured: has(saved.featured) ? saved.featured : null,
        downloads,
      });
      setLoad({ state: 'ready', schema, post: existing.post, initial: { refs, downloads }, hasApplication: dev.hasApplication });
      bibleConnected().then((esv) => setLoad((l) => ({ ...l, esv })));
    } catch (e) {
      setLoad({ state: 'error', message: e.message });
    }
  };
  useEffect(() => { start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    const s = await dialog.open((c) => <WordPressConnectDialog close={c} />);
    if (s?.connected) start();
  };

  // The note's post of the kind being sent (a blog post and a devotional are separate things on the site).
  const current = load.post && form && (load.post.kind ?? 'post') === form.kind ? load.post : null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setTerms = (restBase, names) => setForm((f) => ({ ...f, terms: { ...f.terms, [restBase]: names } }));
  const toggleTerm = (restBase, name) => {
    const cur = form.terms[restBase] ?? [];
    setTerms(restBase, cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]);
  };
  const toggleDownload = (id) => set({ downloads: form.downloads.includes(id) ? form.downloads.filter((d) => d !== id) : [...form.downloads, id] });

  const submit = async (e) => {
    e.preventDefault();
    const { schema, initial } = load;
    setError(null);
    const formMemo = {
      kind: form.kind, day: form.day, refs: form.refs, terms: form.terms, excerpt: form.excerpt, featured: form.featured, downloads: form.downloads,
    };
    if (form.kind === 'devotional') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.day)) {
        setError('Choose the day this devotional is for.');
        document.getElementById('wp-day')?.focus();
        return;
      }
      try {
        setBusy('Preparing the devotional…');
        const html = await getHtml();
        const dev = splitDevotional(html);
        // The verse box's translation counts as quoted too, so its publisher's notice ends the devotional.
        const quoted = form.verseText.trim() && form.verseVersion.trim() ? `${html} (${form.verseVersion.trim()})` : html;
        const content = [await noteToBlocks(dev.html, mediaUploader(setBusy)), await scriptureNoticeBlocks(quoted)].filter(Boolean).join('\n\n');
        setBusy(current ? 'Updating the devotional…' : 'Creating the devotional…');
        setResult(await api.saveNotePost(noteId, {
          kind: 'devotional',
          title: form.title.trim() || 'Untitled',
          content,
          status: form.status === 'publish' ? 'publish' : 'draft',
          devotional_date: form.day,
          verse_reference: form.verseRef.trim(),
          verse_text: form.verseText.trim(),
          verse_version: form.verseVersion.trim(),
          application: dev.application,
          form: formMemo,
        }));
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(null);
      }
      return;
    }
    const at = form.status === 'future' ? fromWallClock(form.when) : null;
    if (at !== null && !(at > Date.now() + 60_000)) {
      setError('Choose a time in the future to schedule the post.');
      document.getElementById('wp-when')?.focus();
      return;
    }
    // References and downloads are sent only when entered or changed, so a blank box never wipes what the post
    // already has. Clearing references that were there sends a blank on purpose.
    const sameRefs = (a, b) => a.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean).join(';') === b.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean).join(';');
    const sendRefs = schema.fields.scriptureRefs && (current ? !sameRefs(form.refs, initial.refs) : !!form.refs.trim());
    const sameDownloads = [...form.downloads].sort().join() === [...initial.downloads].sort().join();
    const sendDownloads = schema.fields.downloads && (current ? !sameDownloads : form.downloads.length > 0);
    try {
      if (sendRefs && form.refs.trim()) {
        setBusy('Checking references…');
        let check;
        try { check = await api.parseScripture(form.refs); } catch (err) { check = { refs: [], errors: [err.message] }; }
        if (check.errors?.length) {
          setBusy(null);
          const ok = await dialog.confirm({
            title: 'Some references couldn’t be read',
            message: `Couldn’t read: ${check.errors.join(' · ')}.${check.refs?.length ? ` The rest will be saved as ${check.refs.join('; ')}.` : ''}`
              + ' References the site can’t read don’t place the post in Bible order.',
            okLabel: 'Save anyway',
            cancelLabel: 'Fix references',
          });
          if (!ok) { document.getElementById('wp-refs')?.focus(); return; }
        }
      }
      setBusy('Preparing the post…');
      const uploads = mediaUploader(setBusy);
      const html = await getHtml();
      const cited = await citationsForWordPress(html);
      const content = [await noteToBlocks(cited.html, uploads), await scriptureNoticeBlocks(html), cited.tail].filter(Boolean).join('\n\n');
      const body = {
        title: form.title.trim() || 'Untitled', content, status: form.status, terms: {}, newTerms: {}, footnotes: cited.footnotes,
      };
      if (at !== null) body.date = new Date(at).toISOString();
      else if (current?.status === 'future') body.clearSchedule = true;
      for (const t of schema.taxonomies) {
        const byName = new Map(t.terms.map((x) => [x.name.toLowerCase(), x.id]));
        const names = form.terms[t.restBase] ?? [];
        body.terms[t.restBase] = names.map((n) => byName.get(n.toLowerCase())).filter(Boolean);
        body.newTerms[t.restBase] = names.filter((n) => !byName.has(n.toLowerCase()));
      }
      if (schema.fields.excerpt) body.excerpt = form.excerpt;
      if (schema.fields.featuredMedia) body.featured_media = form.featured ? (await uploads.attachment(form.featured)).id : 0;
      if (sendRefs) body.scripture_refs = form.refs.trim();
      if (sendDownloads) {
        body.sbt_downloads = [];
        for (const id of form.downloads) {
          const a = attachments.find((x) => x.id === id);
          body.sbt_downloads.push({ id: (await uploads.attachment(id)).id, label: a.filename.replace(/\.[^.]+$/, '') });
        }
      }
      body.form = formMemo;
      setBusy(form.status === 'future' ? 'Scheduling the post…' : current ? 'Updating the post…' : 'Creating the post…');
      const saved = await api.saveNotePost(noteId, body);
      // A chapter of a series: put back its series box and bring the other parts' links up to date.
      setBusy('Updating the series links…');
      await api.syncNoteSeries(noteId).catch((err) => dialog.toast(`Posted, but the series links weren’t updated: ${err.message}`, 'error'));
      setResult(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (load.state === 'loading') return <div className="wp-dialog"><h2>Post to WordPress</h2><p className="muted">Reading the site…</p></div>;
  if (load.state === 'disconnected' || load.state === 'error') {
    return (
      <div className="wp-dialog">
        <h2>Post to WordPress</h2>
        <p className={load.state === 'error' ? 'form-error' : 'modal-message'}>
          {load.state === 'error' ? load.message : 'Connect a WordPress site first.'}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => close(null)}>Close</button>
          {load.state === 'error'
            ? <button type="button" className="btn btn-primary" onClick={start}>Try again</button>
            : <button type="button" className="btn btn-primary" onClick={connect}>Connect…</button>}
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="wp-dialog">
        <h2>{{ publish: 'Published', future: 'Scheduled' }[result.status] ?? 'Saved as a draft'}</h2>
        <p className="modal-message">
          {result.kind === 'devotional' && result.status === 'publish' && (result.devotional_date ?? form.day) > todayStr()
            ? <>“{form.title || 'Untitled'}” is published on {load.schema.name}; readers see it on {formatLongDate(result.devotional_date ?? form.day)}.</>
            : result.status === 'publish' && <>“{form.title || 'Untitled'}” is live on {load.schema.name}.</>}
          {result.status === 'future' && <>“{form.title || 'Untitled'}” will go live on {load.schema.name} {whenPhrase(result.date)}.</>}
          {!['publish', 'future'].includes(result.status) && <>“{form.title || 'Untitled'}” is waiting in {load.schema.name} as a draft.</>}
        </p>
        <div className="modal-actions spread">
          <span className="modal-actions-group">
            <a className="btn" href={result.link} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={15} /> {result.status === 'publish' ? (result.kind === 'devotional' ? 'View devotional' : 'View post') : 'Preview'}
            </a>
            <a className="btn" href={result.editLink} target="_blank" rel="noopener noreferrer">Edit in WordPress</a>
          </span>
          <button type="button" className="btn btn-primary" onClick={() => close(result)}>Done</button>
        </div>
      </div>
    );
  }

  const { schema } = load;
  const images = attachments.filter(isImage);
  const files = attachments.filter((a) => !isImage(a));
  const hier = schema.taxonomies.filter((t) => t.hierarchical);
  const flat = schema.taxonomies.filter((t) => !t.hierarchical);

  return (
    <form className="wp-dialog wp-post" onSubmit={submit} noValidate>
      <h2>{current ? (form.kind === 'devotional' ? 'Update devotional' : 'Update WordPress post') : 'Post to WordPress'}</h2>
      <p className="muted wp-site">
        {schema.name}
        {current && <> · <a href={current.link} target="_blank" rel="noopener noreferrer">currently {{ publish: 'published', future: `scheduled for ${formatMoment(current.date)}` }[current.status] ?? current.status}</a></>}
      </p>

      <label className="field-label" htmlFor="wp-title">Title</label>
      <input id="wp-title" className="input" value={form.title} onChange={(e) => set({ title: e.target.value })} />

      {schema.fields.devotionals && (
        <fieldset className="wp-fieldset">
          <legend className="field-label">Post as</legend>
          <div className="segmented wp-kind">
            {[['post', 'Blog post'], ['devotional', 'Devotional']].map(([k, label]) => (
              <button key={k} type="button" className={form.kind === k ? 'is-active' : ''} aria-pressed={form.kind === k}
                onClick={() => set({ kind: k, status: k === 'devotional' && form.status === 'future' ? 'publish' : form.status })}>{label}</button>
            ))}
          </div>
          {load.post && !current && (
            <p className="muted wp-help">
              This note is on the site as a {load.post.kind === 'devotional' ? 'devotional' : 'blog post'}. Sending it
              as a {form.kind === 'devotional' ? 'devotional' : 'blog post'} makes a new one; the {load.post.kind === 'devotional' ? 'devotional' : 'post'} stays on the site.
            </p>
          )}
        </fieldset>
      )}

      {form.kind === 'devotional' ? (
        <DevotionalFields form={form} set={set} esv={load.esv} hasApplication={load.hasApplication}
          canPublish={schema.canPublish} current={current} />
      ) : (<>
      {schema.fields.scriptureRefs && (
        <>
          <label className="field-label" htmlFor="wp-refs">Scripture references</label>
          <ScriptureField value={form.refs} onChange={(refs) => set({ refs })} />
        </>
      )}
      {schema.plugin && !schema.fields.scriptureRefs && (
        <p className="muted wp-help">Update the Scripture Blog plugin to 2.5.0 to send scripture references from here.</p>
      )}

      {hier.map((t) => (
        <fieldset key={t.slug} className="wp-fieldset">
          <legend className="field-label">{t.name}</legend>
          <TermChecklist terms={t.terms} selected={form.terms[t.restBase] ?? []} onToggle={(n) => toggleTerm(t.restBase, n)} />
        </fieldset>
      ))}
      {flat.map((t) => (
        <div key={t.slug}>
          <label className="field-label" htmlFor={`wp-tax-${t.slug}`}>{t.name}</label>
          <TermTokens id={`wp-tax-${t.slug}`} terms={t.terms} names={form.terms[t.restBase] ?? []}
            onChange={(names) => setTerms(t.restBase, names)} placeholder="Type to search or add…" />
        </div>
      ))}

      {schema.fields.excerpt && (
        <>
          <label className="field-label" htmlFor="wp-excerpt">Excerpt</label>
          <textarea id="wp-excerpt" className="input" rows={3} value={form.excerpt} onChange={(e) => set({ excerpt: e.target.value })} />
        </>
      )}

      {schema.fields.featuredMedia && images.length > 0 && (
        <fieldset className="wp-fieldset">
          <legend className="field-label">Featured image</legend>
          <div className="wp-images">
            <label className={`wp-image-choice is-none ${form.featured == null ? 'is-active' : ''}`}>
              <input type="radio" name="wp-featured" checked={form.featured == null} onChange={() => set({ featured: null })} />
              None
            </label>
            {images.map((a) => (
              <label key={a.id} className={`wp-image-choice ${form.featured === a.id ? 'is-active' : ''}`} title={a.filename}>
                <input type="radio" name="wp-featured" checked={form.featured === a.id} onChange={() => set({ featured: a.id })} />
                <img src={fileUrl(a.id)} alt={a.filename} loading="lazy" />
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {schema.fields.downloads && files.length > 0 && (
        <fieldset className="wp-fieldset">
          <legend className="field-label">Downloads box</legend>
          <div className="wp-checklist">
            {files.map((a) => (
              <label key={a.id} className="wp-check">
                <input type="checkbox" checked={form.downloads.includes(a.id)} onChange={() => toggleDownload(a.id)} />
                {a.filename}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="wp-fieldset">
        <legend className="field-label">When it’s sent</legend>
        <div className="segmented wp-status">
          <button type="button" className={form.status === 'draft' ? 'is-active' : ''} aria-pressed={form.status === 'draft'}
            onClick={() => set({ status: 'draft' })}>Save as draft</button>
          <button type="button" className={form.status === 'publish' ? 'is-active' : ''} aria-pressed={form.status === 'publish'}
            disabled={!schema.canPublish} onClick={() => set({ status: 'publish' })}>Publish now</button>
          <button type="button" className={form.status === 'future' ? 'is-active' : ''} aria-pressed={form.status === 'future'}
            disabled={!schema.canPublish} onClick={() => set({ status: 'future' })}>Schedule</button>
        </div>
        {form.status === 'future' && (
          <div className="wp-when">
            <input id="wp-when" className="input input-inline" type="datetime-local" aria-label="Publish on"
              value={form.when} min={wallClock(Date.now())} required onChange={(e) => { set({ when: e.target.value }); setError(null); }} />
            <span className="muted">{zoneName(form.when ? fromWallClock(form.when) : undefined)}</span>
          </div>
        )}
        {current?.status === 'publish' && form.status !== 'publish' && (
          <p className="muted wp-help">This takes the published post off the site until it {form.status === 'future' ? 'goes live again' : 'is published again'}.</p>
        )}
        {current?.status === 'future' && form.status === 'draft' && (
          <p className="muted wp-help">This cancels the schedule; the post stays a draft until you publish or schedule it.</p>
        )}
      </fieldset>
      </>)}

      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)} disabled={!!busy}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!!busy}>
          {busy ?? (form.kind === 'devotional' && current?.status === 'publish' && form.status === 'publish' ? 'Update' : null) ?? {
            publish: current ? 'Update and publish' : 'Publish',
            future: current?.status === 'future' ? 'Update schedule' : 'Schedule',
            draft: current ? 'Update draft' : 'Save draft',
          }[form.status]}
        </button>
      </div>
    </form>
  );
}

/**
 * Ask how to delete `count` posts. Resolves to { permanent } or null if cancelled.
 * Trash is the default: WordPress keeps trashed posts (30 days by default) and they can be restored there.
 */
export async function askDeletePosts(dialog, { count = 1, title } = {}) {
  const what = count === 1 ? (title ? `“${title}”` : 'this post') : `these ${count} posts`;
  const choice = await dialog.choose({
    title: count === 1 ? 'Delete WordPress post?' : `Delete ${count} WordPress posts?`,
    message: `How should ${what} be deleted from the site?`,
    options: [
      { value: 'trash', label: 'Move to Trash (can be restored in WordPress)' },
      { value: 'permanent', label: 'Delete permanently (can’t be undone)' },
    ],
    okLabel: 'Delete',
  });
  return choice ? { permanent: choice === 'permanent' } : null;
}
