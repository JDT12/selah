import { DATA, METHODS, SERVICES, SOFTWARE, SOURCE_URL, TRADEMARKS } from '../../../shared/credits.js';

const Link = ({ url, children }) => (url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}</a> : children);

/** Settings → Credits (11.0): everything Selah uses from others, and on what terms. */
export default function CreditsPane() {
  return (
    <div className="credits-pane">
      <p className="muted">
        Selah is free software under the GNU Affero General Public License (version 3 or later), built on the work of
        many others. <Link url={SOURCE_URL}>Source code</Link> · <Link url="https://www.gnu.org/licenses/agpl-3.0.html">The license</Link>
      </p>

      <h3>Bible text and services</h3>
      <ul className="credits-list">
        {SERVICES.map((s) => (
          <li key={s.name}><strong><Link url={s.url}>{s.name}</Link></strong> <span className="muted">· {s.by}</span><p>{s.note}</p></li>
        ))}
      </ul>

      <h3>Methods</h3>
      <p className="muted">The builders and guides follow these methods. The wording is Selah’s own; read the books for the real thing.</p>
      <ul className="credits-list">
        {METHODS.map((m) => <li key={m.name}><strong>{m.name}</strong> <span className="muted">· {m.by}</span><p>{m.used}</p></li>)}
      </ul>

      <h3>Data and fonts</h3>
      <ul className="credits-list">
        {DATA.map((d) => (
          <li key={d.name}><strong><Link url={d.url}>{d.name}</Link></strong> <span className="muted">· {d.by} · {d.license}</span><p>{d.note}</p></li>
        ))}
      </ul>

      <h3>Open-source software</h3>
      <ul className="credits-software">
        {SOFTWARE.map(([name, license]) => <li key={name}><strong>{name}</strong> <span className="muted">{license}</span></li>)}
      </ul>
      <p className="muted">The full license texts are in THIRD-PARTY-NOTICES.md with the source code.</p>

      <h3>Trademarks</h3>
      <p className="muted">{TRADEMARKS}</p>
    </div>
  );
}
