import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { WORKFLOWS, defaultMethodOf, defaultPrefKey, lastPrefKey, methodById, methodsFor, seriesMethod } from '../../../shared/methods.js';

/**
 * Choosing the method a new Bible study, lesson or sermon follows (shared/methods.js), or switching a note to
 * another one. A card per method: its name, where it comes from, what it suits, and its steps.
 */
function MethodPicker({ workflow, preselect, templates = [], series = null, switching = null, close }) {
  const w = WORKFLOWS[workflow];
  const methods = methodsFor(workflow).filter((m) => m.id !== switching);
  const [pick, setPick] = useState(preselect && (methods.some((m) => m.id === preselect) || templates.some((t) => t.id === preselect)) ? preselect : methods[0]?.id);
  const [forSeries, setForSeries] = useState(false);
  const card = (id, name, source, bestFor, steps) => (
    <button key={id} type="button" role="radio" aria-checked={pick === id} className={`study-kind method-card ${pick === id ? 'is-active' : ''}`}
      onClick={() => setPick(id)} onDoubleClick={() => close({ method: id, forSeries })}>
      <strong>{name}</strong>
      {source && <span className="method-source">{source}</span>}
      {bestFor && <span>{bestFor}</span>}
      {steps?.length > 0 && <span className="method-steps">{steps.map((s) => <em key={s}>{s}</em>)}</span>}
    </button>
  );
  return (
    <form className="method-picker" onSubmit={(e) => { e.preventDefault(); if (pick != null) close({ method: pick, forSeries }); }}>
      <div className="dialog-header">
        <h2>{switching ? 'Switch to Another Method' : `Choose a Method for This ${w.label}`}</h2>
        <button type="button" className="icon-btn" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">{switching
        ? `Sections that match carry across, and anything the new method has no place for goes under Other notes, so nothing is lost. Ctrl+Z undoes it.`
        : `How should this ${w.noun} be laid out? You can switch it to another method later.`}</p>
      <div className="study-kinds method-cards" role="radiogroup" aria-label="Method">
        {methods.map((m) => card(m.id, m.name, m.source, m.bestFor, m.steps))}
        {!switching && templates.map((t) => card(t.id, t.title || 'Untitled', 'Your template', 'Starts from your own template note, with {{passage}}, {{lesson}} and {{study}} filled in.', null))}
      </div>
      {series && !switching && (
        <label className="check-row method-series">
          <input type="checkbox" checked={forSeries} onChange={(e) => setForSeries(e.target.checked)} />
          <span>Use it for every {w.noun} in “{series.title}”</span>
        </label>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={pick == null}>{switching ? 'Switch' : 'Start'}</button>
      </div>
    </form>
  );
}

const readPref = (key) => api.getPref(key).catch(() => null);

/**
 * The method a new study, lesson or sermon follows. A series or course that sets one decides; then the default in
 * Settings; otherwise the picker asks (with the one you used last chosen), unless there's only one to pick from.
 * Lessons can start from your templates too, as teaching studies could before. Resolves the method (an id, or a
 * template's note id), or null when you cancel.
 */
export async function chooseMethod(dialog, workflow, { studyId = null } = {}) {
  const series = studyId ? await api.study(studyId).catch(() => null) : null;
  const set = seriesMethod(series?.data, workflow);
  if (set != null) return set;
  const templates = workflow === 'lesson' ? await api.listNotes({ templates: 1, sort: 'title' }).catch(() => []) : [];
  if (methodsFor(workflow).length + templates.length <= 1) return defaultMethodOf(workflow);
  const [def, last] = await Promise.all([readPref(defaultPrefKey(workflow)), readPref(lastPrefKey(workflow))]);
  if (def && def !== 'ask' && methodById(def)?.workflow === workflow) return def;
  const r = await dialog.open((close) => <MethodPicker workflow={workflow} preselect={last} templates={templates} series={series} close={close} />);
  if (!r) return null;
  api.setPref(lastPrefKey(workflow), r.method).catch(() => {});
  if (r.forSeries && series) {
    const data = workflow === 'lesson' ? { lessonLayout: r.method } : { methods: { ...(series.data?.methods ?? {}), [workflow]: r.method } };
    await api.updateStudy(series.id, { data }).catch((e) => dialog.toast(e.message, 'error'));
  }
  return r.method;
}

/** Asks which method to switch a note to. Resolves the method id, or null. */
export async function chooseSwitch(dialog, workflow, current) {
  const r = await dialog.open((close) => <MethodPicker workflow={workflow} switching={current} close={close} />);
  return r?.method ?? null;
}

/** Settings: a default method for each workflow that has more than one (or Ask each time). */
export function MethodDefaults() {
  const flows = Object.keys(WORKFLOWS).filter((w) => methodsFor(w).length > 1);
  const [values, setValues] = useState({});
  useEffect(() => {
    Promise.all(flows.map((w) => readPref(defaultPrefKey(w)).then((v) => [w, v ?? 'ask']))).then((all) => setValues(Object.fromEntries(all)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!flows.length) return null;
  const change = (w, v) => { setValues((x) => ({ ...x, [w]: v })); api.setPref(defaultPrefKey(w), v).catch(() => {}); };
  return flows.map((w) => (
    <label key={w} className="about-row">
      <span className="muted">New {WORKFLOWS[w].plural.toLowerCase()} use</span>
      <select className="input method-default" value={values[w] ?? 'ask'} onChange={(e) => change(w, e.target.value)}>
        <option value="ask">Ask each time</option>
        {methodsFor(w).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
  ));
}

/**
 * A series' or course's method for its notes, for its settings: Ask each time (your Settings default, else the
 * picker), or one method (lessons can use one of your templates too). Shown only when there's a choice to make.
 */
export function SeriesMethodField({ workflow, value, onChange, label, templates = [], hint = null }) {
  if (methodsFor(workflow).length + templates.length <= 1) return null;
  const v = value == null ? '' : String(value);
  const pick = (x) => onChange(x === '' ? null : /^\d+$/.test(x) ? Number(x) : x);
  return (
    <label className="field">{label}
      <select className="input" value={v} onChange={(e) => pick(e.target.value)}>
        <option value="">Ask each time</option>
        {methodsFor(workflow).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        {templates.length > 0 && (
          <optgroup label="Your templates">
            {templates.map((t) => <option key={t.id} value={t.id}>{t.title || 'Untitled'}</option>)}
          </optgroup>
        )}
      </select>
      <span className="muted field-hint">{/^\d+$/.test(v)
        ? 'In a template, {{passage}}, {{lesson}} and {{study}} fill in with the session’s passage, title and study.'
        : hint ?? `Used when you start a ${WORKFLOWS[workflow].noun}; ones you’ve already started don’t change.`}</span>
    </label>
  );
}
