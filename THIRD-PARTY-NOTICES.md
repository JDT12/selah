# Third-party notices

Selah is licensed under the GNU Affero General Public License v3.0 or later (see [LICENSE](LICENSE)). It includes, or
connects to, work by others under their own terms, listed here. The same list is in the app under Settings → Credits
(`shared/credits.js`); keep the two in step.

Product names, logos and trademarks mentioned here belong to their owners. Selah is not affiliated with or endorsed by
any of them.

## Software bundled with Selah

Each package's full license text is in its folder under `node_modules/` (and in the published packages on npm).

| Software | License | Where |
| --- | --- | --- |
| citeproc-js (Frank Bennett) | CPAL-1.0 **or** AGPL-3.0; used under the AGPL | Citations and bibliographies |
| pdf.js (Mozilla) | Apache-2.0 (text in `client/public/pdfjs/LICENSE`) | Reading PDFs |
| Tesseract.js, tesseract.js-core | Apache-2.0 | Handwriting and printed-page OCR |
| @tesseract.js-data/eng (Tesseract trained data) | Apache-2.0 data, packaged under MIT | OCR language data |
| ffmpeg, via ffmpeg-static | GPL-3.0-or-later | Video and audio thumbnails. Its source is at https://ffmpeg.org/download.html; ffmpeg-static's build notes say which build is used. |
| libheif, via libheif-js | LGPL-3.0 | iPhone photos (HEIC); heic-convert and heic-decode are ISC |
| @mozilla/readability | Apache-2.0 | Clipping web pages |
| React, React DOM | MIT | The app |
| Tiptap, ProseMirror (@tiptap/*) | MIT | The note editor |
| FullCalendar (@fullcalendar/*) | MIT | Plan's calendar |
| Fastify and @fastify/* plugins | MIT | The server |
| Vite, @vitejs/plugin-react | MIT | Building the app |
| docx | MIT | Word export |
| marked | MIT | Markdown import |
| highlight.js | BSD-3-Clause | Code blocks |
| lowlight | MIT | Code blocks |
| rrule | BSD-3-Clause | Repeating events and tasks |
| sax | BlueOak-1.0.0 | .enex file import |
| qrcode | MIT | Phone remote and two-step sign-in |
| undici | MIT | Fetching outside addresses safely |
| rclone (hosting image only) | MIT | Off-site backups |

## Fonts

Cormorant Garamond (Christian Thalmann), Inter (Rasmus Andersson) and Source Serif 4 (Frank Grießhammer, Adobe),
bundled through Fontsource, under the [SIL Open Font License 1.1](https://openfontlicense.org/).

## Data and content

- **STEPBible-Data**, Tyndale House Cambridge and STEPBible.org, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
  the tagged Hebrew and Greek texts and brief lexicons in word studies (`server/lang/`), adapted (compacted, with
  English verse numbering) by `scripts/build-lang-data.mjs`. https://github.com/STEPBible/STEPBible-Data
- **Citation Style Language styles and locale** (`client/src/citations/csl/`), the CSL project and each style's
  authors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). https://citationstyles.org/
- **M'Cheyne's Calendar for Daily Readings**, Robert Murray M'Cheyne (1842), public domain.

## Services Selah connects to (with your own keys or accounts)

None of these is bundled; each is used under its own terms, with keys you get yourself.

- **ESV® Bible**, Crossway (api.esv.org). ESV® is a registered trademark of Crossway.
- **New Living Translation**, Tyndale House Publishers (api.nlt.to), non-commercial use.
- **API.Bible**, American Bible Society (api.bible), with its Fair Use Management System reporting.
- **Bible Gateway** verse-of-the-day reference (its daily pick; the text comes from the user's own translation).
- **Zotero** (Corporation for Digital Scholarship), **Logos** links and imports (Faithlife), **WordPress** posting,
  **Canvas** calendar feeds (Instructure).

## Methods the builders follow

The study, lesson and sermon builders follow methods taught in these books; the wording of the guidance is Selah's
own. J. Scott Duvall and J. Daniel Hays, *Grasping God's Word* (the Interpretive Journey); D. A. Carson, *Exegetical
Fallacies*; Lawrence O. Richards and Gary J. Bredfeldt, *Creative Bible Teaching* (Hook, Book, Look, Took); Wayne
McDill, *12 Essential Skills for Great Preaching*; Haddon W. Robinson, *Biblical Preaching* (the Big Idea); Walter
Pauk, *How to Study in College* (Cornell notes); Kate L. Turabian, *A Manual for Writers* (notes-bibliography style).
