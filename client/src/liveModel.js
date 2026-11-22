import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { joinCoedit, setYText } from './coedit.js';
import { useBuilderEnv } from './builderApi.js';

/**
 * Live co-editing for the builders (14.3): a sermon, lesson or study builder's state ({ model, meta, … }) shared
 * between everyone with the builder open, through the note's 'builder' room (server/coedit.js).
 *
 * The builders keep their state as plain objects, changed immutably. This mirrors it in one Yjs map: objects are
 * Y.Maps, arrays Y.Arrays (items with a `uid`, like a sermon's divisions, are matched by it), and every string is a
 * Y.Text changed by the smallest edit, so two people typing in the same box merge as they type. What the others
 * change comes back as new state for the builder to show; it isn't this window's change, so it doesn't save here
 * (each window saves after its own changes, and everyone's state is the same).
 */

const REMOTE = 'coedit-remote';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasUid = (a) => a.length > 0 && a.every((x) => isObj(x) && typeof x.uid === 'string');

function toY(v) {
  if (typeof v === 'string') return new Y.Text(v);
  if (Array.isArray(v)) {
    const a = new Y.Array();
    a.insert(0, v.filter((x) => x !== undefined).map(toY));
    return a;
  }
  if (isObj(v)) {
    const m = new Y.Map();
    for (const [k, x] of Object.entries(v)) if (x !== undefined) m.set(k, toY(x));
    return m;
  }
  return v ?? null;
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const uidOf = (y) => (y instanceof Y.Map ? y.get('uid')?.toString() : undefined);

/** Where an offset in `before` is in `after` (what's the same at the start stays put). */
function shiftOffset(pos, before, after) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  return pos <= p ? pos : Math.max(p, Math.min(after.length, pos + after.length - before.length));
}

/**
 * This window changed a string from `base` (what it showed) to `next`; the Y.Text may have the others' typing
 * in it since. Only this window's edit goes in, where it falls in the text as it is now.
 */
function mergeText(ytext, base, next) {
  const cur = ytext.toString();
  if (next === cur) return;
  if (base === cur) { setYText(ytext, next); return; }
  let p = 0;
  while (p < base.length && p < next.length && base[p] === next[p]) p++;
  let e = 0;
  while (e < base.length - p && e < next.length - p && base[base.length - 1 - e] === next[next.length - 1 - e]) e++;
  const del = base.length - p - e;
  const ins = next.slice(p, next.length - e);
  const at = shiftOffset(p, base, cur);
  ytext.doc.transact(() => {
    if (del > 0) ytext.delete(at, Math.min(del, cur.length - at));
    if (ins) ytext.insert(Math.min(at, ytext.length), ins);
  });
}

/**
 * Puts this window's change (from `prev`, what it showed, to `next`) into the Y value at parent[key]. What the
 * others changed meanwhile stays: only what differs between prev and next is written.
 */
function patchIn(parent, key, prev, next) {
  if (prev === next) return;
  const cur = parent.get(key);
  const replace = () => {
    if (parent instanceof Y.Array) { parent.delete(key, 1); parent.insert(key, [toY(next)]); } else if (next === undefined) parent.delete(key);
    else parent.set(key, toY(next));
  };
  if (typeof next === 'string' && cur instanceof Y.Text) { mergeText(cur, typeof prev === 'string' ? prev : cur.toString(), next); return; }
  if (isObj(next) && cur instanceof Y.Map) {
    const was = isObj(prev) ? prev : {};
    for (const k of new Set([...Object.keys(was), ...Object.keys(next)])) {
      if (next[k] === undefined) { if (cur.has(k)) cur.delete(k); continue; }
      if (!cur.has(k)) { cur.set(k, toY(next[k])); continue; }
      patchIn(cur, k, was[k], next[k]);
    }
    return;
  }
  if (Array.isArray(next) && cur instanceof Y.Array) { patchArray(cur, Array.isArray(prev) ? prev : cur.toJSON(), next); return; }
  if (cur instanceof Y.AbstractType || typeof next === 'object' || cur !== next) replace();
}

function patchArray(yarr, prev, next) {
  if (hasUid(next) && (!prev.length || hasUid(prev))) {
    const nextIds = new Set(next.map((x) => x.uid));
    const prevBy = new Map(prev.map((x) => [x.uid, x]));
    // Taken out here.
    for (let i = yarr.length - 1; i >= 0; i--) {
      const id = uidOf(yarr.get(i));
      if (prevBy.has(id) && !nextIds.has(id)) yarr.delete(i, 1);
    }
    const indexOf = (id) => { for (let i = 0; i < yarr.length; i++) if (uidOf(yarr.get(i)) === id) return i; return -1; };
    // Moved here: the order of the ones both had changed.
    const order = (list) => list.map((x) => x.uid).filter((id) => prevBy.has(id) && nextIds.has(id));
    const moved = order(prev).join() !== order(next).join();
    let after = -1;
    next.forEach((item) => {
      let j = indexOf(item.uid);
      if (j < 0) { yarr.insert(after + 1, [toY(item)]); after += 1; return; }
      if (moved && j <= after) {
        const json = yarr.get(j).toJSON();
        yarr.delete(j, 1);
        after -= 1;
        yarr.insert(after + 1, [toY({ ...json, ...item })]);
        j = after + 1;
      } else {
        patchIn(yarr, j, prevBy.get(item.uid), item);
      }
      after = Math.max(after, j);
    });
    return;
  }
  if (prev.length === next.length && yarr.length === next.length) {
    next.forEach((x, i) => { if (prev[i] !== x) patchIn(yarr, i, prev[i], x); });
    return;
  }
  // Something added or taken out here: what's the same at both ends of prev and next stays.
  let start = 0;
  while (start < prev.length && start < next.length && same(prev[start], next[start])) start++;
  let end = 0;
  while (end < prev.length - start && end < next.length - start && same(prev[prev.length - 1 - end], next[next.length - 1 - end])) end++;
  const del = Math.min(prev.length - start - end, Math.max(0, yarr.length - start));
  if (del > 0) yarr.delete(Math.min(start, yarr.length), del);
  const add = next.slice(start, next.length - end);
  if (add.length) yarr.insert(Math.min(start, yarr.length), add.map(toY));
}

