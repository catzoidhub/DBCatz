/** Obvious secrets in text: auth headers, bearer tokens and JWTs, passwords and tokens in quotes, IDENTIFIED BY, AUTH, URLs with a password. */
export function maskSecrets(text: string): string {
  return text
    // First: the name=value rule below would take only the word after the name. A quoted value ends at its quote, any other at the end of the line.
    .replace(/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\n]*)/gi, '$1$2•••')
    // A scheme and its credentials, wherever they stand. Needs a digit, a sign or mixed case, so "basic information" stays.
    .replace(/\b(bearer|basic|token|digest)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi, (m, scheme: string, gap: string, value: string) => (/[0-9._~+/=-]|[a-z][A-Z]/.test(value) ? `${scheme}${gap}•••` : m))
    // A JWT, with or without a name.
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '•••')
    // IDENTIFIED BY 'x', PASSWORD 'x', AUTH x (Redis): the value right after the word.
    .replace(/\b(IDENTIFIED\s+(?:WITH\s+\S+\s+)?BY|PASSWORD|AUTH)(\s+)('[^']*'|"[^"]*"|(?![=:])\S+)/gi, '$1$2•••')
    .replace(/\b(\w*(?:pass(?:word)?|secret|token|api_?key)\w*)(["']?\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,)]+)/gi, '$1$2•••')
    .replace(/(\w+:\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1•••@')
    .replace(/\b(sk|pk|rk|ghp|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{10,}/g, '•••');
}
