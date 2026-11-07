/**
 * The methods a workflow can follow: how a Bible study, a lesson or a sermon is laid out and built. Each workflow has
 * one or more; when it has more than one, starting a new one asks which (unless its series, or Settings, already
 * says), and a note can switch to another later (matching sections carry across, the rest goes under Other notes).
 *
 * A method's sections are what switching reads and writes: the heading level they sit at, a pattern that finds each
 * one in a note, and its roles. Content moves between methods by role: a section's first role is what its content
 * is, and the rest are what else it takes in when the method switched from has a section of that kind. A heading at that level that matches
 * none of them keeps its own heading: as `rest` when the method has one (a sermon's divisions are its body), else as
 * Other notes.
 *
 * Built in for now. Kept as plain data so methods made from your own templates can be added to the same list later.
 */
export const WORKFLOWS = {
  study: { label: 'Bible study', plural: 'Bible studies', noun: 'study' },
  lesson: { label: 'Lesson', plural: 'Lessons', noun: 'lesson' },
  sermon: { label: 'Sermon', plural: 'Sermons', noun: 'sermon' },
  // A writing project's type (6.6): its pieces (chapters, posts, a paper's parts) are laid out the same way.
  writing: { label: 'Piece of Writing', plural: 'Writing projects', noun: 'piece' },
};

export const OTHER_NOTES = 'Other notes';

