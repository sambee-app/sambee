+++
title = "Deploy Sambee with Docker"
+++

## Before You Start

You need:

- Docker and `docker compose` installed.
- A host that can reach the SMB file servers Sambee will use.
- A deployment directory where you can keep local files such as `docker-compose.yml`, optional `config.toml`, and the persistent `data/` directory.

You do not need to clone the repository or build Sambee locally for a normal Docker deployment. Sambee publishes ready-to-run container images to GitHub Container Registry.

## 1. Create a Deployment Directory

Create a dedicated directory for your local deployment files and move into it:

```bash
mkdir -p sambee
cd sambee
```

This directory will hold your Compose file, optional configuration file, and persistent application data.

## 2. Prepare Persistent Storage

Create the local data directory and set ownership to user and group ID `1000`, which the containerized application uses:

```bash
mkdir -p ./data
chown -Rfv 1000:1000 ./data
```

This directory contains the Sambee database and other state that must survive restarts, rebuilds, and host reboots.

## 3. Create the Compose File

Create `docker-compose.yml` with this content:

```yaml
services:
  sambee:
    image: ghcr.io/helgeklein/sambee:stable
    restart: unless-stopped
    volumes:
      - ./data:/app/data
      # Optional: uncomment when you create config.toml locally.
      # - ./config.toml:/app/config.toml:ro
    ports:
      - 8000:8000
```

#### Select a Release Channel

Sambee has three different release channels. You select which to follow via the Docker image tag:

- `stable` for the production channel.
- `beta` for prerelease builds.
- `test` for preview builds.

{{< admonition type="tip" >}}
While Sambee is in beta, the `stable` tag may not be available yet.
{{< /admonition >}}

## 4. Optional: Create a Local Configuration File

You do not need `config.toml` for a basic deployment. Create it only if you need to override defaults such as authentication, logging, or Companion download settings.

Create `config.toml` with only the settings you want to change. For example:

```toml
[app]
log_level = "INFO"

[security]
auth_method = "password"

[admin]
username = "admin"
```

If you create `config.toml`, uncomment the read-only bind mount in `docker-compose.yml`.

Keep this file local. In production, mount it read-only.

## 5. Pull and Start Sambee

Pull the configured image:

```bash
docker compose pull
```

Then start the application:

```bash
docker compose up -d
```

By default, the service is available at:

- Frontend: `http://localhost:8000`
- Backend API: `http://localhost:8000/api`
- API docs: `http://localhost:8000/docs`

## Verify the Deployment

Before moving on, confirm that the deployment really came up cleanly.

- The `docker compose ps` output shows the `sambee` service running.
- The frontend URL responds on the expected host port.
- The startup logs do not show an obvious failure loop.

For a quick log review:

```bash
docker compose logs sambee --tail 100
```

Once the deployment is healthy, continue with the first login procedure on the next page.
