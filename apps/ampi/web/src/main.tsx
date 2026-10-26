import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { perfMarkPainted } from "./perf.ts";
import { installQuietScroll } from "./quiet-scroll.ts";
import "./styles.css";

installQuietScroll();
createRoot(document.getElementById("root")!).render(<App />);
perfMarkPainted("first-paint", true);
