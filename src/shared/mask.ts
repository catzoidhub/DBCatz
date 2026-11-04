/** Obvious secrets in logged statements: passwords and tokens in quotes, IDENTIFIED BY, AUTH, URLs with a password. */
export function maskSecrets(text: string): string {
  return text
    // IDENTIFIED BY 'x', PASSWORD 'x', AUTH x (Redis): the value right after the word.
    .replace(/\b(IDENTIFIED\s+(?:WITH\s+\S+\s+)?BY|PASSWORD|AUTH)(\s+)('[^']*'|"[^"]*"|(?![=:])\S+)/gi, '$1$2•••')
    .replace(/\b(\w*(?:pass(?:word)?|secret|token|api_?key)\w*)(["']?\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,)]+)/gi, '$1$2•••')
    .replace(/(\w+:\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1•••@')
    .replace(/\b(sk|pk|rk|ghp|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{10,}/g, '•••');
}
