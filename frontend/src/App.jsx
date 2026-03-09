import { Suspense } from "react";
import AppRoutes from "./routes/AppRoutes";

function RouteLoader() {
  return (
    <div className="min-h-screen bg-black text-[#D9D9D9]">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="h-12 w-52 animate-pulse rounded-xl border border-black bg-[#141414]" />
        <div className="mt-6 h-44 animate-pulse rounded-2xl border border-black bg-[#141414]" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="h-40 animate-pulse rounded-2xl border border-black bg-[#141414]" />
          <div className="h-40 animate-pulse rounded-2xl border border-black bg-[#141414]" />
          <div className="h-40 animate-pulse rounded-2xl border border-black bg-[#141414]" />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteLoader />}>
      <AppRoutes />
    </Suspense>
  );
}
