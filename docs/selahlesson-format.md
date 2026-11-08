# The .selahlesson package (format 1)

A `.selahlesson` file is one sermon, lesson or note exported from Selah (Desktop or Cloud, 12.2 and later) for
**Selah Companion** on the iPad. It's a zip file (stored, no compression needed) with:

| Path            | What it is                                                                  |
|-----------------|-----------------------------------------------------------------------------|
| `manifest.json` | Who and what: the stable id, version, metadata, delivery log, Bible mode     |
| `content.json`  | The text as blocks, in delivery order, with Bible passages when included    |
| `deck.json`     | The slides, when the note has a deck                                        |
| `media/…`       | Pictures in the text, slide pictures, the slide background, art and logo    |
| `README.md`     | A readable copy in Markdown (for anyone who opens the zip without the app)  |

There's no sync: a change on the computer goes to the iPad as a new export of the same lesson. Companion knows it
as the same lesson by `id`, and as newer by `version`.

## manifest.json

```json
{
  "format": 1,
  "id": "6f1c7a52-3d0e-4c8b-9a51-2b7d0c9e4f11",
  "version": 4,
  "hash": "sha256 hex of content.json and deck.json",
  "exportedAt": "2026-11-07T18:20:00.000Z",
  "selah": { "version": "12.2.0", "edition": "desktop" },
  "kind": "sermon",
  "title": "Dead in Sin, Alive in Christ",
  "passage": "Ephesians 2:1–10",
  "series": { "title": "Ephesians", "color": "#93613a" },
  "course": null,
  "date": "2026-11-09",
  "goalMinutes": 32,
  "steps": null,
  "tags": ["Ephesians", "Grace"],
  "status": "ready",
  "method": "mcdill",
  "author": "",
  "log": [{ "date": "2026-10-12", "place": "Grace Chapel", "occasion": "Sunday morning", "minutes": 34, "notes": "" }],
  "bible": { "mode": "text", "translations": ["KJV"], "copyright": ["Scripture quotations are from the King James Version."] },
  "files": { "content": "content.json", "deck": "deck.json", "readme": "README.md" },
  "media": [{ "path": "media/12.jpg", "mime": "image/jpeg", "bytes": 81234 }]
}
```

- **format**: this document is format 1. Companion opens any format it knows and says "update Companion" otherwise.
  New optional fields don't change the format; a change Companion 1.0 couldn't read safely does.
