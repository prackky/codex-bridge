# Publish to GitHub

This directory is a clean, independent release copy. Do not publish your running
installation or copy its `.env`, service file, logs, or Codex credentials here.
The release is licensed under MIT; see LICENSE.

```bash
git init -b main
git add .
git diff --cached --stat
git diff --cached  # review the files being published
git commit -m "Prepare portable Codex bridge with Docker setup"
```

Create an empty repository named `codex-bridge` on GitHub, then:

```bash
git remote add origin https://github.com/prackky/codex-bridge.git
git push -u origin main
```

Replace the clone URL in README.md with your repository URL. GitHub Actions runs
the integration suite and builds the Docker image. External publication has not
been performed by this preparation step.
