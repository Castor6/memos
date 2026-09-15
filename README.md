# Memos

## Personal fork / 个人定制

This personal fork of [usememos/memos](https://github.com/usememos/memos) starts from **v0.30.0**, uses `main` for customization, and selectively imports upstream changes through pull requests.
Start with [协作与开发入口](docs/README.md) for task records, local development, and browser verification.
See [个人定制与自动部署记录](docs/customization-and-deployment.zh-CN.md) for the maintenance approach,
deployment proposal, ACR pricing and usage limits, and outstanding verification work.

Report issues and discuss improvements in [Castor6/memos Issues](https://github.com/Castor6/memos/issues).
Custom releases are not configured yet; the installation commands below install upstream Memos.

<img align="right" height="96px" src="https://raw.githubusercontent.com/usememos/.github/refs/heads/main/assets/logo-rounded.png" alt="Memos" />

Memos is an open-source, self-hosted note-taking app built for quick capture. It is Markdown-native, lightweight, and keeps your data under your control.

[![Home](https://img.shields.io/badge/🏠-usememos.com-blue?style=flat-square)](https://usememos.com)
[![Live Demo](https://img.shields.io/badge/✨-Try%20Demo-orange?style=flat-square)](https://demo.usememos.com/)
[![Docs](https://img.shields.io/badge/📚-Documentation-green?style=flat-square)](https://usememos.com/docs)
[![Discord](https://img.shields.io/badge/💬-Discord-5865f2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/tfPJa4UmAv)
[![Docker Pulls](https://img.shields.io/docker/pulls/neosmemo/memos?style=flat-square&logo=docker)](https://hub.docker.com/r/neosmemo/memos)

<img src="https://raw.githubusercontent.com/usememos/.github/refs/heads/main/assets/demo.png" alt="Memos Demo Screenshot" height="512" />

## Features

- **Capture quickly** — A timeline-first interface keeps note-taking simple: open, write, and move on.
- **Own your data** — Self-host Memos on your infrastructure with no telemetry.
- **Deploy anywhere** — Run a single Go binary or Docker container with SQLite, MySQL, or PostgreSQL.
- **Integrate freely** — Build on the REST and gRPC APIs or adapt the MIT-licensed source to your needs.

## Upstream Quick Start

Want to explore Memos first? Open the [live demo](https://demo.usememos.com/).

### Docker (Recommended)

```bash
docker run -d \
  --name memos \
  -p 5230:5230 \
  -v ~/.memos:/var/opt/memos \
  neosmemo/memos:stable
```

Open `http://localhost:5230` and start writing.

### Native Binary

```bash
curl -fsSL https://raw.githubusercontent.com/usememos/memos/main/scripts/install.sh | sh
```

### Other Installation Methods

- **Docker Compose** — Recommended for production deployments.
- **Kubernetes** — Helm charts and manifests are available.
- **Build from source** — Best for development and customization.

See the [deployment guide](https://usememos.com/docs/deploy) for detailed instructions.

## Web Clipper

Save pages, selected text, and images directly to your Memos instance with the official [Memos Web Clipper](https://github.com/usememos/web-clipper). The extension is available for [Chrome](https://chromewebstore.google.com/detail/memos-web-clipper/nebaoebnljalfegiidibihhkebeiklbl) and [Firefox](https://addons.mozilla.org/en-US/firefox/addon/memos-web-clipper/), and lets you review each clip, choose its visibility, and customize its Markdown format before saving.

## Contributing

Use this fork's issue tracker and pull requests for personal customizations and fixes.

- [Report bugs](https://github.com/Castor6/memos/issues/new?template=bug_report.yml)
- [Suggest features](https://github.com/Castor6/memos/issues/new?template=feature_request.yml)
- [Submit pull requests](https://github.com/Castor6/memos/pulls)
- [Development and task records](docs/README.md)

For the original project, see [upstream Memos](https://github.com/usememos/memos) and its [documentation](https://usememos.com/docs).

## License

Memos is open-source software licensed under the [MIT License](LICENSE). See our [Privacy Policy](https://usememos.com/privacy) for details on data handling.

---

**[Website](https://usememos.com)** • **[Documentation](https://usememos.com/docs)** • **[Demo](https://demo.usememos.com/)** • **[Discord](https://discord.gg/tfPJa4UmAv)** • **[X/Twitter](https://x.com/usememos)**
