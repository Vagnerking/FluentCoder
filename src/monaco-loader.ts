/**
 * Unifies the Monaco instance and wires its web workers — must be imported once
 * at app entry, BEFORE any `@monaco-editor/react` editor mounts.
 *
 * Why this exists: `@monaco-editor/react` defaults to loading Monaco from a CDN,
 * creating editor models in a SEPARATE Monaco instance from the npm
 * `monaco-editor` package that our LSP layer imports (`src/lsp/client.ts` →
 * `MonacoServices.install(monaco)`). With two instances, the language client
 * watches an empty `monaco.editor.getModels()` and never sends `textDocument/
 * didOpen` — so no C#/TS IntelliSense. `loader.config({ monaco })` forces
 * `@monaco-editor/react` to use the SAME npm instance, so models and the LSP
 * client share one world.
 *
 * Using the npm Monaco (instead of the CDN build) means we must also supply the
 * editor/language web workers ourselves; Vite bundles them via the `?worker`
 * imports below.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { installWindowsFileUriSerialization } from "./lsp/uri";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Must happen before @monaco-editor/react creates the first model. Otherwise
// Roslyn receives file:///c%3A/... and treats project files as miscellaneous.
installWindowsFileUriSerialization(monaco);

// Monaco asks for a worker by language label; return the matching bundled one.
// (The TS/JS worker's own IntelliSense is disabled elsewhere for LSP-backed
// languages, but the worker is still needed for tokenization/basic services.)
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Point @monaco-editor/react at the npm instance instead of its CDN default.
loader.config({ monaco });
