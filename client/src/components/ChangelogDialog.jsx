import changelog from '../../../CHANGELOG.md?raw';
import Icon from './Icon.jsx';
import { renderMarkdown } from '../markdownLite.js';

const html = renderMarkdown(changelog);

export default function ChangelogDialog({ version, close }) {
  return (
    <div className="changelog-dialog">
      <div className="dialog-header changelog-header">
        <h2>What’s new <span className="muted">· v{version}</span></h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>
      {/* Content comes from the app's own CHANGELOG.md, escaped before formatting. */}
      <div className="changelog-body" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={() => close()}>Close</button>
      </div>
    </div>
  );
}
