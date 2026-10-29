/**
 * Tabela do que o shim deste host oferece (gerada — ver
 * tools/ext-host/discovery/capabilities.js). Separada de compatibility.ts para
 * o classificador continuar puro e testável sem importar JSON.
 */
import data from "./capabilities.json";
import type { Capabilities } from "./compatibility";

export const CAPABILITIES: Capabilities = data as Capabilities;
