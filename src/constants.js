// Graph vocabulary shared by every module. The label/edge lists are the spec's closed sets.

export const ROOT_LABEL = 'CodeNode';

export const NODE_LABELS = [
  'Project', 'Package', 'Folder', 'File', 'Module', 'Class', 'Function',
  'Method', 'Interface', 'Enum', 'Type', 'Route', 'Resource',
];

export const EDGE_TYPES = [
  'CONTAINS_PACKAGE', 'CONTAINS_FOLDER', 'CONTAINS_FILE', 'DEFINES', 'DEFINES_METHOD',
  'IMPORTS', 'CALLS', 'CALL_REFERENCE', 'USAGE', 'IMPLEMENTS', 'INHERITS', 'HANDLES',
  'CONFIGURES', 'WRITES', 'MEMBER_OF', 'TESTS', 'USES_TYPE', 'FILE_CHANGES_WITH',
  'HTTP_CALLS', 'ASYNC_CALLS', 'EMITS', 'LISTENS_ON', 'DATA_FLOWS', 'SIMILAR_TO',
  'SEMANTICALLY_RELATED',
];

// Edge types the indexer/linker actually emit today. The rest of EDGE_TYPES is the spec's closed
// vocabulary, reserved for future analyzers (runtime traces, git history, embeddings) and accepted on import.
export const PRODUCED_EDGE_TYPES = [
  'CONTAINS_FOLDER', 'CONTAINS_FILE', 'DEFINES', 'DEFINES_METHOD', 'MEMBER_OF', 'IMPORTS', 'CALLS',
  'CALL_REFERENCE', 'USAGE', 'IMPLEMENTS', 'INHERITS', 'USES_TYPE', 'HANDLES',
];

// Edge types the Pass 2 linker (re)computes from stored per-file references.
export const LINK_EDGE_TYPES = [
  'IMPORTS', 'CALLS', 'CALL_REFERENCE', 'USAGE', 'IMPLEMENTS', 'INHERITS',
  'USES_TYPE', 'HANDLES', 'TESTS',
];

// Edge types a file's own structure produces; purged together with the file's nodes.
export const STRUCTURE_EDGE_TYPES = [
  'CONTAINS_PACKAGE', 'CONTAINS_FOLDER', 'CONTAINS_FILE', 'DEFINES', 'DEFINES_METHOD', 'MEMBER_OF',
];

// Symbol kinds that can be the target of a call/type/heritage resolution.
export const CALLABLE_KINDS = ['Function', 'Method', 'Class'];
export const TYPE_KINDS = ['Class', 'Interface', 'Enum', 'Type'];

export const INDEX_NAMES = {
  constraint: 'unique_code_entity',
  vector: 'code_embedding_idx',
  fulltext: 'code_fulltext_idx',
};

export const EMBEDDING_DIMS = 1536;

export const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target',
  '.claude','.claude/worktrees','.worktrees', '.next', '.nuxt', 'coverage', '.idea', '.vscode', '.pytest_cache', '.mypy_cache',
  '.gradle', 'bin/Debug', 'obj',
];

export function assertLabel(label) {
  if (!NODE_LABELS.includes(label)) throw new Error(`Unknown node label: ${label}`);
  return label;
}

export function assertEdge(type) {
  if (!EDGE_TYPES.includes(type)) throw new Error(`Unknown edge type: ${type}`);
  return type;
}
