// "More actions" for one class row. Uses the kit's .sc-overflow styles
// (floating layer, M11 menu motion, none under reduced motion) with menu
// semantics: arrows move between items, Esc and an outside click close it
// and focus returns to the trigger. Carbon's OverflowMenu styles are not
// loaded in the Console, so this replaces it. OWNER: WS-D1.
import { OverflowMenuVertical } from "@carbon/icons-react";
import { useEffect, useId, useRef, useState } from "react";

export default function RowOverflowMenu({ label, items, disabled = false, onSelect }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapper = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus?.();
  };

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    menu.current?.querySelector?.("[role='menuitem']:not([disabled])")?.focus?.();
    const onPointer = (event) => {
      if (!wrapper.current?.contains?.(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const onMenuKey = (event) => {
    const entries = Array.from(menu.current?.querySelectorAll?.("[role='menuitem']:not([disabled])") || []);
    const index = entries.indexOf(typeof document === "undefined" ? null : document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      entries[(index + step + entries.length) % entries.length]?.focus?.();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      entries[event.key === "Home" ? 0 : entries.length - 1]?.focus?.();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  if (!items?.length) return null;
  return (
    <div className="sc-overflow cls-row__more" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="sc-overflow__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <OverflowMenuVertical size={20} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={menuId} ref={menu} className="sc-overflow__menu" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {items.map((item, index) => (
            <li key={item.key} role="none" className={item.danger && !items[index - 1]?.danger ? "cls-menu__divider" : undefined}>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={disabled}
                className={`sc-overflow__item${item.danger ? " sc-overflow__item--danger" : ""}`}
                onClick={() => {
                  close();
                  onSelect(item.key);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
