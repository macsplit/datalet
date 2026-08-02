import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { init } from "./utils/ngSession";

init();
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
