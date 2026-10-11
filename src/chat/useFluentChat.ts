/**
 * Estado e ações do Fluent Chat (antes espalhados no `App`): store de
 * conversas/agentes por workspace, agentes globais, provedores do registro,
 * envio com streaming coalescido por frame, aprovações, retry/edição e
 * reversão por snapshot git.
 *
 * Contratos em docs/context/agentes-ia.md — destaque:
 * - um processo por provedor+workspace (o backend reaproveita o worker);
 * - a sessão nativa (`nativeSessionId`) é sempre persistida;
 * - o `contextPrompt` (instruções do agente + histórico) é só fallback;
 * - status/erro/raciocínio pertencem à conversa que os produziu.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  acpCancel,
  acpPrompt,
  acpStopWorkspace,
  acpWarm,
  agentsLoad,
  agentsSave,
  chatGlobalAgentsLoad,
  chatGlobalAgentsSave,
  chatProviders,
  chatRespondApproval,
  gitSnapshotCreate,
  gitSnapshotRestore,
} from "../api";
import {
  acpResolveModel,
  mergeProviderStatuses,
  NATIVE_PROVIDER_IDS,
  type AcpModelDefinition,
  type ProviderStatus,
} from "../acp/providers";
import {
  agentRunOptions,
  buildAgentPrompt,
  capToolCall,
  createLocalId,
  EMPTY_AGENT_STORE,
  normalizeAgentStore,
  normalizeGlobalAgents,
  replaceConversation,
} from "../agents/store";
import {
  READ_ONLY_MODES,
  normalizeAgentMode,
  type AgentConversation,
  type AgentDefinition,
  type AgentDraft,
  type AgentEditorContext,
  type AgentMessage,
  type AgentMode,
  type AgentStore,
  type ChatApproval,
} from "../agents/types";
import type { Problem } from "../types";
import {
  addAttachment,
  assemblePrompt,
  attachmentLabel,
  presetAttachments,
  type ChatAttachment,
} from "./context";
import { resolveAttachmentBlocks } from "./resolveContext";
import {
  buildTargets,
  defaultTargetId,
  isProviderTarget,
  providerTargetId,
  resolveTarget,
  type ChatTarget,
} from "./targets";
import { mergeUsage, settleToolCalls, upsertToolCall } from "./transcript";
import { getSetting } from "../settings/instance";

const PREFS_KEY = "fluentChat.prefs";

interface ChatPrefs {
  lastTarget?: string;
  mode?: AgentMode;
  models?: Record<string, string>;
}

function readPrefs(): ChatPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as ChatPrefs) : {};
  } catch {
    return {};
  }
}

function writePrefs(update: Partial<ChatPrefs>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...update }));
  } catch {
    /* armazenamento indisponível: preferências só nesta sessão */
  }
}

/** Status/erro amarrados à conversa (`null` = aviso global / chat novo). */
interface Owned {
  conversationId: string | null;
  message: string;
}

export interface FluentChatDeps {
  rootPath: string | null;
  rootPathRef: MutableRefObject<string | null>;
  /** A sidebar está aberta (só então pré-aquecemos o provedor). */
  visible: boolean;
  readEditorContext: () => AgentEditorContext | null;
  readProblems: () => Problem[];
  refreshExplorer: () => Promise<void>;
}

