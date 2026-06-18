// MUST be first: unifies the Monaco instance (npm, not CDN) + wires workers so
// the editor models and the LSP client share one Monaco. See monaco-loader.ts.
import "./monaco-loader";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
