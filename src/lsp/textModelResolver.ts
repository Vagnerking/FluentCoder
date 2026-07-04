/**
 * File-backed `ITextModelService` (bugfix: Ctrl+hover sem underline).
 *
 * O contribution `GotoDefinitionAtPosition` do Monaco, para UM resultado de
 * definition, resolve o model do ALVO via `createModelReference(uri)` para
 * montar o preview — e só então desenha o underline do link. Sem um provider
 * de filesystem real para `file://` (estamos num WebView), a resolução de um
 * arquivo nunca aberto rejeita, e o `.then(...)` do contribution não tem
 * handler de rejeição: alvo nunca aberto ⇒ underline nunca aparece (o
 * Ctrl+click ainda navega, pois passa pelo nosso `registerEditorOpener`).
 * Sintoma: "não sublinha na primeira vez; depois de navegar e voltar,
 * funciona" — a navegação abre o model do alvo.
 *
 * Port v10 (@codingame/monaco-vscode-api): patch na INSTÂNCIA do
 * `ITextModelService` (via `getService`), com fallback ao original. No miss,
 * lê o arquivo via IPC (`readFile`, com detecção de encoding/BOM do text_io) e
 * materializa o model com o helper oficial `createModelReference(uri, content)`
 * — que registra o conteúdo no serviço de text-file e devolve exatamente o
 * shape de referência que o contribution espera. Modelos criados ficam vivos
 * como cache: navegação subsequente é instantânea e o peek de references
 * cross-file passa a resolver também.
 */
import { createModelReference as vscodeCreateModelReference } from "@codingame/monaco-vscode-api/monaco";
import { getService } from "@codingame/monaco-vscode-api/services";
// O padrão de exports `./vscode/*` mapeia para `./vscode/src/*.js` (+`.d.ts`
// para types) — o specifier omite o `src` E a extensão (ambos injetados).
import { ITextModelService } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/services/resolverService.service";
import type { Uri } from "monaco-editor";
import { readFile } from "../api";
import { fromFileUri } from "./uri";
import { lspLog } from "./debug";

let installed = false;

/**
 * Instala o patch uma única vez (idempotente, best-effort). Async porque o
 * `getService` aguarda o boot dos serviços (`ensureVscodeServices`); chamado
 * fire-and-forget no setup — o patch assenta milissegundos após o boot, muito
 * antes do primeiro hover.
 */
export function installFileTextModelResolver(): void {
  if (installed) return;
  installed = true;
  void (async () => {
    try {
      const service = (await getService(ITextModelService)) as {
        createModelReference(uri: Uri): Promise<unknown>;
      };
      const original = service.createModelReference.bind(service);
      service.createModelReference = async (uri: Uri): Promise<unknown> => {
        try {
          return await original(uri);
        } catch (err) {
          if (uri.scheme !== "file") throw err;
          // Miss: materializa o model a partir do disco (encoding-aware) com o
          // helper oficial — registra no text-file service e devolve o shape
          // de IReference<ITextFileEditorModel> que os consumidores esperam.
          const decoded = await readFile(fromFileUri(uri.toString()));
          return vscodeCreateModelReference(
            uri as Parameters<typeof vscodeCreateModelReference>[0],
            decoded.content
          );
        }
      };
      lspLog("textModelResolver: patch aplicado (createModelReference com fallback a disco)");
    } catch (err) {
      // Sem o patch o editor segue funcional — só sem o fix do underline.
      lspLog("textModelResolver: patch NÃO aplicado", String(err));
    }
  })();
}
