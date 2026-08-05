import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { init } from "./utils/ngSession";
import { startSync } from "./utils/remoteSyncEngine";
import { AppErrorBoundary } from "./components/RuntimeSafety";

init();
startSync();
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <RouterProvider router={router} />
  </AppErrorBoundary>,
);
