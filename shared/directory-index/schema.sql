PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA application_id = 1396853073;
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

CREATE TABLE generations (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    state TEXT NOT NULL CHECK (state IN ('building', 'accepted', 'candidate', 'retired')),
    coverage TEXT NOT NULL CHECK (coverage IN ('partial', 'complete', 'uncertain')),
    indexed_count INTEGER NOT NULL DEFAULT 0 CHECK (indexed_count >= 0),
    issue_count INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
    scan_baseline INTEGER NOT NULL DEFAULT 0 CHECK (scan_baseline >= 0)
) STRICT;

CREATE TABLE source_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('smb', 'local')),
    source_identity TEXT NOT NULL,
    normalization_version INTEGER NOT NULL CHECK (normalization_version = 1),
    traversal_version INTEGER NOT NULL CHECK (traversal_version = 1),
    selected_generation INTEGER REFERENCES generations(id),
    accepted_revision INTEGER NOT NULL DEFAULT 0 CHECK (accepted_revision >= 0),
    committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= 0),
    last_verified_at_ms INTEGER CHECK (last_verified_at_ms >= 0),
    last_access_at_ms INTEGER NOT NULL CHECK (last_access_at_ms >= 0)
) STRICT;

CREATE TABLE directories (
    id INTEGER PRIMARY KEY,
    generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK (length(path) > 0 AND substr(path, 1, 1) <> '/'
        AND substr(path, -1) <> '/' AND instr(path, char(0)) = 0
        AND instr('/' || path || '/', '//') = 0
        AND instr('/' || path || '/', '/./') = 0
        AND instr('/' || path || '/', '/../') = 0),
    path_key TEXT NOT NULL,
    basename_key TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth >= 0),
    has_dot_directory INTEGER NOT NULL CHECK (has_dot_directory IN (0, 1)),
    UNIQUE (generation_id, path)
) STRICT;
CREATE INDEX directories_generation ON directories(generation_id);

CREATE TABLE coverage_issues (
    generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (code IN ('access_denied', 'unsupported_encoding',
        'unsafe_traversal', 'identity_unverified', 'event_loss', 'scan_failed')),
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (generation_id, code)
) STRICT;

CREATE VIRTUAL TABLE directory_fts USING fts5(
    path_key, content='directories', content_rowid='id',
    tokenize='trigram case_sensitive 1', detail=full
);
CREATE TRIGGER directories_insert AFTER INSERT ON directories BEGIN
    INSERT INTO directory_fts(rowid, path_key) VALUES (new.id, new.path_key);
    UPDATE generations SET indexed_count = indexed_count + 1 WHERE id = new.generation_id;
END;
CREATE TRIGGER directories_delete AFTER DELETE ON directories BEGIN
    INSERT INTO directory_fts(directory_fts, rowid, path_key) VALUES ('delete', old.id, old.path_key);
    UPDATE generations SET indexed_count = indexed_count - 1 WHERE id = old.generation_id;
END;
CREATE TRIGGER directories_update AFTER UPDATE ON directories BEGIN
    INSERT INTO directory_fts(directory_fts, rowid, path_key) VALUES ('delete', old.id, old.path_key);
    INSERT INTO directory_fts(rowid, path_key) VALUES (new.id, new.path_key);
    UPDATE generations SET indexed_count = indexed_count - 1 WHERE id = old.generation_id;
    UPDATE generations SET indexed_count = indexed_count + 1 WHERE id = new.generation_id;
END;
