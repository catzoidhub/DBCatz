import type { DbCatzApi } from '@shared/types';

/**
 * Every action DBCatz can do, and where it stands with MCatzP (scope: every action, user 2026-10-28). A new method in
 * DbCatzApi fails the typecheck here until it is placed, so nothing is left out unnoticed.
 * `tool: …` is done. `later: …` is still to do, in that tier. `not a tool`: it only makes sense in the window (a menu, a
 * file picker, this app's own updater or AI buttons). `never: …`: left out on purpose, with why.
 * A tab fed from the window's own state has no method here, so it has its own tool: Logs (list_query_log), History (list_query_history).
 */
export const MCATZP_COVERAGE = {
  // tool: list_connections
  dvConnections: 'tool: list_connections',
  dvLayout: 'tool: list_connections',
  // tool: server_info
  dvServerInfo: 'tool: server_info',
  // tool: list_databases
  dvDatabases: 'tool: list_databases',
  dvDbPrefs: 'tool: list_databases',
  // tool: list_tables
  dvTables: 'tool: list_tables',
  // tool: describe_table
  dvStructure: 'tool: describe_table',
  // tool: list_column_types
  dvTypes: 'tool: list_column_types',
  // tool: list_charsets
  dvCharsets: 'tool: list_charsets',
  // tool: list_saved_queries
  dvSavedQueries: 'tool: list_saved_queries',
  // tool: list_jobs
  dvJobs: 'tool: list_jobs',
  // tool: read_rows
  dvRows: 'tool: read_rows',
  // tool: run_read_query (reads); writes: later
  dvQuery: 'tool: run_read_query',
  // tool: list_keys
  dvKeys: 'tool: list_keys',
  // tool: get_key
  dvKey: 'tool: get_key',

  // change
  dvInsertRow: 'tool: insert_row',
  dvUpdateRow: 'tool: update_row',
  dvCreateDatabase: 'tool: create_database',
  dvCreateTable: 'tool: create_table',
  dvAlterCheck: 'tool: check_alter',
  dvAlterTable: 'tool: alter_table',
  dvDuplicateTable: 'tool: duplicate_table',
  dvExport: 'tool: export_data',
  dvImport: 'tool: import_file',
  dvBackup: 'tool: backup',
  dvCancelJob: 'tool: cancel_job',
  dvClearJobs: 'tool: clear_finished_jobs',
  dvKeySet: 'tool: set_key',
  dvKeyRename: 'tool: rename_key',
  dvSaveQuery: 'tool: save_query',
  dvDeleteQuery: 'tool: delete_saved_query',
  dvSetLayout: 'tool: set_favorite, set_group',
  dvSetDbPrefs: 'tool: star_database',
  dvDisconnect: 'tool: disconnect',
  dvOpen: 'tool: open_in_window',
  openInDevCatz: 'tool: open_in_service_app',
  openInDoCatz: 'tool: open_in_service_app',
  dvSaveConnection: 'tool: add_connection (new, plain, no password; editing could lift Read-only, so it stays in the window)',
  dvTestConnection: 'tool: server_info (connects to a shared connection; a test of unsaved settings would need their secrets)',

  // destructive: type a name
  dvDeleteRows: 'tool: delete_rows',
  dvDropDatabase: 'tool: drop_database',
  dvDropTable: 'tool: drop_tables',
  dvDropTables: 'tool: drop_tables',
  dvTruncateTable: 'tool: truncate_tables',
  dvTruncateTables: 'tool: truncate_tables',
  dvKeyDelete: 'tool: delete_keys',
  dvFlush: 'tool: flush_keys',
  dvDeleteConnection: 'tool: delete_connection (its stored password cannot be had back)',

  // never: SSH, AWS and Vault hold secrets, and are set up in the window
  dvAwsProfiles: 'never: only for setting up a connection in the window',
  dvSshKeys: 'never: only for setting up a connection in the window',

  // not a tool: only makes sense in the window
  appInfo: 'not a tool',
  aboutInfo: 'not a tool',
  captureWindow: 'not a tool',
  openUrl: 'not a tool',
  pickFile: 'not a tool',
  dvPickSqlite: 'not a tool',
  dvCancelConnect: 'not a tool',
  dvReveal: 'not a tool',
  dvTableMenu: 'not a tool',
  dvAppMenu: 'not a tool',
  dvMenuShortcuts: 'not a tool',
  dvMenuKey: 'not a tool',
  dvGridPrefs: 'not a tool',
  dvSetGridPrefs: 'not a tool',
  updateState: 'not a tool',
  updateCheck: 'not a tool',
  updateDownload: 'not a tool',
  updateCancel: 'not a tool',
  updateSkip: 'not a tool',
  updateInstall: 'not a tool',
  updateConfigure: 'not a tool',
  reportPreview: 'not a tool',
  reportSend: 'not a tool',
  reportError: 'not a tool',
  reportSettings: 'not a tool',
  reportConfigure: 'not a tool',
  aiModels: 'not a tool',
  aiProbe: 'not a tool',
  aiTest: 'not a tool',
  aiAsk: 'not a tool',
  aiAskDbcatz: 'not a tool',
  aiPreviewAskDbcatz: 'not a tool',
  aiExplainLog: 'not a tool',
  aiPreviewLog: 'not a tool',
  aiCancel: 'not a tool',
  aiPreview: 'not a tool',
  aiForget: 'not a tool',

  // never: left out on purpose
  settings: 'never: holds what is shared; a client does not read or set its own limits',
  setSettings: 'never: holds what is shared; a client does not read or set its own limits',
  setAiKey: 'never: a client never sets or sees a secret',
  uninstallPlan: 'never: removing the app is the user\'s',
  uninstallRun: 'never: removing the app is the user\'s',
  mcatzpActivity: 'never: the log watches the client',
  mcatzpClearActivity: 'never: the log watches the client',
  mcatzpRevoke: 'never: approval is the user\'s',
  mcatzpPending: 'never: the question is for the user',
  mcatzpWindowReply: 'never: the window answering the main process',
  mcatzpAnswer: 'never: the question is for the user',
  mcatzpSetup: 'never: a client does not install itself',
  mcatzpInstall: 'never: a client does not install itself',
  mcatzpInstallCancel: 'never: a client does not install itself',
  mcatzpApprovals: 'never: approval is the user\'s',
  mcatzpTargets: 'never: a client does not install itself',
  mcatzpAddToClient: 'never: a client does not install itself',
  mcatzpRemoveFromClient: 'never: a client does not install itself',
} satisfies Record<keyof DbCatzApi, string>;
