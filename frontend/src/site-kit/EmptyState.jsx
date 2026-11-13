import Button from "./Button";
import { cx } from "./utils";

/**
 * Calm empty state (plan §7.2 rule 5): one sentence, an optional short body
 * and at most one real action that leads somewhere (a link via `href` or a
 * handler via `onClick`, e.g. opening the enquiry modal). Never fabricated data.
 *
 * action: { label, href?, onClick?, kind? }
 */
export default function EmptyState({ title, body, action, headingLevel = 3, icon, className, ...rest }) {
  const Heading = `h${Math.min(6, Math.max(2, Number(headingLevel) || 3))}`;
  return (
    <div className={cx("sk-empty", className)} {...rest}>
      {icon ? (
        <span className="sk-empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Heading className="sk-empty__title">{title}</Heading>
      {body ? <p className="sk-empty__body">{body}</p> : null}
      {action && action.label && (action.href || action.onClick) ? (
        <div className="sk-empty__action">
          <Button kind={action.kind || "tertiary"} size="md" href={action.href} onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
