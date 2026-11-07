import { useEffect, useMemo, useState } from 'react';
import { useDialog } from '../components/Dialogs.jsx';
import Icon from '../components/Icon.jsx';
import { useStoragePicker } from '../components/StoragePicker.jsx';
import { adminApi } from './adminApi.js';
import {
  Badge, Card, ErrorNote, JobRow, ago, plural, size, useLoad, waitForJob, when,
} from './common.jsx';

/**
 * A place host backups go, and its passphrase: OneDrive, S3-compatible storage, WebDAV or any rclone remote (the same
 * choices a person has for their own off-site backup). `dest` is one already set up, to connect again.
 */
function SetupDialog({ dest = null, first = false, rclone = true, close }) {
  const picker = useStoragePicker({
    prev: dest, rcloneReady: rclone, custom: true, folder: 'Selah Host Backup', idPrefix: 'hb',
    connect: { start: adminApi.backupConnectStart, finish: adminApi.backupConnectFinish },
    test: adminApi.testBackupStorage,
  });
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const problem = picker.problem
    ?? (pass.length < 16 ? 'The passphrase needs at least 16 characters.'
      : pass !== pass2 ? 'The passphrases don’t match.'
        : !saved ? 'Confirm you’ve saved the passphrase.' : null);
  const submit = async (e) => {
    e.preventDefault();
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await adminApi.setupBackups({ ...picker.body(), passphrase: pass, id: dest?.id ?? null });
      close(true);
    } catch (err) {
      if (err.status !== 403) setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="stack-form adm-dialog offsite-dialog" onSubmit={submit}>
      <h2>{dest ? `Reconnect ${dest.account}` : first ? 'Set Up the Host Backup' : 'Add a Backup Destination'}</h2>
      <p className="muted">
        {first
          ? 'Every night each tenant’s notes, attachments and keys are encrypted here with your passphrase, then copied to storage you control. It covers everyone, whether or not they back up to storage of their own.'
          : 'Each night’s backup is copied to every destination, each encrypted with its own passphrase. If one is down, the others still get it.'}
      </p>
      <h3>1. Where Backups Go</h3>
      {picker.ui}
      <h3>2. {dest ? 'Its Passphrase' : 'Choose a Passphrase'}</h3>
      {dest && <p className="muted">Use the same passphrase as before, so the backups already there can still be read.</p>}
      <input className="input" type="password" autoComplete="new-password" placeholder="At least 16 characters" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Passphrase" />
      <input className="input" type="password" autoComplete="new-password" placeholder="Type it again" value={pass2} onChange={(e) => setPass2(e.target.value)} aria-label="Passphrase again" />
      <label className="wp-check offsite-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I’ve saved this passphrase away from this server (a password manager, and on paper). <strong>Without it nothing in this destination can be restored.</strong></span>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !rclone}>{busy ? 'Connecting…' : 'Connect'}</button>
      </div>
    </form>
  );
}

/**
 * Restoring one tenant, from the host backup (pick a snapshot, then a test restore or over the live Selah) or from a
 * backup file they downloaded (Download a backup in Selah).
 */
export function RestoreDialog({ slug, missing = false, close }) {
  const [source, setSource] = useState('host');
  // The snapshot list is read once (from the storage, which can take several seconds) and shared by the tabs.
  const [dest, setDest] = useState(null);
  const snaps = useLoad(() => adminApi.snapshots(slug, dest), [slug, dest]);
  const shared = { snaps, dest, setDest };
  return (
    <div className="stack-form adm-dialog">
      <h2>{missing ? `Bring Back ${slug}` : `Restore ${slug}`}</h2>
      {!missing && (
        <div className="segmented adm-restore-source">
          <button type="button" className={source === 'host' ? 'is-active' : ''} aria-pressed={source === 'host'} onClick={() => setSource('host')}>Whole Selah</button>
          <button type="button" className={source === 'items' ? 'is-active' : ''} aria-pressed={source === 'items'} onClick={() => setSource('items')}>Notes &amp; Notebooks</button>
          <button type="button" className={source === 'file' ? 'is-active' : ''} aria-pressed={source === 'file'} onClick={() => setSource('file')}>From a Backup File</button>
        </div>
      )}
      {source === 'host' ? <HostRestore slug={slug} missing={missing} close={close} {...shared} />
        : source === 'items' ? <ItemRestore slug={slug} close={close} {...shared} /> : <FileRestore slug={slug} close={close} />}
    </div>
  );
}

