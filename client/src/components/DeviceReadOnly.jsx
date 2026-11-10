import { useLayoutEffect, useRef } from 'react';

const FIELDS = 'input, select, textarea, .task-check, .course-pip';

/**
 * A planning page that this device only reads (13.0). Fields and check marks are switched off, drag and long-press
 * menus stop, and styles.css hides every other button, so a control added later is hidden until it's marked safe:
 * `data-read` on a control keeps it working.
 */
export default function DeviceReadOnly({ on = true, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!on || !root) return undefined;
    const apply = () => {
      root.querySelectorAll(FIELDS).forEach((el) => { if (!el.hasAttribute('data-read')) el.disabled = true; });
      root.querySelectorAll('[draggable="true"]').forEach((el) => { el.draggable = false; });
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [on]);
  if (!on) return children;
  return (
    <div ref={ref} className="device-readonly" onContextMenuCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {children}
    </div>
  );
}
