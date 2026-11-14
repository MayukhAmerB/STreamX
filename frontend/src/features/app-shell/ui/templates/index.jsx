// Page templates (UI overhaul plan §2.6, Appendix A.5). OWNER: WS-A.
// Every Console page uses exactly one. Layout slots: header, toolbar, main,
// aside, actions (plus children, appended to main).
//   T1Home   greeting + Next up + short lists; one column, generous rhythm
//   T2List   header, toolbar, list or table
//   T3Detail main 2/3 + aside 1/3 at >= 1056 px; the aside follows the title on phones
//   T4Form   one 640 px column + the sticky action bar (actions slot)
//   T5Studio focus mode: media edge to edge; the shell hides its nav (data-focus-mode)
import "../overhaul.scss";

function Template({ variant, header, toolbar, main, aside, actions, children, className = "" }) {
  return (
    <div className={`sc-template sc-template--${variant} ${className}`.trim()} data-template={variant} data-focus-mode={variant === "t5" ? "true" : undefined}>
      {header ? <div className="sc-template__header">{header}</div> : null}
      {toolbar ? <div className="sc-template__toolbar">{toolbar}</div> : null}
      <div className="sc-template__body">
        <div className="sc-template__main">
          {main}
          {children}
        </div>
        {aside ? <aside className="sc-template__aside">{aside}</aside> : null}
      </div>
      {actions ? <div className="sc-template__actions">{actions}</div> : null}
    </div>
  );
}

export function T1Home(props) {
  return <Template variant="t1" {...props} />;
}

export function T2List(props) {
  return <Template variant="t2" {...props} />;
}

export function T3Detail(props) {
  return <Template variant="t3" {...props} />;
}

export function T4Form(props) {
  return <Template variant="t4" {...props} />;
}

export function T5Studio(props) {
  return <Template variant="t5" {...props} />;
}
