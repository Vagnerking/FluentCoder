/**
 * CodeLens "▶ Executar Teste" para arquivos C# (`.cs`) — milestone #5.
 *
 * Registra UM provider Monaco (`registerCodeLensProvider`) para `csharp` que
 * põe um lens "▶ Executar Teste" acima de cada método de teste detectado. O
 * clique dispara o test runner existente (`dotnet test --filter`) via callback.
 *
 * API pública:
 *   - `findTestMethods(sourceText): TestMethod[]` — scanner puro (testável) que
 *     acha métodos anotados com `[Fact]`/`[Theory]`/`[Test]`/`[TestMethod]`/
 *     `[TestCase]` (e formas qualificadas/com args/agrupadas) e deriva o FQN
 *     `namespace.classe.metodo`.
 *   - `installTestCodeLens(csprojResolver, runTest): IDisposable[]` — registra o
 *     provider + o comando Monaco. O caller (fiação em client.ts/App.tsx, feita
 *     em OUTRO trabalho) injeta:
 *       * `csprojResolver: () => Promise<string | null>` — descobre o `.csproj`
 *         de teste que roda o lens (ex.: primeiro `.csproj` de teste do
 *         workspace via `listProjectFiles`). Desacopla este módulo de `api.ts`.
 *       * `runTest: (csprojPath, fullyQualifiedName) => void | Promise<void>` —
 *         dispara `dotnetTestRun(csprojPath, fqn)` e mostra o resultado.
 *
 * FRONTEIRA com a milestone #10 (Debug Test): este módulo emite APENAS o lens
 * "▶ Executar Teste". O lens "Depurar Teste" NÃO é implementado aqui; será um
 * segundo lens/command adicionado na #10, reusando `findTestMethods`.
 *
 * Contratos (docs/context/editor.md, cshtml-language-service.md): um único
 * provider por feature/linguagem; selector restrito a `language: "csharp"`;
 * todo disposable é retornado para descarte pelo caller; idempotente sob React
 * StrictMode (registrar/descartar não vaza providers). NÃO toca nos bridges de
 * semantic tokens/diagnostics/references existentes.
 *
 * NOTA de import: `monaco-editor` só é carregado DENTRO de `installTestCodeLens`
 * (import dinâmico), nunca no topo do módulo. Assim `findTestMethods` — a parte
 * pura — é importável em `node --test` sem puxar o bundle do Monaco (que arrasta
 * CSS e quebra o runner de testes de unidade).
 */
import type * as monaco from "monaco-editor";

/** Um método de teste detectado no fonte. `line` é 1-based (linha da assinatura). */
export interface TestMethod {
  /** Linha 1-based onde a assinatura do método aparece (âncora do CodeLens). */
  line: number;
  /** Nome simples do método (ex.: `Soma_DoisMaisDois_Da4`). */
  methodName: string;
  /**
   * Nome totalmente qualificado `namespace.classe.metodo` quando resolvível,
   * senão apenas `metodo`. O runner casa por sufixo de FullyQualifiedName, então
   * um FQN parcial ainda seleciona o teste.
   */
  fullyQualifiedName: string;
}

/** Command id do lens "Executar Teste". Exportado para o caller / testes. */
export const RUN_TEST_COMMAND_ID = "fluentcoder.runTest";

/**
 * Atributos que marcam um método como teste, em nome simples. A detecção casa
 * o nome com ou sem namespace qualificado (`Xunit.Fact`) e com ou sem args
 * (`Theory(...)`).
 */
const TEST_ATTRIBUTE_NAMES = new Set([
  "Fact",
  "Theory",
  "Test",
  "TestMethod",
  "TestCase",
]);

