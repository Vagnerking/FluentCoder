/**
 * Hooks React das configurações. `useSyncExternalStore` sobre a VERSÃO do
 * serviço (número), e o valor recalculado só quando a versão muda — sem
 * re-render do App inteiro e sem loop por objetos recriados.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { settings } from "./instance.ts";
import type { ConfigTarget } from "./model.ts";

export interface SettingScopeOptions {
  resource?: string | null;
  languageId?: string | null;
}

/** Versão do serviço (muda a cada alteração de qualquer setting). */
export function useSettingsVersion(): number {
  return useSyncExternalStore(settings.subscribe, settings.getVersion, settings.getVersion);
}

/** Valor efetivo de uma setting. */
export function useSetting<T>(key: string, opts: SettingScopeOptions = {}): T {
  const version = useSettingsVersion();
  return useMemo(
    () => settings.get<T>(key, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key, opts.resource, opts.languageId],
  );
}

/**
 * Estado React espelhado numa setting do Usuário, para preferências que a UI
 * muda em tempo real (arrastar a barra de atividades/painel, Ctrl+= no zoom):
 * o valor local muda na hora e a gravação no settings.json sai com debounce
 * (sem escrever o arquivo a cada pixel de arraste). Mudanças vindas do
 * arquivo/UI de Configurações são adotadas.
 */
export function useSyncedSetting<T>(
  key: string,
  normalize: (raw: unknown) => T,
  delayMs = 400,
): [T, Dispatch<SetStateAction<T>>] {
  const fromSettings = normalize(useSetting<unknown>(key));
  const serialized = JSON.stringify(fromSettings);
  const [value, setValue] = useState<T>(fromSettings);
  const adopted = useRef(serialized);
  useEffect(() => {
    adopted.current = serialized;
    setValue(JSON.parse(serialized) as T);
  }, [serialized]);
  useEffect(() => {
    const next = JSON.stringify(value);
    if (next === adopted.current) return;
    const t = setTimeout(() => {
      adopted.current = next;
      void settings.update(key, value, "user").catch((err) => console.warn("[settings]", key, err));
    }, delayMs);
    return () => clearTimeout(t);
  }, [value, key, delayMs]);
  return [value, setValue];
}

/**
 * Par `[valor, setter]` para preferências que a UI também altera (posição da
 * sidebar, zoom…). O setter grava no Usuário — como o VS Code faz quando você
 * arrasta a barra de atividades.
 */
export function useSettingState<T>(key: string, target: ConfigTarget = "user"): [T, (next: T | ((prev: T) => T)) => void] {
  const value = useSetting<T>(key);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = settings.get<T>(key);
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (JSON.stringify(v) === JSON.stringify(prev)) return;
      void settings.update(key, v, target).catch((err) => console.warn("[settings]", key, err));
    },
    [key, target],
  );
  return [value, set];
}
