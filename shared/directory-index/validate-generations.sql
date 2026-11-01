SELECT NOT EXISTS (
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
);
