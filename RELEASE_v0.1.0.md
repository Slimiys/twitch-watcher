# Twitch Watcher v0.1.0 - Initial Release

**Release Date:** December 7, 2025

## Overview

Initial release of Twitch Watcher - an automated application for watching Twitch streams to earn channel points and game drops. This release includes core functionality with two operation modes, health checks, and comprehensive documentation.

## Key Features

### Core Functionality
- Automatic watching of priority Twitch streamers
- API Mode: Headless operation without browser, low resource consumption, instant WebSocket event handling
- Puppeteer Mode: Browser automation with screenshot support
- Automatic collection of channel point bonus chests
- Real-time viewing statistics and earned points tracking
- Token-based authentication
- Proxy support

### Health Checks and Monitoring
- HTTP health check endpoint at `/health`
- Component status monitoring (WebSocket, API, Token, Watching activity)
- Performance metrics tracking
- Automatic health status reporting

### Infrastructure
- Full TypeScript implementation
- Docker support with Docker Compose
- Git Flow workflow with conventional commits
- Cross-platform support (Windows, Linux, Android)

## Installation

```bash
git clone https://github.com/Slimiys/twitch-watcher.git
cd twitch-watcher
npm install
npm run build
npm start
```

## Documentation

See the `docs/` folder for comprehensive documentation including configuration guides, Docker setup, and development roadmap.

## Breaking Changes

None - this is the initial release.

## Known Issues

- Health checks are currently only available in API mode
- Puppeteer mode requires browser installation

## Links

- [Full Release Notes](RELEASE_NOTES.md)
- [Documentation](docs/)
- [GitHub Repository](https://github.com/Slimiys/twitch-watcher)

