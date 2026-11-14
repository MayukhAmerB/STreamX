// /lecture-questions (staff): student questions from lecture pages, as a T2
// list (UI overhaul plan §4.3). OWNER: WS-D2. The same list is the
// Questions tab of Admin › Community (WS-G); this old URL keeps working.
import { PageHeader, T2List } from "../features/app-shell/ui";
import { QuestionsList } from "../features/questions";

export default function LectureQuestionsPage() {
  return (
    <T2List
      header={<PageHeader eyebrow={null} title="Questions" description="What students ask from lecture pages. Answered in the Friday session." />}
      main={<QuestionsList />}
    />
  );
}
