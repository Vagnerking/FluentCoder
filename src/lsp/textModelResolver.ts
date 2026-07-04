/**
 * File-backed `ITextModelService` (bugfix: Ctrl+hover sem underline).
 *
 * O contribution `GotoDefinitionAtPosition` do Monaco, para UM resultado de
 * definition, resolve o model do ALVO via `createModelReference(uri)` para
 * montar o preview — e só então desenha o underline do link. O resolver
 * standalone rejeita URIs sem model já aberto ("Model not found"), e o
 * `.then(...)` do contribution não tem handler de rejeição: alvo nunca aberto
 * ⇒ underline nunca aparece (o Ctrl+click ainda navega, pois passa pelo nosso
 * `registerEditorOpener`). Sintoma: "não sublinha na primeira vez; depois de
 * navegar e voltar, funciona" — a navegação abre o model do alvo.
 *
 * Estratégia: PATCH NA INSTÂNCIA do serviço já registrado (via
 * `StandaloneServices.get`), com fallback ao comportamento original. Não dá
 * para usar `StandaloneServices.initialize({overrides})`: o monaco-languageclient
 * (monaco-vscode-api) inicializa os services no import do bundle e o initialize
 * ignora overrides silenciosamente depois disso. O patch preserva o caminho que
 * funciona (model aberto) e só adiciona o caso de miss: lê o arquivo via IPC
 * (`readFile`, que também descarta BOM) e cria o model sob demanda — que fica
 * vivo como cache (navegação instantânea; peek references cross-file resolve).
 */
import * as monaco from "monaco-editor";
// Deep imports sem d.ts — shapes estáveis no standalone 0.5x.
// @ts-expect-error deep import sem tipos
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
// @ts-expect-error deep import sem tipos
import { ITextModelService } from "monaco-editor/esm/vs/editor/common/services/resolverService.js";
import { readFile } from "../api";
import { fromFileUri } from "./uri";
import { lspLog } from "./debug";

let installed = false;

interface ModelReference {
  object: { textEditorModel: monaco.editor.ITextModel };
  dispose(): void;
}

/** Instala o patch uma única vez. Idempotente e best-effort. */
export function installFileTextModelResolver(): void {
  if (installed) return;
  installed = true;
  try {
    const service = StandaloneServices.get(ITextModelService) as {
      createModelReference(uri: monaco.Uri): Promise<ModelReference>;
    };
    const original = service.createModelReference.bind(service);
    service.createModelReference = async (uri: monaco.Uri): Promise<ModelReference> => {
      try {
        return await original(uri);
      } catch (err) {
        if (uri.scheme !== "file") throw err;
        const text = await readFile(fromFileUri(uri.toString()));
        // Alguém pode ter criado o model enquanto líamos do disco (ex.: o
        // usuário abriu a tab) — criar de novo lançaria "duplicate model".
        const model =
          monaco.editor.getModel(uri) ??
          // Linguagem inferida pela extensão (ids registrados no setup).
          monaco.editor.createModel(text, undefined, uri);
        // Referência "imortal" (mesma semântica do standalone): o model vive
        // como cache de preview/navegação; dispose é no-op.
        return { object: { textEditorModel: model }, dispose: () => {} };
      }
    };
    lspLog("textModelResolver: patch aplicado (createModelReference com fallback a disco)");
  } catch (err) {
    // Sem o patch o editor segue funcional — só sem o fix do underline.
    lspLog("textModelResolver: patch NÃO aplicado", String(err));
  }
}
