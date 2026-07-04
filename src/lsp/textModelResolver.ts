/**
 * Disk-backed `file://` filesystem overlay (bugfix: Ctrl+hover sem underline).
 *
 * O contribution `GotoDefinitionAtPosition` do Monaco, para UM resultado de
 * definition, resolve o model do ALVO via `ITextModelService.createModelReference`
 * para montar o preview — e só então desenha o underline do link. Na stack
 * @codingame o serviço resolve através do `IFileService`, cujo provider default
 * para `file://` é um filesystem EM MEMÓRIA: qualquer arquivo nunca aberto
 * rejeita com "Unable to resolve nonexistent file" e o underline nunca aparece
 * (o Ctrl+click ainda navega, pois passa pelo nosso `registerEditorOpener`).
 *
 * Patch de instância no `ITextModelService` (a abordagem da stack 0.52) NÃO
 * funciona aqui: os contributions recebem um proxy de serviço cujas escritas de
 * método são ignoradas silenciosamente. O caminho suportado é registrar um
 * `IFileSystemProvider` real. Este overlay entra com prioridade NEGATIVA —
 * atrás do provider de memória — então só é consultado em miss: leitura do
 * disco via IPC (`readFile`, com detecção de encoding/BOM do text_io). Com ele,
 * o preview do underline, o peek de references cross-file e qualquer resolução
 * `file://` da stack passam a enxergar o disco. Somente leitura: escrita segue
 * exclusivamente pelo caminho de save do app (Tauri).
 */
import {
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import type { Uri } from "monaco-editor";
import { readFile } from "../api";
import { fromFileUri } from "./uri";
import { lspLog } from "./debug";

let installed = false;

type OverlayProvider = Parameters<typeof registerFileSystemOverlay>[1];
type DisposableLike = { dispose(): void };

/**
 * `stat` + `readFile` chegam em sequência para o mesmo recurso durante um
 * resolve; o cache curto evita duas leituras IPC por preview.
 */
const contentCache = new Map<string, { bytes: Uint8Array; at: number }>();
const CACHE_TTL_MS = 5_000;

async function readBytes(resource: Uri): Promise<Uint8Array> {
  const key = resource.toString();
  const hit = contentCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bytes;
  let content: string;
  try {
    content = (await readFile(fromFileUri(key))).content;
  } catch (err) {
    throw FileSystemProviderError.create(
      String(err),
      FileSystemProviderErrorCode.FileNotFound
    );
  }
  const bytes = new TextEncoder().encode(content);
  contentCache.set(key, { bytes, at: Date.now() });
  return bytes;
}

function readOnlyError(): FileSystemProviderError {
  return FileSystemProviderError.create(
    "overlay de disco é somente leitura",
    FileSystemProviderErrorCode.NoPermissions
  );
}

const NONE_EVENT = () => ({ dispose: () => {} }) as DisposableLike;

/**
 * Registra o overlay uma única vez (idempotente, best-effort). Deve rodar após
 * `ensureVscodeServices` — chamado no setup do Monaco, muito antes do primeiro
 * hover.
 */
export function installDiskFileSystemOverlay(): void {
  if (installed) return;
  installed = true;
  try {
    const provider = {
      capabilities:
        FileSystemProviderCapabilities.FileReadWrite |
        FileSystemProviderCapabilities.Readonly |
        FileSystemProviderCapabilities.PathCaseSensitive,
      onDidChangeCapabilities: NONE_EVENT,
      onDidChangeFile: NONE_EVENT,
      watch: (): DisposableLike => ({ dispose: () => {} }),
      stat: async (resource: Uri) => {
        const bytes = await readBytes(resource);
        return { type: FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength };
      },
      readFile: (resource: Uri): Promise<Uint8Array> => readBytes(resource),
      writeFile: async (): Promise<void> => {
        throw readOnlyError();
      },
      mkdir: async (): Promise<void> => {
        throw readOnlyError();
      },
      readdir: async (): Promise<[string, FileType][]> => [],
      delete: async (): Promise<void> => {
        throw readOnlyError();
      },
      rename: async (): Promise<void> => {
        throw readOnlyError();
      },
    };
    registerFileSystemOverlay(-1, provider as unknown as OverlayProvider);
    lspLog("fs overlay: provider de disco registrado (fallback atrás da memória)");
  } catch (err) {
    // Sem o overlay o editor segue funcional — só sem o fix do underline.
    lspLog("fs overlay: NÃO registrado", String(err));
  }
}