function newConversation(agentId: string): AgentConversation {
  const now = new Date().toISOString();
  return {
    id: createLocalId("conversation"),
    agentId,
    title: "Nova conversa",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Remove a última troca (pergunta + resposta) e devolve a pergunta. */
function forkWithoutLastExchange(conversation: AgentConversation) {
  const lastUser = [...conversation.messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return null;
  const index = conversation.messages.lastIndexOf(lastUser);
  const { nativeSessionId: _dropped, ...rest } = conversation;
  // Novo id: os workers do backend guardam a sessão nativa por conversa; o
  // fork precisa nascer limpo e reconstruir o histórico pelo contextPrompt.
  const fork: AgentConversation = {
    ...rest,
    id: createLocalId("conversation"),
    messages: conversation.messages.slice(0, index),
    updatedAt: new Date().toISOString(),
  };
  return { fork, message: lastUser };
}

export function useFluentChat(deps: FluentChatDeps) {
  const { rootPath, rootPathRef, visible } = deps;
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [store, setStore] = useState<AgentStore>(() => ({ ...EMPTY_AGENT_STORE }));
  const [globalAgents, setGlobalAgents] = useState<AgentDefinition[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>(() =>
    // Otimista até o backend responder: nativos disponíveis.
    mergeProviderStatuses(NATIVE_PROVIDER_IDS.map((id) => ({ id, installed: true }))),
  );
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Settings `fluent.agents.defaultProvider/defaultMode` vencem o "último
  // usado" (estado em localStorage); vazio = último usado. Bypass nunca é padrão.
  const [composerTarget, setComposerTarget] = useState<string>(() => {
    const preferred = getSetting<string>("fluent.agents.defaultProvider");
    return preferred ? providerTargetId(preferred) : readPrefs().lastTarget ?? providerTargetId("claude");
  });
  const [mode, setModeState] = useState<AgentMode>(() => {
    const preferred = normalizeAgentMode(getSetting<string>("fluent.agents.defaultMode"));
    return (preferred && preferred !== "bypass" ? preferred : null) ?? normalizeAgentMode(readPrefs().mode) ?? "ask";
  });
  const [prefModels, setPrefModels] = useState<Record<string, string>>(
    () => readPrefs().models ?? {},
  );
  const [dynamicModels, setDynamicModels] = useState<Record<string, AcpModelDefinition[]>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Owned | null>(null);
  const [error, setError] = useState<Owned | null>(null);
  const [thought, setThought] = useState<{ conversationId: string; text: string } | null>(null);
  const [approvals, setApprovals] = useState<ChatApproval[]>([]);
  const streamingConversationIdRef = useRef<string | null>(null);

  // ---- Provedores (registro do backend) ----
  const refreshProviders = useCallback(async () => {
    try {
      const statuses = await chatProviders();
      setProviders(mergeProviderStatuses(statuses));
      setProvidersLoaded(true);
    } catch {
      // Backend antigo/indisponível: mantém o catálogo otimista.
      setProvidersLoaded(true);
    }
  }, []);
  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // ---- Agentes globais (dados do app) ----
  useEffect(() => {
    chatGlobalAgentsLoad()
      .then((value) => setGlobalAgents(normalizeGlobalAgents(value)))
      .catch(() => setGlobalAgents([]));
  }, []);

  const persistGlobalAgents = useCallback((next: AgentDefinition[]) => {
    setGlobalAgents(next);
    void chatGlobalAgentsSave({ version: 2, agents: next }).catch((err) =>
      setError({ conversationId: null, message: String(err) }),
    );
  }, []);

  // ---- Store por workspace ----
  useEffect(() => {
    let cancelled = false;
    setActiveId(null);
    setError(null);
    setStatus(null);
    setApprovals([]);
    // Um envio em andamento do workspace anterior vê isStaleWorkspace() e
    // desiste; libera o busy aqui para o novo workspace começar livre.
    setBusy(false);
    if (!rootPath) {
      setStore({ ...EMPTY_AGENT_STORE });
      return () => {
        cancelled = true;
      };
    }
    agentsLoad(rootPath)
      .then((loaded) => {
        if (!cancelled) setStore(normalizeAgentStore(loaded));
      })
      .catch((err) => {
        if (!cancelled) {
          setStore({ ...EMPTY_AGENT_STORE });
          setError({ conversationId: null, message: String(err) });
        }
      });
    return () => {
      cancelled = true;
      void acpStopWorkspace(rootPath).catch(() => {});
    };
  }, [rootPath]);

  const persistStore = useCallback(
    async (next: AgentStore) => {
      setStore(next);
      if (!rootPath) return;
      try {
        await agentsSave(rootPath, next);
        setError((prev) => (prev?.conversationId === null ? null : prev));
      } catch (err) {
        setError({ conversationId: null, message: String(err) });
      }
    },
    [rootPath],
  );

  // ---- Derivados ----
  const agents = useMemo(
    () => [...store.agents, ...globalAgents],
    [store.agents, globalAgents],
  );
  const targets = useMemo(() => buildTargets(providers, agents), [providers, agents]);
  const conversations = useMemo(
    () => [...store.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [store.conversations],
  );
  const activeConversation = activeId
    ? store.conversations.find((conversation) => conversation.id === activeId) ?? null
    : null;
  const currentTargetId = activeConversation?.agentId ?? composerTarget;
  const target: ChatTarget =
    resolveTarget(currentTargetId, providers, agents) ??
    resolveTarget(defaultTargetId(targets, null), providers, agents)!;
  const modelsFor = dynamicModels[target.provider];
  const model = target.agent
    ? acpResolveModel(target.provider, target.agent.model, modelsFor)
    : acpResolveModel(target.provider, prefModels[target.id], modelsFor);

  // Primeiro uso / último alvo desinstalado: o chat novo cai no primeiro
  // provedor instalado (sem sobrescrever a preferência salva).
  useEffect(() => {
    if (!providersLoaded || activeId) return;
    const current = resolveTarget(composerTarget, providers, agents);
    if (current?.installed) return;
    const fallback = targets.find((candidate) => candidate.kind === "provider" && candidate.installed);
    if (fallback && fallback.id !== composerTarget) setComposerTarget(fallback.id);
  }, [providersLoaded, activeId, composerTarget, providers, agents, targets]);

  // Pré-aquece o provedor do alvo atual quando o chat está visível: o boot do
  // processo sai do caminho do primeiro envio. Idempotente no backend.
  useEffect(() => {
    if (!visible || !rootPath || !target.installed) return;
    void acpWarm(target.provider, rootPath).catch(() => {});
  }, [visible, rootPath, target.provider, target.installed]);

  const setMode = useCallback((next: AgentMode) => {
    setModeState(next);
    writePrefs({ mode: next });
  }, []);

  // ---- Alvo, modelo e conversas ----
  const updateAgent = useCallback(
    (agentId: string, patch: Partial<AgentDefinition>) => {
      const now = new Date().toISOString();
      if (globalAgents.some((agent) => agent.id === agentId)) {
        persistGlobalAgents(
          globalAgents.map((agent) => (agent.id === agentId ? { ...agent, ...patch, updatedAt: now } : agent)),
        );
        return;
      }
      void persistStore({
        ...store,
        agents: store.agents.map((agent) =>
          agent.id === agentId ? { ...agent, ...patch, updatedAt: now } : agent,
        ),
      });
    },
    [globalAgents, persistGlobalAgents, persistStore, store],
  );

  const setModel = useCallback(
    (next: string) => {
      if (target.agent) {
        updateAgent(target.agent.id, { model: next });
        return;
      }
      setPrefModels((prev) => {
        const models = { ...prev, [target.id]: next };
        writePrefs({ models });
        return models;
      });
    },
    [target, updateAgent],
  );

  const selectTarget = useCallback(
    (targetId: string) => {
      const picked = resolveTarget(targetId, providers, agents);
      if (!picked) return;
      if (activeConversation && activeConversation.agentId !== targetId) {
        if (activeConversation.messages.length > 0) {
          // Trocar de agente no meio da conversa abre uma conversa nova (a
          // sessão nativa pertence ao provedor/agente anterior).
          setActiveId(null);
        } else {
          void persistStore(
            replaceConversation(store, activeConversation.id, (current) => ({
              ...current,
              agentId: targetId,
            })),
          );
        }
      }
      setComposerTarget(targetId);
      writePrefs({ lastTarget: targetId });
      if (picked.defaultMode) setMode(picked.defaultMode);
    },
    [activeConversation, agents, persistStore, providers, setMode, store],
  );

  const startNewConversation = useCallback(
    (targetId?: string) => {
      setActiveId(null);
      if (targetId) selectTarget(targetId);
      else if (activeConversation) setComposerTarget(activeConversation.agentId);
      setError((prev) => (prev?.conversationId === null ? null : prev));
    },
    [activeConversation, selectTarget],
  );

  const openConversation = useCallback((conversationId: string) => {
    setActiveId(conversationId);
  }, []);

  const renameConversation = useCallback(
    (conversationId: string, title: string) => {
      const now = new Date().toISOString();
      void persistStore(
        replaceConversation(store, conversationId, (current) => ({ ...current, title, updatedAt: now })),
      );
    },
    [persistStore, store],
  );

  const deleteConversation = useCallback(
    (conversationId: string) => {
      void persistStore({
        ...store,
        conversations: store.conversations.filter((conversation) => conversation.id !== conversationId),
      });
      if (activeId === conversationId) setActiveId(null);
    },
    [activeId, persistStore, store],
  );

  // ---- Agentes personalizados ----
  const saveAgent = useCallback(
    (draft: AgentDraft): string | null => {
      if (!rootPath) return null;
      const now = new Date().toISOString();
      const existing = draft.id ? agents.find((agent) => agent.id === draft.id) : undefined;
      const id = existing?.id ?? createLocalId("agent");
      const scope = draft.scope === "global" ? "global" : "workspace";
      const definition: AgentDefinition = {
        id,
        name: draft.name,
        color: draft.color,
        initialPrompt: draft.initialPrompt,
        provider: draft.provider,
        model: draft.model ?? "",
        workspacePath: rootPath,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.icon ? { icon: draft.icon } : {}),
        ...(draft.defaultMode ? { defaultMode: draft.defaultMode } : {}),
        ...(draft.contextPresets?.length ? { contextPresets: draft.contextPresets } : {}),
        ...(draft.allowedTools?.length ? { allowedTools: draft.allowedTools } : {}),
        ...(draft.disallowedTools?.length ? { disallowedTools: draft.disallowedTools } : {}),
        ...(draft.networkAccess ? { networkAccess: true } : {}),
        ...(scope === "global" ? { scope: "global" as const } : {}),
      };
      const inWorkspace = store.agents.filter((agent) => agent.id !== id);
      const inGlobal = globalAgents.filter((agent) => agent.id !== id);
      if (scope === "global") {
        persistGlobalAgents([...inGlobal, definition]);
        if (inWorkspace.length !== store.agents.length) void persistStore({ ...store, agents: inWorkspace });
      } else {
        void persistStore({ ...store, agents: [...inWorkspace, definition] });
        if (inGlobal.length !== globalAgents.length) persistGlobalAgents(inGlobal);
      }
      return id;
    },
    [agents, globalAgents, persistGlobalAgents, persistStore, rootPath, store],
  );

  const deleteAgent = useCallback(
    (agentId: string) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (!agent) return;
      // As conversas continuam (sem perda de histórico) com o provedor base.
      const fallback = providerTargetId(agent.provider);
      const next: AgentStore = {
        ...store,
        agents: store.agents.filter((candidate) => candidate.id !== agentId),
        conversations: store.conversations.map((conversation) =>
          conversation.agentId === agentId ? { ...conversation, agentId: fallback } : conversation,
        ),
      };
      void persistStore(next);
      if (globalAgents.some((candidate) => candidate.id === agentId)) {
        persistGlobalAgents(globalAgents.filter((candidate) => candidate.id !== agentId));
      }
      if (composerTarget === agentId) setComposerTarget(fallback);
    },
    [agents, composerTarget, globalAgents, persistGlobalAgents, persistStore, store],
  );

  const duplicateAgent = useCallback(
    (agentId: string) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (!agent) return;
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = agent;
      saveAgent({ ...rest, name: `${agent.name} (cópia)` });
    },
    [agents, saveAgent],
  );

  // ---- Envio ----
  const send = useCallback(
    async (
      text: string,
      attachments: ChatAttachment[],
      override?: { conversation: AgentConversation },
    ) => {
      const { rootPath: root, readEditorContext, readProblems } = depsRef.current;
      const message = text.trim();
      if (!root || !message || busy) return;
      const targetId = override?.conversation.agentId ?? currentTargetId;
      const sendTarget = resolveTarget(targetId, providers, agents);
      if (!sendTarget) return;
      if (providersLoaded && !sendTarget.installed) {
        setError({
          conversationId: override?.conversation.id ?? activeId,
          message: `${sendTarget.label} não está instalado. Instale com \`${sendTarget.installHint}\` e tente de novo.`,
        });
        return;
      }

      const existing = override?.conversation ?? activeConversation;
      const conversation = existing ?? newConversation(targetId);
      const isNew = !existing;
      const sendRoot = root;
      const isStaleWorkspace = () => rootPathRef.current !== sendRoot;
      const conversationId = conversation.id;
      const setSendStatus = (value: string | null) =>
        setStatus(value === null ? null : { conversationId, message: value });
      const setSendError = (value: string) => setError({ conversationId, message: value });

      setActiveId(conversationId);
      setBusy(true);
      streamingConversationIdRef.current = conversationId;
      setError((prev) =>
        prev && prev.conversationId !== null && prev.conversationId !== conversationId ? prev : null,
      );

      // Contexto anexado pelo usuário (chips) + presets do agente dele.
      const editor = readEditorContext();
      let allAttachments = attachments;
      for (const preset of presetAttachments(sendTarget.agent?.contextPresets, editor, () => createLocalId("ctx"))) {
        allAttachments = addAttachment(allAttachments, preset);
      }

      const readOnly = READ_ONLY_MODES.has(mode);
      const now = new Date().toISOString();
      const userMessage: AgentMessage = {
        id: createLocalId("message"),
        role: "user",
        content: message,
        createdAt: now,
        status: "done",
        mode,
        ...(allAttachments.length
          ? { attachments: allAttachments.map((a) => ({ kind: a.kind, label: attachmentLabel(a) })) }
          : {}),
      };
      const assistantMessage: AgentMessage = {
        id: createLocalId("message"),
        role: "assistant",
        content: "",
        createdAt: now,
        status: "streaming",
      };

      // Atualizações funcionais sobre o store ATUAL (renomear/excluir durante
      // o stream sobrevive); o resultado é capturado para persistir o que a UI
      // mostra.
      const applyToConversation = (
        update: (current: AgentConversation) => AgentConversation,
      ): AgentStore | null => {
        let reconciled: AgentStore | null = null;
        setStore((prev) => {
          let base = prev;
          if (!prev.conversations.some((c) => c.id === conversationId)) {
            if (!isNew && !override) return prev; // apagada durante o stream
            base = { ...prev, conversations: [...prev.conversations, conversation] };
          }
          reconciled = replaceConversation(base, conversationId, update);
          return reconciled;
        });
        return reconciled;
      };

      let saveQueue = Promise.resolve();
      const persistForSend = (next: AgentStore | null): Promise<void> => {
        if (!next || isStaleWorkspace()) return saveQueue;
        saveQueue = saveQueue
          .then(() =>
            agentsSave(sendRoot, next).then(() =>
              setError((prev) =>
                prev && prev.conversationId !== null && prev.conversationId !== conversationId ? prev : null,
              ),
            ),
          )
          .catch((err) => setSendError(String(err)));
        return saveQueue;
      };

      // A pergunta aparece na hora (feedback imediato); o ponto de
      // restauração e o contexto são reunidos em paralelo.
      applyToConversation((current) => ({
        ...current,
        title: current.messages.length === 0 ? message.slice(0, 60) || "Nova conversa" : current.title,
        messages: [...current.messages, userMessage, assistantMessage],
        updatedAt: now,
      }));
      setSendStatus(
        allAttachments.length ? "Reunindo o contexto…" : readOnly ? "Preparando a conversa…" : "Criando ponto de restauração…",
      );
      let revert: AgentMessage["revert"] | null = null;
      let blocks: string[] = [];
      try {
        [revert, blocks] = await Promise.all([
          readOnly ? Promise.resolve(null) : gitSnapshotCreate(sendRoot),
          resolveAttachmentBlocks(allAttachments, {
            workspacePath: sendRoot,
            message,
            editor,
            readProblems,
          }),
        ]);
      } catch (err) {
        const messageText = String(err);
        void persistForSend(
          applyToConversation((current) => ({
            ...current,
            messages: current.messages.map((candidate) =>
              candidate.id === assistantMessage.id
                ? { ...candidate, content: messageText, status: "error" }
                : candidate,
            ),
          })),
        );
        setSendError(messageText);
        setSendStatus(null);
        setBusy(false);
        streamingConversationIdRef.current = null;
        return;
      }
      if (isStaleWorkspace()) {
        setBusy(false);
        streamingConversationIdRef.current = null;
        return;
      }

      // Os blocos de contexto vão no prompt enviado (incremental e de sessão
      // nova), nunca na `content` exibida.
      const promptWithContext = assemblePrompt(message, blocks);
      const contextPrompt = buildAgentPrompt(
        { initialPrompt: sendTarget.agent?.initialPrompt ?? "" },
        conversation.messages,
        promptWithContext,
      );

      setSendStatus("Conectando ao agente…");
      void persistForSend(
        applyToConversation((current) => ({
          ...current,
          messages: current.messages.map((candidate) =>
            candidate.id === userMessage.id && revert ? { ...candidate, revert } : candidate,
          ),
        })),
      );

      // Deltas menores que uma palavra: um update React por frame (24ms).
      let receivedLength = 0;
      let pendingText = "";
      let textTimer: ReturnType<typeof setTimeout> | null = null;
      const updateAssistant = (update: (message: AgentMessage) => AgentMessage) =>
        applyToConversation((current) => ({
          ...current,
          messages: current.messages.map((candidate) =>
            candidate.id === assistantMessage.id ? update(candidate) : candidate,
          ),
          updatedAt: new Date().toISOString(),
        }));
      const flushText = () => {
        if (textTimer !== null) {
          clearTimeout(textTimer);
          textTimer = null;
        }
        if (!pendingText || isStaleWorkspace()) return;
        const chunk = pendingText;
        pendingText = "";
        updateAssistant((candidate) => ({ ...candidate, content: candidate.content + chunk, status: "streaming" }));
      };
      const appendText = (content: string) => {
        pendingText += content;
        receivedLength += content.length;
        if (textTimer === null) textTimer = setTimeout(flushText, 24);
      };

      let pendingThought = "";
      let thoughtTimer: ReturnType<typeof setTimeout> | null = null;
      const flushThought = () => {
        if (thoughtTimer !== null) {
          clearTimeout(thoughtTimer);
          thoughtTimer = null;
        }
        if (!pendingThought || isStaleWorkspace()) return;
        const chunk = pendingThought;
        pendingThought = "";
        setThought((prev) => ({
          conversationId,
          text: prev && prev.conversationId === conversationId ? prev.text + chunk : chunk,
        }));
      };
      const appendThought = (content: string) => {
        pendingThought += content;
        if (thoughtTimer === null) thoughtTimer = setTimeout(flushThought, 24);
      };
      const clearThought = () => {
        pendingThought = "";
        if (thoughtTimer !== null) {
          clearTimeout(thoughtTimer);
          thoughtTimer = null;
        }
        setThought((prev) => (prev && prev.conversationId === conversationId ? null : prev));
      };
      const clearApprovals = () =>
        setApprovals((prev) => prev.filter((approval) => approval.conversationId !== conversationId));

      let finalizePromise: Promise<void> | null = null;
      let wasCancelled = false;
      const finalize = (outcome: "done" | "error", fallback: string): Promise<void> => {
        if (isStaleWorkspace()) return Promise.resolve();
        if (finalizePromise) return finalizePromise;
        flushText();
        finalizePromise = persistForSend(
          updateAssistant((candidate) => ({
            ...candidate,
            content: candidate.content || fallback,
            status: outcome,
            ...(candidate.toolCalls ? { toolCalls: settleToolCalls(candidate.toolCalls, outcome) } : {}),
          })),
        );
        return finalizePromise;
      };

      const runModel = sendTarget.agent
        ? acpResolveModel(sendTarget.provider, sendTarget.agent.model, dynamicModels[sendTarget.provider])
        : acpResolveModel(sendTarget.provider, prefModels[sendTarget.id], dynamicModels[sendTarget.provider]);

      try {
        await acpPrompt(
          sendTarget.provider,
          sendRoot,
          conversationId,
          contextPrompt,
          promptWithContext,
          mode,
          runModel,
          conversation.nativeSessionId ?? null,
          agentRunOptions(sendTarget.agent ?? null),
          (event) => {
            if (isStaleWorkspace()) return;
            switch (event.type) {
              case "status":
                setSendStatus(event.message);
                return;
              case "session":
                void persistForSend(
                  applyToConversation((current) =>
                    current.nativeSessionId === event.sessionId
                      ? current
                      : { ...current, nativeSessionId: event.sessionId },
                  ),
                );
                return;
              case "thought":
                appendThought(event.content);
                return;
              case "text":
                setSendStatus("Recebendo resposta…");
                clearThought();
                appendText(event.content);
                return;
              case "toolCall": {
                // O texto pendente entra antes, para a ordem do transcript.
                flushText();
                const { type: _type, ...call } = event;
                const offset = receivedLength;
                updateAssistant((candidate) => ({
                  ...candidate,
                  toolCalls: upsertToolCall(candidate.toolCalls, call, offset).map(capToolCall),
                }));
                return;
              }
              case "usage": {
                const { type: _type, ...usage } = event;
                updateAssistant((candidate) => ({ ...candidate, usage: mergeUsage(candidate.usage, usage) }));
                return;
              }
              case "models":
                setDynamicModels((prev) => ({
                  ...prev,
                  [sendTarget.provider]: event.models.map((entry) => ({ id: entry.id, label: entry.label, hint: "" })),
                }));
                return;
              case "approval": {
                const { type: _type, ...approval } = event;
                setApprovals((prev) => [
                  ...prev.filter((candidate) => candidate.requestId !== approval.requestId),
                  { ...approval, conversationId },
                ]);
                return;
              }
              case "approvalResolved":
                setApprovals((prev) => prev.filter((candidate) => candidate.requestId !== event.requestId));
                return;
              case "done":
                wasCancelled = event.stopReason.toLowerCase() === "cancelled";
                void finalize(
                  "done",
                  wasCancelled
                    ? "Execução interrompida pelo usuário."
                    : "O agente encerrou a resposta sem conteúdo textual.",
                );
                return;
              case "error":
                setSendError(event.message);
                return;
            }
          },
        );
        if (isStaleWorkspace()) return;
        await finalize("done", "O agente encerrou a resposta sem conteúdo textual.");
        setSendStatus(wasCancelled ? "Execução interrompida." : "Resposta concluída.");
      } catch (err) {
        if (isStaleWorkspace()) return;
        flushText();
        const messageText = String(err);
        await finalize("error", messageText);
        setSendError(messageText);
        setSendStatus(null);
      } finally {
        if (textTimer !== null) clearTimeout(textTimer);
        clearThought();
        clearApprovals();
        setBusy(false);
        streamingConversationIdRef.current = null;
      }
    },
    [
      activeConversation,
      activeId,
      agents,
      busy,
      currentTargetId,
      dynamicModels,
      mode,
      prefModels,
      providers,
      providersLoaded,
      rootPathRef,
    ],
  );

  const stop = useCallback(() => {
    if (!busy) return;
    const conversationId = streamingConversationIdRef.current;
    setStatus({ conversationId, message: "Parando o agente…" });
    void acpCancel().catch((err) => setError({ conversationId, message: String(err) }));
  }, [busy]);

  const respondApproval = useCallback((requestId: string, optionId: string) => {
    const approval = approvals.find((candidate) => candidate.requestId === requestId);
    setApprovals((prev) => prev.filter((candidate) => candidate.requestId !== requestId));
    void chatRespondApproval(requestId, optionId).catch((err) =>
      setError({ conversationId: approval?.conversationId ?? null, message: String(err) }),
    );
  }, [approvals]);

  /**
   * Refaz a última pergunta numa ramificação limpa da conversa (sem a troca
   * anterior; a sessão nativa é recriada a partir do histórico da UI).
   */
  const retryLast = useCallback(() => {
    if (!activeConversation || busy) return;
    const forked = forkWithoutLastExchange(activeConversation);
    if (!forked) return;
    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations.map((conversation) =>
        conversation.id === activeConversation.id ? forked.fork : conversation,
      ),
    }));
    setActiveId(forked.fork.id);
    void send(forked.message.content, [], { conversation: forked.fork });
  }, [activeConversation, busy, send]);

  /** Remove a última troca e devolve o texto para o composer editar. */
  const editLast = useCallback((): string | null => {
    if (!activeConversation || busy) return null;
    const forked = forkWithoutLastExchange(activeConversation);
    if (!forked) return null;
    const empty = forked.fork.messages.length === 0;
    void persistStore({
      ...store,
      // Sem nada antes da pergunta editada, a conversa some: o reenvio cria
      // uma nova (sem deixar uma conversa vazia no histórico).
      conversations: empty
        ? store.conversations.filter((conversation) => conversation.id !== activeConversation.id)
        : store.conversations.map((conversation) =>
            conversation.id === activeConversation.id ? forked.fork : conversation,
          ),
    });
    setActiveId(empty ? null : forked.fork.id);
    if (empty) setComposerTarget(activeConversation.agentId);
    return forked.message.content;
  }, [activeConversation, busy, persistStore, store]);

  /** Volta a árvore de trabalho ao snapshot anterior ao pedido. */
  const revert = useCallback(
    async (conversationId: string, userMessageId: string) => {
      if (!rootPath) return;
      const conversation = store.conversations.find((candidate) => candidate.id === conversationId);
      const targetMessage = conversation?.messages.find((candidate) => candidate.id === userMessageId);
      if (!targetMessage?.revert || targetMessage.revert.reverted) return;
      try {
        await gitSnapshotRestore(rootPath, targetMessage.revert);
      } catch (err) {
        setError({ conversationId, message: `Não foi possível reverter: ${String(err)}` });
        return;
      }
      void persistStore(
        replaceConversation(store, conversationId, (current) => ({
          ...current,
          messages: current.messages.map((candidate) =>
            candidate.id === userMessageId && candidate.revert
              ? { ...candidate, revert: { ...candidate.revert, reverted: true } }
              : candidate,
          ),
        })),
      );
      await depsRef.current.refreshExplorer();
      setStatus({ conversationId, message: "Alterações revertidas para antes deste pedido." });
    },
    [persistStore, rootPath, store],
  );

  // Avisos só na conversa dona (ou globais). Chat novo = conversa `null`.
  const owned = <T extends { conversationId: string | null }>(value: T | null) =>
    value && (value.conversationId === null || value.conversationId === activeId) ? value : null;

  return {
    rootPath,
    store,
    agents,
    workspaceAgents: store.agents,
    globalAgents,
    providers,
    providersLoaded,
    refreshProviders,
    targets,
    target,
    model,
    dynamicModels: modelsFor,
    mode,
    conversations,
    activeConversation,
    busy,
    streamingConversationId: streamingConversationIdRef.current,
    status: owned(status)?.message ?? null,
    error: owned(error)?.message ?? null,
    thought: thought && thought.conversationId === activeId ? thought.text : null,
    approvals: approvals.filter((approval) => approval.conversationId === activeId),
    setMode,
    setModel,
    selectTarget,
    startNewConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    saveAgent,
    deleteAgent,
    duplicateAgent,
    send,
    stop,
    respondApproval,
    retryLast,
    editLast,
    revert,
    dismissError: () => setError(null),
    isProviderTarget,
  };
}

export type FluentChatState = ReturnType<typeof useFluentChat>;
