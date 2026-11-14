// /meeting (old URL). Meetings are a mode of Classes now (UI overhaul WS-D1,
// features/classes): this module sends old links to the Classes list or to
// the meeting room you were in. OWNER: WS-D1.
import LegacyClassesRedirect from "../features/classes/LegacyClassesRedirect";
import { MODE_MEETING } from "../features/classes/classesModel";

export default function MeetingPage() {
  return <LegacyClassesRedirect mode={MODE_MEETING} />;
}
