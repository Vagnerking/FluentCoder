/**
 * File-backed `ITextModelService` override (bugfix: Ctrl+hover sem underline).
 *
 * O contribution `GotoDefinitionAtPosition` do Monaco, para UM resultado de
 * definition, resolve o model do ALVO via `createModelReference(uri)` para
 * montar o preview — e só então desenha o underline do link. O serviço
 * standalone padrão (`StandaloneTextModelService`) rejeita URIs sem model já
 * aberto ("Model not found"), e o `.then(...)` do contribution não tem handler
 * de rejeição: alvo nunca aberto ⇒ underline nunca aparece (o Ctrl+click ainda
 * navega, pois passa pelo nosso `registerEditorOpener`). Por isso o sintoma
 * "não sublinha na primeira vez; depois de navegar e voltar, funciona" — a
 * navegação abre o model do alvo e o resolver passa a encontrá-lo.
 *
 * Este override cria o model sob demanda lendo o arquivo via IPC (`readFile`,
 * que também descarta BOM). Modelos criados ficam vivos como cache — a
 * navegação subsequente para eles é instantânea, e o peek de references
 * cross-file passa a resolver também. Deep import do `StandaloneServices` é o
 * hook consagrado do monaco standalone (o monaco-languageclient 1.x usa o
 * mesmo caminho); precisa rodar ANTES da criação do primeiro editor.
 */
import * as monaco from "monaco-editor";
// O ESM profundo do monaco não publica tipos — o shape usado (initialize com
// overrides por nome de serviço) é estável no standalone 0.5x.
// @ts-expect-error deep import sem d.ts
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { readFile } from "../api";
import { fromFileUri } from "./uri";
import { lspLog } from "./debug";

let installed = false;

/** Instala o resolver uma única vez, antes de qualquer editor ser criado. */
export function installFileTextModelResolver(): void {
  if (installed) return;
  installed = true;

  const service = {
    canHandleResource(uri: monaco.Uri): boolean {
      return uri.scheme === "file" || monaco.editor.getModel(uri) != null;
    },
    registerTextModelContentProvider(): { dispose(): void } {
      return { dispose: () => {} };
    },
    async createModelReference(uri: monaco.Uri): Promise<{
      object: { textEditorModel: monaco.editor.ITextModel };
      dispose(): void;
    }> {
      let model = monaco.editor.getModel(uri);
      if (!model || model.isDisposed()) {
        if (uri.scheme !== "file") {
          throw new Error(`Model not found: ${uri.toString()}`);
        }
        const text = await readFile(fromFileUri(uri.toString()));
        // Alguém pode ter criado o model enquanto líamos do disco (ex.: o
        // usuário abriu a tab) — criar de novo lançaria "duplicate model".
        model =
          monaco.editor.getModel(uri) ??
          // Linguagem inferida pela extensão (ids já registrados no setup).
          monaco.editor.createModel(text, undefined, uri);
      }
      // Referência "imortal" (mesma semântica do standalone): o model criado
      // fica vivo como cache de navegação/preview; dispose é no-op.
      return { object: { textEditorModel: model }, dispose: () => {} };
    },
  };

  try {
    StandaloneServices.initialize({ textModelService: service });
  } catch (err) {
    // Best-effort: se algo já inicializou os serviços antes de nós, o override
    // não se aplica — o editor segue funcional, só sem o fix do underline.
    lspLog("textModelResolver: initialize falhou (override não aplicado)", String(err));
  }
}
