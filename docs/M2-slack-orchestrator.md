# M2 — Harry Botter Slack Orchestrator

## Overview

The orchestrator is the master Slack app that receives `/harrybotter` slash commands and provisions per-user Slack apps via the Manifest API. Each user gets their own bot identity ("Harry Botter (username)") backed by a NanoClaw pod.

## Prerequisites

- Node.js 20+
- A Slack workspace where you can create apps
- Slack admin access (for app approval)

## Creating the Master Slack App

### 1. Create the App

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From scratch**
3. Name: `Harry Botter` (or whatever you prefer)
4. Select your workspace

### 2. Enable Socket Mode

1. Go to **Settings** → **Socket Mode**
2. Enable Socket Mode
3. Create an app-level token with `connections:write` scope
4. Save the token as `SLACK_APP_TOKEN` (starts with `xapp-`)

### 3. Add Slash Command

1. Go to **Features** → **Slash Commands**
2. Create: `/harrybotter`
   - Description: "Manage your Harry Botter instance"
   - Usage hint: "create | destroy | status"

### 4. Bot Token Scopes

Go to **Features** → **OAuth & Permissions** → **Bot Token Scopes**:

- `chat:write` — Send messages
- `commands` — Handle slash commands

### 5. Install to Workspace

1. Go to **Settings** → **Install App**
2. Install to your workspace
3. Copy the Bot User OAuth Token as `SLACK_BOT_TOKEN` (starts with `xoxb-`)

### 6. Get App Configuration Token (for Manifest API)

The App Configuration Token lets the orchestrator create/delete Slack apps programmatically.

1. Go to https://api.slack.com/reference/manifests#config-tokens
2. Click **Generate Token**
3. Select your workspace
4. Save as `SLACK_APP_CONFIGURATION_TOKEN` (starts with `xoxe-`)

> **Note:** App Configuration Tokens have a rotation mechanism. The token includes a refresh token. The orchestrator should handle 401 responses by rotating. This is tracked for a future milestone.

## Running Locally

```bash
cd orchestrator
cp .env.example .env
# Fill in your tokens in .env

npm install
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `/harrybotter create` | Create your personal bot instance |
| `/harrybotter destroy` | Destroy your bot instance |
| `/harrybotter status` | Check your bot's status |
| `/harrybotter` (no args) | Show help |

## Architecture

```
User → /harrybotter create
  → Orchestrator checks registry (SQLite)
  → Calls apps.manifest.create (Slack API)
  → Stores app_id, pod_name in registry
  → Responds with bot info
  → (M3) Provisions K8s pod
```

## Docker

```bash
# From project root
docker build -f docker/Dockerfile.orchestrator -t harry-botter-orchestrator .
docker run --env-file orchestrator/.env harry-botter-orchestrator
```

## Database

SQLite with WAL mode. Tables:

- `user_bots` — One row per user, tracks app_id, pod_name, status
- `token_rotations` — Audit log of token rotations

## Known Limitations (M2)

- No actual K8s pod provisioning (placeholder — M3)
- No OAuth install flow for per-user apps (bot_token is empty until M3)
- No token rotation for app configuration token
- No rate limiting on slash commands
