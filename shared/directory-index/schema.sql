PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA application_id = 1396853073;
PRAGMA user_version = 5;
PRAGMA foreign_keys = ON;

CREATE TABLE generations (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    state TEXT NOT NULL CHECK (state IN ('building', 'accepted')),
    coverage TEXT NOT NULL CHECK (coverage IN ('partial', 'complete', 'uncertain')),
    indexed_count INTEGER NOT NULL DEFAULT 0 CHECK (indexed_count >= 0),
    issue_count INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
    scan_pass_id INTEGER NOT NULL DEFAULT 0 CHECK (scan_pass_id >= 0),
    scan_active INTEGER NOT NULL DEFAULT 0 CHECK (scan_active IN (0, 1))
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
    last_access_at_ms INTEGER NOT NULL CHECK (last_access_at_ms >= 0),
    clean_shutdown INTEGER NOT NULL DEFAULT 0 CHECK (clean_shutdown IN (0, 1))
) STRICT;

CREATE TABLE directories (
    id INTEGER PRIMARY KEY,
    generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES directories(id) ON DELETE CASCADE ON UPDATE CASCADE,
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
CREATE INDEX directories_parent ON directories(generation_id, parent_id);

CREATE TABLE scan_queue (
    generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0, 1)),
    file_id BLOB CHECK (file_id IS NULL OR length(file_id) IN (8, 16)),
    PRIMARY KEY (generation_id, path)
) STRICT;
CREATE INDEX scan_queue_pending ON scan_queue(generation_id, processed);

CREATE TABLE scan_snapshot_children (
    generation_id INTEGER NOT NULL,
    parent_path TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (generation_id, parent_path, path),
    FOREIGN KEY (generation_id, parent_path) REFERENCES scan_queue(generation_id, path) ON DELETE CASCADE
) STRICT;

CREATE TABLE coverage_issues (
    generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (code IN ('access_denied', 'unsupported_encoding',
        'unsafe_traversal', 'identity_unverified', 'event_loss', 'scan_failed')),
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (generation_id, code)
) STRICT;

CREATE TRIGGER directories_insert AFTER INSERT ON directories BEGIN
    INSERT INTO directory_fts(rowid, path_key) VALUES (new.id, new.path_key);
    UPDATE generations SET indexed_count = indexed_count + 1 WHERE id = new.generation_id;
END;
CREATE TRIGGER directories_delete AFTER DELETE ON directories BEGIN
    DELETE FROM scan_queue WHERE generation_id = old.generation_id AND path = old.path;
    INSERT INTO directory_fts(directory_fts, rowid, path_key) VALUES ('delete', old.id, old.path_key);
    UPDATE generations SET indexed_count = indexed_count - 1 WHERE id = old.generation_id;
END;
CREATE TRIGGER directories_update AFTER UPDATE ON directories BEGIN
    INSERT INTO directory_fts(directory_fts, rowid, path_key) VALUES ('delete', old.id, old.path_key);
    INSERT INTO directory_fts(rowid, path_key) VALUES (new.id, new.path_key);
    UPDATE generations SET indexed_count = indexed_count - 1 WHERE id = old.generation_id;
    UPDATE generations SET indexed_count = indexed_count + 1 WHERE id = new.generation_id;
END;
