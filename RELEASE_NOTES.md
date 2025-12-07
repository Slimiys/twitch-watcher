# Release Notes

## Version 0.1.0 - Initial Release

**Release Date:** December 7, 2025

### Overview

This is the initial release of Twitch Watcher, an automated application for watching Twitch streams to earn channel points and game drops. The application supports two operation modes: API mode (headless, recommended) and Puppeteer mode (browser automation).

### Features

#### Core Functionality
- Automatic watching of priority Twitch streamers
- Two operation modes:
  - **API Mode**: Headless operation without browser, low resource consumption, instant WebSocket event handling
  - **Puppeteer Mode**: Browser automation with screenshot support
- Automatic collection of channel point bonus chests
- Real-time viewing statistics and earned points tracking
- Token-based authentication (auth-token)
- Proxy support for network configuration

#### Health Checks and Monitoring
- HTTP health check endpoint (`/health`)
- Component status monitoring:
  - WebSocket connection status
  - Twitch GraphQL API availability
  - Token validation
  - Active watching activity
- Performance metrics tracking
- Automatic health status reporting

#### Development and Infrastructure
- Full TypeScript implementation with type safety
- Docker support with Docker Compose configuration
- Git Flow workflow with conventional commits
- Comprehensive documentation
- Cross-platform support (Windows, Linux, Android via Termux)

### Technical Details

#### Dependencies
- Node.js 18+
- TypeScript 5.9.3
- WebSocket support via `ws` library
- Puppeteer Core for browser automation (Puppeteer mode only)
- Day.js for date/time handling

#### Configuration
- Environment variable based configuration
- Support for multiple priority channels
- Configurable logging levels (verbose, normal, minimal)
- Health check port configuration (default: 3000)

### Documentation

Comprehensive documentation is available in the `docs/` folder:
- Configuration guide
- Environment variables reference
- Docker setup instructions
- Android setup guide
- Git Flow workflow documentation
- Development roadmap

### Installation

```bash
# Clone repository
git clone https://github.com/Slimiys/twitch-watcher.git
cd twitch-watcher

# Install dependencies
npm install

# Build project
npm run build

# Start application
npm start
```

### Docker Quick Start

```bash
# Copy example configuration
cp docker-compose-example.yml docker-compose.yml

# Edit docker-compose.yml with your settings
# Then start:
docker-compose up -d
```

### Breaking Changes

None - this is the initial release.

### Known Issues

- Health checks are currently only available in API mode
- Puppeteer mode requires browser installation

### Future Plans

See [ROADMAP.md](docs/ROADMAP.md) for planned features and improvements.

### Contributors

Initial release by the development team.

### License

MIT License - see [LICENSE](LICENSE) file for details.

### Links

- GitHub Repository: https://github.com/Slimiys/twitch-watcher
- Documentation: See `docs/` folder
- Issues: https://github.com/Slimiys/twitch-watcher/issues

