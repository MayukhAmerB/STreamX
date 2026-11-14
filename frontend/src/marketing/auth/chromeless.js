// Public paths that render the full-screen split auth layout (T-AUTH) with no
// site navbar or footer, exactly like HackPath's /signin. AppLayout (WS-MKT)
// imports this list and skips <Navbar /> and <AppFooter /> for these paths;
// <TermsGate /> stays mounted everywhere.
export const AUTH_CHROMELESS_PATHS = Object.freeze(["/login", "/reset-password"]);

export function isAuthChromelessPath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  return AUTH_CHROMELESS_PATHS.includes(path);
}
