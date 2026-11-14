// Placeholder for a Console route whose page is still being built (UI
// overhaul WS-0). OWNER: WS-A (component); each page module that renders it
// belongs to the workstream named in `owner` and replaces it.
//
// Calm by design: plain page title, one line, and a way to do the job today
// (the current page or the back office). Links into Django (/admin/…) are
// full page loads, everything else stays in the app.
import { ArrowRight, Launch } from "@carbon/icons-react";
import { Link } from "react-router-dom";
import PageHeader from "./PageHeader";
import "./overhaul.scss";

function isDocumentHref(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || href.startsWith("/admin/") || href === "/admin";
}

function PlaceholderLink({ link }) {
  const external = link.external ?? isDocumentHref(link.href);
  const Icon = external ? Launch : ArrowRight;
  const content = (
    <>
      <span>{link.label}</span>
      <Icon size={16} aria-hidden="true" />
    </>
  );
  return external ? (
    <a className="sc-placeholder__action" href={link.href}>
      {content}
    </a>
  ) : (
    <Link className="sc-placeholder__action" to={link.href}>
      {content}
    </Link>
  );
}

export default function RoutePlaceholder({
  title,
  description,
  heading = "This page is being rebuilt",
  body = "Everything here will open in this place soon. Until then, the job still works where it lives today.",
  links = [],
  owner,
}) {
  return (
    <div className="sc-route-placeholder" data-placeholder-owner={owner || undefined}>
      <PageHeader title={title} description={description} eyebrow={null} />
      <section className="sc-placeholder" aria-labelledby="sc-placeholder-heading">
        <span className="sc-placeholder__rule" aria-hidden="true" />
        <h2 id="sc-placeholder-heading" className="sc-placeholder__title">
          {heading}
        </h2>
        <p className="sc-placeholder__body">{body}</p>
        {links.length ? (
          <div className="sc-placeholder__actions">
            {links.map((link) => (
              <PlaceholderLink key={link.href} link={link} />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
