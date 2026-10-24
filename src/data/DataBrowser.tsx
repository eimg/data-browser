import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Code2, Eye, FolderOpen, Link2, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { cancelData, connect, currentSession, dataRequest, disconnect } from '../api';
import { connectionLostMessage, engineLabel, isConnectionLost, LostConnection, type Engine, type SessionInfo } from '../shared/connection';
import ConnectCard from './ConnectCard';
import Dialog from './Dialog';
import ColumnFields from './ColumnFields';
import RowFields, { initialInsertValues } from './RowFields';
import RowViewer from './RowViewer';
import { largeField, type CellChunk, type ReadCell } from './row-values';
import TableWorkspace from './TableWorkspace';
import ActionMenu from './ActionMenu';
import HelpTip from '../HelpTip';
import Workspace from '../Workspace';
import IndexFields, { indexableColumns, suggestedIndexName, type IndexDefinition } from './IndexFields';
import SchemaDetails from './SchemaDetails';
import ForeignKeyExamples from './ForeignKeyExamples';
import SqlBlock from './SqlBlock';
import { summarizeQueryResults } from './query-results';
import { editableColumn, fromColumn, newColumn, type Column, type Definition, type LargeFields, type RowRef, type Page, type QueryResult, type Row, type Structure, type Table, type TableIndex } from './types';
import './data.css';

type EditKind = 'import_sql' | 'create_database' | 'rename_database' | 'drop_database' | 'create_table' | 'rename_table' | 'drop_table' | 'add_column' | 'change_column' | 'drop_column' | 'create_index' | 'drop_index' | 'insert' | 'update' | 'delete';
type Edit = { kind: EditKind; path?: string; row?: Row; column?: Column; index?: TableIndex; rowRef?: RowRef; largeFields?: LargeFields };
const titles: Record<EditKind, string> = { import_sql: 'Import SQL', create_database: 'Create database', rename_database: 'Rename database', drop_database: 'Delete database', create_table: 'Create table', rename_table: 'Rename table', drop_table: 'Delete table', add_column: 'Add column', change_column: 'Edit column', drop_column: 'Delete column', create_index: 'Create index', drop_index: 'Remove index', insert: 'Insert row', update: 'Edit row', delete: 'Delete row' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const idColumn = (): Definition => ({ ...newColumn('id'), type: 'BIGINT', nullable: false, primary: true, autoIncrement: true });
const cell = (value: string | null) => value === null ? <span className="db-null">NULL</span> : value === '' ? <span className="db-null">empty</span> : value;
type Source = { driver: 'postgres' } | { driver: 'mysql' } | { driver: 'sqlite'; path: string | null };
const recentKey = 'data-browser.sqlite.recent.v1';
const fileName = (path: string) => path.split(/[/\\]/).pop() || path;
type BackupFile = { name: string; path: string; kind: 'sqlite' | 'sql' | 'other'; bytes: number; modified: string };
type BackupList = { directory: string; files: BackupFile[]; truncated: boolean };
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const formatWhen = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(); };
const backupKind = (kind: BackupFile['kind']) => kind === 'sqlite' ? 'SQLite copy' : kind === 'sql' ? 'SQL snapshot' : 'File';
function recentFiles(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]');
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string' && path.length > 0).slice(0, 6) : [];
  } catch { return []; }
}

const exampleSql = (driver: Source['driver']) => driver === 'sqlite' ? 'SELECT sqlite_version();' : driver === 'postgres' ? 'SELECT version();' : 'SELECT VERSION();';

