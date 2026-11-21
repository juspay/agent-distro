# The comparison on the home page: its date, its columns and its rows.
#
# A row's `own` is agent-distro's cell. Every other cell is `{ text; detail?;
# source; }`: `text` goes in the table, and `detail` (or `text`, when the two
# are one fact) goes in the list under it, linked to `source`. site.nix reads
# `source` from every such cell, so a cell without one fails the build.
#
# `agents` is the number of agents agent-distro runs, as a capitalised word,
# taken from harnesses/ so the table cannot disagree with it.
{ agents }:
let
  apm = "https://github.com/microsoft/apm";
  skills = "https://github.com/vercel-labs/skills";
  llmAgents = "https://github.com/numtide/llm-agents.nix";
in
{
  readOn = "20 November 2026";

  others = [
    { key = "apm"; name = "APM"; url = apm; }
    { key = "skills"; name = "skills"; url = skills; }
    { key = "llmAgents"; name = "llm-agents.nix"; url = llmAgents; }
  ];

  rows = [
    {
      label = "Runs the agents";
      own = "${agents} agents";
      apm = { text = "No"; detail = "APM governs what is installed. Your agent governs what runs"; source = "${apm}#3-governed-by-policy"; };
      skills = { text = "No"; detail = "The command finds the agents that you have installed"; source = "${skills}/blob/main/docs/agents.md"; };
      llmAgents = { text = "68 packages"; detail = "68 agents under AI Coding Agents. You run each one with `nix run`"; source = "${llmAgents}#ai-coding-agents"; };
    }
    {
      label = "Sets agents up";
      own = "${agents} agents";
      apm = { text = "Nine agents"; detail = "Nine agents named in the README, among them Claude Code, Codex, and OpenCode"; source = "${apm}#readme"; };
      skills = { text = "79 agents"; detail = "OpenCode, Claude Code, Codex, Cursor, and 75 more"; source = "${skills}#skills"; };
      llmAgents = { text = "No"; detail = "Nix packages for AI coding agents and development tools, with no setup for them"; source = "${llmAgents}#readme"; };
    }
    {
      label = "A setup holds";
      own = "Skills, MCP, no hooks";
      apm = { text = "Skills, MCP, hooks, more"; detail = "Instructions, skills, prompts, agents, hooks, plugins, and MCP servers"; source = "${apm}#1-portable-by-manifest"; };
      skills = { text = "Skills only"; detail = "Every command adds, updates, or removes skills"; source = "${skills}#other-commands"; };
      llmAgents = { text = "Nothing"; detail = "A package is the agent program, with no setup"; source = "${llmAgents}#ai-coding-agents"; };
    }
    {
      label = "How it reaches an agent";
      own = "Read at launch";
      apm = { text = "Files written per agent"; detail = "`apm install` writes each one in the format of each agent"; source = "${apm}#why-apm"; };
      skills = { text = "Symlinks or copies"; detail = "A symlink from each agent to one copy, or a copy for each agent where symlinks fail"; source = "${skills}/blob/main/docs/commands.md#installation-methods"; };
      llmAgents = { text = "Not applicable"; detail = "Nothing is installed into an agent"; source = "${llmAgents}#ai-coding-agents"; };
    }
    {
      label = "Lockfile";
      own = "No lockfile";
      apm = { text = "`apm.lock.yaml`"; detail = "`apm.lock.yaml` records the exact commit and a hash of every file that APM wrote"; source = "${apm}#why-apm"; };
      skills = { text = "`skills-lock.json`"; detail = "`skills-lock.json` records a hash for each skill of a project"; source = "${skills}#lock-file-content-hash"; };
      llmAgents = { text = "Flake input"; detail = "You add it to your own flake as an input"; source = "${llmAgents}#installation"; };
    }
    {
      label = "Updates";
      own = "Four times a day";
      apm = { text = "Dependabot or Renovate"; detail = "Fixes reach you as Dependabot or Renovate pull requests"; source = "${apm}#1-portable-by-manifest"; };
      skills = { text = "`skills update`"; detail = "You run `npx skills update`"; source = "${skills}#other-commands"; };
      llmAgents = { text = "Daily"; detail = "Packages are updated and built every day"; source = "${llmAgents}#binary-cache"; };
    }
    {
      label = "Needs";
      own = "Needs Nix";
      apm = { text = "Homebrew, curl, or pip"; detail = "Homebrew, a curl script, pip, WinGet, or Scoop"; source = "${apm}#get-started"; };
      skills = { text = "Node.js 22.20"; detail = "Node.js 22.20 or later"; source = "${skills}#install-a-skill"; };
      llmAgents = { text = "Nix"; detail = "Nix with flakes"; source = "${llmAgents}#installation"; };
    }
  ];
}
