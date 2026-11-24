"""Shared V2 ZIP reader conformance fixture checks for the backend parser."""

import hashlib
import json
from pathlib import Path

import pytest

from app.services.archive.zip_reader import ArchiveFormatError, ArchiveInspectionManifestMember, ZipEntry, ZipReader

CORPUS_ROOT = Path(__file__).resolve().parents[2] / "archive_testdata"
INSPECTION_CORPUS_PATH = Path(__file__).resolve().parents[2] / "archive-contract" / "v2" / "fixtures" / "inspection-scenarios-v2.json"
COMPATIBILITY_CORPUS_PATH = Path(__file__).resolve().parents[2] / "archive-contract" / "v2" / "fixtures" / "zip-compatibility-recovery.json"


class FileRandomAccessReader:
    def __init__(self, path: Path) -> None:
        self._data = path.read_bytes()

    async def read_at(self, offset: int, length: int) -> bytes:
        return self._data[offset : offset + length]

    async def close(self) -> None:
        return None


async def _read_entries(reader: ZipReader) -> list[ZipEntry]:
    entries: list[ZipEntry] = []
    while (entry := await reader.next_entry()) is not None:
        entries.append(entry)
    return entries


@pytest.mark.asyncio
async def test_zip64_directory_size_accessor() -> None:
    fixture_path = CORPUS_ROOT / "zip64-v2.zip"
    data = fixture_path.read_bytes()
    zip64_eocd = data.index(b"PK\x06\x06")
    expected_size = int.from_bytes(data[zip64_eocd + 40 : zip64_eocd + 48], "little")
    reader = ZipReader(FileRandomAccessReader(fixture_path), len(data))

    assert await reader.central_directory_size() == expected_size
    assert [entry.path for entry in (await reader.effective_projection()).entries] == ["zip64.txt"]


def _inspection_member(entry: ZipEntry) -> ArchiveInspectionManifestMember:
    return ArchiveInspectionManifestMember(
        path=entry.path,
        is_directory=entry.is_directory,
        compressed_size=entry.compressed_size,
        uncompressed_size=entry.uncompressed_size,
        compression_method=entry.compression_method,
        crc32=entry.crc32,
        modified_at=entry.modified_at,
        encrypted=entry.encrypted,
        is_safe=entry.is_safe,
        has_supported_file_type=entry.has_supported_file_type,
    )


@pytest.mark.asyncio
async def test_v2_zip_reader_conformance_corpus() -> None:
    manifest = json.loads((CORPUS_ROOT / "manifest-v2.json").read_text())
    assert manifest["version"] == 2

    for fixture in manifest["fixtures"]:
        fixture_path = CORPUS_ROOT / fixture["name"]
        data = fixture_path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == fixture["sha256"]
        if fixture.get("expected_error") == "format_error":
            with pytest.raises(ArchiveFormatError):
                reader = ZipReader(FileRandomAccessReader(fixture_path), len(data))
                await reader.next_entry()
            continue
        reader = ZipReader(FileRandomAccessReader(fixture_path), len(data))
        entries = await _read_entries(reader)
        expected_entries = fixture["entries"]
        assert len(entries) == len(expected_entries)
        for entry, expected in zip(entries, expected_entries, strict=True):
            assert entry.raw_name.hex() == expected["raw_name_hex"]
            assert entry.path == expected["path"]
            assert entry.is_directory is expected["directory"]
            assert entry.compression_method == expected["method"]
            assert entry.uncompressed_size == expected["uncompressed_size"]
            assert entry.is_safe is expected["safe"]
            assert bool(entry.flags & 0x0008) is expected["data_descriptor"]
            if expected["safe"] and expected["member_sha256"] is not None:
                member = b"".join([chunk async for chunk in reader.stream_entry(entry)])
                assert hashlib.sha256(member).hexdigest() == expected["member_sha256"]


@pytest.mark.asyncio
async def test_zip_compatibility_recovery_corpus() -> None:
    corpus = json.loads(COMPATIBILITY_CORPUS_PATH.read_text())
    assert corpus["version"] == 1

    for fixture in corpus["fixtures"]:
        fixture_path = CORPUS_ROOT / fixture["name"]
        data = fixture_path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == fixture["sha256"]
        reader = ZipReader(FileRandomAccessReader(fixture_path), len(data))
        entries = await _read_entries(reader)
        assert len(entries) == len(fixture["members"])
        for entry, expected in zip(entries, fixture["members"], strict=True):
            assert entry.raw_name.hex() == expected["raw_name_hex"]
            assert entry.path == expected["path"]
            assert entry.compression_method == expected["method"]
            if expected["outcome"] == "accepted":
                member = b"".join([chunk async for chunk in reader.stream_entry(entry)])
                assert hashlib.sha256(member).hexdigest() == expected["member_sha256"]
            else:
                with pytest.raises(ArchiveFormatError):
                    _ = [chunk async for chunk in reader.stream_entry(entry)]


@pytest.mark.asyncio
async def test_v2_inspection_scenarios() -> None:
    corpus = json.loads(INSPECTION_CORPUS_PATH.read_text())
    assert corpus["version"] == 2
    for scenario in corpus["scenarios"]:
        data = (CORPUS_ROOT / scenario["fixture"]).read_bytes()
        if scenario.get("error") == "format_error":
            with pytest.raises(ArchiveFormatError):
                reader = ZipReader(FileRandomAccessReader(CORPUS_ROOT / scenario["fixture"]), len(data))
                await reader.inspection_page(None, 500)
            continue
        reader = ZipReader(FileRandomAccessReader(CORPUS_ROOT / scenario["fixture"]), len(data))
        entries = await _read_entries(reader)
        assert [
            {
                "path": member.path,
                "is_directory": member.is_directory,
                "compression_method": member.compression_method,
                "uncompressed_size": member.uncompressed_size,
                "is_safe": member.is_safe,
                "preview_state": member.preview_state,
                "inline_preview_eligible": member.is_inline_preview_eligible(),
            }
            for entry in entries
            for member in [_inspection_member(entry)]
        ] == scenario["entries"]
