/** Rótulos de UI que dependem do SO (gerenciador de arquivos, lixeira…). */

import { getPlatform, type OsKind } from "./os.ts";

export interface PlatformLabels {
  /** Nome do gerenciador de arquivos do SO. */
  fileManager: string;
  /** Item de menu "Revelar no …". */
  revealInFileManager: string;
  /** Item de menu "Mover para a Lixeira/Lixo". */
  moveToTrash: string;
  /** Nome da lixeira em mensagens. */
  trash: string;
  /** Aviso ao tentar revelar um caminho remoto (SSH). */
  remoteRevealUnavailable: string;
}

const LABELS: Record<OsKind, PlatformLabels> = {
  windows: {
    fileManager: "Explorador de Arquivos",
    revealInFileManager: "Revelar no Explorador de Arquivos",
    moveToTrash: "Mover para a Lixeira",
    trash: "Lixeira",
    remoteRevealUnavailable: "Caminho remoto copiado. O Explorador de Arquivos não abre roots SSH diretamente.",
  },
  macos: {
    fileManager: "Finder",
    revealInFileManager: "Revelar no Finder",
    moveToTrash: "Mover para o Lixo",
    trash: "Lixo",
    remoteRevealUnavailable: "Caminho remoto copiado. O Finder não abre roots SSH diretamente.",
  },
  linux: {
    fileManager: "Gerenciador de Arquivos",
    revealInFileManager: "Revelar no Gerenciador de Arquivos",
    moveToTrash: "Mover para a Lixeira",
    trash: "Lixeira",
    remoteRevealUnavailable: "Caminho remoto copiado. O Gerenciador de Arquivos não abre roots SSH diretamente.",
  },
};

export function platformLabels(os: OsKind = getPlatform().os): PlatformLabels {
  return LABELS[os];
}