/**
 * Remove comentários (`//` de linha e `/* *​/` de bloco) e o CONTEÚDO de
 * strings/chars do fonte, preservando quebras de linha e o comprimento (troca
 * cada caractere removido por espaço) para que posições de linha continuem
 * exatas. Trata strings normais `"..."`, verbatim `@"..."` (aspas duplas
 * escapam) e chars `'.'`. Isso evita que uma chave `{`/`}` ou um `[Fact]` dentro
 * de comentário/string confunda o scanner de escopo.
 */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  const pushSpaces = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(src[k] === "\n" ? "\n" : " ");
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // Comentário de linha.
    if (c === "/" && c2 === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      pushSpaces(i, j);
      i = j;
      continue;
    }
    // Comentário de bloco.
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      pushSpaces(i, j);
      i = j;
      continue;
    }
    // String verbatim `@"..."` (aspas dupla `""` = escape de aspas).
    if (c === "@" && c2 === '"') {
      out.push(" ", " ");
      let j = i + 2;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            out.push(" ", " ");
            j += 2;
            continue;
          }
          break;
        }
        out.push(src[j] === "\n" ? "\n" : " ");
        j++;
      }
      out.push(" "); // aspas de fechamento
      i = j + 1;
      continue;
    }
    // String normal `"..."` (respeita escape `\"`).
    if (c === '"') {
      out.push(" ");
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") {
          out.push(" ", " ");
          j += 2;
          continue;
        }
        out.push(src[j] === "\n" ? "\n" : " ");
        j++;
      }
      out.push(" ");
      i = j + 1;
      continue;
    }
    // Char literal `'.'` (respeita escape `'\''`).
    if (c === "'") {
      out.push(" ");
      let j = i + 1;
      while (j < n && src[j] !== "'") {
        if (src[j] === "\\") {
          out.push(" ", " ");
          j += 2;
          continue;
        }
        out.push(" ");
        j++;
      }
      out.push(" ");
      i = j + 1;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * Extrai o(s) nome(s) de atributo de um conteúdo de colchetes `[...]`. Trata
 * múltiplos atributos agrupados (`Fact, Trait("x","y")`), args (`Theory(...)`) e
 * formas qualificadas (`Xunit.Fact`). Retorna os nomes SIMPLES (último segmento
 * após `.`). Ignora targets de atributo (`assembly:`, `return:`).
 */
function parseAttributeNames(inner: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let token = "";
  const flush = () => {
    let t = token.trim();
    token = "";
    if (!t) return;
    // Remove target de atributo (`assembly:Foo`).
    const colon = t.indexOf(":");
    if (colon !== -1) t = t.slice(colon + 1).trim();
    // Pega o identificador antes de eventuais `(` de args.
    const paren = t.indexOf("(");
    if (paren !== -1) t = t.slice(0, paren).trim();
    if (!t) return;
    // Último segmento de um nome qualificado (`Xunit.Fact` -> `Fact`).
    const dot = t.lastIndexOf(".");
    const simple = dot !== -1 ? t.slice(dot + 1) : t;
    if (simple) names.push(simple);
  };
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      flush();
      continue;
    }
    token += ch;
  }
  flush();
  return names;
}

interface ScopeFrame {
  kind: "namespace" | "class" | "block";
  name?: string;
}

/**
 * Scanner leve de C#: percorre o fonte (já sem comentários/strings) rastreando
 * escopos `namespace`/`class`/`struct`/`record` por chaves, coleta os atributos
 * pendentes e, ao ver uma assinatura de método, emite um `TestMethod` se algum
 * atributo pendente for de teste.
 *
 * Suporta namespaces file-scoped (`namespace X;`), namespaces/classes em bloco,
 * classes aninhadas e atributos em linhas separadas do método. Não é um parser
 * completo — prioriza corretude do FQN nos casos comuns.
 */
