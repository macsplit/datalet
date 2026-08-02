import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReactExpenseTracker as App } from "./components/Main";
import { init } from "./utils/ngSession";

init();
createRoot(document.getElementById("root")!).render(<App />);