- **id**: stable for this note in this library, kept across exports (a UUID). The same note from another library
  (a copy, another person's) has another id.
- **version**: starts at 1 and goes up by one on each export whose `hash` differs from the last export's. Exporting
  again without changes keeps the version.
- **kind**: `sermon` (a sermon in the sermon builder), `lesson` (a lesson in a course or class) or `note`.
- **series**: a sermon's series. **course**: a lesson's `{ "title", "week" }`.
- **date**: the date it's planned for (a lesson's session date, a sermon's series date), or null.
- **goalMinutes**: the sermon's planned length or the class length; the timer counts down from it.
- **steps**: a lesson's steps with their planned minutes:
  `[{ "key": "hook", "label": "Hook", "minutes": 5 }, …]` (keys `hook`, `book`, `look`, `took`); null otherwise.
- **status**: `building` or `ready` (sermon), `planned` or `taught` (lesson), null for a note.
- **log**: when it was preached (sermons) or `[{ "date", "notes" }]` when it was taught (lessons), newest first.
- **bible.mode**: `text` when the verse text is in `content.json` (`passages`), `refs` when only the references
  are (Companion shows the reference alone). `copyright` lines are shown wherever the text is.

## content.json

```json
{
  "manuscript": [ /* blocks */ ],
  "outline": [ /* blocks */ ] ,
  "passages": { "Eph 2:4–5": { "reference": "Ephesians 2:4–5", "translation": "KJV", "text": "[4] But God, …", "copyright": "…" } }
}
```

- **manuscript**: the text as Selah's Preach and Teach modes show it: a sermon's divisions in delivery order (the
  order numbered on the Arrange board), each run of Explanation, Illustration, Argumentation or Application in an
  `element` block.
- **outline**: a sermon with a delivery order also comes as an outline (each block a numbered point, its further
  lines and sub-points beneath it). Null otherwise: the Outline view then shows `manuscript`, as on the computer.
- **passages**: by the reference as written in the text (each `ref` run's value), when `bible.mode` is `text`.
  `text` marks verse numbers as `[16]`, paragraphs with a blank line and poetry lines with three leading spaces.

### Blocks

Every block has a `type`. Blocks you can write on (ink, margin notes) also have:

- **id**: the block's own id (`b…`), kept in the note through editing on the computer, so a note written beside a
  paragraph stays with it when the lesson is changed and exported again. A block new since the last export gets
  one then.
- **fp**: a fingerprint of the block's text (the first 12 hex digits of SHA-1 of its words, lowercased). When a
  block's id isn't found after a re-import (its paragraph was rewritten in a builder), Companion looks for its
  fingerprint, then for the closest text, and lists what it can't place as orphans.

| type        | Fields                                                                                           |
|-------------|--------------------------------------------------------------------------------------------------|
| `section`   | `id, fp, level` (1 or 2), `title`, `step` (a lesson's `hook`/`book`/`look`/`took`, on level 1), `children` |
| `element`   | `element` (`explanation`, `illustration`, `argumentation`, `application`, `other`), `label`, `children` |
| `paragraph` | `id, fp, runs`                                                                                   |
| `heading`   | `id, fp, level` (3–6), `runs`                                                                    |
| `list`      | `ordered`, `start`, `items: [{ id, fp, element?, label?, checked?, question?, children }]`       |
| `quote`     | `id, fp, children`                                                                               |
| `image`     | `id, src` (a `media/` path), `alt`                                                               |
| `table`     | `id, fp, rows: [[{ runs, header? }]]`                                                            |
| `code`      | `id, text`                                                                                       |
| `rule`      | (a line across)                                                                                  |
| `file`      | `id, name` (an attachment that isn't a picture; not in the package)                              |

A section's `children` are what's under its heading up to the next heading at its level or above. A list item's
`children` are its own paragraph(s), then any list nested in it. In a lesson's Look step, the questions list's items
have `question: true` (the lines nested under one are its answers). `checked` is a task list's tick.

### Runs

A paragraph's text, in pieces of one style:
`{ "text": "dead", "b": true }`. Styles: `b` bold, `i` italic, `u` underline, `s` struck, `code`, `mark`
(highlighted), `sup`, `sub`; `ref` (a Bible reference; its value is the key into `passages`); `link` (a web
address; Companion shows it as text). `{ "br": true }` is a line break.

## deck.json

The deck as Selah keeps it, plus how it looks, so Companion can draw it on a TV:

```json
{
  "kind": "sermon",
  "look": {
    "palette": { "bg": "#fbf8f2", "bg2": "#f3ece1", "text": "#2a1f17", "muted": "#6f5e4f", "accent": "#93613a", "head": "#2a1f17", "art": "#93613a" },
    "fonts": { "id": "classic", "head": "Playfair Display", "body": "Source Serif 4" },
    "art": "media/art.png", "background": "media/31.jpg", "dim": 0.35, "logo": { "src": "media/9.png", "corner": "tr" }
  },
  "translation": "KJV",
  "slides": [{ "id": "s1k2j3", "type": "point", "title": "But God", "text": "", "points": [{ "text": "Rich in mercy", "level": 0 }], "anchor": "But God", "block": "b8x2k1q0", "image": null, "notes": "" }]
}
```

- Slide types: `title`, `point`, `passage` (with `ref`, `tr` and, in text mode, the passage under `passages` in
  content.json), `image` (`image` is a media path, `fit` `cover` or `contain`), `question` (`answer`), `custom`.
- **block**: the id of the block the slide goes with (moving through the text moves the slides), when found.

## README.md

The manuscript as Markdown, with the passage, series and date under the title, and the copyright lines at the end.
It's only for people; Companion doesn't read it.
