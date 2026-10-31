# Archive Inspection Semantics V2

Inspection parses a ZIP central directory without staging member contents. Each member path is normalized by converting backslashes to slashes and removing a trailing directory separator. A path is safe only when it is non-empty, relative, contains no NUL, `.` or `..` segment, empty segment, or colon.

Entries retain archive order. Presentation adapters may derive a bounded virtual-directory page, ordered with directories first and then NFC case-folded name order.

A preview is eligible only for a safe, supported regular file that is not encrypted and uses Stored (0), Deflate (8), or BZIP2 (12). There is no archive-specific preview size limit. Server-side conversion uses the configured conversion limits; downloads remain streamed. Invalid central-directory, ZIP64, member-header, and integrity records are reported as `format_error`; unavailable codecs and encryption are `unavailable_member`; unsafe or missing member paths are `invalid_member_path`.
