// Certificate routes, spread into AppRoutes.jsx inside <Route element={<AppLayout />}>
// (the public website layout): {certificatePublicRoutes()}. OWNER: WS-CERTIFICATES.
// The page is its own lazy chunk (with its fonts and CSS); nothing loads until opened.
import { lazy } from "react";
import { Route } from "react-router-dom";

const CertificatePage = lazy(() => import("./CertificatePage"));

export const CERTIFICATES_PATH = "/certificates";

/** `/certificates` (verify form) and `/certificates/:reference` (the certificate; a slug redirects). */
export function certificatePublicRoutes() {
  return [
    <Route key="certificates-verify" path={CERTIFICATES_PATH} element={<CertificatePage />} />,
    <Route key="certificates-view" path={`${CERTIFICATES_PATH}/:reference`} element={<CertificatePage />} />,
  ];
}
