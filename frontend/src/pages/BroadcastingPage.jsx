// /broadcasting (old URL). The page was split into features/classes (UI
// overhaul WS-D1): the Classes list, the Host-a-class flow and the Host
// studio. This module only sends old links and the host's "You are live"
// badge to the right place. OWNER: WS-D1.
import LegacyClassesRedirect from "../features/classes/LegacyClassesRedirect";
import { MODE_BROADCAST } from "../features/classes/classesModel";

export default function BroadcastingPage() {
  return <LegacyClassesRedirect mode={MODE_BROADCAST} />;
}
