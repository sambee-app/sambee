"""Name matching for live file-system search."""

import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


def _load_casefold_table() -> dict[int, str]:
    paths = tuple(Path(__file__).resolve().parents[level] / "shared" / "filesystem-search" / "casefold.json" for level in (3, 2))
    path = next((candidate for candidate in paths if candidate.is_file()), paths[0])
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or type(document.get("version")) is not int or document["version"] != 1:
        raise ValueError("File-system search case-folding data is invalid. Restore the shared data file.")
    entries = document.get("casefold")
    if not isinstance(entries, list):
        raise ValueError("File-system search case-folding data is invalid. Restore the shared data file.")
    table: dict[int, str] = {}
    for entry in entries:
        if (
            not isinstance(entry, list)
            or len(entry) != 2
            or not isinstance(entry[0], str)
            or len(entry[0]) != 1
            or not isinstance(entry[1], str)
            or not entry[1]
            or ord(entry[0]) in table
        ):
            raise ValueError("File-system search case-folding data is invalid. Restore the shared data file.")
        table[ord(entry[0])] = entry[1]
    return table


_CASEFOLD_TABLE = _load_casefold_table()


class _TokenKind(Enum):
    LITERAL = "literal"
    ANY = "any"
    STAR = "star"


@dataclass(frozen=True)
class _Token:
    kind: _TokenKind
    value: str = ""


class NameMatcher:
    """Parse one query and match base names without regular-expression backtracking."""

    def __init__(self, query: str, *, case_sensitive: bool) -> None:
        if not query.strip():
            raise ValueError("Enter a search term that is not empty or only whitespace.")
        self._case_sensitive = case_sensitive
        tokens: list[_Token] = []
        literal: list[str] = []
        is_pattern = False

        def append_literal() -> None:
            if literal:
                text = "".join(literal)
                tokens.append(_Token(_TokenKind.LITERAL, text if case_sensitive else text.translate(_CASEFOLD_TABLE)))
                literal.clear()

        position = 0
        while position < len(query):
            character = query[position]
            if character == "\\" and position + 1 < len(query) and query[position + 1] in "*?\\":
                literal.append(query[position + 1])
                position += 2
                continue
            if character in "*?":
                is_pattern = True
                append_literal()
                kind = _TokenKind.STAR if character == "*" else _TokenKind.ANY
                if kind is not _TokenKind.STAR or not tokens or tokens[-1].kind is not _TokenKind.STAR:
                    tokens.append(_Token(kind))
            else:
                literal.append(character)
            position += 1
        append_literal()
        self._tokens = tuple(tokens)
        self._plain = None if is_pattern else tokens[0].value

    def matches(self, name: str) -> bool:
        if self._plain is not None:
            return self._plain in (name if self._case_sensitive else name.translate(_CASEFOLD_TABLE))

        folded_parts = [character if self._case_sensitive else character.translate(_CASEFOLD_TABLE) for character in name]
        folded = "".join(folded_parts)
        boundaries = [0]
        for part in folded_parts:
            boundaries.append(boundaries[-1] + len(part))
        positions = {offset: position for position, offset in enumerate(boundaries)}
        name_position = 0
        token_position = 0
        star_position: int | None = None
        star_name_position = 0
        while name_position < len(name):
            if token_position < len(self._tokens):
                token = self._tokens[token_position]
                if token.kind is _TokenKind.ANY:
                    name_position += 1
                    token_position += 1
                    continue
                if token.kind is _TokenKind.LITERAL:
                    start = boundaries[name_position]
                    end = start + len(token.value)
                    next_position = positions.get(end)
                    if next_position is not None and folded.startswith(token.value, start):
                        name_position = next_position
                        token_position += 1
                        continue
                if token.kind is _TokenKind.STAR:
                    star_position = token_position
                    star_name_position = name_position
                    token_position += 1
                    continue
            if star_position is None or star_name_position == len(name):
                return False
            star_name_position += 1
            name_position = star_name_position
            token_position = star_position + 1
        while token_position < len(self._tokens) and self._tokens[token_position].kind is _TokenKind.STAR:
            token_position += 1
        return token_position == len(self._tokens)
