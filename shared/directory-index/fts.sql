CREATE VIRTUAL TABLE IF NOT EXISTS directory_fts USING fts5(
    path_key, content='directories', content_rowid='id',
    tokenize='trigram case_sensitive 1', detail=full
);