/** A .selahbak or .tar.gz from Download a backup: uploaded when chosen, then restored over the tenant's Selah. */
function FileRestore({ slug, close }) {
  const dialog = useDialog();
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(null);
  const [upload, setUpload] = useState(null);
  const [pass, setPass] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const choose = async (f) => {
    setFile(f);
    setUpload(null);
    setError(null);
    setResult(null);
    if (!f) return;
    setProgress(0);
    try {
      setUpload(await adminApi.uploadBackup(slug, f, setProgress));
    } catch (e) {
      setError(e.message);
    }
    setProgress(null);
  };
  const run = async () => {
    setError(null);
    try {
      const r = await adminApi.restoreFile(slug, upload.upload, upload.encrypted ? pass : null, typed);
      setResult(await waitForJob(r.jobId, setBusy));
    } catch (e) {
      if (e.status !== 403) setError(e.message);
    }
    setBusy(null);
  };
  const ready = upload && (!upload.encrypted || pass) && typed === slug;
  return (
    <>
      <p className="muted">A backup they downloaded from Selah (Settings → Data &amp; backup → Download a backup): a <code>.selahbak</code>, or the <code>.tar.gz</code> kind. It’s checked before anything changes. Then {slug} stops, its data is moved aside (kept, not deleted) and replaced, and everyone signs in again.</p>
      <label className="field-label" htmlFor="rf-file">Backup file</label>
      <input id="rf-file" className="input" type="file" accept=".selahbak,.gz,.tgz,application/gzip,application/octet-stream" disabled={progress != null || !!busy}
        onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      {progress != null && (
        <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> Uploading {file?.name}: {Math.round(progress * 100)}% of {size(file?.size ?? 0)}…</p>
      )}
      {upload && (
        <p className="muted">✓ Uploaded {file?.name} ({size(upload.bytes)}){upload.encrypted ? ', encrypted' : ', not encrypted'}.</p>
      )}
      {upload?.encrypted && (
        <>
          <label className="field-label" htmlFor="rf-pass">Its passphrase</label>
          <input id="rf-pass" className="input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
        </>
      )}
      {upload && (
        <>
          <label className="field-label" htmlFor="rf-confirm">Type <code>{slug}</code> to confirm</label>
          <input id="rf-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </>
      )}
      {busy && <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> {busy}…</p>}
      {error && <p className="form-error">{error}</p>}
      {result && (
        <p className={result.ok ? 'adm-result is-good' : 'adm-result is-bad'}>
          {result.ok ? '✓ ' : '✗ '}
          {result.detail?.error ?? `Restored${result.detail.at ? ` from the backup made ${when(result.detail.at)}` : ''}: ${plural(result.detail.notes, 'note')}, ${plural(result.detail.files, 'file')}${result.detail.missing ? ` (${result.detail.missing} attachment${result.detail.missing === 1 ? '' : 's'} missing from the file)` : ''}. ${slug} is running again.`}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(!!result?.ok)}>{result ? 'Done' : 'Cancel'}</button>
        {!result?.ok && (
          <button type="button" className="btn btn-danger" disabled={!ready || !!busy} onClick={() => run().catch((e) => dialog.toast(e.message, 'error'))}>Restore</button>
        )}
      </div>
    </>
  );
}

/** Which destination and snapshot to restore from (a destination picker only when there are several). */
function SnapshotPicker({ data, dest, setDest, chosen, setSnapshot }) {
  return (
    <>
      {data.dests.length > 1 && (
        <>
          <label className="field-label" htmlFor="rs-dest">From</label>
          <select id="rs-dest" className="input" value={dest ?? data.dest} onChange={(e) => { setDest(e.target.value); setSnapshot(null); }}>
            {data.dests.map((d) => <option key={d.id} value={d.id}>{d.account}</option>)}
          </select>
        </>
      )}
      <label className="field-label" htmlFor="rs-snap">Snapshot</label>
      <select id="rs-snap" className="input" value={chosen} onChange={(e) => setSnapshot(e.target.value)}>
        {data.history.map((h, i) => (
          <option key={h.snapshot} value={h.snapshot}>{when(h.at)}{i === 0 ? ' (latest)' : ''} · {plural(h.notes, 'note')} · {plural(h.files?.count ?? 0, 'file')}</option>
        ))}
      </select>
    </>
  );
}

/**
 * Some notes or whole notebooks back into a running tenant, as copies, from a host-backup snapshot. Only notebook
 * names and note titles are shown here; what the notes say never reaches the console.
 */
function ItemRestore({ slug, close, snaps: { data, error }, dest, setDest }) {
  const dialog = useDialog();
  const [snapshot, setSnapshot] = useState(null);
  const [opened, setOpened] = useState(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [query, setQuery] = useState('');
  const [books, setBooks] = useState(new Set());
  const [notes, setNotes] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const chosen = snapshot ?? data?.latest;
  const key = `${data?.dest}:${chosen}`;

  const open = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      if (opened) adminApi.closeItems(opened.token).catch(() => {});
      setOpened({ ...(await adminApi.openItems(slug, chosen, data.dest)), key });
      setBooks(new Set());
      setNotes(new Set());
    } catch (e) {
      if (e.status !== 403) setOpenError(e.message);
    }
    setOpening(false);
  };
  // The latest snapshot opens by itself once the list is in; another one opens with the button.
  useEffect(() => {
    if (data && !opened && !opening && !openError) open();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const shut = (ok) => { if (opened) adminApi.closeItems(opened.token).catch(() => {}); close(ok); };
  const byBook = useMemo(() => {
    const m = new Map();
    for (const n of opened?.notes ?? []) {
      if (!m.has(n.notebook_id)) m.set(n.notebook_id, []);
      m.get(n.notebook_id).push(n);
    }
    return m;
  }, [opened]);
  const q = query.trim().toLowerCase();
  const toggle = (set, setter, id) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); setter(next); };
  const loose = [...notes].filter((id) => !books.has(opened?.notes.find((n) => n.id === id)?.notebook_id));

  const run = async () => {
    setResult(null);
    try {
      const r = await adminApi.restoreItems(opened.token, { slug, notes: loose, notebooks: [...books] });
      setResult(await waitForJob(r.jobId, setBusy));
    } catch (e) {
      if (e.status !== 403) dialog.toast(e.message, 'error', 7000);
    }
    setBusy(null);
  };

  return (
    <>
      <p className="muted">Bring back single notes or whole notebooks as copies, into {slug}’s Selah while it keeps running. Nothing they have now is changed. You’ll see notebook names and note titles only, never what the notes say.</p>
      <ErrorNote error={error} />
      {!data ? !error && <ReadingSnapshots /> : (
        <>
          <SnapshotPicker data={data} dest={dest} setDest={setDest} chosen={chosen} setSnapshot={setSnapshot} />
          {opened && opened.key !== key && !opening && (
            <div className="adm-actions">
              <button type="button" className="btn btn-small" onClick={open}>Open this snapshot</button>
            </div>
          )}
          {opening && <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> Opening the snapshot (names and titles only)…</p>}
          {openError && (
            <p className="form-error">{openError} <button type="button" className="link-btn" onClick={open}>Try again</button></p>
          )}
        </>
      )}
      {opened && !result?.ok && (
        <>
          <input className="input" type="search" placeholder="Filter by title…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter by title" />
          <div className="adm-items">
            {opened.notebooks.map((b) => {
              const list = (byBook.get(b.id) ?? []).filter((n) => !q || n.title.toLowerCase().includes(q));
              if (q && !list.length && !b.name.toLowerCase().includes(q)) return null;
              const whole = books.has(b.id);
              return (
                <details key={b.id} className="adm-item-book" open={!!q}>
                  <summary>
                    <input type="checkbox" checked={whole} onChange={() => toggle(books, setBooks, b.id)} onClick={(e) => e.stopPropagation()}
                      aria-label={`Restore the whole notebook ${b.name}`} title="Restore the whole notebook" />
                    <strong>{b.name}</strong>{b.stack && <span className="muted"> · {b.stack}</span>}
                    <span className="muted"> · {plural(b.count, 'note')}</span>
                  </summary>
                  <ul>
                    {list.map((n) => (
                      <li key={n.id}>
                        <label>
                          <input type="checkbox" checked={whole || notes.has(n.id)} disabled={whole} onChange={() => toggle(notes, setNotes, n.id)} />
                          <span>{n.title || 'Untitled'}</span>
                          <span className="muted">{when(n.updated_at)}{n.attachments ? ` · ${plural(n.attachments, 'attachment')}` : ''}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </>
      )}
      {busy && <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> {busy}…</p>}
      {result && (
        <p className={result.ok ? 'adm-result is-good' : 'adm-result is-bad'}>
          {result.ok ? '✓ ' : '✗ '}
          {result.detail?.error ?? `Restored ${plural(result.detail.notes, 'note')}${result.detail.notebooks ? ` (${plural(result.detail.notebooks, 'new notebook')})` : ''} into ${slug}’s Selah${result.detail.missing ? `; ${plural(result.detail.missing, 'attachment')} couldn’t be found` : ''}.`}
        </p>
      )}
      <div className="modal-actions spread">
        <span className="muted">{opened && !result?.ok && `${books.size ? plural(books.size, 'notebook') : ''}${books.size && loose.length ? ' and ' : ''}${loose.length ? plural(loose.length, 'note') : ''}${!books.size && !loose.length ? 'Tick notebooks or notes.' : ''}`}</span>
        <span className="modal-actions-group">
          <button type="button" className="btn" onClick={() => shut(!!result?.ok)}>{result ? 'Done' : 'Cancel'}</button>
          {!result?.ok && (
            <button type="button" className="btn btn-primary" disabled={!opened || opened.key !== key || !!busy || (!books.size && !loose.length)} onClick={run}>Restore</button>
          )}
        </span>
      </div>
    </>
  );
}

/** While the backup's snapshots are being read. */
const ReadingSnapshots = () => <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> Reading the backup’s snapshots (this can take a few seconds)…</p>;

function HostRestore({ slug, missing, close, snaps: { data, error }, dest, setDest }) {
  const dialog = useDialog();
  const [snapshot, setSnapshot] = useState(null);
  const [mode, setMode] = useState(missing ? 'live' : 'test');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const chosen = snapshot ?? data?.latest;
  const run = async () => {
    setResult(null);
    try {
      const r = mode === 'test' ? await adminApi.testRestore(slug, chosen, data.dest) : await adminApi.restore(slug, chosen, typed, data.dest);
      const j = await waitForJob(r.jobId, setBusy);
      setResult(j);
    } catch (e) {
      if (e.status !== 403) dialog.toast(e.message, 'error', 7000);
    }
    setBusy(null);
  };
  return (
    <>
      <ErrorNote error={error} />
      {!data ? !error && <ReadingSnapshots /> : (
        <>
          <SnapshotPicker data={data} dest={dest} setDest={setDest} chosen={chosen} setSnapshot={setSnapshot} />
          {!missing && (
            <div className="adm-choice">
              <label><input type="radio" checked={mode === 'test'} onChange={() => setMode('test')} /> <span><strong>Test restore</strong><span className="muted">Restore into a scratch folder, check it opens and every attachment is there, then remove it. Nothing changes for {slug}.</span></span></label>
              <label><input type="radio" checked={mode === 'live'} onChange={() => setMode('live')} /> <span><strong>Restore over their Selah</strong><span className="muted">Their Selah stops, its data is moved aside (kept, not deleted) and replaced with the snapshot. They’ll sign in again and reconnect their own off-site backup.</span></span></label>
            </div>
          )}
          {missing && <p className="muted">{slug} isn’t on this server. It will be created again from the backup, at the same address, with its notes, attachments and settings. They’ll sign in with their old password.</p>}
          {mode === 'live' && (
            <>
              <label className="field-label" htmlFor="rs-confirm">Type <code>{slug}</code> to confirm</label>
              <input id="rs-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </>
          )}
          {busy && <p className="adm-busy"><span className="offsite-spinner" aria-hidden="true" /> {busy}…</p>}
          {result && (
            <p className={result.ok ? 'adm-result is-good' : 'adm-result is-bad'}>
              {result.ok ? '✓ ' : '✗ '}
              {result.detail?.error ?? (result.kind === 'test-restore'
                ? `The snapshot restores: ${plural(result.detail.notes, 'note')}, ${plural(result.detail.files, 'file')}, database checks out${result.detail.problems?.length ? `, but: ${result.detail.problems.join('; ')}` : ''}.`
                : `Restored: ${plural(result.detail.notes, 'note')}, ${plural(result.detail.files, 'file')}. ${slug} is running again.`)}
            </p>
          )}
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(!!result?.ok)}>{result ? 'Done' : 'Cancel'}</button>
        {!result?.ok && (
          <button type="button" className={`btn ${mode === 'live' ? 'btn-danger' : 'btn-primary'}`} disabled={!data || !!busy || (mode === 'live' && typed !== slug)} onClick={run}>
            {mode === 'test' ? 'Test restore' : missing ? 'Bring it back' : 'Restore'}
          </button>
        )}
      </div>
    </>
  );
}

export default function Backups({ go }) {
  const dialog = useDialog();
  const { data, error, reload } = useLoad(() => adminApi.backups(), [], 10_000);
  const jobs = useLoad(() => adminApi.jobs({ limit: 30 }), [], 10_000);
  const inBackup = useLoad(() => (data?.configured ? adminApi.inBackup() : Promise.resolve({ tenants: [] })), [data?.configured]);
  const [time, setTime] = useState(null);
  const [busy, setBusy] = useState(null);

  if (!data) return error ? <ErrorNote error={error} /> : <div className="adm-loading" />;
  const run = async (verify = false) => {
    setBusy(verify ? 'Backing up and checking' : 'Backing up');
    try {
      const r = await adminApi.runBackups(null, verify);
      reload();
      const j = await waitForJob(r.jobId, (p) => setBusy(p));
      dialog.toast(j.ok ? 'Every tenant is backed up' : `The backup had problems: ${j.detail?.error ?? j.detail?.failed?.join(', ')}`, j.ok ? 'info' : 'error', 7000);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    setBusy(null);
    reload(); jobs.reload(); inBackup.reload();
  };
  const setup = async (dest = null) => {
    if (await dialog.open((c) => <SetupDialog dest={dest} first={!data.configured} rclone={data.rclone} close={c} />)) { reload(); inBackup.reload(); }
  };
  const remove = async (d) => {
    const last = data.dests.length === 1;
    if (!await dialog.confirm({
      title: `Stop backing up to ${d.account}?`,
      message: `${last ? 'Nightly backups stop: this is the only destination. ' : 'Backups keep going to the other destinations. '}What’s already there stays there.`,
      okLabel: last ? 'Stop backups' : 'Remove', danger: true,
    })) return;
    try { await adminApi.removeBackupDest(d.id); reload(); inBackup.reload(); } catch (e) { if (e.status !== 403) dialog.toast(e.message, 'error'); }
  };
  const saveTime = async () => {
    try { await adminApi.backupSchedule(time); setTime(null); reload(); dialog.toast('Saved'); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const missing = (inBackup.data?.tenants ?? []).filter((t) => !t.here);
  const backupJobs = (jobs.data?.jobs ?? []).filter((j) => ['backup', 'test-restore', 'restore', 'restore-notes'].includes(j.kind));

  if (!data.configured) {
    return (
      <div className="adm-empty">
        <Icon name="restore" size={28} />
        <p>Nobody’s Selah is backed up off this server yet. Set up the host backup: every tenant, every night, encrypted with your passphrase.</p>
        {!data.rclone && <p className="form-error">rclone isn’t installed. On the server, run <code>npm run install-rclone</code>.</p>}
        <button className="btn btn-primary" disabled={!data.rclone} onClick={() => setup()}>Set up the host backup…</button>
      </div>
    );
  }

  return (
    <div className="adm-grid">
      <Card title="Host Backup" icon="restore" className="adm-wide"
        actions={<span className="adm-actions"><button className="btn btn-small" disabled={!!busy || !!data.running} onClick={() => run(false)}>Back up now</button><button className="btn btn-small" disabled={!!busy || !!data.running} onClick={() => run(true)}>Back up and check</button></span>}>
        <p className="adm-status">
          {data.running ? <Badge kind="busy">{data.running.phase}…</Badge>
            : !data.last ? <Badge kind="warn">No backup yet</Badge>
              : data.last.ok ? <Badge kind="good">Backed up {ago(data.last.finishedAt)}</Badge>
                : <Badge kind="bad">Last backup failed {ago(data.last.finishedAt)}</Badge>}
          {busy && !data.running && <span className="muted"> {busy}…</span>}
        </p>
        <ul className="adm-dests" aria-label="Where backups go">
          {data.dests.map((d) => (
            <li key={d.id}>
              <Icon name={(d.provider ?? d.kind) === 'onedrive' ? 'cloud' : d.provider === 's3' ? 'database' : 'server'} size={16} />
              <span className="adm-dest-name"><strong>{d.account}</strong>
                <span className="muted">{d.last ? (d.last.ok ? `✓ backed up ${ago(d.last.finishedAt)}` : <span className="is-bad">✗ {d.last.error ?? 'failed'}</span>) : `connected ${ago(d.connectedAt)}`}</span>
              </span>
              <button className="btn btn-small" onClick={() => setup(d)}>Reconnect…</button>
              <button className="btn btn-small btn-danger-text" onClick={() => remove(d)}>Remove…</button>
            </li>
          ))}
        </ul>
        {data.dests.length < data.maxDests && (
          <button className="btn btn-small adm-add-dest" onClick={() => setup()}><Icon name="plus" size={13} /> Add a destination…</button>
        )}
        <dl className="adm-facts">
          <dt>Keeps</dt><dd>{data.keepDays} days of snapshots (never fewer than {data.keepMin}); removed attachments for {data.keepDays} days</dd>
          <dt>Every night at</dt>
          <dd className="adm-inline">
            <input className="input" type="time" value={time ?? data.backupTime} onChange={(e) => setTime(e.target.value)} aria-label="Backup time (UTC)" /> UTC
            {time && time !== data.backupTime && <button className="btn btn-small btn-primary" onClick={saveTime}>Save</button>}
          </dd>
        </dl>
      </Card>

      <Card title="Tenants" icon="users" className="adm-wide">
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr><th>Tenant</th><th>Host backup</th><th>Last check</th><th>Their own backup</th><th /></tr></thead>
            <tbody>
              {data.tenants.map((t) => {
                const h = t.host;
                return (
                  <tr key={t.slug}>
                    <td><button className="link-btn" onClick={() => go('tenants', t.slug)}>{t.slug}</button></td>
                    <td>{h?.last && !h.last.ok ? <span className="is-bad">Failed {ago(h.last.finishedAt)}: {h.last.error}</span>
                      : h?.lastSuccess ? `${ago(h.lastSuccess.finishedAt)} · ${plural(h.lastSuccess.notes, 'note')} · ${size(h.lastSuccess.files?.bytes)}` : <span className="muted">Not yet</span>}</td>
                    <td className="muted">{h?.lastVerify ? (h.lastVerify.ok ? `✓ ${ago(h.lastVerify.at)}` : <span className="is-bad">✗ {h.lastVerify.error}</span>) : '–'}</td>
                    <td className="muted">{t.own?.configured ? `${t.own.lastSuccessAt ? ago(t.own.lastSuccessAt) : 'connected'}${t.own.lastError ? ' · failing' : ''}` : 'Not connected'}</td>
                    <td><button className="btn btn-small" onClick={() => dialog.open((c) => <RestoreDialog slug={t.slug} close={c} />).then(reload)}>Restore…</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {missing.length > 0 && (
        <Card title="In the Backup, Not on This Server" icon="download" className="adm-wide">
          <p className="muted">Tenants the backup holds that this server doesn’t have: after moving to a new server, or deleted here before their backup was removed.</p>
          <ul className="adm-list">
            {missing.map((t) => (
              <li key={t.slug}>
                <strong>{t.slug}</strong><span className="muted">backed up {t.createdAt ? when(Date.parse(t.createdAt)) : '–'} · {plural(t.notes, 'note')} · {plural(t.snapshots, 'snapshot')}</span>
                <button className="btn btn-small" onClick={() => dialog.open((c) => <RestoreDialog slug={t.slug} missing close={c} />).then(() => { reload(); inBackup.reload(); })}>Bring back…</button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="History" icon="clock" className="adm-wide">
        {backupJobs.length === 0 ? <p className="card-empty">No backups or restores yet.</p> : <ul className="adm-jobs">{backupJobs.map((j) => <JobRow key={j.id} job={j} />)}</ul>}
      </Card>
    </div>
  );
}
