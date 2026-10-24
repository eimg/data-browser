import type { QueryResult } from './types';

// Label results without changing execution. Ambiguous scripts (CALL, stored
// programs, SQL-mode changes) retain generic counts instead of guessing which
// statement produced a result set.
function statementTokens(sql: string, sqlite: boolean): string[][] | null {
  const statements: string[][] = [];
  let tokens: string[] = [], depth = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i], next = sql[i + 1];
    if ((c === '-' && next === '-' && (sqlite || !sql[i + 2] || /\s/.test(sql[i + 2]))) || (!sqlite && c === '#')) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i++;
    } else if (c === '/' && next === '*') {
      if (sql[i + 2] === '!' || sql.slice(i + 2, i + 4) === 'M!') return null;
      const end = sql.indexOf('*/', i + 2); if (end < 0) return null;
      i = end + 2;
    } else if (["'", '"', '`', ...(sqlite ? ['['] : [])].includes(c)) {
      const end = c === '[' ? ']' : c;
      let closed = false; i++;
      while (i < sql.length) {
        if (!sqlite && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === end) {
          if (sql[i + 1] === end) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return null;
    } else if (c === '(') { depth++; i++; }
    else if (c === ')') { if (--depth < 0) return null; i++; }
    else if (c === ';' && depth === 0) {
      if (tokens.length) statements.push(tokens);
      tokens = []; i++;
    } else if (/[a-z_]/i.test(c)) {
      const start = i++;
      while (i < sql.length && /[a-z0-9_$]/i.test(sql[i])) i++;
      if (!depth) tokens.push(sql.slice(start, i).toUpperCase());
    } else i++;
  }
  if (depth) return null;
  if (tokens.length) statements.push(tokens);
  if (statements.some(tokens => tokens[0] === 'CALL' || tokens[0] === 'DELIMITER' ||
      tokens[0] === 'CREATE' && tokens.some(token => ['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT'].includes(token)) ||
      tokens[0] === 'SET' && tokens.includes('SQL_MODE'))) return null;
  return statements;
}

export function summarizeQueryResults(sql: string, result: QueryResult, sqlite = false): QueryResult {
  const statements = statementTokens(sql, sqlite);
  const aligned = statements && (statements.length === result.sets.length || result.resultsTruncated && statements.length > result.sets.length);
  return { ...result, sets: result.sets.map((set, index) => {
    const tokens = aligned ? statements[index] : [];
    const verb = tokens[0] === 'WITH' ? tokens.find(token => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(token)) : tokens[0];
    let action = verb === 'INSERT' ? 'inserted' : verb === 'UPDATE' ? sqlite ? 'matched for update' : 'updated' : verb === 'DELETE' ? 'deleted' : null;
    if (verb === 'INSERT' && (tokens.includes('DUPLICATE') || tokens.includes('CONFLICT') || tokens.includes('REPLACE'))) action = null;
    const count = set.columns.length ? set.rows.length : set.affected;
    const rows = `${count} ${count === 1 ? 'row' : 'rows'}`;
    let summary: string;
    if (set.columns.length) summary = `${rows} returned`;
    else if (action) summary = `${rows} ${action}`;
    else if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'SET', 'USE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'VACUUM'].includes(verb ?? '') || count <= 0) summary = 'Statement completed';
    else summary = `${rows} affected`;
    return { ...set, summary };
  }) };
}