export const METHODS = [
  {
    id: 'ggw', workflow: 'study', name: 'The Interpretive Journey',
    source: 'J. Scott Duvall and J. Daniel Hays, Grasping God’s Word',
    bestFor: 'Careful study of any passage: what it meant then, the principle behind it, and what it means now.',
    steps: ['Their Town', 'The River', 'The Bridge', 'The Biblical Map', 'Our Town', 'Keeper'],
    builder: 'study', level: 1,
    sections: [
      { title: 'Step 1: The Text in Their Town', match: /their\s+town|^step\s*1\b/i, roles: ['meaning'] },
      { title: 'Step 2: Measuring the River to Cross', match: /river|^step\s*2\b/i, roles: ['differences'] },
      { title: 'Step 3: Cross the Principlizing Bridge', match: /bridge|^step\s*3\b/i, roles: ['idea'] },
      { title: 'Step 4: Consult the Biblical Map', match: /biblical\s+map|^step\s*4\b/i, roles: ['consistency'] },
      { title: 'Step 5: The Text in My Town', match: /(my|our)\s+town|^step\s*5\b/i, roles: ['application'] },
      { title: 'Keeper', match: /^keeper/i, roles: ['keeper'] },
    ],
  },
  // 8.5: a book's background (one per book, shown beside every study in it) and a word study (one per word, with
  // the Greek or Hebrew, its uses, and a hover card wherever you write it).
  {
    id: 'background', workflow: 'study', name: 'Background Study',
    source: 'Author, date, audience, setting, genre and purpose: the questions of a Bible introduction',
    bestFor: 'A book of the Bible before you study its passages: who wrote it, when, to whom, why, and how it’s put together.',
    steps: ['Author', 'Date and Setting', 'Audience', 'Culture', 'Genre', 'Purpose', 'Scholars', 'Keeper'],
    builder: 'background', level: 1,
    sections: [
      { title: 'Book and Author', match: /author/i, roles: ['author'] },
      { title: 'Date and Setting', match: /^date|setting/i, roles: ['setting'] },
      { title: 'Audience and Occasion', match: /audience|occasion/i, roles: ['audience'] },
      { title: 'Culture and History', match: /culture|histor/i, roles: ['differences'] },
      { title: 'Genre and Structure', match: /genre|structure|outline/i, roles: ['structure'] },
      { title: 'Purpose and Themes', match: /purpose|theme/i, roles: ['idea', 'meaning'] },
      { title: 'Scholars Compared', match: /scholar|views/i, roles: ['scholars'] },
      { title: 'Keeper', match: /^keeper/i, roles: ['keeper'] },
    ],
  },
  {
    id: 'word', workflow: 'study', name: 'Word Study',
    source: 'Hebrew and Greek from STEPBible.org; the method of D. A. Carson’s Exegetical Fallacies and Duvall and Hays',
    bestFor: 'One important word in a verse: its Hebrew or Greek, how translations render it, its range of meaning, its uses, and what it means here.',
    steps: ['The Word', 'Original', 'Translations', 'Range of Meaning', 'Usage', 'In This Context', 'Keeper'],
    builder: 'word', level: 1,
    sections: [
      { title: 'The Word', match: /^the\s+word$/i, roles: ['word'] },
      { title: 'Original Language', match: /original|hebrew|greek/i, roles: ['original'] },
      { title: 'Translations', match: /translation/i, roles: ['translations'] },
      { title: 'Range of Meaning', match: /range|meanings?$/i, roles: ['range'] },
      { title: 'Usage', match: /usage|uses|occurrence/i, roles: ['usage', 'consistency'] },
      { title: 'In This Context', match: /context/i, roles: ['meaning', 'idea'] },
      { title: 'Keeper', match: /^keeper/i, roles: ['keeper'] },
    ],
  },
  {
    id: 'hblt', workflow: 'lesson', name: 'Hook, Book, Look, Took',
    source: 'Lawrence O. Richards, Creative Bible Teaching',
    bestFor: 'Classes that talk it through: a hook into the passage, the passage itself, discussion, then a response.',
    steps: ['Hook', 'Book', 'Look', 'Took'],
    builder: 'lesson', level: 1,
    sections: [
      { title: 'Introduction (Hook)', match: /hook|^introduction/i, roles: ['intro'] },
      { title: 'Exposition (Book)', match: /\bbook\b|exposition/i, roles: ['body', 'idea', 'text'] },
      { title: 'Inquisition (Look)', match: /\blook\b|inquisition|discussion/i, roles: ['questions'] },
      { title: 'Application (Took)', match: /\btook\b|application/i, roles: ['application', 'conclusion'] },
    ],
  },
  {
    id: 'points', workflow: 'lesson', name: 'Big Idea and Three Points',
    source: 'A classic teaching outline',
    bestFor: 'Lessons you mostly teach from the front: one big idea, three points, then application and questions.',
    steps: ['Big Idea', 'Text', 'Introduction', 'Three Points', 'Application', 'Discussion Questions'],
    builder: null, level: 2,
    sections: [
      { title: 'Big idea', match: /big\s+idea/i, roles: ['idea'] },
      { title: 'Text', match: /^text\b/i, roles: ['text'] },
      { title: 'Introduction', match: /^introduction/i, roles: ['intro'] },
      { title: '1. First point', match: /^1\.|first point/i, roles: ['body'] },
      { title: '2. Second point', match: /^2\.|second point/i, roles: [] },
      { title: '3. Third point', match: /^3\.|third point/i, roles: [] },
      { title: 'Application', match: /application/i, roles: ['application', 'conclusion'] },
      { title: 'Discussion questions', match: /question|discussion/i, roles: ['questions'] },
    ],
  },
  {
    id: 'mcdill', workflow: 'sermon', name: 'Twelve Essential Skills',
    source: 'Wayne McDill, 12 Essential Skills for Great Preaching',
    bestFor: 'Expository sermons: from the text’s idea to divisions you explain, illustrate, argue and apply.',
    steps: ['Introduction', 'Divisions', 'Conclusion'],
    builder: 'sermon', level: 1, rest: 'body',
    sections: [
      { title: 'Introduction', match: /^introduction/i, roles: ['intro'] },
      { title: 'Conclusion', match: /^conclusion/i, roles: ['conclusion', 'application'] },
    ],
  },
  // Writing (6.6). `piece` names one note of the project (a book's chapter, a blog's post); `ask` is the question each
  // section answers, shown in the Revise panel's Structure tab. Questions only: the writing is yours.
  {
    id: 'book', workflow: 'writing', name: 'Book',
    source: 'Chapters in order, with front and back matter',
    bestFor: 'A book or long study guide: chapters you write one at a time and read as one manuscript.',
    steps: ['Front Matter', 'Chapters', 'Back Matter'],
    builder: null, level: 1, rest: 'body', piece: 'chapter', pieces: 'chapters',
    // A chapter starts blank: its headings are its own.
    sections: [],
    matter: {
      front: ['Dedication', 'Foreword', 'Preface', 'Acknowledgments', 'Introduction'],
      back: ['Conclusion', 'Appendix', 'Notes', 'Bibliography', 'Scripture Index'],
    },
  },
  {
    id: 'blog', workflow: 'writing', name: 'Blog Post or Series',
    source: 'Short posts, on their own or as a series',
    bestFor: 'Posts for your site: one idea each, opened with a hook and closed with something to take away.',
    steps: ['Hook', 'Body', 'Takeaway'],
    builder: null, level: 1, piece: 'post', pieces: 'posts',
    sections: [
      { title: 'Hook', match: /^hook|^introduction|^opening/i, roles: ['intro'], ask: 'What question, story or moment will make your reader want the rest?' },
      { title: 'Body', match: /^body|^main/i, roles: ['body', 'idea', 'text'], ask: 'What’s the one idea of this post, and how will you show it?' },
      { title: 'Takeaway', match: /takeaway|^conclusion|^closing|application/i, roles: ['application', 'conclusion'], ask: 'What do you want the reader to carry away or do?' },
    ],
  },
  {
    id: 'paper', workflow: 'writing', name: 'Research Paper',
    source: 'Kate L. Turabian, A Manual for Writers (notes-bibliography style)',
    bestFor: 'Papers for a class: a thesis argued through sections you name, with footnotes and a bibliography.',
    steps: ['Introduction', 'Sections', 'Conclusion', 'Bibliography'],
    builder: null, level: 1, rest: 'body', piece: 'part', pieces: 'parts',
    sections: [
      { title: 'Introduction', match: /^introduction/i, roles: ['intro', 'idea'], ask: 'What question does the paper answer, and what is your thesis, in one sentence?' },
      { title: 'Conclusion', match: /^conclusion/i, roles: ['conclusion', 'application'], ask: 'How has the paper supported the thesis, and why does it matter?' },
      { title: 'Bibliography', match: /^bibliography|^works cited|^sources/i, roles: ['sources'], ask: 'Is every source you cited listed here?' },
    ],
  },
  {
    id: 'devotional', workflow: 'writing', name: 'Devotional or Article',
    source: 'A passage, a reflection, a response',
    bestFor: 'Short devotionals and articles: one passage, what it shows, and how to live it.',
    steps: ['Scripture', 'Reflection', 'Application', 'Prayer'],
    builder: null, level: 1, piece: 'piece', pieces: 'pieces',
    sections: [
      { title: 'Scripture', match: /^scripture|^text|^passage|^read/i, roles: ['text'], ask: 'Which passage, and which words in it stopped you?' },
      { title: 'Reflection', match: /^reflection|^body|^main/i, roles: ['body', 'idea', 'meaning'], ask: 'What does the passage show you about God, and about us?' },
      { title: 'Application', match: /application|takeaway|^response/i, roles: ['application'], ask: 'What is one way to live this today?' },
      { title: 'Prayer', match: /^prayer/i, roles: ['conclusion'], ask: 'How will you pray it back?' },
    ],
  },
];

