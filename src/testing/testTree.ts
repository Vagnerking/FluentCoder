/**
 * Agrupamento de testes .NET numa árvore namespace/classe → método (milestone
 * #10). Puro (sem React/Monaco) para ser testável em `node --test`.
 *
 * Os FQN vêm como `Namespace.Sub.Classe.Metodo` (lista plana do
 * `dotnet test --list-tests`). Theory pode carregar args no TRX
 * (`...Metodo(x: 1)`), mas o `--list-tests` devolve o método sem args — a árvore
 * agrupa pelo FQN do método; a associação do resultado por-caso é do chamador.
 */

/** Um nó folha: um método de teste. */
export interface TestLeaf {
  /** FQN completo, ex.: `App.Tests.CalcTests.Soma`. */
  fqn: string;
  /** Nome do método (último segmento). */
  method: string;
}

/** Um grupo (classe, com o namespace no rótulo) contendo seus métodos. */
export interface TestGroup {
  /** Rótulo do grupo: o FQN sem o método, ex.: `App.Tests.CalcTests`. */
  container: string;
  /** Nome curto da classe (último segmento do container). */
  className: string;
  /** Namespace (tudo antes da classe), ex.: `App.Tests`; vazio se não houver. */
  namespace: string;
  leaves: TestLeaf[];
}

/**
 * Agrupa FQN planos por classe (o penúltimo segmento). O último segmento é o
 * método; o resto antes da classe é o namespace. FQN sem ponto viram um grupo de
 * container vazio com o próprio nome como método. Grupos e folhas saem ordenados
 * e estáveis (ordem alfabética por container, depois por método).
 */
export function groupTests(fqns: readonly string[]): TestGroup[] {
  const byContainer = new Map<string, TestLeaf[]>();
  for (const fqn of fqns) {
    // Ignora args de Theory se aparecerem: corta no primeiro '('.
    const clean = fqn.split("(")[0];
    const lastDot = clean.lastIndexOf(".");
    const container = lastDot === -1 ? "" : clean.slice(0, lastDot);
    const method = lastDot === -1 ? clean : clean.slice(lastDot + 1);
    if (!method) continue;
    const leaves = byContainer.get(container) ?? [];
    // Dedup por fqn (o mesmo método não deve duplicar).
    if (!leaves.some((l) => l.fqn === fqn)) leaves.push({ fqn, method });
    byContainer.set(container, leaves);
  }

  const groups: TestGroup[] = [];
  for (const [container, leaves] of byContainer) {
    const lastDot = container.lastIndexOf(".");
    const className = lastDot === -1 ? container : container.slice(lastDot + 1);
    const namespace = lastDot === -1 ? "" : container.slice(0, lastDot);
    leaves.sort((a, b) => a.method.localeCompare(b.method));
    groups.push({ container, className, namespace, leaves });
  }
  groups.sort((a, b) => a.container.localeCompare(b.container));
  return groups;
}
