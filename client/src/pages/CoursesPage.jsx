import Icon from '../components/Icon.jsx';
import Ring from '../components/Ring.jsx';
import { relativeDay } from '../time.js';
import { NewCourseDialog } from '../components/CourseDialogs.jsx';
import { DAY_NAMES } from '../course.js';
import { BOOKS } from '../../../shared/scripture.js';

const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

/** Starts a new course with the wizard and opens it on Desk. */
export async function startCourse(dialog, tree) {
  const id = await dialog.open((close) => <NewCourseDialog tree={tree} close={close} />);
  if (id) window.dispatchEvent(new CustomEvent('noteapp:show-course', { detail: id }));
  return id;
}

function paceText(p) {
  if (!p.total) return 'No weeks planned yet';
  if (p.done === p.total) return 'All weeks taught';
  return [`${p.done} of ${plural(p.total, 'week')} taught`, p.behind ? `${p.behind} behind` : p.next?.date && 'on track'].filter(Boolean).join(' · ');
}

/** A course's card on Desk (Teach). */
export function CourseCard({ s, onOpen }) {
  const c = s.data.course;
  const day = c.classDay != null ? `${DAY_NAMES[c.classDay]}s` : null;
  return (
    <button type="button" className={`study-card study-c-${s.color ?? 'green'}`} onClick={onOpen}>
      <span className="study-card-kind"><Icon name="present" size={14} /> {[c.type === 'topic' ? (c.topic || 'Topical') : (BOOKS.find((x) => x.order === c.book)?.name ?? 'Course'), day].filter(Boolean).join(' · ')}</span>
      <strong className="study-card-title">{s.title}</strong>
      {s.description && <span className="study-card-desc">{s.description}</span>}
      {s.progress.total > 0 && <Ring value={s.progress.done} max={s.progress.total} />}
      <span className={`study-card-pace ${s.progress.behind ? 'is-behind' : ''}`}>{paceText(s.progress)}</span>
      {s.status === 'active' && s.progress.next && (
        <span className="study-card-next"><Icon name="chevronRight" size={13} /> {s.progress.next.title}{s.progress.next.date ? ` · ${relativeDay(s.progress.next.date)}` : ''}</span>
      )}
    </button>
  );
}