/** Where the cursor is in a text box (or input), to put it back after the others' typing arrives. */
function caretNow() {
  const el = document.activeElement;
  if (!el || !('selectionStart' in el) || el.selectionStart == null) return null;
  return { el, value: el.value, start: el.selectionStart, end: el.selectionEnd };
}

/**
 * values: the builder's state, by name ({ model, meta }); set: its setters, by the same names. ready: the builder
 * has loaded (values are all there); loaded: the round it loaded for. Returns { live, peers, round, onRemote }: live is the session (its epoch goes
 * with saves) or null; round goes up when the room starts again, and the builder then loads the note again.
 */
export function useLiveModel({ noteId, ready: loadedAny, loaded = 0, values, set, onRemote }) {
  const [live, setLive] = useState(null);
  const [peers, setPeers] = useState([]);
  const [round, setRound] = useState(0);
  // 14.3: a builder for a note shared with me reaches its room on the owner's Selah.
  const coeditOpts = useBuilderEnv().coedit;
  // Ready only once the builder has loaded the note for this round (after a reset, not the state from before).
  const ready = !!loadedAny && loaded === round;
  const synced = useRef({}); // the state this window last showed, by name: the base of its edits
  const remote = useRef({}); // the others' state as last taken from the map, by name
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const setRef = useRef(set);
  setRef.current = set;
  const remoteRef = useRef(onRemote);
  remoteRef.current = onRemote;
  const caret = useRef(null);
  const [remoteTick, setRemoteTick] = useState(0);

  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    let session = null;
    const offs = [];
    (async () => {
      session = await joinCoedit(noteId, 'builder', coeditOpts ?? {});
      if (!alive) { session?.destroy(); return; }
      if (!session) { setLive(null); return; }
      const root = session.doc.getMap('builder');
      if (session.seed) {
        session.doc.transact(() => {
          for (const [k, v] of Object.entries(valuesRef.current)) root.set(k, toY(v));
        });
        synced.current = { ...valuesRef.current };
        session.seedDone();
      } else {
        const next = {};
        for (const k of Object.keys(valuesRef.current)) if (root.has(k)) next[k] = root.get(k).toJSON?.() ?? root.get(k);
        synced.current = { ...valuesRef.current };
        remote.current = next;
        for (const [k, v] of Object.entries(next)) setRef.current[k]?.(v);
      }
      // The others' changes: a change of this window's not yet sent (typed a moment ago, not yet shown) goes in
      // first, so it isn't lost under theirs; then the merged state is what shows.
      const onDeep = (events, tr) => {
        if (tr.origin !== REMOTE) return;
        for (const k of Object.keys(valuesRef.current)) {
          if (!root.has(k)) continue;
          setRef.current[k]?.((cur) => {
            if (cur !== synced.current[k] && cur !== remote.current[k] && cur != null) {
              session.doc.transact(() => patchIn(root, k, synced.current[k], cur));
              synced.current[k] = cur;
            }
            if (!caret.current) caret.current = caretNow();
            const y = root.get(k).toJSON?.() ?? root.get(k);
            remote.current[k] = y;
            return y;
          });
        }
        remoteRef.current?.();
        setRemoteTick((n) => n + 1);
      };
      root.observeDeep(onDeep);
      offs.push(() => root.unobserveDeep(onDeep));
      offs.push(session.on('reset', () => setRound((r) => r + 1)));
      offs.push(session.on('peers', setPeers));
      setPeers(session.peers());
      setLive(session);
    })();
    return () => {
      alive = false;
      for (const off of offs) off();
      session?.destroy();
      setLive(null);
      setPeers([]);
    };
  }, [noteId, ready, round]);

  // This window's changes go into the shared map. A change typed just as the others' arrived was made in what this
  // window showed before; the merged state then comes back to show.
  useEffect(() => {
    if (!live) return;
    const root = live.doc.getMap('builder');
    const pushed = [];
    live.doc.transact(() => {
      for (const [k, v] of Object.entries(values)) {
        if (v === synced.current[k]) continue;
        if (v !== remote.current[k]) {
          if (!root.has(k)) root.set(k, toY(v));
          else patchIn(root, k, synced.current[k], v);
          pushed.push(k);
        }
        synced.current[k] = v;
      }
    });
    for (const k of pushed) {
      const y = root.get(k)?.toJSON?.();
      if (y !== undefined && !same(y, values[k])) {
        caret.current = caretNow();
        remote.current[k] = y;
        setRef.current[k]?.(y);
        setRemoteTick((n) => n + 1);
      }
    }
  }); // every render: only what changed is compared

  // The cursor stays where it was in a text box when the others' typing comes in.
  useLayoutEffect(() => {
    const c = caret.current;
    caret.current = null;
    if (!c || document.activeElement !== c.el || c.el.value === c.value) return;
    try { c.el.setSelectionRange(shiftOffset(c.start, c.value, c.el.value), shiftOffset(c.end, c.value, c.el.value)); } catch { /* not a text box */ }
  }, [remoteTick]);

  const saveFields = useCallback((base) => (live ? { live: live.epoch } : { base_updated_at: base }), [live]);
  return { live, peers, round, saveFields };
}
