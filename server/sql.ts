import { ConnectionError } from '../src/shared/connection';
import type { Engine } from '../src/shared/connection';

export function assertIdent(value: unknown, label = 'Name'): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 64 || /\p{Cc}/u.test(value)) {
    throw new ConnectionError(`${label} must be 1–64 characters without control characters.`);
  }
  return value;
}

export function quoteIdent(value: string, engine: Engine): string {
  const name = assertIdent(value);
  if (engine === 'mysql') return `\`${name.replaceAll('`', '``')}\``;
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const systemMysql = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
const systemPostgres = new Set(['template0', 'template1']);

export function userCatalog(engine: Engine, value: unknown): string {
  const name = assertIdent(value, 'Database');
  if (engine === 'mysql' && systemMysql.has(name.toLowerCase())) throw new ConnectionError('System databases are not managed here.');
  if (engine === 'postgres' && systemPostgres.has(name)) throw new ConnectionError('Template databases are not managed here.');
  return name;
}

export function pgTable(value: string): { schema: string; name: string } {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return { schema: 'public', name: value };
  return { schema: value.slice(0, dot), name: value.slice(dot + 1) };
}

export function splitStatements(sql: string, sqlite: boolean): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    const next = sql[i + 1];
    if ((char === '-' && next === '-' && (sqlite || !sql[i + 2] || /\s/.test(sql[i + 2]))) || (!sqlite && char === '#')) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i++;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new ConnectionError('SQL comment was not closed.');
      i = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || (sqlite && char === '[')) {
      const end = char === '[' ? ']' : char;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (!sqlite && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === end) {
          if (sql[i + 1] === end) { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new ConnectionError('SQL text was not closed.');
      continue;
    }
    if (char === '(') { depth++; i++; continue; }
    if (char === ')') {
      if (--depth < 0) throw new ConnectionError('SQL has an extra closing parenthesis.');
      i++;
      continue;
    }
    if (char === ';' && depth === 0) {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  if (depth) throw new ConnectionError('SQL has an unclosed parenthesis.');
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
