/**
 * Metadados dos modos no estilo VS Code/Copilot, mapeados para os modos
 * NATIVOS dos provedores (nenhum texto de modo é injetado no prompt — ver
 * docs/context/agentes-ia.md, "Modos sem prompt injetado").
 */
import type { AgentMode } from "../agents/types.ts";

export interface ModeMeta {
  label: string;
  hint: string;
  /** IconAction do modo. */
  icon: "modeAsk" | "modePlan" | "modeEdit" | "modeAuto" | "modeBypass";
  /** Aviso exibido quando o modo é perigoso (Bypass). */
  warning?: string;
}

export const MODE_META: Record<AgentMode, ModeMeta> = {
  ask: {
    label: "Perguntar",
    hint: "Somente leitura — responde e explica sem alterar arquivos.",
    icon: "modeAsk",
  },
  plan: {
    label: "Planejar",
    hint: "Explora o código e propõe um plano antes de qualquer edição.",
    icon: "modePlan",
  },
  edit: {
    label: "Editar",
    hint: "Edita arquivos do workspace automaticamente; não roda comandos.",
    icon: "modeEdit",
  },
  auto: {
    label: "Agente",
    hint: "Trabalha de forma autônoma; ações sensíveis pedem sua aprovação.",
    icon: "modeAuto",
  },
  bypass: {
    label: "Bypass",
    hint: "Acesso total, sem confirmações.",
    icon: "modeBypass",
    warning:
      "O agente poderá editar qualquer arquivo e executar comandos sem pedir aprovação. Use só em ambientes descartáveis.",
  },
};
