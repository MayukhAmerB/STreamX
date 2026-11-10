/**
 * Page header pattern: title, one-line description, primary action(s).
 * `actions` is usually a single Carbon <Button> (icon + short label).
 */
export default function PageHeader({ title, description, actions }) {
  return (
    <header className="cds-page-header">
      <div className="cds-page-header__text">
        <h1 className="cds-page-header__title">{title}</h1>
        {description ? <p className="cds-page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="cds-page-header__actions">{actions}</div> : null}
    </header>
  );
}
