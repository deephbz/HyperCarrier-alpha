import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TraceViewer } from "./TraceViewer";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TraceViewer />
  </StrictMode>,
);
