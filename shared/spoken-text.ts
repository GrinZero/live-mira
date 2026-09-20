// Stateful so split, nested and unfinished stage directions never leak on screen.
export function stripStage(text: string): string {
  let depth = 0;
  let spoken = '';
  for (const char of text) {
    if ('（(【'.includes(char)) depth++;
    else if ('）)】'.includes(char)) depth = Math.max(0, depth - 1);
    else if (!depth) spoken += char;
  }
  return spoken.trim();
}
