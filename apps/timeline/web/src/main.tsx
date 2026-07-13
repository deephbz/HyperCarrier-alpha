import React from "react";
import { createRoot } from "react-dom/client";
import { AlphaApp } from "./AlphaApp";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.pathname === "/alpha" || window.location.pathname.startsWith("/alpha/") ? (
      <AlphaApp />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
