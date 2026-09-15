const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const pty = require("node-pty");

const app = express();
const PORT = 9000;

app.use(express.json());

// Allow cross-origin requests (needed when accessing via Tailscale IP or any non-localhost origin)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function run(cmd, cwd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

function validateRepo(repoPath) {
  if (!repoPath) throw new Error("No repo path provided");
  if (!fs.existsSync(repoPath)) throw new Error("Path does not exist");
}

app.get("/api/tailscale-ip", (req, res) => {
  const interfaces = os.networkInterfaces();
  let tailscaleIP = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && iface.address.startsWith("100.")) {
        tailscaleIP = iface.address;
      }
    }
  }
  res.json({ ip: tailscaleIP });
});

app.get("/api/repo-info", async (req, res) => {
  const { repoPath } = req.query;
  try {
    validateRepo(repoPath);
    const [remote, branch, lastCommit] = await Promise.all([
      run("git remote get-url origin", repoPath),
      run("git rev-parse --abbrev-ref HEAD", repoPath),
      run("git log -1 --pretty=format:'%s|%an|%ar'", repoPath),
    ]);
    const [subject, author, time] = lastCommit.split("|");
    const githubUrl = remote.replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
    const repoName = remote.replace(/.*[\/:]/, "").replace(".git", "");
    res.json({ remote: githubUrl, repoName, branch, lastCommit: { subject, author, time } });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/repos", async (req, res) => {
  try {
    const { spawn } = require("child_process");
    const readline = require("readline");
    const home = os.homedir();
    const searchDirs = [
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.join(home, 'projects'),
      path.join(home, 'src'),
      path.join(home, 'dev')
    ].filter(fs.existsSync);

    if (!searchDirs.length) return res.json({ repos: [] });

    const args = [...searchDirs, '-maxdepth', '3', '-name', '.git', '-type', 'd', '-prune'];
    const child = spawn('find', args, { stdio: ['ignore', 'pipe', 'ignore'] });

    const repos = [];
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on('line', line => {
      if (line && repos.length < 100) {
        repos.push(line.replace(/\/\.git$/, ''));
      }
    });

    child.on('close', () => {
      res.json({ repos });
    });

    child.on('error', (e) => {
      res.status(500).json({ error: e.message });
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.get("/api/status", async (req, res) => {
  const { repoPath } = req.query;
  try {
    validateRepo(repoPath);
    const [status, diff] = await Promise.all([
      run("git status --short", repoPath),
      run("git diff HEAD", repoPath),
    ]);
    res.json({ status, diff });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/push", async (req, res) => {
  const { message, repoPath } = req.body;
  try {
    validateRepo(repoPath);
    if (!message) return res.status(400).json({ error: "Commit message required" });
    await run("git add .", repoPath);
    await run(`git commit -m "${message.replace(/"/g, '\\"')}"`, repoPath);
    const pushOut = await run("git push", repoPath);
    res.json({ success: true, output: pushOut });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/file-tree", async (req, res) => {
  const { repoPath } = req.query;
  try {
    validateRepo(repoPath);
    // Use git ls-files to get all tracked files (respects .gitignore automatically)
    const output = await run("git ls-files", repoPath);
    const files = output.split('\n').filter(Boolean);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.get("/api/file-read", async (req, res) => {
  const { repoPath, file } = req.query;
  console.log(`[file-read] repoPath=${repoPath} file=${JSON.stringify(file)}`);
  try {
    validateRepo(repoPath);
    if (!file) return res.status(400).json({ error: "No file specified" });
    const abs = path.resolve(repoPath, file);
    // Prevent path traversal outside the repo
    if (!abs.startsWith(path.resolve(repoPath))) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ error: `File not found: ${abs}` });
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Cannot edit a directory (submodule?)" });
    }
    if (stat.size > 2 * 1024 * 1024) {
      return res.status(400).json({ error: "File too large to edit (>2MB)" });
    }
    const content = fs.readFileSync(abs, "utf8");
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/file-write", async (req, res) => {
  const { repoPath, file, content } = req.body;
  try {
    validateRepo(repoPath);
    if (!file) return res.status(400).json({ error: "No file specified" });
    if (content === undefined) return res.status(400).json({ error: "No content provided" });
    const abs = path.resolve(repoPath, file);
    // Prevent path traversal outside the repo
    if (!abs.startsWith(path.resolve(repoPath))) {
      return res.status(403).json({ error: "Access denied" });
    }
    fs.writeFileSync(abs, content, "utf8");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.use(express.static("public"));

// ── HTTP + WebSocket server ──────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/terminal" });

wss.on("connection", (ws, req) => {
  const params = new URL(req.url, "http://localhost").searchParams;
  const repoPath = params.get("repoPath") || os.homedir();
  const cwd = fs.existsSync(repoPath) ? repoPath : os.homedir();

  // Pick a shell — check candidates in order
  const shellCandidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ].filter(Boolean);

  const shell = shellCandidates.find(s => {
    try { return fs.existsSync(s) && fs.statSync(s).isFile(); } catch { return false; }
  }) || "/bin/sh";

  console.log(`[term] shell=${shell} cwd=${cwd}`);

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
  } catch (err) {
    console.error("[term] spawn failed:", err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
      ws.close();
    }
    return;
  }

  ptyProcess.onData(data => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on("message", msg => {
    try {
      const d = JSON.parse(msg);
      if (d.type === "input")  ptyProcess.write(d.data);
      if (d.type === "resize") ptyProcess.resize(d.cols, d.rows);
    } catch {
      ptyProcess.write(msg);
    }
  });

  ws.on("close", () => {
    try { ptyProcess.kill(); } catch {}
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use.\nRun: lsof -ti :${PORT} | xargs kill -9\n`);
    process.exit(1);
  } else throw e;
});

server.listen(PORT, "0.0.0.0", () => {
  const interfaces = os.networkInterfaces();
  let tailscaleIP = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && iface.address.startsWith("100.")) tailscaleIP = iface.address;
    }
  }
  console.log(`Groove running at http://localhost:${PORT}`);
  if (tailscaleIP) console.log(`Groove on Tailscale: http://${tailscaleIP}:${PORT}`);
});
