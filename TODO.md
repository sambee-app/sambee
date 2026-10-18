# TODO

## Misc. commands

- Add a command to open the current file list location in a new browser tab (which keyboard shortcut to assign? Ctrl+(Shift)+Tab is needed by the browser)

## File list

- Settings > File browser: add a setting to control whether dot directories are shown in the list
- Dual-pane mode: Ctrl+left/right to change the location (connection+path) of the left pane to that of the right pane and vice-versa

## Companion

- Allow auto-updates on Windows without UAC prompts (admin rights)
   - Tauri doesn't have an update service that could be run with elevated privileges.
   - Auto-updating is, therefore, only possible for per-user installations.
   - The NSIS installer is currently configured in `both` mode.
      - Caveat:
         - This mode requires admin rights even for per-user installations ([docs](https://v2.tauri.app/reference/config/#nsisinstallermode)).
         - Reason: The NSIS installer executable has the "require elevation" flag in `both` mode, so it needs elevation to even start.

## Image viewer

- Support multi-page image files:
  - TIFF
  - ICO (test with uberAgent icon)

- Additional formats
   - DCM (medical image format)

## Storage

- Plugin system to support additional backends like S3 or SFTP
   - Every backend must use the new system.
   - This means we need to move the existing storage support (SMB and local drives) to the new system.

## Audio & video players

- MP3 files should be easy
- Videos probably need more dependencies

## Public upload & download links

### Issue

The Sambee backend (container) is designed to be run in an internal network, not exposed to the internet. That prevents file sharing with people who don't have access to the internal network.

### Proposal

#### File sharing service and container

Create a hardened container to be exposed to the internet. This container runs a publicly accessible file sharing service. The public container has no access to Sambee, only the other way round: When files are shared in Sambee, they are copied to the public container. Files uploaded to the public container are pulled in from Sambee.

Files stored on the public container are always end-to-end encrypted. The encryption keys are not stored on the public container. Thus, when the public container is compromised, its data is useless to attackers because the cannot decrypt it.

#### Download links

Files to be shared via download links are encrypted by Sambee. Each sharing operation uses a new, random encryption key. Encryption keys are stored by Sambee so they can be re-shared.

After encryption, Sambee uploads a file to be shared to the public container along with necessary metadata.

Sharing links include the encryption key, so users can access shared files without having to fumble with keys: decryption happens transparently upon access/download in the user's browser.

#### Upload links

Upload links are created in Sambee. They are tied to a specific directory on SMB storage. Access to that directory from the Sambee backends happens with the credentials of the user creating the link.

When an upload link is created in Sambee, the backend communicates the metadata to the public container which then accepts uploads from the internet via the upload link. Uploads are encrypted in the user's browser and stored encrypted on the public container. The public container doesn't store the decryption key. Sambee periodically pulls in new uploads from the public container.

#### User-configurable sharing options

- Time limit: after which shared data is deleted by the public container
- Password: if set, it is combined with the random encryption key. Decryption needs the key (shared via the link) and the password. This enables secure sharing where the link alone is not sufficient to decrypt the data.
- Download links:
   - Max. download count
- Upload links:
   - Max. size