/** A new note's skeleton in a method: its sections as empty headings (a method with a body of its own, like a book's chapters, puts an empty paragraph where its body goes). */
export function skeletonHtml(id) {
  const m = methodById(id);
  if (!m) return '<p></p>';
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = m.sections.map((s) => `<h${m.level}>${esc(s.title)}</h${m.level}><p></p>`);
  if (m.rest && parts.length) parts.splice(1, 0, '<p></p>');
  return parts.join('') || '<p></p>';
}

export const methodById = (id) => METHODS.find((m) => m.id === id) ?? null;
export const methodsFor = (workflow) => METHODS.filter((m) => m.workflow === workflow);
/** A workflow's first method: what it uses when nothing else says. */
export const defaultMethodOf = (workflow) => methodsFor(workflow)[0]?.id ?? null;
/** Whether starting one asks which method (only when there's more than one). */
export const hasChoice = (workflow) => methodsFor(workflow).length > 1;
/** A method id that's real for this workflow, else null. */
export const validMethod = (workflow, id) => (methodById(id)?.workflow === workflow ? id : null);

/**
 * The method a series or course sets for a workflow's notes (null when it leaves it to you). Teaching studies have
 * kept theirs as lessonLayout since 5.11 (where a number is one of your templates); the others keep data.methods.
 */
export function seriesMethod(data, workflow) {
  const d = data ?? {};
  const v = d.methods?.[workflow] ?? (workflow === 'lesson' ? d.lessonLayout : undefined);
  return v === undefined || v === null || v === '' ? null : v;
}

/** Preference keys: the Settings default ('ask' or a method id) and the method used last. */
export const defaultPrefKey = (workflow) => `methodDefault-${workflow}`;
export const lastPrefKey = (workflow) => `methodLast-${workflow}`;
