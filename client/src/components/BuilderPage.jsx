import SermonBuilder from './SermonBuilder.jsx';
import StudyBuilder from './StudyBuilder.jsx';
import LessonBuilder from './LessonBuilder.jsx';
import { BackgroundBuilder, WordStudyBuilder } from './ReferenceStudies.jsx';

const BUILDERS = { sermon: SermonBuilder, study: StudyBuilder, lesson: LessonBuilder, background: BackgroundBuilder, word: WordStudyBuilder };

/**
 * A builder as a page in its own tab (10.0): the steps down the side and the boxes filling the page, like a note.
 * `close` is the builder's ✕ (and Save and close, Preach…): its tab closes and you go back to where you were.
 */
export default function BuilderPage({ id, builder, startAt = null, close }) {
  const C = BUILDERS[builder] ?? StudyBuilder;
  return (
    <div className="builder-page">
      <C noteId={id} close={close} {...(builder === 'sermon' && startAt != null ? { startAt } : {})} />
    </div>
  );
}
