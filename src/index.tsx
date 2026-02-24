import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReactExpenseTracker as App } from "./components/Main";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
