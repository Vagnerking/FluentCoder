import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode } from "../../agents/codeHighlight";
import { parseFileRef, resolveWorkspacePath } from "../../agents/fileRef";
import { tokenizeInline } from "../../agents/inlineCode";

/** Extrai o texto puro dos filhos de um nó `code` do markdown. */
function markdownText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" ? child : ""))
    .join("");
}

/**
 * Bloco de código cercado com realce de sintaxe (Shiki, tema Dark+ — as mesmas
 * cores do editor). O realce é assíncrono: até chegar (ou quando a linguagem
 * não tem grammar), o bloco renderiza plano com a mesma moldura, sem salto de
 * layout. O guard de sequência garante que um realce atrasado de um conteúdo
 * antigo nunca sobrescreva o mais recente durante o streaming.
 */
function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    let alive = true;
    void highlightCode(code, lang).then((result) => {
      if (alive && seqRef.current === seq) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="agent-code-block fc-code-block">
      <div className="fc-code-toolbar">
        <span className="fc-code-lang">{lang ?? "texto"}</span>
        <button type="button" className="fc-code-copy" onClick={copy} aria-label="Copiar código">
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      {html ? (
        // HTML gerado pelo Shiki a partir do texto do bloco (escapado) — não é
        // HTML vindo do LLM, então é seguro injetar.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * Markdown de uma resposta do agente (react-markdown + GFM, SEM HTML cru: o
 * conteúdo é saída de LLM não confiável). `code` inline que parece caminho de
 * arquivo vira botão que abre no editor; blocos cercados ganham realce.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  onOpenFile,
  workspacePath,
}: {
  content: string;
  onOpenFile: (path: string, line?: number) => void;
  workspacePath: string | null;
}) {
  return (
    <div className="agent-message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, children, ...props }) => {
            const ref = href ? parseFileRef(href) : null;
            if (ref) {
              return (
                <button
                  type="button"
                  className="agent-file-link"
                  title={`Abrir ${ref.path}`}
                  onClick={() => onOpenFile(resolveWorkspacePath(workspacePath, ref.path), ref.line)}
                >
                  {children}
                </button>
              );
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          table: ({ node: _node, children, ...props }) => (
            <div className="agent-table-wrap">
              <table {...props}>{children}</table>
            </div>
          ),
          pre: ({ node: _node, children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            if (isValidElement(child)) {
              const props = child.props as { className?: string; children?: ReactNode };
              const lang = /language-([\w#+.-]+)/.exec(props.className ?? "")?.[1] ?? null;
              return <CodeBlock code={markdownText(props.children).replace(/\n$/, "")} lang={lang} />;
            }
            return <pre>{children}</pre>;
          },
          code: ({ node: _node, className, children, ...props }) => {
            const raw = String(children);
            const ref = !className ? parseFileRef(raw) : null;
            if (ref) {
              return (
                <button
                  type="button"
                  className="agent-file-link code"
                  title={`Abrir ${ref.path}`}
                  onClick={() => onOpenFile(resolveWorkspacePath(workspacePath, ref.path), ref.line)}
                >
                  {children}
                </button>
              );
            }
            if (!className) {
              return (
                <code {...props}>
                  {tokenizeInline(raw).map((token, index) =>
                    token.kind === "plain" ? (
                      token.text
                    ) : (
                      <span key={index} className={`tok-${token.kind}`}>
                        {token.text}
                      </span>
                    ),
                  )}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
