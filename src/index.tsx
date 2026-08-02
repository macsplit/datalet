import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { init } from "./utils/ngSession";
import { AppErrorBoundary } from "./components/RuntimeSafety";

init();
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <RouterProvider router={router} />
  </AppErrorBoundary>,
);
