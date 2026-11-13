// Where to send the user after signing in, from a `?next=` query value.
//
// Only two kinds of target are honoured, so the login page can never be used
// as an open redirect:
//   * an in-app path ("/console", never "//host" or "/\host"),
//   * an https URL on a trusted sibling site (the labs subdomain), or the
//     labs dev server on localhost.
// Anything else returns null and the caller falls back to its default.

const TRUSTED_SUBDOMAINS = ["labs"];
const DEV_LABS_PORTS = new Set(["8092"]);

function baseDomain(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

function isTrustedExternal(url, currentLocation) {
  const currentHost = baseDomain(currentLocation.hostname);
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) return false;
  if (url.protocol === "https:" && !url.port) {
    return TRUSTED_SUBDOMAINS.some((sub) => host === `${sub}.${currentHost}`);
  }
  const isLocal = (value) => value === "localhost" || value === "127.0.0.1";
  return (
    url.protocol === "http:" &&
    isLocal(host) &&
    isLocal(currentHost) &&
    DEV_LABS_PORTS.has(url.port)
  );
}

export function resolveReturnTarget(rawNext, currentLocation = window.location) {
  const value = String(rawNext || "").trim();
  if (!value || value.length > 2048) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) {
    return { type: "internal", path: value };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!isTrustedExternal(url, currentLocation)) return null;
  return { type: "external", href: url.href };
}

export function returnTargetFromSearch(search, currentLocation = window.location) {
  try {
    return resolveReturnTarget(new URLSearchParams(search || "").get("next"), currentLocation);
  } catch {
    return null;
  }
}
