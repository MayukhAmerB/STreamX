// OWNER: WS-G. Wave-2 Console Admin pages (plan §4.3) link to their Django
// page until they are built: payments, people, batches, leads, live chat,
// website, live config, upload tokens.
import { RoutePlaceholder } from "../app-shell/ui";

export const BACK_OFFICE_SECTIONS = Object.freeze({
  payments: { title: "Payments", description: "Orders, refunds and course access.", href: "/admin/payments/payment/" },
  people: { title: "People", description: "Students, instructors and admins.", href: "/admin/users/user/" },
  batches: { title: "Batches", description: "Batch passes for future batches.", href: "/admin/payments/batchpass/" },
  leads: { title: "Leads and forms", description: "Join forms and enquiries.", href: "/admin/courses/publicenrollmentlead/" },
  chat: { title: "Live chat moderation", description: "Chat names and moderation for live classes.", href: "/admin/realtime/owncastchatidentity/" },
  website: { title: "Website", description: "YouTube channel and website settings.", href: "/admin/site_media/youtubechannel/" },
  live: { title: "Live config", description: "Streaming and realtime configuration.", href: "/admin/realtime/realtimeconfiguration/" },
  tokens: { title: "Upload tokens", description: "Desktop uploader tokens.", href: "/admin/recording_uploads/recordinguploadtoken/" },
});

export default function AdminBackOfficePage({ section }) {
  const entry = BACK_OFFICE_SECTIONS[section] || { title: "Back office", description: "Records, settings and audit.", href: "/admin/" };
  return (
    <RoutePlaceholder
      owner="WS-G"
      title={entry.title}
      description={entry.description}
      heading="This lives in the back office for now"
      body="It moves into the Console in a later round. The back office has everything you need today."
      links={[{ label: "Open in the back office", href: entry.href }]}
    />
  );
}
