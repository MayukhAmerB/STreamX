// `/reports/marks` ("My marks") moved into Coursework › Grades (plan §3.2/§3.4).
// Old links and bookmarks land on /gradebook (replace: no extra history entry).
import { Navigate, useLocation } from "react-router-dom";

export default function ReportsMarksPage() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: "/gradebook", search, hash }} replace />;
}
