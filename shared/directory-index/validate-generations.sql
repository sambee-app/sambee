SELECT (SELECT count(*) FROM generations) <> 1 OR NOT EXISTS (
    SELECT 1 FROM source_metadata AS metadata
    JOIN generations AS generation ON generation.id = metadata.selected_generation
    WHERE metadata.id = 1 AND generation.state IN ('building', 'accepted')
) OR EXISTS (
    SELECT 1 FROM generations AS generation
    WHERE generation.indexed_count <> (
        SELECT count(*) FROM directories WHERE generation_id = generation.id
    ) OR generation.issue_count <> coalesce((
        SELECT sum(count) FROM coverage_issues WHERE generation_id = generation.id
    ), 0)
    OR (generation.coverage = 'complete' AND generation.issue_count <> 0)
    OR (generation.state = 'building' AND generation.coverage = 'complete')
    OR (generation.scan_active = 1 AND (generation.scan_pass_id = 0
        OR generation.id <> (SELECT selected_generation FROM source_metadata WHERE id = 1)))
) OR EXISTS (
    SELECT 1 FROM directories AS child
    JOIN directories AS parent ON parent.id = child.parent_id
    WHERE child.generation_id <> parent.generation_id
        OR substr(child.path, 1, length(parent.path) + 1) <> parent.path || '/'
        OR instr(substr(child.path, length(parent.path) + 2), '/') <> 0
) OR EXISTS (
    SELECT 1 FROM scan_snapshot_children AS snapshot
    JOIN scan_queue AS parent ON parent.generation_id = snapshot.generation_id AND parent.path = snapshot.parent_path
    WHERE parent.processed <> 0 OR length(snapshot.path) = 0
        OR (snapshot.parent_path = '' AND instr(snapshot.path, '/') <> 0)
        OR (snapshot.parent_path <> '' AND (
            substr(snapshot.path, 1, length(snapshot.parent_path) + 1) <> snapshot.parent_path || '/'
            OR instr(substr(snapshot.path, length(snapshot.parent_path) + 2), '/') <> 0
        ))
);
