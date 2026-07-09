/**
 * Remapeamento de semantic tokens do `.g.cs` projetado de volta para o `.cshtml`
 * (milestone #7). Puro (sem monaco) para testar em `node --test`.
 *
 * O LSP entrega semantic tokens como um stream de 5 uints por token, RELATIVO
 * (deltaLine, deltaStart, length, tokenType, tokenModifiers). Para remapear
 * gen→source por token precisamos: (1) decodificar para posições ABSOLUTAS no
 * `.g.cs`; (2) remapear cada range com o mapeador STRICT (descartando tokens em
 * C# sintético — contrato: nada nasce de texto sintético); (3) reordenar por
 * posição no `.cshtml` (o remap não preserva ordem monotônica) e (4) recodificar
 * como stream relativo em coords do `.cshtml`, pronto para
 * `applySemanticTokenDecorations`.
 */

/** Um token absoluto (0-based line/char), antes/depois do remap. */
export interface AbsToken {
  line: number;
  char: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

/** Decodifica o stream relativo LSP em tokens absolutos (0-based). */
export function decodeTokens(data: readonly number[]): AbsToken[] {
  const out: AbsToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    line += deltaLine;
    char = deltaLine === 0 ? char + data[i + 1] : data[i + 1];
    out.push({
      line,
      char,
      length: data[i + 2],
      tokenType: data[i + 3],
      tokenModifiers: data[i + 4],
    });
  }
  return out;
}

/** Recodifica tokens absolutos (já ORDENADOS por posição) no stream relativo. */
export function encodeTokens(tokens: readonly AbsToken[]): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const t of tokens) {
    const deltaLine = t.line - prevLine;
    const deltaChar = deltaLine === 0 ? t.char - prevChar : t.char;
    data.push(deltaLine, deltaChar, t.length, t.tokenType, t.tokenModifiers);
    prevLine = t.line;
    prevChar = t.char;
  }
  return data;
}

/** Um range de token para remapear (0-based, meio-aberto). */
export interface TokenRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Range remapeado no `.cshtml` (0-based), ou null se caiu em sintético. */
export type RemappedRange = { start: { line: number; character: number }; end: { line: number; character: number } } | null;

/**
 * Remapeia tokens do `.g.cs` para o `.cshtml`: decodifica, remapeia cada range
 * com `remapRanges` (batch strict), descarta os não-mapeáveis, reordena por
 * posição no `.cshtml` e recodifica. `remapRanges` deve preservar a ordem de
 * entrada (índice i da entrada ↔ índice i da saída), com null para descartados.
 * A largura do token no `.cshtml` vem do range remapeado (mesma linha assumida;
 * tokens que cruzam múltiplas linhas no source são descartados por segurança).
 */
export async function remapSemanticTokens(
  data: readonly number[],
  legend: { tokenTypes: string[] },
  remapRanges: (ranges: TokenRange[]) => Promise<RemappedRange[]>
): Promise<number[]> {
  const abs = decodeTokens(data);
  if (abs.length === 0) return [];
  const ranges: TokenRange[] = abs.map((t) => ({
    start: { line: t.line, character: t.char },
    end: { line: t.line, character: t.char + t.length },
  }));
  const mapped = await remapRanges(ranges);
  const out: AbsToken[] = [];
  for (let i = 0; i < abs.length; i++) {
    const r = mapped[i];
    if (!r) continue; // synthetic C# — drop
    if (r.start.line !== r.end.line) continue; // multi-line remap — drop (unsafe width)
    const length = r.end.character - r.start.character;
    if (length <= 0) continue;
    // Só emite tokens cujo tipo tem nome na legenda (senão o painter ignora).
    if (!legend.tokenTypes[abs[i].tokenType]) continue;
    out.push({
      line: r.start.line,
      char: r.start.character,
      length,
      tokenType: abs[i].tokenType,
      tokenModifiers: abs[i].tokenModifiers,
    });
  }
  // O remap não preserva ordem: reordena por (linha, coluna) antes de recodificar.
  out.sort((a, b) => a.line - b.line || a.char - b.char);
  return encodeTokens(out);
}
