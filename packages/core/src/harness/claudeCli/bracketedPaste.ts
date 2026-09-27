const ESC = '\x1b';

// Bracketed paste tells Claude Code's terminal reader to treat everything between these two sequences as
// one pasted blob instead of running its own paste-detection heuristic, which loses a contiguous span of a
// long, unframed single write once node-pty's tty queue splits it into more than one kernel-level write
// (measured: consistently reproducible past ~1KB). The body's own ESC bytes are stripped first: left in,
// an embedded paste-end sequence (literal "ESC[201~") would close the paste early and spill the rest of
// the body onto the terminal as ordinary keystrokes, submitting whatever follows a stray '\r'.
export function frameForPaste(body: string): string {
  const withoutEscapeBytes = body.replaceAll(ESC, '');
  return `${ESC}[200~${withoutEscapeBytes}${ESC}[201~`;
}
