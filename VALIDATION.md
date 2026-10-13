# Release validation

- 33 integration/setup tests passed locally and inside the Node 22 Docker image.
- Docker Compose configuration validated without an `.env` file.
- Docker image built with standalone Codex CLI 0.162.1.
- Real container app-server initialization verified; clean image correctly requires ChatGPT login.
- Setup tested to generate a 64-character random token, set file permissions to 0600,
  and leave existing settings unchanged.
- Release scanned for original usernames, host paths, IP address, and gateway token.
- Existing deployed service was not edited or restarted during release preparation.

Not exercised: interactive user sign-in, authenticated live inference in the new
container, macOS Docker Desktop, or ARM64 container build. These require the
appropriate platform and a user's login. GitHub CI builds the default Linux image.
