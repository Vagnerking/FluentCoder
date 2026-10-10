/**
 * Registro do quick fix "Adicionar referência ao projeto" para `.cs` (issue #95,
 * milestone #11). Ver a lógica pura e o racional em `addProjectReference.ts`.
 *
 * O provider Monaco COEXISTE com as code actions nativas do Roslyn — o editor
 * mescla as listas de vários providers, então isto ADICIONA a action de
 * cross-referência sem substituir as demais. Selector restrito a `csharp`;
 * disposables retornados para descarte no reset de servidores.
 */
import * as monaco from "monaco-editor";
import { listProjectFiles, dotnetAddReference, dotnetFindTypeProject } from "../api";
import { fromFileUri } from "./uri";
import { lspLog } from "./debug";
import {
  isMissingTypeDiagnostic,
  typeNameFromMissingTypeMessage,
  owningCsproj,
  csprojDisplayName,
} from "./addProjectReference";

/** Command id disparado ao aplicar o quick fix. */
const ADD_REFERENCE_COMMAND = "fluentcoder.addProjectReference";

/**
 * Registra o code action provider + o comando de aplicação. `rootPath` é a raiz
 * do workspace (para achar os `.csproj` e resolver o tipo). Retorna disposables.
 */
export function installAddProjectReferenceProvider(rootPath: string): monaco.IDisposable[] {
  const disposables: monaco.IDisposable[] = [];

  // O comando: adiciona a ProjectReference e, ao concluir, insere o `using`.
  disposables.push(
    monaco.editor.registerCommand(
      ADD_REFERENCE_COMMAND,
      (_accessor, args: { fromCsproj: string; toCsproj: string }) => {
        void (async () => {
          try {
            const r = await dotnetAddReference(args.fromCsproj, args.toCsproj);
            if (!r.success) {
              lspLog("addProjectReference falhou", r.output);
            }
          } catch (err) {
            lspLog("addProjectReference erro", String(err));
          }
        })();
      }
    )
  );

  disposables.push(
    monaco.languages.registerCodeActionProvider(
      { language: "csharp", scheme: "file" },
      {
        provideCodeActions: async (model, _range, context, token) => {
          // Só nos interessam os CS0246 no contexto (tipo/namespace não achado).
          const missing = context.markers.filter((m) => isMissingTypeDiagnostic(m.code));
          if (missing.length === 0) return { actions: [], dispose: () => {} };

          // O csproj do arquivo atual (o "from") — o mais próximo subindo.
          const files = await listProjectFiles(rootPath).catch(() => []);
          if (token.isCancellationRequested) return { actions: [], dispose: () => {} };
          const csprojs = files
            .filter((f) => f.name.toLowerCase().endsWith(".csproj"))
            .map((f) => f.path);
          const fromCsproj = owningCsproj(fromFileUri(model.uri.toString()), csprojs);
          if (!fromCsproj) return { actions: [], dispose: () => {} };

          const actions: monaco.languages.CodeAction[] = [];
          const seen = new Set<string>();
          for (const marker of missing) {
            const typeName = typeNameFromMissingTypeMessage(marker.message);
            if (!typeName || seen.has(typeName)) continue;
            seen.add(typeName);
            // Resolve o projeto dono do tipo no backend (scan de source).
            const toCsproj = await dotnetFindTypeProject(rootPath, typeName).catch(() => null);
            if (token.isCancellationRequested) break;
            // Sem projeto dono, ou é o próprio projeto → nada a oferecer.
            if (!toCsproj || toCsproj === fromCsproj) continue;
            actions.push({
              title: `Adicionar referência ao projeto '${csprojDisplayName(toCsproj)}'`,
              kind: "quickfix",
              diagnostics: [marker],
              command: {
                id: ADD_REFERENCE_COMMAND,
                title: "Adicionar referência ao projeto",
                arguments: [{ fromCsproj, toCsproj }],
              },
            });
          }
          return { actions, dispose: () => {} };
        },
      }
    )
  );

  lspLog("add-project-reference quick fix registrado", rootPath);
  return disposables;
}
