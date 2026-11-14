// A link that is a full page load for the back office (/admin/…) and an SPA
// link for Console pages. OWNER: WS-G.
import { Link } from "react-router-dom";
import { isDocumentHref } from "../command-palette/paletteModel";

export default function SmartLink({ href, children, ...rest }) {
  if (!href) return <span {...rest}>{children}</span>;
  if (isDocumentHref(href)) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}