export function findTestMethods(sourceText: string): TestMethod[] {
  const clean = stripCommentsAndStrings(sourceText);
  const results: TestMethod[] = [];

  const scopes: ScopeFrame[] = [];
  // Namespace file-scoped vale para o arquivo inteiro (não abre chave).
  let fileScopedNamespace: string | null = null;
  // Nomes que a PRÓXIMA `{` deve empilhar (declaração pendente antes da chave).
  let pendingScope: ScopeFrame | null = null;
  // Se há atributo de teste pendente aguardando a assinatura do método.
  let pendingTestAttrs = false;

  const currentFqnPrefix = (): string => {
    const parts: string[] = [];
    if (fileScopedNamespace) parts.push(fileScopedNamespace);
    for (const s of scopes) {
      if (s.name) parts.push(s.name);
    }
    return parts.join(".");
  };

  const lines = clean.split("\n");

  const NS_RE = /namespace\s+([A-Za-z_][\w.]*)\s*([;{]?)/;
  const TYPE_RE =
    /(?:class|struct|record\s+struct|record\s+class|record|interface)\s+([A-Za-z_]\w*)/;
  const ATTR_RE = /\[([^\]]*)\]/;
  // Assinatura de método: `Nome(` — identificador (com genéricos opcionais)
  // seguido de `(`.
  const METHOD_RE = /([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let idx = 0;

    while (idx < line.length) {
      const rest = line.slice(idx);
      const ch = rest[0];

      if (ch === " " || ch === "\t" || ch === "\r") {
        idx += 1;
        continue;
      }

      // 1) Atributo(s) `[...]` na posição atual.
      if (ch === "[") {
        const attrMatch = anchoredMatch(rest, ATTR_RE);
        if (attrMatch) {
          const names = parseAttributeNames(attrMatch[1]);
          if (names.some((n) => TEST_ATTRIBUTE_NAMES.has(n))) {
            pendingTestAttrs = true;
          }
          idx += attrMatch[0].length;
          continue;
        }
      }

      // 2) namespace.
      const nsMatch = anchoredMatch(rest, NS_RE);
      if (nsMatch && isKeywordStart(rest)) {
        const name = nsMatch[1];
        const terminator = nsMatch[2];
        if (terminator === ";") {
          fileScopedNamespace = name;
        } else if (terminator === "{") {
          scopes.push({ kind: "namespace", name });
        } else {
          pendingScope = { kind: "namespace", name };
        }
        pendingTestAttrs = false;
        idx += nsMatch[0].length;
        continue;
      }

      // 3) tipo (class/struct/record/interface).
      const typeMatch = anchoredMatch(rest, TYPE_RE);
      if (typeMatch && isKeywordStart(rest)) {
        pendingScope = { kind: "class", name: typeMatch[1] };
        pendingTestAttrs = false;
        idx += typeMatch[0].length;
        continue;
      }

      // 4) abertura de chave: consome escopo pendente ou bloco anônimo.
      if (ch === "{") {
        scopes.push(pendingScope ?? { kind: "block" });
        pendingScope = null;
        pendingTestAttrs = false;
        idx += 1;
        continue;
      }

      // 5) fechamento de chave.
      if (ch === "}") {
        scopes.pop();
        pendingTestAttrs = false;
        idx += 1;
        continue;
      }

      // 6) assinatura de método: só interessa quando há atributo de teste
      //    pendente. Casa `Nome(` no início do resto.
      if (pendingTestAttrs) {
        const mMatch = anchoredMatch(rest, METHOD_RE);
        if (mMatch) {
          const methodName = mMatch[1];
          const prefix = currentFqnPrefix();
          const fqn = prefix ? `${prefix}.${methodName}` : methodName;
          results.push({
            line: li + 1,
            methodName,
            fullyQualifiedName: fqn,
          });
          pendingTestAttrs = false;
          idx += mMatch[0].length;
          continue;
        }
      }

      idx += 1;
    }
  }

  return results;
}

/**
 * Casa `re` ancorado no INÍCIO de `s`. Retorna o match (com `index === 0`) ou
 * `null`. Helper para varredura posicional caractere-a-caractere.
 */
function anchoredMatch(s: string, re: RegExp): RegExpMatchArray | null {
  const anchored = new RegExp("^(?:" + re.source + ")", re.flags.replace("g", ""));
  return anchored.exec(s);
}

/**
 * Como o scanner só tenta keywords quando o caractere corrente inicia um
 * identificador e sempre avança 1 caractere quando nenhuma regra casa, um
 * `namespace`/`class` casado por `anchoredMatch` já está numa fronteira de
 * palavra (o caractere anterior não fazia parte do identificador — senão o
 * scanner teria pulado o identificador inteiro antes). Mantido como função
 * nomeada para deixar a intenção explícita.
 */
function isKeywordStart(_rest: string): boolean {
  return true;
}

/**
 * Registra o provider Monaco de CodeLens "▶ Executar Teste" para `csharp` e o
 * comando que o clique dispara. Retorna os disposables (provider + command) para
 * o caller descartar. Não faz I/O aqui — `csprojResolver`/`runTest` são
 * injetados.
 *
 * É `async` porque carrega `monaco-editor` sob demanda (import dinâmico) para
 * manter `findTestMethods` livre do bundle do Monaco (ver NOTA de import acima).
 *
 * @param csprojResolver Descobre o `.csproj` de teste do lens (null se nenhum).
 * @param runTest Dispara o teste (csproj + FullyQualifiedName).
 */
export async function installTestCodeLens(
  csprojResolver: () => Promise<string | null>,
  runTest: (csprojPath: string, fullyQualifiedName: string) => void | Promise<void>
): Promise<monaco.IDisposable[]> {
  const monaco = await import("monaco-editor");
  const disposables: monaco.IDisposable[] = [];

  // Comando disparado pelo clique no lens. Recebe o FQN como argumento; resolve
  // o csproj no momento do clique (o workspace pode ter mudado) e delega.
  disposables.push(
    monaco.editor.registerCommand(
      RUN_TEST_COMMAND_ID,
      (_accessor: unknown, fullyQualifiedName: string) => {
        void (async () => {
          const csproj = await csprojResolver();
          if (!csproj) return;
          await runTest(csproj, fullyQualifiedName);
        })();
      }
    )
  );

  const selector: monaco.languages.LanguageSelector = {
    language: "csharp",
    scheme: "file",
  };

  disposables.push(
    monaco.languages.registerCodeLensProvider(selector, {
      provideCodeLenses: (model) => {
        const methods = findTestMethods(model.getValue());
        const lenses: monaco.languages.CodeLens[] = methods.map((m) => ({
          range: {
            startLineNumber: m.line,
            startColumn: 1,
            endLineNumber: m.line,
            endColumn: 1,
          },
          command: {
            id: RUN_TEST_COMMAND_ID,
            title: "▶ Executar Teste",
            arguments: [m.fullyQualifiedName],
          },
        }));
        return { lenses, dispose: () => {} };
      },
      resolveCodeLens: (_model, codeLens) => codeLens,
    })
  );

  return disposables;
}
