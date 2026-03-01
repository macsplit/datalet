import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReactExpenseTracker as App } from "./components/Main";
import { sessionPromise } from "./utils/ngSession";

sessionPromise.then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