export default function DataBrowser() {
  const [source, setSource] = useState<Source>({ driver: 'postgres' });
  const [connections, setConnections] = useState<SessionInfo[] | null>(null);
  const [sqliteDraft, setSqliteDraft] = useState('');
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [backupList, setBackupList] = useState<BackupList | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const selectedSource = useRef(source);
  const [recent, setRecent] = useState(recentFiles);
  const sqlite = source.driver === 'sqlite';
  const postgres = source.driver === 'postgres';
  const sqlitePath = sqlite ? source.path : null;
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const engineReady = (driver: Exclude<Engine, 'sqlite'>) => connectionsRef.current?.some(item => item.engine === driver) ?? false;
  const available = sqlite ? !!sqlitePath : engineReady(source.driver);
  const [databases, setDatabases] = useState<string[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [database, setDatabase] = useState('');
  const [tables, setTables] = useState<Table[]>([]);
  const [table, setTable] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [pane, setPane] = useState<'rows' | 'structure' | 'query'>('rows');
  const [pending, setPending] = useState<string | null>(null);
  const [importPhase, setImportPhase] = useState<'working' | 'backup' | 'import' | 'canceling' | 'refreshing' | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [foreignKeyExamples, setForeignKeyExamples] = useState<'create' | 'structure' | null>(null);
  const [tableSql, setTableSql] = useState<{ table: string; sql: string } | null>(null);
  const [viewedRow, setViewedRow] = useState<{ row: Row; columns: Column[]; table: string; database: string; source: Source; position: number; rowRef?: RowRef; largeFields?: LargeFields } | null>(null);
  const [name, setName] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [fieldLoading, setFieldLoading] = useState(false);
  const [values, setValues] = useState<Row>({});
  const [indexDefinition, setIndexDefinition] = useState<IndexDefinition>({ name: '', unique: false, columns: [] });
  const [sort, setSort] = useState({ sort: '', direction: 'ASC' });
  const [sql, setSql] = useState(exampleSql('postgres'));
  const [query, setQuery] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const editor = useRef<HTMLTextAreaElement>(null);
  const active = useRef(false);
  const activeTask = useRef<Promise<void> | null>(null);
  const job = useRef<string | null>(null);
  const mounted = useRef(false);
  const restoreRecent = useRef(true);
  const operationFocus = useRef<HTMLElement | null>(null);
  const rowsScroll = useRef<HTMLDivElement>(null);
  const serverSelection = useRef({ postgres: { database: '', table: '' }, mysql: { database: '', table: '' } });
  const [rowsHeight, setRowsHeight] = useState<number>();
  const browsing = !!pending && /^(Loading|Refreshing|Sorting) /.test(pending);
  const [showPending, setShowPending] = useState(false);
  const blocked = !!pending && !browsing;
  const writable = page?.kind === 'BASE TABLE';
  const canEdit = writable && !!page?.key.length;

  async function request<T>(body: Record<string, unknown>, targetSource = source, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const id = crypto.randomUUID(); job.current = id;
    const cancel = () => { void cancelData(id).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try { return await dataRequest<T>(id, { ...body, ...targetSource }); }
    catch (error) {
      if (isConnectionLost(error, targetSource.driver)) {
        dropEngine(targetSource.driver);
        throw new LostConnection();
      }
      throw error;
    }
    finally { signal?.removeEventListener('abort', cancel); if (job.current === id) job.current = null; }
  }
  function cellReader(db: string, tbl: string, target: Source, rowRef?: RowRef): ReadCell | undefined {
    return rowRef ? (column, offset, signal) => request<CellChunk>({ op: 'cell', database: db, table: tbl, rowRef, column, offset }, target, signal) : undefined;
  }
  async function run(label: string, action: () => Promise<void>) {
    if (active.current) return;
    operationFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    active.current = true; setPending(label); setNotice(null);
    const task = (async () => {
      try { await action(); }
      catch (error) { if (mounted.current) setNotice({ error: true, text: errorText(error) }); }
      finally { active.current = false; setPending(null); }
    })();
    activeTask.current = task;
    await task;
    if (activeTask.current === task) activeTask.current = null;
  }
  async function loadRows(db: string, selected: string, offset = 0, order = sort) {
    if (!selected) { setPage(null); return; }
    const result = await request<Page>({ op: 'rows', database: db, table: selected, offset, ...(order.sort ? order : {}) });
    setPage(result);
  }
  async function load(preferredDb?: string, preferredTable?: string, targetSource = source) {
    const memory = targetSource.driver === 'postgres' || targetSource.driver === 'mysql' ? serverSelection.current[targetSource.driver] : null;
    const wantedDb = preferredDb ?? (database || memory?.database || '');
    const wantedTable = preferredTable ?? (table || memory?.table || '');
    const list = await request<{ databases: string[] }>({ op: 'databases' }, targetSource);
    const db = list.databases.includes(wantedDb) ? wantedDb : (list.databases[0] ?? '');
    const result = db ? await request<{ tables: Table[] }>({ op: 'tables', database: db }, targetSource) : { tables: [] };
    const selected = result.tables.find(t => t.name === wantedTable)?.name ?? result.tables[0]?.name ?? '';
    let nextPage: Page | null = null;
    let nextStructure: Structure | null = null;
    let failure: string | null = null;
    try {
      if (selected) {
        nextPage = await request<Page>({ op: 'rows', database: db, table: selected, offset: 0 }, targetSource);
        nextStructure = await request<Structure>({ op: 'structure', database: db, table: selected }, targetSource);
      }
    } catch (error) {
      if (!mounted.current || isConnectionLost(error)) throw error;
      nextPage = null; nextStructure = null;
      failure = errorText(error);
    }
    // A table failure must not hide the catalog or SQL repair tools. Publish
    // the new selection with empty data rather than pairing it with old rows.
    if (db !== database) setQuery(null);
    setDatabases(list.databases); setDatabase(db); setTables(result.tables);
    setTable(selected); setPage(nextPage); setStructure(nextStructure);
    setTableError(failure);
    setCatalogLoaded(true);
    setSort({ sort: '', direction: 'ASC' });
    if (targetSource.driver === 'postgres' || targetSource.driver === 'mysql') serverSelection.current[targetSource.driver] = { database: db, table: selected };
  }
  function remember(paths: string[]) {
    setRecent(paths);
    try { localStorage.setItem(recentKey, JSON.stringify(paths)); } catch { /* Browsing still works without local storage. */ }
  }
  async function switchSource(next: Source) {
    const previous = selectedSource.current;
    selectedSource.current = next;
    try {
      if (next.driver === 'sqlite' && next.path) {
        const current = connectionsRef.current?.find(item => item.engine === 'sqlite');
        if (current?.database !== next.path) {
          const info = await connect({ engine: 'sqlite', path: next.path });
          const nextConnections = [...(connectionsRef.current ?? []).filter(item => item.engine !== 'sqlite'), info];
          connectionsRef.current = nextConnections;
          setConnections(nextConnections);
          next = { driver: 'sqlite', path: info.database };
          selectedSource.current = next;
        }
      }
      const opened = next.driver === 'sqlite' ? next.path : null;
      const connected = next.driver === 'sqlite' ? !!opened : engineReady(next.driver);
      if (!connected) {
        setDatabases([]); setDatabase(''); setTables([]); setTable(''); setPage(null); setStructure(null); setCatalogLoaded(false);
        setTableError(null);
      } else await load(next.driver === 'sqlite' ? '' : serverSelection.current[next.driver].database, next.driver === 'sqlite' ? '' : serverSelection.current[next.driver].table, next);
      setSource(next); setPane('rows'); setQuery(null); setHistory([]);
      setSql(exampleSql(next.driver));
      if (opened) {
        restoreRecent.current = true;
        remember([opened, ...recent.filter(path => path !== opened)].slice(0, 6));
      }
    } catch (error) {
      if (!isConnectionLost(error)) selectedSource.current = previous;
      throw error;
    }
  }
  function selectDriver(next: Source) {
    if (next.driver === source.driver && (next.driver !== 'sqlite' || next.path === (source.driver === 'sqlite' ? source.path : null))) return;
    void run('Loading database…', () => switchSource(next));
  }
  async function connectEngine(input: Parameters<typeof connect>[0]) {
    const info = await connect(input);
    const nextConnections = [...(connectionsRef.current ?? []).filter(item => item.engine !== info.engine), info];
    connectionsRef.current = nextConnections;
    setConnections(nextConnections);
    if (input.engine === 'sqlite') await switchSource({ driver: 'sqlite', path: info.database });
    else {
      serverSelection.current[input.engine] = { database: info.database, table: '' };
      await switchSource({ driver: input.engine });
    }
  }
  async function openSqlite(path: string) {
    if (!path) { setNotice({ error: true, text: 'Database file is required.' }); return; }
    await run('Opening SQLite file…', () => connectEngine({ engine: 'sqlite', path }));
  }
  function backupSqlite() {
    void run('Backing up SQLite file…', async () => {
      const result = await request<{ message: string }>({ op: 'backup' });
      setNotice({ error: false, text: result.message });
    });
  }
  async function loadBackups() {
    const result = await request<BackupList>({ op: 'list_backups' });
    setBackupList(result);
    setBackupError(null);
    return result;
  }
  function showBackups() {
    setBackupError(null);
    setBackupsOpen(true);
    void loadBackups().catch(error => { if (mounted.current) setBackupError(errorText(error)); });
  }
  function revealBackups() {
    setBackupError(null);
    void request<{ message: string }>({ op: 'open_backups' })
      .then(result => { if (mounted.current) setNotice({ error: false, text: result.message }); })
      .catch(error => { if (mounted.current) setBackupError(errorText(error)); });
  }
  function importBackup(path: string) {
    setBackupsOpen(false);
    setConfirmation('');
    setBackupError(null);
    setEdit({ kind: 'import_sql', path });
  }
  function dropEngine(engine: Engine) {
    const had = (connectionsRef.current ?? []).some(item => item.engine === engine);
    if (!had) return;
    if (engine === 'sqlite') restoreRecent.current = false;
    const nextConnections = (connectionsRef.current ?? []).filter(item => item.engine !== engine);
    connectionsRef.current = nextConnections;
    setConnections(nextConnections);
    if (selectedSource.current.driver === engine) {
      const next: Source = engine === 'sqlite' ? { driver: 'sqlite', path: null } : { driver: engine };
      selectedSource.current = next;
      setSource(next);
      setDatabases([]); setDatabase(''); setTables([]); setTable(''); setPage(null); setStructure(null);
      setCatalogLoaded(false); setTableError(null); setQuery(null);
    }
    setBackupsOpen(false); setEdit(null); setViewedRow(null); setForeignKeyExamples(null); setTableSql(null);
    setNotice({ error: true, text: connectionLostMessage });
    void disconnect(engine).catch(() => { /* The tab is already clear when the API is down. */ });
  }
  function closeCurrent() {
    const engine = source.driver;
    if (engine === 'sqlite') restoreRecent.current = false;
    void run(engine === 'sqlite' ? 'Closing SQLite file…' : 'Disconnecting…', async () => {
      await disconnect(engine);
      const nextConnections = (connectionsRef.current ?? []).filter(item => item.engine !== engine);
      connectionsRef.current = nextConnections;
      setConnections(nextConnections);
      const next: Source = engine === 'sqlite' ? { driver: 'sqlite', path: null } : { driver: engine };
      selectedSource.current = next;
      setSource(next);
      setDatabases([]); setDatabase(''); setTables([]); setTable(''); setPage(null); setStructure(null);
      setCatalogLoaded(false); setTableError(null); setQuery(null);
    });
  }
  useEffect(() => {
    if (pending || !operationFocus.current) return;
    const trigger = operationFocus.current;
    operationFocus.current = null;
    // Disabling the control can blur it. Restore it without scrolling, and
    // leave focus alone when the user has moved on or a dialog is open.
    if (document.activeElement === document.body && !document.querySelector('[aria-modal="true"]') && trigger.isConnected && !trigger.matches(':disabled')) {
      trigger.focus({ preventScroll: true });
    }
  }, [pending]);
  useEffect(() => {
    setShowPending(false);
    if (!pending) return;
    if (!browsing) { setShowPending(true); return; }
    const timer = window.setTimeout(() => setShowPending(true), 200);
    return () => window.clearTimeout(timer);
  }, [pending, browsing]);
  const refreshCurrentSource = useEffectEvent(() => {
    // Read the current source after waiting for an active task; never publish
    // a MySQL catalog into a SQLite workspace. Keep refresh on sidebar return.
    // A switch can finish before React commits setSource. Its synchronous
    // selection also protects this gap between task completion and rendering.
    const target = selectedSource.current;
    if (target.driver === 'sqlite' ? target.path : engineReady(target.driver)) void run('Loading databases…', () => load(undefined, undefined, target));
    else { setPage(null); setStructure(null); }
  });
  useEffect(() => {
    let disposed = false;
    void currentSession().then(found => {
      if (disposed) return;
      connectionsRef.current = found;
      setConnections(found);
    }).catch(error => {
      if (!disposed) setNotice({ error: true, text: errorText(error) });
      setConnections([]);
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (connections === null) return;
    let disposed = false;
    // A sidebar return may overlap cancellation of the previous view's request.
    // Wait for it before refreshing, so an initial load cannot be skipped forever.
    void (async () => {
      await activeTask.current;
      if (disposed) return;
      refreshCurrentSource();
    })();
    return () => { disposed = true; };
    // Refresh on visibility/service changes, not on each snapshot poll.
  }, [connections]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // React's development effect replay is not an actual navigation away.
      queueMicrotask(() => { if (!mounted.current && job.current) void cancelData(job.current).catch(() => {}); });
    };
  }, []);
  useEffect(() => {
    const element = rowsScroll.current;
    if (!element) return;
    const measure = () => {
      const below = element.nextElementSibling instanceof HTMLElement ? element.nextElementSibling.offsetHeight : 0;
      const room = window.innerHeight - element.getBoundingClientRect().top - below - 20;
      setRowsHeight(Math.max(220, Math.floor(room)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [pane, table, database, sqlite, page, catalogLoaded]);

  function begin(kind: EditKind, row?: Row, column?: Column, index?: TableIndex, rowRef?: RowRef, largeFields?: LargeFields) {
    setNotice(null); setName(kind === 'rename_database' ? database : kind === 'rename_table' ? table : '');
    setFieldLoading(false); setConfirmation(''); setValues(kind === 'insert' && page ? initialInsertValues(page.columns) : {});
    const fresh = (name = ''): Definition => ({ ...newColumn(name, sqlite), ...(sqlite || postgres ? { type: 'TEXT' } : {}) });
    setDefinitions(kind === 'create_table' ? [{ ...idColumn(), ...(sqlite || postgres ? { type: 'INTEGER' } : {}) }, fresh('name')] : column ? [fromColumn(column, postgres)] : [fresh()]);
    const first = indexableColumns(page?.columns ?? [], sqlite)[0]?.name;
    setIndexDefinition({ name: suggestedIndexName(table, first ? [first] : [], false), unique: false, columns: first ? [first] : [] });
    setEdit({ kind, row, column, index, rowRef, largeFields });
  }
  async function save() {
    if (!edit || fieldLoading) return;
    const current = edit;
    await run('Saving database changes…', async () => {
      const body: Record<string, unknown> = { op: current.kind, database, table, confirmed: true };
      if (current.kind === 'create_database') body.database = name;
      if (['rename_database', 'rename_table', 'drop_column'].includes(current.kind)) body.name = current.kind === 'drop_column' ? current.column?.name : name;
      if (current.kind === 'create_table') { body.table = name; body.columns = definitions; }
      if (current.kind === 'add_column' || current.kind === 'change_column') { body.column = definitions[0]; body.oldName = current.column?.name; }
      if (current.rowRef) body.rowRef = current.rowRef;
      else if (current.row) { body.original = current.row; body.binaryColumns = page?.columns.filter(c => c.binary).map(c => c.name); }
      if (current.kind === 'insert' || current.kind === 'update') body.values = values;
      if (current.kind === 'create_index') { body.name = indexDefinition.name; body.indexColumns = indexDefinition.columns; body.unique = indexDefinition.unique; }
      if (current.kind === 'drop_index') { body.name = current.index?.name; body.originalIndex = current.index; }
      const result = await request<{ message: string }>(body);
      setEdit(null);
      await load(current.kind === 'create_database' || current.kind === 'rename_database' ? name : database, current.kind === 'create_table' || current.kind === 'rename_table' ? name : table);
      setNotice({ error: false, text: result.message });
    });
  }
  function showPane(next: typeof pane) {
    setPane(next);
  }
  function chooseImport() {
    setConfirmation('');
    setBackupError(null);
    setEdit({ kind: 'import_sql', path: '' });
    void loadBackups().catch(error => { if (mounted.current) setBackupError(errorText(error)); });
  }
  async function importSql() {
    if (!edit?.path || confirmation !== database || sqlite) return;
    const path = edit.path;
    await run('Importing SQL…', async () => {
      setImportPhase('import');
      let result: { message: string };
      try {
        result = await request<{ message: string }>({ op: 'import', database, sqlFile: path, confirmed: true });
      } catch (error) {
        setImportPhase('refreshing');
        setConfirmation(''); setQuery(null);
        try { if (mounted.current) await load(); } catch { /* Preserve the import error and backup path. */ }
        throw error;
      } finally { setImportPhase(null); }
      setEdit(null); setQuery(null);
      try { await load(); }
      catch (error) { setNotice({ error: true, text: `${result.message}\nImport completed, but the browser could not refresh: ${errorText(error)}` }); return; }
      setNotice({ error: false, text: result.message });
    });
  }
  function cancelImport() {
    const id = job.current;
    if (!id) return;
    const previousPhase = importPhase;
    setImportPhase('canceling');
    void cancelData(id).catch(error => {
      setNotice({ error: true, text: errorText(error) });
      if (job.current === id) setImportPhase(previousPhase);
    });
  }
  async function exportSql(selectedTable?: string) {
    await run(selectedTable ? 'Exporting table…' : 'Exporting database…', async () => {
      const result = await request<{ message: string }>({ op: 'export', database, ...(selectedTable ? { table: selectedTable } : {}) });
      setNotice({ error: false, text: result.message });
    });
  }
  async function runQuery() {
    const selection = editor.current;
    const text = selection && selection.selectionStart !== selection.selectionEnd ? sql.slice(selection.selectionStart, selection.selectionEnd) : sql;
    setQuery(null);
    await run('Running SQL…', async () => {
      const result = await request<QueryResult>({ op: 'query', database, sql: text });
      setQuery(summarizeQueryResults(text, result, sqlite)); setHistory(previous => [text, ...previous.filter(item => item !== text)].slice(0, 10));
      // SQL can change or remove the selected table. Refresh the catalog after execution.
      await load();
    });
  }
  const destructive = edit?.kind.startsWith('drop_') || edit?.kind === 'delete';
  const target = edit?.kind === 'drop_database' ? database : edit?.kind === 'drop_table' ? table : edit?.kind === 'drop_index' ? edit.index?.name ?? '' : edit?.column?.name ?? '';
  const needsName = edit && ['create_database', 'rename_database', 'create_table', 'rename_table'].includes(edit.kind);
  const columnForm = edit && ['add_column', 'change_column'].includes(edit.kind);
  const pageNotice = notice && !edit ? notice : null;

  const catalogNoun = 'Database';
  return <Workspace id="data" title="Data browser" className="db-browser db-screen" busy={!!pending}>
    <header className="db-navbar">
      <div className="db-navbar-title"><img src="/fairway-logo.png" alt="Fairway XMP" width="32" height="32" /><h1>Data browser</h1></div>
      <div className="db-source-tabs" role="tablist" aria-label="Data source">{(['postgres', 'mysql', 'sqlite'] as const).map(driver => <button key={driver} role="tab" aria-selected={source.driver === driver} disabled={blocked} onClick={() => selectDriver(driver === 'sqlite' ? { driver, path: restoreRecent.current ? sqlitePath ?? recent[0] ?? null : sqlitePath } : { driver })}>{engineLabel(driver)}</button>)}</div>
      {available && <button className="secondary db-navbar-close" disabled={blocked} onClick={closeCurrent}>{sqlite ? 'Close SQLite' : 'Disconnect'}</button>}
    </header>
    <div className="db-screen-body">
    <div className={`db-notice${pageNotice ? ` notice ${pageNotice.error ? 'error' : 'success'}` : ''}`}>
      <div className="db-notice-message">
        <div role={pageNotice && !pageNotice.error ? 'status' : undefined} aria-live="polite" aria-atomic="true">{pageNotice && !pageNotice.error ? pageNotice.text : null}</div>
        <div role={pageNotice?.error ? 'alert' : undefined} aria-live="assertive" aria-atomic="true">{pageNotice?.error ? pageNotice.text : null}</div>
      </div>
      {pageNotice && <button aria-label="Dismiss database message" onClick={() => setNotice(null)}>×</button>}
    </div>
    {sqlitePath && <section className="db-file-card" aria-label="SQLite file" inert={browsing}><p className="db-file-path" title={sqlitePath}><strong>{fileName(sqlitePath)}</strong><span aria-label="SQLite file path">{sqlitePath}</span><small>Editing this file. Changes are saved immediately.</small></p><div className="db-file-actions"><button className="secondary" disabled={blocked} onClick={backupSqlite}>Back up SQLite file</button></div></section>}
    {connections === null ? <div className="db-loading-placeholder" aria-label="Loading database workspace" /> : sqlite && !sqlitePath ? <section className="settings-card db-empty"><FolderOpen size={28} /><h2>Open a SQLite file to browse your data</h2><p>Enter the path of an existing database file. Opening it does not create a new file, and changes are saved immediately.</p><form className="project-form" onSubmit={event => { event.preventDefault(); void openSqlite(sqliteDraft.trim()); }}><label><span>Database file</span><input value={sqliteDraft} onChange={event => setSqliteDraft(event.target.value)} placeholder="/path/to/database.sqlite" autoComplete="off" spellCheck={false} /></label><div className="db-empty-actions"><button className="primary" disabled={blocked} type="submit">Open SQLite file</button>{recent[0] && <button className="secondary" type="button" disabled={blocked} title={recent[0]} onClick={() => void openSqlite(recent[0])}>Reopen {fileName(recent[0])}</button>}</div></form></section> : !available && !sqlite ? <ConnectCard key={source.driver} engine={source.driver} pending={!!pending} onConnect={connectEngine} /> : <div className="db-content" inert={browsing}>
      {!sqlite && <>
      <section className="db-catalog" aria-label="Database controls">
        <label>{catalogNoun}<select aria-label={catalogNoun} value={database} disabled={blocked || !databases.length} onChange={e => void run('Loading database…', () => load(e.target.value, ''))}>{!databases.length && <option value="">No {catalogNoun.toLowerCase()}s</option>}{databases.map(db => <option key={db}>{db}</option>)}</select></label>
        <div className="db-actions"><button className="secondary" disabled={blocked} onClick={() => begin('create_database')}><Plus size={14} />{catalogNoun}</button><button className="icon-button" aria-label={`Refresh ${catalogNoun.toLowerCase()}s`} disabled={blocked} onClick={() => void run('Refreshing databases…', () => load())}><RefreshCw size={15} /></button><ActionMenu label={`${catalogNoun} actions`} disabled={blocked || !database} actions={[
          { label: `Export ${catalogNoun.toLowerCase()} SQL`, onSelect: () => void exportSql() },
          { label: 'Import SQL file…', onSelect: () => chooseImport() },
          { label: `Rename ${catalogNoun.toLowerCase()}`, onSelect: () => begin('rename_database') },
          { label: `Delete ${catalogNoun.toLowerCase()}`, danger: true, onSelect: () => begin('drop_database') },
        ]} /></div>
      </section>
      </>}
      {!catalogLoaded && !notice?.error && <div className="db-loading-placeholder" aria-label="Loading database workspace" />}
      {database && <TableWorkspace sidebar={
        <aside className="db-tables" aria-label="Tables"><div className="db-tables-heading"><h2>Tables <span>{tables.length}</span></h2><button className="icon-button" aria-label="Create table" title="Create table" disabled={blocked} onClick={() => begin('create_table')}><Plus size={16} /></button></div>
          {tables.length ? tables.map(t => <button key={t.name} title={t.name} className={`db-table-choice ${table === t.name ? 'selected' : ''}`} disabled={blocked} onClick={() => void run('Loading table…', () => load(database, t.name))}><span>{t.name}</span>{t.kind === 'VIEW' && <small>view</small>}</button>) : <div className="db-tables-empty"><p className="db-hint">No tables yet.</p><button className="secondary" disabled={blocked} onClick={() => begin('create_table')}>Create table</button></div>}
        </aside>
      }>{toggle =>
        <section className="db-detail" aria-label="Database workspace">
          <div className="db-detail-heading"><div className="db-detail-title">{toggle}<h2>{table || (sqlite ? fileName(database) : database)}</h2></div><div className="db-detail-controls">{table && <>{pane === 'rows' && <button className="secondary" disabled={blocked || !writable} onClick={() => begin('insert')}><Plus size={14} />Insert row</button>}<ActionMenu label="Table actions" disabled={blocked} actions={[
            ...(!sqlite ? [{ label: 'Export table SQL', onSelect: () => void exportSql(table) }] : []),
            { label: 'Rename table', disabled: !writable, onSelect: () => begin('rename_table') },
            { label: 'Delete table', disabled: !writable, danger: true, onSelect: () => begin('drop_table') },
          ]} /></>}</div></div>
          <div className="db-tabs" role="tablist" aria-label="Data views">{(['rows', 'structure', 'query'] as const).map(tab => <button key={tab} role="tab" aria-selected={pane === tab} disabled={blocked || (tab !== 'query' && !table)} onClick={() => showPane(tab)}>{tab === 'query' ? 'SQL query' : tab === 'rows' ? 'Rows' : 'Structure'}</button>)}</div>
          {tableError && <div className="notice error" role="alert"><span>Could not load {table}. {tableError} Choose another table or use SQL to repair it.</span><button className="secondary" disabled={blocked} onClick={() => void run('Refreshing table…', () => load())}>Retry table</button></div>}
          {!table && pane !== 'query' ? <div className="db-empty"><p>Create a table or open SQL query to begin.</p><div className="db-empty-actions"><button className="secondary" disabled={blocked} onClick={() => begin('create_table')}>Create table</button><button className="secondary" disabled={blocked} onClick={() => showPane('query')}>Open SQL query</button></div></div> : pane === 'rows' && page ? <>
            {!canEdit && <p className="db-hint">{writable ? 'No non-null primary or unique key: browse and insert are available. Use SQL for row updates and deletes.' : page.kind === 'VIEW' ? 'This view is read-only. Use SQL for advanced changes.' : 'This virtual table is read-only in forms. Use SQL for advanced changes.'}</p>}
            <div ref={rowsScroll} className="db-grid-scroll" tabIndex={0} role="region" aria-label="Table rows" style={rowsHeight ? { maxHeight: rowsHeight } : undefined}><table className="db-grid"><thead><tr><th>Actions</th>{page.columns.map(c => <th key={c.name}><button disabled={blocked} onClick={() => { const next = { sort: c.name, direction: sort.sort === c.name && sort.direction === 'ASC' ? 'DESC' : 'ASC' }; setSort(next); void run('Sorting rows…', () => loadRows(database, table, 0, next)); }}>{c.name}{sort.sort === c.name ? sort.direction === 'ASC' ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead><tbody>{page.rows.map((row, index) => <tr key={index}><td className="db-actions-cell"><div className="db-row-actions"><button className="icon-button" title={`View row ${index + 1}`} aria-label={`View row ${index + 1}`} disabled={blocked} onClick={() => { setNotice(null); setViewedRow({ row, columns: page.columns, table, database, source, position: page.offset + index + 1, rowRef: page.rowRefs?.[index], largeFields: page.truncated?.[index] }); }}><Eye size={14} /></button>{canEdit && <><button className="icon-button" title={`Edit row ${index + 1}`} aria-label={`Edit row ${index + 1}`} disabled={blocked} onClick={() => begin('update', row, undefined, undefined, page.rowRefs?.[index], page.truncated?.[index])}><Pencil size={14} /></button><button className="icon-button db-icon-danger" title={`Delete row ${index + 1}`} aria-label={`Delete row ${index + 1}`} disabled={blocked} onClick={() => begin('delete', row, undefined, undefined, page.rowRefs?.[index], page.truncated?.[index])}><Trash2 size={14} /></button></>}</div></td>{page.columns.map(c => <td key={c.name}><span className="db-cell" title={largeField(page.truncated?.[index], c.name) ? `Preview · ${largeField(page.truncated?.[index], c.name)!.length.toLocaleString()} characters. Open the row for the complete value.` : row[c.name] ?? 'SQL NULL'}>{cell(row[c.name])}{largeField(page.truncated?.[index], c.name) && '…'}</span></td>)}</tr>)}</tbody></table>{!page.rows.length && <p className="db-grid-empty">{writable ? 'No rows yet. Insert a row to get started.' : 'This view has no rows.'}</p>}</div>
            <div className="db-pagination"><span>{page.rows.length ? page.offset + 1 : 0}–{page.offset + page.rows.length} of {page.total}</span><div className="db-actions"><button className="icon-button" aria-label="Previous page" disabled={blocked || page.offset === 0} onClick={() => void run('Loading rows…', () => loadRows(database, table, Math.max(0, page.offset - page.limit)))}><ChevronLeft size={17} /></button><button className="icon-button" aria-label="Next page" disabled={blocked || BigInt(page.offset + page.rows.length) >= BigInt(page.total)} onClick={() => void run('Loading rows…', () => loadRows(database, table, page.offset + page.limit))}><ChevronRight size={17} /></button><button className="icon-button" aria-label="Refresh rows" disabled={blocked} onClick={() => void run('Refreshing rows…', () => loadRows(database, table, page.offset))}><RefreshCw size={14} /></button></div></div>
          </> : pane === 'structure' && page ? <>
            <div className="db-row-tools"><p className="db-hint">{page.key.length ? `Row identity: ${page.key.join(', ')}` : 'No safe row identity found.'}</p><div className="db-actions"><button type="button" className="secondary" disabled={blocked || !structure?.sql} onClick={() => { if (structure?.sql) setTableSql({ table, sql: structure.sql }); }}><Code2 size={14} />Table SQL</button><button className="secondary" disabled={blocked || !writable} onClick={() => begin('add_column')}><Plus size={14} />Column</button></div></div>
            <div className="db-grid-scroll" tabIndex={0} role="region" aria-label="Table structure"><table className="db-grid"><thead><tr><th>Column</th><th>Type</th><th>NULL</th><th>Default</th><th>Attributes</th><th>Actions</th></tr></thead><tbody>{page.columns.map(c => <tr key={c.name}><td>{c.name}</td><td>{c.type}</td><td>{c.nullable ? 'Yes' : 'No'}</td><td>{cell(c.defaultValue)}</td><td>{[c.columnKey, c.extra, c.generated ? 'generated' : ''].filter(Boolean).join(' · ') || '—'}</td><td className="db-actions-cell"><div className="db-row-actions"><button className="icon-button" title={`Edit column ${c.name}`} aria-label={`Edit column ${c.name}`} disabled={blocked || !writable || sqlite || !editableColumn(c, postgres)} onClick={() => begin('change_column', undefined, c)}><Pencil size={14} /></button><button className="icon-button db-icon-danger" title={`Delete column ${c.name}`} aria-label={`Delete column ${c.name}`} disabled={blocked || !writable || (sqlite && c.columnKey === 'PRI')} onClick={() => begin('drop_column', undefined, c)}><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></div>
            <p className="db-hint">{sqlite ? 'Use SQL for foreign-key changes, column renames and type changes. Column deletion requires SQLite 3.35 or newer; dependent constraints may prevent it.' : postgres ? 'Use SQL for foreign keys and advanced column definitions.' : 'Foreign-key changes and advanced column definitions are available through SQL.'}</p>
            {structure && <SchemaDetails structure={structure} database={database} sqlite={sqlite} writable={!!writable} blocked={blocked} canCreate={indexableColumns(page.columns, sqlite).length > 0} onCreate={() => begin('create_index')} onRemove={index => begin('drop_index', undefined, undefined, index)} onForeignKeys={() => setForeignKeyExamples('structure')} />}
          </> : pane === 'query' ? <div className="db-query">
            <div className="db-query-heading"><label htmlFor="db-sql">SQL for <strong>{sqlite ? fileName(database) : database}</strong></label><HelpTip label="SQL query help"><p>SQL changes run immediately. Cancel cannot undo completed statements.</p><p>Results show up to 200 rows per statement.{!sqlite && ' SELECT without a LIMIT is capped at 201.'} Use LIMIT and OFFSET to see more.</p><p>{sqlite ? 'Run up to ten statements and 1 MiB of SQL at once. Finish transactions within the same run. SQL changes do not create automatic backups.' : 'All statements run; only the first ten result sets are displayed. Finish transactions with COMMIT or ROLLBACK in the same run. Import full SQL dumps through Database actions → Import SQL file.'}</p></HelpTip></div><textarea ref={editor} id="db-sql" value={sql} disabled={blocked} onChange={e => setSql(e.target.value)} rows={8} spellCheck={false} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !blocked && sql.trim()) { e.preventDefault(); void runQuery(); } }} />
            <div className="db-row-tools"><button className="primary" disabled={blocked || !sql.trim()} onClick={() => void runQuery()}>Run selection / all</button><span className="db-hint">⌘ / Ctrl + Enter</span>{history.length > 0 && <select aria-label="Query history" value="" disabled={blocked} onChange={e => setSql(e.target.value)}><option value="">Recent queries (this session)</option>{history.map((text, i) => <option key={i} value={text}>{text.slice(0, 70)}</option>)}</select>}</div>
            {query && <div aria-label="Query results"><p className="db-hint">Completed in {query.elapsedMs} ms</p>{query.resultsTruncated && <p className="db-hint" role="status">All statements ran; only the first ten result sets are shown.</p>}{query.sets.map((set, index) => <section key={index} className="db-query-result"><h3>{query.sets.length === 1 ? set.summary : <>Result {index + 1} <span>{set.summary}</span></>}</h3>{set.truncated && <p className="db-hint">Showing the first 200 rows. Use a LIMIT and OFFSET to see more.</p>}{set.columns.length > 0 && <div className="db-grid-scroll" tabIndex={0} role="region" aria-label={`Query result ${index + 1}`}><table className="db-grid"><thead><tr>{set.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead><tbody>{set.rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}><span className="db-cell">{cell(value)}</span></td>)}</tr>)}</tbody></table></div>}</section>)}</div>}
          </div> : null}
        </section>
      }</TableWorkspace>}

    </div>}
    <footer className="db-footer" inert={browsing}>{available && sqlite && <p className="db-hint">Backups are saved on this machine. Opening a file does not copy or import it.</p>}<button className="secondary" disabled={blocked} onClick={showBackups}><FolderOpen size={14} />Open backups</button></footer>
    </div>
    {pending && showPending && <div className="db-pending" role="status"><LoaderCircle className="spin" size={14} />{pending}{['Running SQL…', 'Loading rows…', 'Sorting rows…'].includes(pending) && <button className="secondary" disabled={!job.current} onClick={() => { if (job.current) void cancelData(job.current).catch(error => setNotice({ error: true, text: errorText(error) })); }}>Cancel query</button>}</div>}
    {viewedRow && <RowViewer table={viewedRow.table} columns={viewedRow.columns} row={viewedRow.row} position={viewedRow.position} largeFields={viewedRow.largeFields} readCell={cellReader(viewedRow.database, viewedRow.table, viewedRow.source, viewedRow.rowRef)} onClose={() => setViewedRow(null)} onEdit={canEdit && !blocked && viewedRow.database === database && viewedRow.table === table && viewedRow.source === source ? () => { setViewedRow(null); begin('update', viewedRow.row, undefined, undefined, viewedRow.rowRef, viewedRow.largeFields); } : undefined} />}
    {backupsOpen && <Dialog title="Backups" busy={blocked} showSubmit={false} cancel="Close" onClose={() => setBackupsOpen(false)} onSubmit={() => {}}>
      <p>{backupList ? <>Saved on this machine in <code>{backupList.directory}</code>.</> : 'Saved on this machine.'}</p>
      {backupError && <div className="notice error" role="alert"><span>{backupError}</span></div>}
      {!backupList && !backupError && <p role="status">Loading backups…</p>}
      {backupList && !backupList.files.length && <p className="db-hint">No backups yet. A SQLite backup or a PostgreSQL or MySQL export will appear here.</p>}
      {backupList && backupList.files.length > 0 && <ul className="db-backup-list">{backupList.files.map(file => <li key={file.path} className="db-backup-row"><div className="db-backup-meta"><strong>{file.name}</strong><span>{backupKind(file.kind)} · {formatWhen(file.modified)} · {formatBytes(file.bytes)}</span></div>{file.kind === 'sqlite' && <button type="button" className="secondary" disabled={blocked} onClick={() => { setBackupsOpen(false); void openSqlite(file.path); }}>Open</button>}{file.kind === 'sql' && <button type="button" className="secondary" disabled={blocked || sqlite || !database} title={sqlite || !database ? 'Connect to PostgreSQL or MySQL and choose a database to import this snapshot.' : 'Import this snapshot'} onClick={() => importBackup(file.path)}>Import</button>}</li>)}</ul>}
      {backupList?.truncated && <p className="db-hint">Showing the latest 200 files.</p>}
      <button type="button" className="secondary db-backup-reveal" disabled={blocked} onClick={revealBackups}>Reveal in folder</button>
    </Dialog>}
    {edit && <Dialog key={edit.kind} title={titles[edit.kind]} busy={blocked} onClose={() => setEdit(null)} onSubmit={() => { if (edit.kind === 'import_sql') { void importSql(); return; } void save(); }} onCancelBusy={edit.kind === 'import_sql' && (importPhase === 'working' || importPhase === 'backup' || importPhase === 'import') ? cancelImport : undefined} submit={edit.kind === 'import_sql' ? 'Import SQL' : edit.kind === 'drop_index' ? 'Remove' : destructive ? 'Delete' : edit.kind.startsWith('create_') ? 'Create' : 'Save'} danger={destructive} valid={!fieldLoading && (edit.kind === 'import_sql' ? confirmation === database && !!edit.path?.trim() : (edit.kind === 'create_index' ? !!indexDefinition.name.trim() && indexDefinition.columns.length > 0 && indexDefinition.columns.every(Boolean) : !destructive || edit.kind === 'delete' || confirmation === target))}>
      {notice?.error && <div className="notice error" role="alert"><span>{notice.text}</span></div>}
      {edit.kind === 'import_sql' && <>
        <p>Import a SQL file into <strong>{database}</strong>. Existing data may be replaced. A backup of <strong>{database}</strong> is saved first. SQL can also change other databases; only this target is backed up automatically. Errors or cancellation can leave partial changes.</p>
        {backupError && <div className="notice error" role="alert"><span>{backupError}</span></div>}
        {(backupList?.files.filter(file => file.kind === 'sql').length ?? 0) > 0 && <div className="db-backup-choices" role="radiogroup" aria-label="SQL file">{backupList?.files.filter(file => file.kind === 'sql').map(file => <label key={file.path} className="db-backup-choice"><input type="radio" name="import-sql-file" checked={edit.path === file.path} onChange={() => setEdit({ ...edit, path: file.path })} /><span><strong>{file.name}</strong><small>{formatWhen(file.modified)} · {formatBytes(file.bytes)}</small></span></label>)}<label className="db-backup-choice"><input type="radio" name="import-sql-file" checked={!backupList?.files.some(file => file.kind === 'sql' && file.path === edit.path)} onChange={() => setEdit({ ...edit, path: '' })} /><span><strong>Another SQL file</strong><small>Type a path on this machine</small></span></label></div>}
        {!(backupList?.files.some(file => file.kind === 'sql' && file.path === edit.path)) && <label>SQL file path<input className="db-import-path" autoComplete="off" spellCheck={false} value={edit.path ?? ''} onChange={event => setEdit({ ...edit, path: event.target.value })} placeholder="/path/to/dump.sql" required /></label>}
        {importPhase && <p role="status">{importPhase === 'working' ? 'Backing up, then importing SQL… Cancel waits for the backup to finish.' : importPhase === 'backup' ? 'Creating a backup… Cancel waits for the backup to finish.' : importPhase === 'import' ? 'Importing SQL…' : importPhase === 'canceling' ? 'Canceling import… Waiting for the current step to stop.' : 'Refreshing the database…'}</p>}
        <label>Type {database} to confirm<input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>
      </>}
      {needsName && <label>{edit.kind.includes('database') ? 'Database name' : 'Table name'}<input required maxLength={64} value={name} onChange={e => setName(e.target.value)} /></label>}
      {edit.kind === 'rename_database' && <p>Only empty databases can be renamed. For a populated database, export it, create a new database, and import it into the new database. Update your project’s connection settings afterward.</p>}
      {edit.kind === 'create_table' && <div className="db-new-columns"><div className="db-actions"><button type="button" className="secondary" onClick={() => setForeignKeyExamples('create')}><Link2 size={14} />Foreign keys</button></div>{definitions.map((definition, index) => <section className="db-column-card" key={index}><h3>Column {index + 1}</h3><ColumnFields sqlite={sqlite} postgres={postgres} value={definition} onChange={value => setDefinitions(previous => previous.map((c, i) => i === index ? value : c))} /><button type="button" className="db-danger-text" disabled={definitions.length === 1} onClick={() => setDefinitions(previous => previous.filter((_, i) => i !== index))}>Remove column</button></section>)}<button type="button" className="secondary" onClick={() => setDefinitions(previous => [...previous, { ...newColumn('', sqlite), ...(sqlite || postgres ? { type: 'TEXT' } : {}) }])} disabled={definitions.length >= 100}><Plus size={14} />Add column</button></div>}
      {columnForm && <><ColumnFields sqlite={sqlite} postgres={postgres} adding={edit.kind === 'add_column'} value={definitions[0]} existing={edit.kind === 'change_column'} hasPrimary={edit.kind === 'add_column' && (sqlite || !!page?.columns.some(c => c.columnKey === 'PRI'))} onChange={value => setDefinitions([value])} />{edit.kind === 'change_column' && <p>Changing type or length can alter existing values. A database backup is saved first. Primary keys are preserved; manage indexes in SQL.</p>}</>}
      {(edit.kind === 'insert' || edit.kind === 'update') && page && <RowFields columns={page.columns} original={edit.row} largeFields={edit.largeFields} readCell={cellReader(database, table, source, edit.rowRef)} onLoadingChange={setFieldLoading} onChange={setValues} />}
      {edit.kind === 'create_index' && page && <IndexFields value={indexDefinition} table={table} columns={indexableColumns(page.columns, sqlite)} onChange={setIndexDefinition} />}
      {destructive && <><p>{edit.kind === 'delete' ? 'Delete this row permanently? The original values will be checked before deletion.' : edit.kind === 'drop_index' ? `Remove index “${target}”? Rows are kept.${edit.index?.unique ? ' This stops enforcing uniqueness through this index.' : ''} A ${sqlite ? 'SQLite' : 'SQL'} backup of this database will be saved first.` : `Delete “${target}” permanently? A ${sqlite ? 'SQLite' : 'SQL'} backup of this database will be saved first. Related application code may need changes.`}</p>{edit.kind !== 'delete' && <label>Type {target} to confirm<input autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} required /></label>}</>}
    </Dialog>}
    {tableSql && <Dialog title="Table SQL" busy={false} onClose={() => setTableSql(null)} onSubmit={() => {}} showSubmit={false} cancel="Close"><SqlBlock title={tableSql.table} sql={tableSql.sql} copyLabel="Copy table SQL" /></Dialog>}
    {foreignKeyExamples && <ForeignKeyExamples sqlite={sqlite} context={foreignKeyExamples} onClose={() => setForeignKeyExamples(null)} />}
  </Workspace>;
}
