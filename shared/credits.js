/**
 * Credits & permissions (11.0): everything Selah uses from others, shown in Settings → Credits and kept in step with
 * THIRD-PARTY-NOTICES.md. Names and marks belong to their owners; listing them is credit, not endorsement.
 */
// 12.0: the public repository (fresh history; the private note-app repo keeps the old one). Change here when it's made.
export const SOURCE_URL = 'https://github.com/JDT12/selah';
/** Where Selah Desktop's installer is downloaded (GitHub Releases). */
export const DESKTOP_DOWNLOAD_URL = `${SOURCE_URL}/releases/latest`;

/** Bible text and services Selah connects to with your own keys or accounts. */
export const SERVICES = [
  { name: 'ESV® Bible', by: 'Crossway, a publishing ministry of Good News Publishers', url: 'https://api.esv.org/',
    note: 'The ESV text, through your own free API key from api.esv.org, for personal and church use under Crossway’s terms. ESV® is a registered trademark of Crossway.' },
  { name: 'New Living Translation (NLT)', by: 'Tyndale House Publishers', url: 'https://api.nlt.to/',
    note: 'The NLT text, through Tyndale’s NLT API with your own key, non-commercial use. Holy Bible, New Living Translation © 1996, 2004, 2015 by Tyndale House Foundation.' },
  { name: 'API.Bible', by: 'American Bible Society', url: 'https://api.bible/',
    note: 'Other translations, through your own API.Bible key; each lookup is reported to its Fair Use Management System, and each passage shows its publisher’s copyright.' },
  { name: 'Bible Gateway', by: 'Bible Gateway (HarperCollins Christian Publishing)', url: 'https://www.biblegateway.com/',
    note: 'The verse of the day on Home: its daily pick (just the reference; the text comes from your own translation).' },
  { name: 'Zotero', by: 'Corporation for Digital Scholarship', url: 'https://www.zotero.org/',
    note: 'Your Zotero library, read with your own API key, for citations.' },
  { name: 'Logos Bible Software', by: 'Faithlife', url: 'https://www.logos.com/',
    note: 'Links that open references and resources in Logos, and sermons brought in from Logos exports. Selah doesn’t connect to your Logos account.' },
  { name: 'WordPress', by: 'the WordPress project', url: 'https://wordpress.org/',
    note: 'Posting to your own WordPress site with an application password. WordPress is a trademark of the WordPress Foundation.' },
  { name: 'Canvas', by: 'Instructure', url: 'https://www.instructure.com/canvas',
    note: 'Class due dates from your Canvas calendar feed (.ics).' },
];

/** Data and content Selah ships with. */
export const DATA = [
  { name: 'STEPBible-Data', by: 'Tyndale House Cambridge and STEPBible.org', license: 'CC BY 4.0', url: 'https://github.com/STEPBible/STEPBible-Data',
    note: 'The tagged Hebrew and Greek texts and brief lexicons in word studies (adapted: compacted, with English verse numbering).' },
  { name: 'Citation Style Language styles', by: 'the CSL project and the styles’ authors', license: 'CC BY-SA 3.0', url: 'https://citationstyles.org/',
    note: 'The APA, Chicago, SBL and Turabian-style citation styles and the en-US locale.' },
  { name: 'M’Cheyne’s Calendar for Daily Readings', by: 'Robert Murray M’Cheyne (1842)', license: 'Public domain', url: '',
    note: 'One of the built-in reading plans.' },
  { name: 'Fonts: Cormorant Garamond, Inter, Source Serif 4', by: 'Christian Thalmann; Rasmus Andersson; Frank Grießhammer (Adobe)', license: 'SIL Open Font License 1.1', url: 'https://openfontlicense.org/',
    note: 'Bundled through Fontsource.' },
  { name: 'Tesseract English data', by: 'the Tesseract OCR project', license: 'Apache-2.0', url: 'https://github.com/tesseract-ocr/tessdata',
    note: 'For reading handwriting and printed pages.' },
];

/** Methods behind the builders and guides: the books and teachers they follow. */
export const METHODS = [
  { name: 'The Interpretive Journey', by: 'J. Scott Duvall and J. Daniel Hays, Grasping God’s Word', used: 'The Bible study builder (their town, the river, the principlizing bridge, the biblical map, our town).' },
  { name: 'Exegetical fallacies', by: 'D. A. Carson, Exegetical Fallacies', used: 'The word study’s fallacy check.' },
  { name: 'Hook, Book, Look, Took', by: 'Lawrence O. Richards (with Gary J. Bredfeldt), Creative Bible Teaching', used: 'The lesson builder, courses’ aims and levels of learning.' },
  { name: '12 Essential Skills', by: 'Wayne McDill, 12 Essential Skills for Great Preaching', used: 'The sermon builder’s steps.' },
  { name: 'The Big Idea', by: 'Haddon W. Robinson, Biblical Preaching', used: 'The Big Idea in lessons and sermons, and the Big Idea and Three Points lesson.' },
  { name: 'Cornell notes', by: 'Walter Pauk, How to Study in College', used: 'The Cornell note template and lecture notes in Learn.' },
  { name: 'Notes-bibliography style', by: 'Kate L. Turabian, A Manual for Writers of Research Papers, Theses, and Dissertations', used: 'Footnotes, bibliographies and the paper format.' },
];

/** Open-source software Selah is built with (each under its own license; full texts in THIRD-PARTY-NOTICES.md). */
export const SOFTWARE = [
  ['React', 'MIT'], ['Tiptap and ProseMirror', 'MIT'], ['FullCalendar', 'MIT'], ['Fastify', 'MIT'], ['Vite', 'MIT'],
  ['citeproc-js', 'CPAL-1.0 or AGPL-3.0 (used under the AGPL)'], ['pdf.js', 'Apache-2.0'], ['Tesseract.js', 'Apache-2.0'],
  ['Mozilla Readability', 'Apache-2.0'], ['ffmpeg (ffmpeg-static)', 'GPL-3.0-or-later'], ['libheif (libheif-js)', 'LGPL-3.0'],
  ['heic-convert', 'ISC'], ['docx', 'MIT'], ['marked', 'MIT'], ['highlight.js and lowlight', 'BSD-3-Clause / MIT'],
  ['rrule', 'BSD-3-Clause'], ['sax', 'BlueOak-1.0.0'], ['qrcode', 'MIT'], ['undici', 'MIT'], ['rclone (hosting)', 'MIT'],
];

export const TRADEMARKS = 'Product names, logos and trademarks mentioned here belong to their owners. Selah is not affiliated with or endorsed by any of them; naming them is credit, not a claim of partnership.';
