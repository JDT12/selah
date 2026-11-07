import { useRef, useState } from 'react';
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { fileUrl, formatSize, pdfViewerUrl } from '../api.js';
import Icon from '../components/Icon.jsx';
import PdfReader from '../components/PdfReader.jsx';

const isPdf = (mime, name) => mime === 'application/pdf' || /\.pdf$/i.test(name);

function AttachmentView({ node, updateAttributes, editor, selected, getPos }) {
  const { id, filename, mime, size } = node.attrs;
  // A note shared with me (8.0) serves its files from the share.
  const url = editor.storage.noteApp?.fileUrl?.(id) ?? fileUrl(id);
  const viewer = editor.storage.noteApp?.fileUrl ? `/pdfjs/web/viewer.html?file=${encodeURIComponent(url)}` : pdfViewerUrl(id);
  const pdf = isPdf(mime, filename);
  const video = mime.startsWith('video/');
  const audio = mime.startsWith('audio/');
  const image = /^image\/(png|jpeg|webp|gif|bmp)$/.test(mime);
  const [open, setOpen] = useState(node.attrs.open);
  const [height, setHeight] = useState(node.attrs.height);
  const [resizing, setResizing] = useState(false);
  const [reading, setReading] = useState(false);
  const start = useRef(null);

  const toggle = () => {
    setOpen(!open);
    if (editor.isEditable) updateAttributes({ open: !open });
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, h: height };
    setResizing(true);
  };
  const onPointerMove = (e) => {
    if (!start.current) return;
    setHeight(Math.max(240, Math.min(3000, start.current.h + e.clientY - start.current.y)));
  };
  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    setResizing(false);
    if (editor.isEditable) updateAttributes({ height });
  };

  return (
    <NodeViewWrapper className={`attachment ${selected ? 'is-selected' : ''} ${resizing ? 'is-resizing' : ''}`}>
      <div className="attachment-bar" contentEditable={false} data-drag-handle>
        <Icon name={pdf ? 'pdf' : 'file'} size={20} className="attachment-icon" />
        <span className="attachment-name" title={filename}>{filename}</span>
        <span className="attachment-size">{formatSize(size)}</span>
        <span className="spacer" />
        {(pdf || image) && editor.isEditable && (
          <button type="button" className="btn btn-small" title="Type up the writing in it: handwriting to text"
            onClick={() => editor.storage.noteApp?.attachmentToText?.(getPos())}>
            <Icon name="scan" size={14} /> To text
          </button>
        )}
        {pdf && (
          <button type="button" className="btn btn-small" onClick={toggle}>
            {open ? 'Hide preview' : 'Show preview'}
          </button>
        )}
        {pdf ? (
          <button type="button" className="icon-btn" title="Open in full-screen reader" aria-label="Open in full-screen reader"
            onClick={() => setReading(true)}>
            <Icon name="expand" size={16} />
          </button>
        ) : (
          <a className="icon-btn" href={url} target="_blank" rel="noopener noreferrer" title="Open">
            <Icon name="external" size={16} />
          </a>
        )}
        <a className="icon-btn" href={`${url}?download=1`} title="Download"><Icon name="download" size={16} /></a>
      </div>
      {pdf && open && (
        <div className="pdf-frame" contentEditable={false} style={{ height }}>
          <iframe src={viewer} title={filename} loading="lazy" />
          <div className="pdf-resize" title="Drag to resize"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
        </div>
      )}
      {reading && <PdfReader id={id} src={editor.storage.noteApp?.fileUrl ? url : null} filename={filename} onClose={() => setReading(false)} />}
      {video && <video className="attachment-media" controls preload="metadata" src={url} contentEditable={false} />}
      {audio && <audio className="attachment-media" controls preload="metadata" src={url} contentEditable={false} />}
    </NodeViewWrapper>
  );
}

const dataAttr = (name, parse = (v) => v) => ({
  parseHTML: (el) => parse(el.getAttribute(`data-${name}`)),
  renderHTML: (attrs) => ({ [`data-${name}`]: attrs[name] }),
});

export const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null, ...dataAttr('attachment', (v) => Number(v)), renderHTML: (a) => ({ 'data-attachment': a.id }) },
      filename: { default: 'file', ...dataAttr('filename', (v) => v || 'file') },
      mime: { default: 'application/octet-stream', ...dataAttr('mime', (v) => v || 'application/octet-stream') },
      size: { default: 0, ...dataAttr('size', (v) => Number(v) || 0) },
      open: { default: true, ...dataAttr('open', (v) => v !== 'false') },
      height: { default: 720, ...dataAttr('height', (v) => Number(v) || 720) },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-attachment]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', HTMLAttributes, node.attrs.filename];
  },

  renderText({ node }) {
    return `[${node.attrs.filename}]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView);
  },
});
