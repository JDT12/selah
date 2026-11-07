import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';

const KINDS = ['info', 'tip', 'warning', 'danger'];
const ICONS = { info: 'ℹ️', tip: '💡', warning: '⚠️', danger: '🛑' };

function CalloutView({ node, updateAttributes, editor }) {
  const { kind } = node.attrs;
  const cycle = () => {
    if (editor.isEditable) updateAttributes({ kind: KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length] });
  };
  return (
    <NodeViewWrapper className={`callout callout-${kind}`} data-callout={kind}>
      <button type="button" className="callout-icon" contentEditable={false} onClick={cycle}
        title="Click to change callout type">{ICONS[kind] ?? ICONS.info}</button>
      <NodeViewContent className="callout-content" />
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'info',
        parseHTML: (el) => (KINDS.includes(el.getAttribute('data-callout')) ? el.getAttribute('data-callout') : 'info'),
        renderHTML: (attrs) => ({ 'data-callout': attrs.kind }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'callout' }), 0];
  },

  addCommands() {
    return {
      setCallout: (attrs = {}) => ({ commands }) => commands.wrapIn(this.name, attrs),
      toggleCallout: (attrs = {}) => ({ commands }) => commands.toggleWrap(this.name, attrs),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});
