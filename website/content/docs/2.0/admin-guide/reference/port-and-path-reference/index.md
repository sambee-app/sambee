+++
title = "Port and Path Reference"
+++

This is the main lookup page for Sambee service ports, deployment files, persistent paths, and container-side paths.

## Service Ports and URLs

| Item | Default value | Notes |
|---|---|---|
| Sambee application port | `8000` | Default application port in the sample deployment |
| Frontend URL | `http://localhost:8000` | Default direct-access frontend URL |
| Backend API | `http://localhost:8000/api` | Default API path |

## Deployment Files and Paths

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Local deployment definition |
| `config.toml` | Optional local configuration file |
| `data/` | Persistent application data directory that must be backed up |
| `data/sambee.db` | SQLite database containing users, connections, security keys, and encrypted passwords |
| `data/directory_cache/` | Default location for Sambee's saved directory index when the relative cache setting is used |

## Container-Side Paths

| Path | Purpose |
|---|---|
| `/app/data` | Container-side mount point for persistent data |
| `/app/data/sambee.db` | Container-side database path |
| `/app/config.toml` | Container-side path for the optional mounted config file |
| `/app/data/directory_cache/` | Default container-side location for the saved directory index |

## Host-to-Container Mapping

- Host-side `./data` becomes `/app/data` in the container.
- Host-side `./config.toml` can be mounted read-only as `/app/config.toml`.
- Deleting or replacing files under `data/` changes persistent deployment state, not just temporary cache files.
