<p align="center"><img src="branding/selah-icon.svg" width="96" height="96" alt=""></p>

# Selah

Free software for pastors, teachers and seminary students: notes, Bible study, teaching and preaching in one place.

- **Study**: Bible, background and word studies with guided steps (Grasping God's Word's Interpretive Journey and
  others), Scripture links and hover text, a passage page that gathers everything you've written on it, memory verses
  and reading plans.
- **Teach**: lessons built from a study (Hook, Book, Look, Took), courses and class schedules, attendance for classes
  and small groups, and seminary classes with syllabi, readings and grades.
- **Preach**: a sermon builder, a sermon bank, arranging and delivery order, preaching mode with a timer, and a slide
  editor with themes, your church's brand and PowerPoint export; slides on a projector while you keep the controls.
- **Notes**: a block editor, tags, templates, linked notes, version history, Cornell notes, handwriting to text,
  pictures, recordings and PDFs, quick capture and a web clipper, tasks, a calendar and prayer lists.

## Two ways to use it

| | Selah Desktop | Selah Cloud |
| --- | --- | --- |
| For | One person on a Windows PC, Mac or Linux computer | A church, class or group, each person with their own Selah |
| Get it | [Download the installer](https://github.com/JDT12/selah/releases/latest) | [Install it on your own server](docs/cloud-install.md) with one command |
| Your notes | On your PC, backed up automatically to a folder you choose | On your server, backed up every night |
| From a phone or another computer | No (one PC; export to share) | Yes, in any browser or as an installed app |

The guides are at **[jdt12.github.io/selah](https://jdt12.github.io/selah/)** (also in [docs/](docs/index.md)):
installing Desktop or Cloud, DNS and HTTPS, backups, updates and troubleshooting.

## Building from source

Selah is a [Fastify](https://fastify.dev/) server on Node.js 24 with SQLite (`node:sqlite`) and a React page built
with Vite.

```bash
npm ci
npm run build
NOTEAPP_TLS=0 NOTEAPP_PORT=8080 npm start
```

The server keeps its data in `data/` and `notes-data/` (it asks you to set up the storage folder the first time:
`npm run move-storage`, then `npm run set-password`).

| Folder | What's in it |
| --- | --- |
| `server/` | the API, one module per area; `server/admin/` is the multi-tenant admin console |
| `client/src/` | the page (React), the editor (`editor/`), the admin console (`admin/`) |
| `shared/` | code both use: Scripture parsing, study methods, What's New, slide themes |
| `desktop-app/` | Selah Desktop (Electron): `npm ci`, then `npm run dist` builds the installer |
| `extension/` | the Edge web clipper |
| `scripts/` | the admin CLI (`npm run admin -- help`), server setup, install and update scripts |
| `docs/` | the guides (GitHub Pages) |

## Contributing and security

Bug reports and ideas are welcome in [Issues](https://github.com/JDT12/selah/issues); see
[CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem privately, see [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Jason Thomas.

Selah is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text, and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the work of others it includes. Names of Bible translations,
publishers and other products belong to their owners; their mention doesn't mean they endorse Selah.
