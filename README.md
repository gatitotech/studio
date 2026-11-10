<div align="center">
  <img src="./assets/banner.svg" alt="Gatita Studio — Your terminal. Her territory.">

  <h1>Gatita Studio</h1>

  <p><strong>A full-screen terminal coding agent you run from your shell.</strong></p>

  <p>
    <a href="https://github.com/gatitotech/studio/stargazers"><img src="https://img.shields.io/github/stars/gatitotech/studio?style=for-the-badge&label=stars&labelColor=171a21&color=f2b35c&logo=github&logoColor=e8e4dc" alt="Stars"></a>
    <a href="https://github.com/gatitotech/studio/network/members"><img src="https://img.shields.io/github/forks/gatitotech/studio?style=for-the-badge&label=forks&labelColor=171a21&color=e58b8b&logo=github&logoColor=e8e4dc" alt="Forks"></a>
    <a href="https://github.com/gatitotech/studio/releases"><img src="https://img.shields.io/github/downloads/gatitotech/studio/total?style=for-the-badge&label=downloads&labelColor=171a21&color=86b9d8&logo=github&logoColor=e8e4dc" alt="Downloads"></a>
    <a href="https://github.com/gatitotech/studio/releases/latest"><img src="https://img.shields.io/github/v/release/gatitotech/studio?style=for-the-badge&label=release&labelColor=171a21&color=8fc98f&logo=github&logoColor=e8e4dc" alt="Latest release"></a>
    <img src="https://img.shields.io/github/license/gatitotech/studio?style=for-the-badge&label=license&labelColor=171a21&color=1e222b" alt="License">
  </p>
</div>

---

## Overview

Gatita Studio is the open-source **client** for Gatita Studio. It gives your terminal an interactive, tool-using coding agent with a full-screen interface, task routing, planning mode, and a composer built for real workflows.

This repository is the client. It does **not** include a hosted inference service or the server-side control plane. The hosted API and its availability are provided by Gatita.

> Forks are welcome. Forks may not get access to the hosted Gatita API; modifying the client is free, but service availability is not open-sourced.

## Highlights

- **Full-screen terminal UI** with responsive layouts, mouse selection, drag/copy, and keyboard-first navigation.
- **Tool use in the terminal**: read/search code, edit files, run commands, search the web, install MCP tools, load plugins, and keep a task list.
- **Plan mode** for thinking first: Gatita asks clarifying questions, builds a detailed implementation plan, and waits for you to approve it before mutating your project.
- **Work details on demand**: finished tool calls collapse out of your way; inspect them with one key or one click when you need to.
- **Steering while it works**: type while Gatita is running; your message is injected after the next safe tool boundary.
- **Reasoning, compactly**: thinking is hidden by default and revealed deliberately.
- **Long-running jobs**: start dev servers, watchers, tests, and long builds without fake timeouts.


## Requirements

- Node.js **24 or newer**
- A terminal with TTY support
- A Gatita account for the hosted API

## Install

### Latest release

```bash
curl -fL -o gatita-studio-latest.tgz \
  https://github.com/gatitotech/studio/releases/latest/download/gatita-studio-latest.tgz
npm install -g ./gatita-studio-latest.tgz
```

Verify it works:

```bash
which gst
gst --version
gst doctor
```

### Alternative download

If you need a non-releases mirror, the same client build is normally also available at:

```bash
https://api.gatita.tech/studio/download/gatita-studio-latest.tgz
```

Availability of that mirror depends on the maintainers keeping it synchronized with the GitHub release. The GitHub Release is the authoritative distribution point.

### From source

```bash
git clone https://github.com/gatitotech/studio.git
cd studio
npm install
npm start
```

## Verify integrity

Every release should publish a `SHA256SUMS` file alongside the tarball.

```bash
curl -fL -o gatita-studio-latest.tgz \
  https://github.com/gatitotech/studio/releases/latest/download/gatita-studio-latest.tgz
curl -fL -o SHA256SUMS \
  https://github.com/gatitotech/studio/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

## First run

```bash
# sign in (creates a local session)
gatita-studio login
# or the short alias
gst
```

Useful commands:

```bash
gst --version     # print the client version
gst login         # sign in again
gst models        # list available models for your account
gst usage         # show usage and limits
gst mcp discover  # find local MCP servers
gst doctor        # check the install
```

## Open source

This project is licensed under the **GNU General Public License v3.0 only**. See [`LICENSE`](./LICENSE).

Forks and modifications are permitted under the license terms. API access, quotas, and account availability remain controlled by the hosted Gatita service.

## Security

Please report vulnerabilities privately to the maintainers through GitHub’s private vulnerability reporting if it is enabled for this repository. Do not use a public issue for a security report.
